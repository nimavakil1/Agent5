const WebSocket = require('ws');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const CallLogEntry = require('../models/CallLogEntry');
const { resolveAgentAndMcp } = require('../util/orchestrator');
const agentSettings = require('../config/agentSettings');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// μ-law decode/encode for 8kHz PCMU <-> PCM16 conversion
function ulawDecode(sample) {
  sample = ~sample & 0xff;
  const sign = sample & 0x80;
  let exponent = (sample >> 4) & 0x07;
  let mantissa = sample & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  let pcm = sign ? -magnitude : magnitude;
  if (pcm > 32767) pcm = 32767;
  if (pcm < -32768) pcm = -32768;
  return pcm;
}

function ulawEncode(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  const exponent = ulaw_exponent_table[(sample >> 7) & 0xFF];
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Precompute exponent table for μ-law
const ulaw_exponent_table = new Uint8Array(256);
(function makeExpTable() {
  let exp = 0;
  for (let i = 0; i < 256; i++) {
    if (i < 16) exp = 0;
    else if (i < 32) exp = 1;
    else if (i < 64) exp = 2;
    else if (i < 128) exp = 3;
    else exp = 4;
    ulaw_exponent_table[i] = exp;
  }
})();

// Convert μ-law buffer to PCM16 Int16Array
function pcmuToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) {
    out[i] = ulawDecode(ulawBuf[i]);
  }
  return out;
}

// Convert PCM16 Int16Array to μ-law buffer
function pcm16ToPcmu(pcm16Arr) {
  const out = Buffer.alloc(pcm16Arr.length);
  for (let i = 0; i < pcm16Arr.length; i++) {
    out[i] = ulawEncode(pcm16Arr[i]);
  }
  return out;
}

