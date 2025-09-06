const WebSocket = require('ws');
const OpenAI = require('openai');
// use global fetch (Node >= 18)
const url = require('url'); // Import url module
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk'); // Import LiveKit SDK
const { createPublisher, toWsUrl } = require('../livekit/publisher');
const CallLogEntry = require('../models/CallLogEntry'); // Import CallLogEntry model
const CustomerRecord = require('../models/CustomerRecord'); // Import CustomerRecord model
const fs = require('fs'); // Import file system module
const path = require('path'); // Import path module

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_REALTIME_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

// LiveKit configuration
const livekitHost = process.env.LIVEKIT_SERVER_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const agentSettings = require('../config/agentSettings');

// --- Audio helpers: PCMU (G.711 u-law) -> PCM16, then upsample to 24kHz ---
function ulawDecode(sample) {
  // u-law decode from 8-bit to 16-bit signed PCM
  sample = ~sample & 0xff;
  const sign = sample & 0x80;
  let exponent = (sample >> 4) & 0x07;
  let mantissa = sample & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  let pcm = sign ? -magnitude : magnitude;
  // Clamp to int16
  if (pcm > 32767) pcm = 32767;
  if (pcm < -32768) pcm = -32768;
  return pcm;
}

function decodePCMUtoPCM16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) {
    out[i] = ulawDecode(ulawBuf[i]);
  }
  return out;
}

function upsampleTo24kHz(pcm8k) {
  // naive upsample x3 (nearest-neighbor)
  const out = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const v = pcm8k[i];
    const j = i * 3;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
  }
  return out;
}

function int16ToLEBuffer(int16Arr) {
  const buf = Buffer.alloc(int16Arr.length * 2);
  for (let i = 0; i < int16Arr.length; i++) {
    buf.writeInt16LE(int16Arr[i], i * 2);
  }
  return buf;
}