async function createOpenAISession(customerRecord = null, sessionOverrides = {}) {
  try {
    const saved = await agentSettings.getSettings();
    let instructions = sessionOverrides.instructions || saved?.instructions || '';
    let voice = sessionOverrides.voice || saved?.voice || undefined;
    let language = sessionOverrides.language || saved?.language || 'en';
    
    if (customerRecord) {
      instructions += ` The customer's name is ${customerRecord.name}. Their preferred language is ${customerRecord.preferred_language || 'English'}. Their historical offers include: ${customerRecord.historical_offers.join(', ')}.`;
    }

    console.log('PSTN OpenAI session -> voice:', voice || '(default)', '| lang:', language, '| instructions len:', instructions.length);

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        modalities: ['text'], // Text-only for PSTN with external TTS
        instructions,
        voice,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to create OpenAI session: ${response.status} ${response.statusText} - ${errorData.message}`);
    }

    const sessionData = await response.json();
    console.log('PSTN OpenAI session created:', sessionData);
    return sessionData;
  } catch (error) {
    console.error('Error creating PSTN OpenAI session:', error);
    throw error;
  }
}

function createPSTNWebSocketHandler(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/pstn-websocket'
  });

  wss.on('connection', async (telnyxWs, req) => {
    console.log('=== PSTN WEBSOCKET CONNECTION ESTABLISHED ===');
    console.log('Connection headers:', JSON.stringify(req.headers, null, 2));
    console.log('Request URL:', req.url);
    
    const url = require('url');
    const parsedUrl = url.parse(req.url, true);
    const query = parsedUrl.query || {};
    const roomName = String(query.roomName || '').replace(/[^a-zA-Z0-9_-]/g, '');
    console.log('Parsed URL query parameters:', JSON.stringify(query, null, 2));
    console.log('Extracted room name:', roomName);

    if (!roomName) {
      console.error('PSTN: Room name not provided - closing connection');
      telnyxWs.close();
      return;
    }

    console.log(`=== PSTN WEBSOCKET SETUP COMPLETE FOR ROOM: ${roomName} ===`);

    let openaiWs = null;
    let telnyxStreamId = null;
    let currentTranscription = '';
    let customerRecord = null;

    // Audio queuing for Telnyx output
    let aiPcmuQueue = Buffer.alloc(0);
    let aiSendTimer = null;
    const AI_FRAME_SAMPLES = 160; // 20ms @8kHz

    // TTS state
    let ttsInFlight = false;
    let ttsAbort = null;
    let outBuf = '';

    // Simple file recording
    let recordingFile = null;
    let recordingPath = '';

    function startAiSender() {
      if (aiSendTimer) return;
      let sentFrames = 0;
      aiSendTimer = setInterval(() => {
        try {
          if (!telnyxWs || telnyxWs.readyState !== WebSocket.OPEN) return;
          if (!telnyxStreamId) return;
          if (aiPcmuQueue.length < AI_FRAME_SAMPLES) return;

          const frame = aiPcmuQueue.subarray(0, AI_FRAME_SAMPLES);
          aiPcmuQueue = aiPcmuQueue.subarray(AI_FRAME_SAMPLES);
          
          const payload = frame.toString('base64');
          const msg = { event: 'media', media: { payload } };
          if (telnyxStreamId) msg.stream_id = telnyxStreamId;
          
          telnyxWs.send(JSON.stringify(msg));
          sentFrames++;
          
          if (sentFrames <= 3 || sentFrames % 50 === 0) {
            console.log(`PSTN AI->Telnyx sent frames: ${sentFrames}`);
          }
        } catch (err) {
          console.error('PSTN AI sender error:', err);
        }
      }, 20);
    }

    function appendAiPcmu(pcmuBuffer) {
      aiPcmuQueue = Buffer.concat([aiPcmuQueue, pcmuBuffer]);
      if (!aiSendTimer) startAiSender();
    }

    async function startTTS(text, force = false) {
      console.log('=== STARTING TTS ===');
      console.log('TTS text:', text);
      console.log('Force flag:', force);
      const ttsProvider = process.env.TTS_PROVIDER_PSTN || 'openai';
      console.log('TTS Provider:', ttsProvider);
      if (ttsProvider !== 'elevenlabs') {
        console.log('PSTN: TTS_PROVIDER_PSTN not set to elevenlabs, skipping TTS');
        return;
      }

      const apiKey = process.env.ELEVENLABS_API_KEY;
      const voiceId = process.env.ELEVENLABS_VOICE_ID;
      console.log('ElevenLabs API Key:', apiKey ? 'Present' : 'Missing');
      console.log('ElevenLabs Voice ID:', voiceId || 'Missing');
      if (!apiKey || !voiceId) {
        console.error('PSTN: ElevenLabs API key or voice ID missing');
        return;
      }

      if (ttsInFlight) return;
      const textToSynth = text.trim();
      if (!textToSynth) return;
      if (!force && textToSynth.length < 60 && !/[\.!?;:]/.test(textToSynth)) return;

      ttsInFlight = true;
      const { streamTextToElevenlabs } = require('../services/ttsElevenlabs');
      const ctrl = new AbortController();
      ttsAbort = ctrl;

      try {
        console.log(`PSTN: Starting ElevenLabs TTS for: "${textToSynth.slice(0, 100)}..."`);
        
        await streamTextToElevenlabs({
          apiKey,
          voiceId,
          text: textToSynth,
          optimize: Number(process.env.ELEVENLABS_OPTIMIZE || '4') || 4,
          abortSignal: ctrl.signal,
          debug: process.env.TTS_DEBUG === '1',
          outputFormat: 'pcm_8000', // Direct 8kHz for PSTN
          onChunk: async (chunk) => {
            try {
              if (!chunk || chunk.length === 0) return;
              
              // Convert PCM16 8kHz to μ-law 8kHz
              const pcm16Samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
              const pcmuBuffer = pcm16ToPcmu(pcm16Samples);
              
              // Send directly to Telnyx
              appendAiPcmu(pcmuBuffer);
              
              // Write to recording file
              if (recordingFile) {
                recordingFile.write(chunk);
              }
            } catch (e) {
              console.error('PSTN: Error processing TTS chunk:', e);
            }
          },
        });
      } catch (e) {
        console.error('PSTN: ElevenLabs TTS error:', e?.message || e);
      } finally {
        ttsInFlight = false;
        ttsAbort = null;
      }
    }

    try {
      // Fetch customer record
      const callLog = await CallLogEntry.findOne({ call_id: roomName });
      if (callLog && callLog.customer_id) {
        customerRecord = await require('../models/CustomerRecord').findOne({ customer_id: callLog.customer_id });
      }

      // Resolve agent configuration
      const campaignHint = String(query.campaign || query.campaign_id || '').trim();
      const languageHint = String(query.lang || query.language || '').toLowerCase();
      let sessionOverrides = { instructions: null, voice: null, language: null };

      try {
        const resolved = await resolveAgentAndMcp({
          campaignId: campaignHint || (callLog?.campaign_id || ''),
          detectedLanguage: languageHint
        });
        
        if (resolved?.agent) {
          sessionOverrides.instructions = resolved.agent.instructions || null;
          sessionOverrides.voice = resolved.agent.voice || null;
          sessionOverrides.language = resolved.agent.language || languageHint || null;
          console.log('PSTN: Resolved agent:', { name: resolved.agent.name, lang: sessionOverrides.language });
        }
      } catch (e) {
        console.error('PSTN: Agent resolution error:', e?.message || e);
      }

      // Start recording
      try {
        const recordingsDir = path.resolve(__dirname, '..', 'recordings', 'pstn');
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
        recordingPath = path.join(recordingsDir, `${roomName}-${Date.now()}.wav`);
        
        // Create WAV file with proper header
        recordingFile = fs.createWriteStream(recordingPath);
        const wavHeader = Buffer.alloc(44);
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(0, 4); // File size - will update on close
        wavHeader.write('WAVE', 8);
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16); // fmt chunk size
        wavHeader.writeUInt16LE(1, 20); // PCM format
        wavHeader.writeUInt16LE(1, 22); // Mono
        wavHeader.writeUInt32LE(8000, 24); // Sample rate 8kHz
        wavHeader.writeUInt32LE(16000, 28); // Byte rate
        wavHeader.writeUInt16LE(2, 32); // Block align
        wavHeader.writeUInt16LE(16, 34); // Bits per sample
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(0, 40); // Data size - will update on close
        recordingFile.write(wavHeader);
        
        console.log(`PSTN: Recording started: ${recordingPath}`);
      } catch (e) {
        console.error('PSTN: Failed to start recording:', e);
      }

      // Create OpenAI session
      console.log('=== CREATING OPENAI SESSION ===');
      console.log('OpenAI API Key available:', process.env.OPENAI_API_KEY ? 'Yes' : 'No');
      console.log('Customer record:', customerRecord ? 'Present' : 'None');
      console.log('Session overrides:', JSON.stringify(sessionOverrides, null, 2));
      
      const session = await createOpenAISession(customerRecord, sessionOverrides);
      console.log('=== OPENAI SESSION CREATED ===');
      console.log('Session response:', JSON.stringify(session, null, 2));
      
      // OpenAI Realtime API changed - use direct WebSocket endpoint instead of session.websocket_url
      const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
      const OPENAI_REALTIME_API_URL = `wss://api.openai.com/v1/realtime?model=${model}`;
      console.log('Using direct OpenAI WebSocket URL:', OPENAI_REALTIME_API_URL);

      openaiWs = new WebSocket(OPENAI_REALTIME_API_URL, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });

      openaiWs.on('open', async () => {
        console.log('=== OPENAI REALTIME API CONNECTED ===');
        console.log('OpenAI WebSocket URL:', OPENAI_REALTIME_API_URL);
        
        try {
          const sessionUpdate = {
            type: 'session.update',
            session: {
              modalities: ['text'], // Text-only responses
              input_audio_format: 'pcm16',
              input_audio_transcription: { 
                model: 'whisper-1', 
                language: sessionOverrides.language || 'en' 
              },
              turn_detection: { 
                type: 'server_vad', 
                threshold: Number(process.env.TURN_DETECTION_THRESHOLD || '0.60'),
                prefix_padding_ms: Number(process.env.TURN_DETECTION_PREFIX_MS || '180'),
                silence_duration_ms: Number(process.env.TURN_DETECTION_SILENCE_MS || '250')
              },
            }
          };
          
          if (sessionOverrides.instructions) {
            sessionUpdate.session.instructions = sessionOverrides.instructions;
          }
          
          console.log('PSTN: Sending session.update with language:', sessionOverrides.language || 'en');
          openaiWs.send(JSON.stringify(sessionUpdate));
        } catch (e) {
          console.error('PSTN: Failed to configure session:', e);
        }
      });

      openaiWs.on('message', async (data) => {
        console.log('=== RECEIVED OPENAI MESSAGE ===');
        console.log('OpenAI message type:', typeof data);
        try {
          const message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
          console.log('OpenAI message type:', message.type);
          
          // Handle text responses
          if (message.type === 'response.text.delta' && message.delta) {
            console.log('=== OPENAI TEXT DELTA ===');
            console.log('Delta content:', message.delta);
            currentTranscription += message.delta;
            outBuf += message.delta;
            
            // Start TTS when we have enough text
            if (outBuf.length > 0) {
              const textToSynth = outBuf;
              console.log('Starting TTS for text:', textToSynth);
              outBuf = ''; // Clear buffer
              await startTTS(textToSynth);
            }
          }
          
          if (message.type === 'response.done') {
            // Flush any remaining text
            if (outBuf.length > 0) {
              await startTTS(outBuf, true);
              outBuf = '';
            }
          }

          // Handle transcription
          if (message.type === 'conversation.item.input_audio_transcription.delta' && message.delta) {
            currentTranscription += message.delta;
          }

        } catch (error) {
          console.error('PSTN: Error processing OpenAI message:', error);
        }
      });

      openaiWs.on('close', () => {
        console.log('PSTN: Disconnected from OpenAI');
      });

      openaiWs.on('error', (error) => {
        console.error('PSTN: OpenAI WebSocket error:', error);
      });

    } catch (error) {
      console.error('PSTN: Failed to initialize connection:', error);
      telnyxWs.close();
      return;
    }

    // Handle Telnyx messages
    telnyxWs.on('message', async (message) => {
      console.log('=== RECEIVED TELNYX WEBSOCKET MESSAGE ===');
      console.log('Message type:', typeof message);
      console.log('Message size:', message.length, 'bytes');
      
      try {
        console.log('Raw message content (first 500 chars):', message.toString().substring(0, 500));
        const data = JSON.parse(message);
        console.log('Parsed JSON data:', JSON.stringify(data, null, 2));
        
        if (data.event === 'start') {
          telnyxStreamId = data.stream_id || data.streamId || (data.start && data.start.stream_id) || null;
          console.log('=== TELNYX STREAM STARTED ===');
          console.log('Stream ID extracted:', telnyxStreamId);
          console.log('Full start event:', JSON.stringify(data, null, 2));
        }
        
        else if (data.event === 'media') {
          console.log('=== PROCESSING MEDIA MESSAGE ===');
          console.log('OpenAI WebSocket state:', openaiWs ? openaiWs.readyState : 'null');
          console.log('Media payload length:', data.media?.payload?.length || 'no payload');
          
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            console.log('Sending audio to OpenAI Realtime API...');
            const audioBase64 = data.media.payload;
            const ulawBuffer = Buffer.from(audioBase64, 'base64');
            console.log('Decoded μ-law buffer size:', ulawBuffer.length, 'bytes');
          
            // Convert μ-law to PCM16 8kHz
            const pcm16Samples = pcmuToPcm16(ulawBuffer);
            console.log('PCM16 samples array length:', pcm16Samples.length);
          
            // Convert to buffer for OpenAI (expects little-endian PCM16)
            const pcm16Buffer = Buffer.alloc(pcm16Samples.length * 2);
            for (let i = 0; i < pcm16Samples.length; i++) {
              pcm16Buffer.writeInt16LE(pcm16Samples[i], i * 2);
            }
            console.log('PCM16 buffer size for OpenAI:', pcm16Buffer.length, 'bytes');
          
            const b64 = pcm16Buffer.toString('base64');
            const openaiMessage = { 
              type: 'input_audio_buffer.append', 
              audio: b64 
            };
            console.log('Sending to OpenAI - message type:', openaiMessage.type, 'audio length:', b64.length);
            openaiWs.send(JSON.stringify(openaiMessage));
          
            // Write to recording file (convert back to PCM16 for WAV)
            if (recordingFile) {
              recordingFile.write(pcm16Buffer);
              console.log('Audio written to recording file');
            }
          } else {
            console.log('OpenAI WebSocket not available - skipping audio processing');
          }
        }
        
        else if (data.event === 'stop') {
          console.log('=== TELNYX STREAM STOPPED ===');
          console.log('Stop event data:', JSON.stringify(data, null, 2));
          
          // Clean up
          if (aiSendTimer) {
            clearInterval(aiSendTimer);
            aiSendTimer = null;
          }
          
          if (ttsAbort) {
            ttsAbort.abort();
          }
          
          if (openaiWs) {
            try {
              openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              openaiWs.send(JSON.stringify({ type: 'response.create' }));
            } catch (e) {
              console.error('PSTN: Error finalizing OpenAI input:', e);
            }
            openaiWs.close();
          }
          
          // Finalize recording
          if (recordingFile) {
            try {
              const pos = recordingFile.bytesWritten;
              recordingFile.end();
              
              // Update WAV header with correct file sizes
              setTimeout(() => {
                try {
                  const fd = fs.openSync(recordingPath, 'r+');
                  const dataSize = Math.max(0, pos - 44);
                  const fileSize = dataSize + 36;
                  
                  const buf = Buffer.alloc(4);
                  buf.writeUInt32LE(fileSize, 0);
                  fs.writeSync(fd, buf, 0, 4, 4);
                  
                  buf.writeUInt32LE(dataSize, 0);
                  fs.writeSync(fd, buf, 0, 4, 40);
                  
                  fs.closeSync(fd);
                  console.log(`PSTN: Recording finalized: ${recordingPath}`);
                } catch (e) {
                  console.error('PSTN: Error finalizing recording header:', e);
                }
              }, 100);
            } catch (e) {
              console.error('PSTN: Error closing recording file:', e);
            }
          }
          
          // Update call log
          try {
            const callEndTime = new Date();
            const audioRecordingUrl = recordingPath ? `/recordings/pstn/${path.basename(recordingPath)}` : '';
            
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              {
                audio_recording_url: audioRecordingUrl,
                end_time: callEndTime,
                call_status: 'success',
                transcription: currentTranscription,
              },
              { new: true, runValidators: true }
            );
          } catch (e) {
            console.error('PSTN: Error updating call log:', e);
          }
        }
      } catch (error) {
        console.error('=== ERROR PARSING TELNYX MESSAGE ===');
        console.error('Parse error:', error.message);
        console.error('Error stack:', error.stack);
        console.error('Raw message causing error:', message.toString());
      }
    });

    telnyxWs.on('close', async () => {
      console.log('PSTN: Telnyx WebSocket disconnected');
      
      if (openaiWs) openaiWs.close();
      if (aiSendTimer) {
        clearInterval(aiSendTimer);
        aiSendTimer = null;
      }
      if (recordingFile) {
        recordingFile.end();
      }
    });

    telnyxWs.on('error', (error) => {
      console.error('PSTN: Telnyx WebSocket error:', error);
      if (openaiWs) openaiWs.close();
    });
  });

  return wss;
}

module.exports = { createPSTNWebSocketHandler };