async function createOpenAISession(customerRecord = null) {
  try {
    let { instructions, voice } = agentSettings.getSettings();
    if (!instructions) instructions = 'You are a helpful AI assistant for a call center.';
    if (customerRecord) {
      instructions += ` The customer's name is ${customerRecord.name}. Their preferred language is ${customerRecord.preferred_language || 'English'}. Their historical offers include: ${customerRecord.historical_offers.join(', ')}.`;
    }

    const response = await fetch(OPENAI_REALTIME_SESSIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview', // Or 'gpt-realtime'
        modalities: ['audio', 'text'],
        instructions,
        voice: voice || undefined,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to create OpenAI session: ${response.status} ${response.statusText} - ${errorData.message}`);
    }

    const sessionData = await response.json();
    console.log('OpenAI session created:', sessionData);
    return sessionData;
  } catch (error) {
    console.error('Error creating OpenAI session:', error);
    throw error;
  }
}

function createWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', async (telnyxWs, req) => { // Add req parameter
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '';
    // Browser mic bridge: /agent-stream?room=<roomName>
    if (pathname === '/agent-stream') {
      try {
        const query = parsedUrl.query || {};
        const roomName = String(query.room || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!roomName) { telnyxWs.close(); return; }

        const { AccessToken } = require('livekit-server-sdk');
        const { createPublisher } = require('../livekit/publisher');
        const settings = agentSettings.getSettings();

        const identity = `browser-bridge-${roomName}-${Date.now()}`;
        const at = new AccessToken(apiKey, apiSecret, { identity });
        at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: false });
        const token = at.toJwt();
        const publisher = await createPublisher({ host: livekitHost, token, roomName });
        if (!publisher) { telnyxWs.close(); return; }

        // OpenAI Realtime WS
        const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
        const OA_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
        const oaWs = new WebSocket(OA_URL, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
        });
        oaWs.on('open', () => {
          try {
            oaWs.send(JSON.stringify({ type: 'session.update', session: { instructions: settings.instructions || 'You are a helpful assistant.', voice: settings.voice || undefined } }));
          } catch (_) {}
        });
        oaWs.on('message', (data) => {
          try {
            const s = typeof data === 'string' ? data : data.toString('utf8');
            const m = JSON.parse(s);
            if ((m.type === 'response.audio.delta' || m.type === 'response.output_audio.delta') && m.delta) {
              const pcm24k = Buffer.from(m.delta, 'base64');
              publisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
            }
          } catch (_) {}
        });
        const closeAll = async () => { try { oaWs.close(); } catch(_) {}; try { await publisher.close(); } catch(_) {} };
        telnyxWs.on('message', (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === 'audio' && m.audio && oaWs.readyState === WebSocket.OPEN) {
              oaWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.audio }));
            } else if (m.type === 'commit' && oaWs.readyState === WebSocket.OPEN) {
              oaWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio'] } }));
            }
          } catch(_) {}
        });
        telnyxWs.on('close', closeAll); telnyxWs.on('error', closeAll); oaWs.on('close', closeAll); oaWs.on('error', closeAll);
      } catch (_) { try { telnyxWs.close(); } catch(_) {} }
      return;
    }
    console.log('Telnyx WebSocket client connected');
    if (pathname !== '/websocket') {
      console.error('Invalid WebSocket path:', pathname);
      telnyxWs.close();
      return;
    }
    const rawRoom = parsedUrl.query.roomName;
    const roomName = String(rawRoom || '').replace(/[^a-zA-Z0-9_-]/g, '');

    if (!roomName) {
      console.error('Room name not provided in WebSocket URL');
      telnyxWs.close();
      return;
    }

    console.log(`Telnyx connected for LiveKit room: ${roomName}`);

    let openaiWs = null; // WebSocket connection to OpenAI
    let livekitRoom = null; // LiveKit Room object
    let telnyxParticipant = null; // LiveKit Participant for Telnyx audio
    let livekitPublisher = null; // Node publisher into LiveKit
    let customerRecord = null; // Customer Record for personalization
    let currentTranscription = ''; // To accumulate transcription
    // Recording stream state
    let audioFilePath = null;
    let audioWriteStream = null;
    let bytesWritten = 0;
    let telnyxStreamId = null; // Stream ID from Telnyx 'start' event

    // Outgoing AI speech queue (PCMU @8kHz)
    let aiPcmuQueue = Buffer.alloc(0);
    let aiSendTimer = null;
    const AI_FRAME_SAMPLES = 160; // 20ms @8kHz

    function linearToUlaw(sample) {
      // Convert 16-bit PCM sample to 8-bit u-law
      const BIAS = 0x84;
      const CLIP = 32635;
      let sign = (sample >> 8) & 0x80;
      if (sign !== 0) sample = -sample;
      if (sample > CLIP) sample = CLIP;
      sample = sample + BIAS;
      const exponent = ulaw_exponent_table[(sample >> 7) & 0xFF];
      const mantissa = (sample >> (exponent + 3)) & 0x0F;
      let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
      return ulawByte;
    }

    // Precompute exponent table for u-law
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

    function downsample24kTo8k(pcmLeBuf) {
      // Buffer of 16-bit LE samples at 24kHz -> Int16Array at 8kHz by decimation
      const len = Math.floor(pcmLeBuf.length / 2);
      const outLen = Math.floor(len / 3);
      const out = new Int16Array(outLen);
      for (let i = 0, j = 0; j < outLen; i += 6, j++) {
        // i increments by 6 bytes = 3 samples (we pick the first sample of each triplet)
        out[j] = pcmLeBuf.readInt16LE(i);
      }
      return out;
    }

    function appendAiPcmuFromOpenAIBase64(b64Pcm16Le24k) {
      const pcm24k = Buffer.from(b64Pcm16Le24k, 'base64');
      const pcm8k = downsample24kTo8k(pcm24k);
      const mu = Buffer.alloc(pcm8k.length);
      for (let i = 0; i < pcm8k.length; i++) {
        mu[i] = linearToUlaw(pcm8k[i]);
      }
      aiPcmuQueue = Buffer.concat([aiPcmuQueue, mu]);
      if (!aiSendTimer) startAiSender();
    }

    function startAiSender() {
      if (aiSendTimer) return;
      aiSendTimer = setInterval(() => {
        try {
          if (!telnyxWs || telnyxWs.readyState !== WebSocket.OPEN) return;
          if (aiPcmuQueue.length < AI_FRAME_SAMPLES) return;
          const frame = aiPcmuQueue.subarray(0, AI_FRAME_SAMPLES);
          aiPcmuQueue = aiPcmuQueue.subarray(AI_FRAME_SAMPLES);
          const payload = frame.toString('base64');
          const msg = { event: 'media', media: { payload } };
          if (telnyxStreamId) msg.stream_id = telnyxStreamId;
          telnyxWs.send(JSON.stringify(msg));
        } catch (err) {
          console.error('AI sender error:', err);
        }
      }, 20); // 20ms pacing
    }

    // Ensure a call log document exists with required fields
    async function ensureCallLogDefaults() {
      const now = new Date();
      await CallLogEntry.findOneAndUpdate(
        { call_id: roomName },
        {
          $setOnInsert: {
            call_id: roomName,
            customer_id: 'unknown',
            campaign_id: 'unknown',
            start_time: now,
            end_time: now,
            language_detected: 'und',
            call_status: 'no_answer',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    try {
      // Fetch customer record based on roomName (assuming it maps to a call_id/phone_number)
      const callLog = await CallLogEntry.findOne({ call_id: roomName });
      if (callLog && callLog.customer_id) {
        customerRecord = await CustomerRecord.findOne({ customer_id: callLog.customer_id });
        console.log('Fetched Customer Record:', customerRecord ? customerRecord.name : 'Not found');
      } else if (callLog && callLog.phone_number) {
        customerRecord = await CustomerRecord.findOne({ phone_number: callLog.phone_number });
        console.log('Fetched Customer Record:', customerRecord ? customerRecord.name : 'Not found');
      }

      // 1. Join LiveKit room with Telnyx participant
      const telnyxParticipantIdentity = `telnyx-bot-${roomName}`;
      const telnyxParticipantAccessToken = new AccessToken(apiKey, apiSecret, {
        identity: telnyxParticipantIdentity,
      });
      telnyxParticipantAccessToken.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      const telnyxParticipantToken = telnyxParticipantAccessToken.toJwt();

      // This part is tricky: LiveKit SDK is for server-side room management, not joining as a client.
      // To join as a client, we'd typically use livekit-client SDK in a browser or a separate process.
      // For a server-side bot, we'd use livekit-server-sdk to manage tracks.
      // For now, we'll just ensure the room exists and log.
      // Actual publishing will require a LiveKit client.
      try {
        livekitRoom = await roomService.getRoom(roomName);
        console.log(`LiveKit room ${roomName} exists.`);
      } catch (e) {
        console.log(`LiveKit room ${roomName} does not exist, creating...`);
        livekitRoom = await roomService.createRoom({ name: roomName });
        console.log(`LiveKit room ${roomName} created.`);
      }

      // Bridge-bot publisher joins LiveKit room & publishes tracks (callee/agent)
      try {
        const bridgeIdentity = `bridge-bot-${roomName}`;
        const bridgeTokenAt = new AccessToken(apiKey, apiSecret, { identity: bridgeIdentity });
        bridgeTokenAt.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: false });
        const bridgeToken = bridgeTokenAt.toJwt();
        livekitPublisher = await createPublisher({ host: livekitHost, token: bridgeToken, roomName });
        if (!livekitPublisher) {
          console.warn('LiveKit publisher not available. Proceeding without LiveKit audio publish.');
        }
      } catch (e) {
        console.error('Failed to start LiveKit publisher:', e);
      }


      // 2. Create OpenAI Session and connect WebSocket
      const session = await createOpenAISession(customerRecord);
      const OPENAI_REALTIME_API_URL = session.websocket_url;

      openaiWs = new WebSocket(OPENAI_REALTIME_API_URL, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });

      openaiWs.on('open', () => {
        console.log('Connected to OpenAI Realtime API');
        // Optionally prime a response with chosen voice
        const { voice } = agentSettings.getSettings();
        openaiWs.send(
          JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'], voice: voice || undefined } })
        );
      });

      openaiWs.on('message', async (data) => {
        try {
          const str = typeof data === 'string' ? data : data.toString('utf8');
          const openaiResponse = JSON.parse(str);
          console.log('Received from OpenAI:', openaiResponse);

          // Text streaming per Realtime events
          if (openaiResponse.type === 'response.output_text.delta' && openaiResponse.delta) {
            const textContent = openaiResponse.delta;
            console.log('OpenAI Text Output:', textContent);

            currentTranscription += textContent + ' '; // Append to transcription

            await ensureCallLogDefaults();
            // Update CallLogEntry with transcription
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              { transcription: currentTranscription },
              { new: true, runValidators: true }
            );

            // TODO: Language Detection and Switching
            const detectedLanguage = 'en'; // Placeholder: Replace with actual detected language
            console.log('Conceptual: Detected Language:', detectedLanguage);

            // Store detected language in CallLogEntry
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              { language_detected: detectedLanguage },
              { new: true, runValidators: true }
            );

            // TODO: Perform sentiment analysis on textContent
            const sentiment = {
              timestamp: new Date(),
              sentiment: 'neutral', // Placeholder
              score: 0.5, // Placeholder
            };
            console.log('Sentiment Analysis Result:', sentiment);

            // Store sentiment in CallLogEntry
            // This assumes a CallLogEntry already exists for this roomName/call_id
            // In a real scenario, the CallLogEntry would be created when the call starts
            // and updated throughout the call.
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName }, // Use roomName as call_id
              { $push: { sentiment_scores: sentiment } },
              { new: true, runValidators: true }
            );
          }

          // Audio streaming deltas (OpenAI -> Telnyx + LiveKit agent track)
          if (openaiResponse.type === 'response.output_audio.delta' && openaiResponse.delta) {
            const audioBase64 = openaiResponse.delta;
            appendAiPcmuFromOpenAIBase64(audioBase64);
            try {
              if (livekitPublisher) {
                const pcm24k = Buffer.from(audioBase64, 'base64');
                livekitPublisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
              }
            } catch (e) {
              console.error('Error feeding agent audio to LiveKit:', e);
            }
          }

        } catch (error) {
          console.error('Error processing OpenAI message:', error);
        }
      });

      openaiWs.on('close', () => {
        console.log('Disconnected from OpenAI Realtime API');
      });

      openaiWs.on('error', (error) => {
        console.error('OpenAI WebSocket error:', error);
      });

    } catch (error) {
      console.error('Failed to establish LiveKit/OpenAI connection:', error);
      telnyxWs.close(); // Close Telnyx connection if OpenAI fails
      return;
    }

    telnyxWs.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.event === 'start') {
          console.log('Telnyx stream started:', data);
          // Prepare streaming WAV file (G.711 u-law @ 8kHz)
          const recordingsDir = path.resolve(__dirname, '../../recordings');
          if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);
          const audioFileName = `${roomName}.wav`;
          audioFilePath = path.resolve(recordingsDir, audioFileName);
          audioWriteStream = fs.createWriteStream(audioFilePath);
          telnyxStreamId = data.stream_id || data.streamId || (data.start && data.start.stream_id) || null;

          // Placeholder WAV header (44 bytes), patched on finalize
          const sampleRate = 8000;
          const numChannels = 1;
          const bitsPerSample = 8; // u-law 8-bit
          const wavHeader = Buffer.alloc(44);
          wavHeader.write('RIFF', 0);
          wavHeader.writeUInt32LE(0, 4);
          wavHeader.write('WAVE', 8);
          wavHeader.write('fmt ', 12);
          wavHeader.writeUInt32LE(16, 16);
          wavHeader.writeUInt16LE(7, 20);
          wavHeader.writeUInt16LE(numChannels, 22);
          wavHeader.writeUInt32LE(sampleRate, 24);
          const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
          const blockAlign = numChannels * (bitsPerSample / 8);
          wavHeader.writeUInt32LE(byteRate, 28);
          wavHeader.writeUInt16LE(blockAlign, 32);
          wavHeader.writeUInt16LE(bitsPerSample, 34);
          wavHeader.write('data', 36);
          wavHeader.writeUInt32LE(0, 40);
          audioWriteStream.write(wavHeader);
          bytesWritten = 44;
          await ensureCallLogDefaults();
        } else if (data.event === 'media') {
          const audioBase64 = data.media.payload;
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          if (audioWriteStream) {
            audioWriteStream.write(audioBuffer);
            bytesWritten += audioBuffer.length;
          }

          // Transcode Telnyx PCMU 8kHz to OpenAI PCM16 24kHz mono and send to Realtime API
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const pcm8k = decodePCMUtoPCM16(audioBuffer);
            const pcm24k = upsampleTo24kHz(pcm8k);
            const pcmBuf = int16ToLEBuffer(pcm24k);
            const b64 = pcmBuf.toString('base64');
            // Append chunk to input buffer
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
          }

          // Also feed callee audio to LiveKit publisher
          if (livekitPublisher) {
            try {
              const pcm8k = decodePCMUtoPCM16(audioBuffer);
              livekitPublisher.pushCalleeFrom8kPcm16(pcm8k);
            } catch (e) {
              console.error('Error feeding callee audio to LiveKit:', e);
            }
          }

          // TODO: Publish audio to LiveKit room via telnyxParticipant
          // This would involve using LiveKit client SDK or a server-side bot framework
        } else if (data.event === 'stop') {
          console.log('Telnyx stream stopped:', data);
          // Stop AI sender
          if (aiSendTimer) {
            clearInterval(aiSendTimer);
            aiSendTimer = null;
          }
          if (openaiWs) {
            try {
              // Commit input and request response
              openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
            } catch (e) {
              console.error('Error finalizing OpenAI input buffer:', e);
            }
            openaiWs.close();
          }
          if (livekitPublisher) {
            try { await livekitPublisher.close(); } catch (_) {}
          }
          // Finalize WAV header and update DB
          try {
            if (audioWriteStream) {
              await new Promise((resolve) => audioWriteStream.end(resolve));
              const dataSize = Math.max(0, bytesWritten - 44);
              const fileSize = dataSize + 36;
              const fd = fs.openSync(audioFilePath, 'r+');
              const buf4 = Buffer.alloc(4);
              buf4.writeUInt32LE(fileSize, 0);
              fs.writeSync(fd, buf4, 0, 4, 4);
              buf4.writeUInt32LE(dataSize, 0);
              fs.writeSync(fd, buf4, 0, 4, 40);
              fs.closeSync(fd);

              const audioRecordingUrl = `/recordings/${path.basename(audioFilePath)}`;
              await ensureCallLogDefaults();
              await CallLogEntry.findOneAndUpdate(
                { call_id: roomName },
                { audio_recording_url: audioRecordingUrl },
                { new: true, runValidators: true }
              );
            }
          } catch (e) {
            console.error('Error finalizing WAV recording:', e);
          }
          // TODO: Disconnect telnyxParticipant from LiveKit
        }
      } catch (error) {
        console.error('Error parsing Telnyx WebSocket message:', error);
      }
    });

    telnyxWs.on('close', async () => { // Make async for DB operations
      console.log('Telnyx WebSocket client disconnected');
      if (openaiWs) {
        openaiWs.close();
      }
      if (aiSendTimer) {
        clearInterval(aiSendTimer);
        aiSendTimer = null;
      }
      if (livekitPublisher) {
        try { await livekitPublisher.close(); } catch (_) {}
      }

      // Try to finalize header sizes if a file exists
      try {
        if (audioFilePath && fs.existsSync(audioFilePath)) {
          const stat = fs.statSync(audioFilePath);
          if (stat.size >= 44) {
            const dataSize = stat.size - 44;
            const fileSize = dataSize + 36;
            const fd = fs.openSync(audioFilePath, 'r+');
            const buf4 = Buffer.alloc(4);
            buf4.writeUInt32LE(fileSize, 0);
            fs.writeSync(fd, buf4, 0, 4, 4);
            buf4.writeUInt32LE(dataSize, 0);
            fs.writeSync(fd, buf4, 0, 4, 40);
            fs.closeSync(fd);
          }
        }
      } catch (e) {
        console.error('Error finalizing WAV on close:', e);
      }
      // TODO: Disconnect telnyxParticipant from LiveKit
    });

    telnyxWs.on('error', (error) => {
      console.error('Telnyx WebSocket error:', error);
      if (openaiWs) {
        openaiWs.close();
      }
      // TODO: Disconnect telnyxParticipant from LiveKit
    });
  });

  return wss;
}

module.exports = { createWebSocketServer };
