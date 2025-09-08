const WebSocket = require('ws');
const OpenAI = require('openai');
// use global fetch (Node >= 18)
const url = require('url'); // Import url module
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk'); // Import LiveKit SDK
const { createPublisher, toWsUrl } = require('../livekit/publisher');
const CallLogEntry = require('../models/CallLogEntry'); // Import CallLogEntry model
const CustomerRecord = require('../models/CustomerRecord'); // Import CustomerRecord model
const CallCostTracking = require('../models/CallCostTracking'); // Import CallCostTracking model
const costCalculationService = require('../services/costCalculationService');
// const onedriveService = require('../services/onedriveService'); // Temporarily disabled due to dependency issues
const fs = require('fs'); // Import file system module
const path = require('path'); // Import path module

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_REALTIME_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

// LiveKit configuration
function toHttpUrl(u) {
  if (!u) return '';
  if (u.startsWith('https://') || u.startsWith('http://')) return u;
  if (u.startsWith('wss://')) return 'https://' + u.slice(6);
  if (u.startsWith('ws://')) return 'http://' + u.slice(5);
  return u;
}
const livekitHost = toHttpUrl(process.env.LIVEKIT_API_URL || process.env.LIVEKIT_SERVER_URL);
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
    // Load saved agent settings (await the async accessor)
    const saved = await agentSettings.getSettings();
    let instructions = saved?.instructions || '';
    let voice = saved?.voice || undefined;
    if (customerRecord) {
      instructions += ` The customer's name is ${customerRecord.name}. Their preferred language is ${customerRecord.preferred_language || 'English'}. Their historical offers include: ${customerRecord.historical_offers.join(', ')}.`;
    }
    // Small debug preview
    try {
      const preview = (instructions || '').slice(0, 160).replace(/\s+/g, ' ');
      console.log('Agent-WS settings -> voice:', voice || '(default)', '| instructions:', preview || '(default)');
    } catch (_) {}

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const response = await fetch(OPENAI_REALTIME_SESSIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        modalities: ['audio', 'text'],
        instructions,
        voice,
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

  // Helper to convert 24kHz PCM to 8kHz u-law for recording browser audio
  function pcm24kToUlaw8k(pcm24kLeBuf) {
    const pcm16kArr = new Int16Array(pcm24kLeBuf.buffer, pcm24kLeBuf.byteOffset, pcm24kLeBuf.length / 2);
    const pcm8k = new Int16Array(Math.floor(pcm16kArr.length / 3));
    for (let i = 0, j = 0; j < pcm8k.length; i += 3, j++) {
      pcm8k[j] = pcm16kArr[i];
    }
    const ulaw = Buffer.alloc(pcm8k.length);
    for (let i = 0; i < pcm8k.length; i++) {
      ulaw[i] = linearToUlaw(pcm8k[i]);
    }
    return ulaw;
  }

  wss.on('connection', async (telnyxWs, req) => { // Add req parameter
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '';
    // Browser mic bridge: /agent-stream?room=<roomName>
    if (pathname === '/agent-stream') {
      try {
        const query = parsedUrl.query || {};
        const roomName = String(query.room || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!roomName) { telnyxWs.close(); return; }
        try { require('../util/roomsStore').touch(roomName); } catch(_) {}
        const primeText = typeof query.text === 'string' ? String(query.text) : '';

        const { AccessToken } = require('livekit-server-sdk');
        const { createPublisher } = require('../livekit/publisher');
        // Load saved settings for this bridge session
        let settings = await agentSettings.getSettings();
        console.log('Base settings loaded:', { hasInstructions: !!settings.instructions, voice: settings.voice });
        try {
          if (query.profile) {
            console.log('Loading profile:', String(query.profile));
            const AgentProfile = require('../models/AgentProfile');
            const p = await AgentProfile.findById(String(query.profile)).lean();
            if (p) {
              console.log('Profile loaded:', { name: p.name, hasInstructions: !!p.instructions, voice: p.voice });
              settings = { instructions: p.instructions || settings.instructions, voice: p.voice || settings.voice };
            } else {
              console.log('Profile not found');
            }
          } else {
            console.log('No profile parameter provided');
          }
        } catch (e) {
          console.error('Error loading profile:', e);
        }
        console.log('Final settings:', { hasInstructions: !!settings.instructions, instructionsLength: settings.instructions?.length, voice: settings.voice });

        // Initialize cost tracking for this session
        let sessionStartTime = new Date();
        let sessionAudioInputMinutes = 0;
        let sessionAudioOutputMinutes = 0;

        // --- Recording state for browser calls ---
        let audioFilePath = null;
        let audioWriteStream = null;
        let bytesWritten = 0;
        let currentTranscription = ''; // To accumulate transcription

        // Prepare streaming WAV file (G.711 u-law @ 8kHz)
        const recordingsDir = path.resolve(__dirname, '../../recordings');
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
        const audioFileName = `${roomName}-${Date.now()}.wav`;
        audioFilePath = path.resolve(recordingsDir, audioFileName);
        audioWriteStream = fs.createWriteStream(audioFilePath);

        // Placeholder WAV header (44 bytes), patched on finalize
        const sampleRate = 8000;
        const numChannels = 1;
        const bitsPerSample = 8; // u-law 8-bit
        const wavHeader = Buffer.alloc(44);
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(0, 4); // Placeholder for file size
        wavHeader.write('WAVE', 8);
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16); // PCM format
        wavHeader.writeUInt16LE(7, 20); // u-law format
        wavHeader.writeUInt16LE(numChannels, 22);
        wavHeader.writeUInt32LE(sampleRate, 24);
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        wavHeader.writeUInt32LE(byteRate, 28);
        wavHeader.writeUInt16LE(blockAlign, 32);
        wavHeader.writeUInt16LE(bitsPerSample, 34);
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(0, 40); // Placeholder for data size
        audioWriteStream.write(wavHeader);
        bytesWritten = 44;

        // Create a CallLogEntry for the browser session
        await CallLogEntry.findOneAndUpdate(
          { call_id: roomName },
          {
            $setOnInsert: {
              call_id: roomName,
              customer_id: 'agent_studio_user',
              campaign_id: 'agent_studio',
              start_time: sessionStartTime,
              call_status: 'in-progress',
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        // --- End Recording state ---

        const identity = `browser-bridge-${roomName}-${Date.now()}`;
        let publisher = null;
        if (process.env.AGENTSTREAM_PUBLISH_LIVEKIT === '1') {
          try {
            const at = new AccessToken(apiKey, apiSecret, { identity });
            at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: false });
            const token = await at.toJwt();
            publisher = await createPublisher({ host: livekitHost, token, roomName });
          } catch (e) {
            console.error('LiveKit publisher error (continuing without LiveKit):', e?.message || e);
          }
        }

        // OpenAI Realtime WS
        const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
        const OA_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
        const oaWs = new WebSocket(OA_URL, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
        });
        let currentResponseId = null;
        let agentSpeaking = false;
        let agentSpeakingSent = false;
        // Simple server-side VAD for barge-in (raised thresholds to reduce false triggers)
        let userSpeaking = false;
        let aboveCnt = 0;
        let belowCnt = 0;
        const speakTh = Number(process.env.SERVER_VAD_SPEAK_TH || '0.020');
        const silentTh = Number(process.env.SERVER_VAD_SILENT_TH || '0.006');
        const onsetNeededBase = Number(process.env.SERVER_VAD_ONSET_FRAMES || '4');
        const onsetNeededWhileAgent = Number(process.env.SERVER_VAD_ONSET_FRAMES_AGENT || '8');
        oaWs.on('open', () => {
          try {
            // Apply saved settings as-is
            const tdThresh = Number(process.env.TURN_DETECTION_THRESHOLD || '0.60');
            const tdPrefix = Number(process.env.TURN_DETECTION_PREFIX_MS || '180');
            const tdSilence = Number(process.env.TURN_DETECTION_SILENCE_MS || '250');
            const sessionData = {
              type: 'session.update',
              session: {
                instructions: settings.instructions || '',
                voice: settings.voice || undefined,
                input_audio_format: 'pcm16',
                turn_detection: { type: 'server_vad', threshold: tdThresh, prefix_padding_ms: tdPrefix, silence_duration_ms: tdSilence }
              }
            };
            console.log('Sending session.update with instructions length:', sessionData.session.instructions.length);
            oaWs.send(JSON.stringify(sessionData));
            // If a prime text was provided, send as an initial user message and request a response
            if (primeText && primeText.trim().length > 0) {
              const preview = primeText.slice(0, 160).replace(/\s+/g, ' ');
              console.log('Agent-WS prime text ->', preview);
              oaWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: primeText }],
                },
              }));
              oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'], voice: settings.voice || undefined } }));
            }
          } catch (_) {}
        });
        let notified = false;
        oaWs.on('message', (data) => {
          try {
            const s = typeof data === 'string' ? data : data.toString('utf8');
            const m = JSON.parse(s);
            console.log('OpenAI message type:', m.type);
            if (m.type === 'session.updated') {
              console.log('OpenAI session.updated:', JSON.stringify(m, null, 2));
            }
            if (m.type === 'error') {
              console.error('OpenAI ERROR:', JSON.stringify(m, null, 2));
            }
            if (m.type === 'response.created' && m.response) {
              currentResponseId = m.response.id || null;
              try { publisher.muteAgent(false); } catch(_) {}
            }
            if ((m.type === 'response.audio_transcript.delta' || m.type === 'response.output_text.delta') && m.delta) {
              currentTranscription += m.delta; // Accumulate transcription
              try { telnyxWs.send(JSON.stringify({ type: 'transcript_delta', text: m.delta })); } catch(_) {}
            }
            if ((m.type === 'response.audio.delta' || m.type === 'response.output_audio.delta') && m.delta) {
              agentSpeaking = true;
              if (!agentSpeakingSent) {
                agentSpeakingSent = true;
                try { telnyxWs.send(JSON.stringify({ type: 'agent_speaking', speaking: true })); } catch(_) {}
              }
              const pcm24k = Buffer.from(m.delta, 'base64');
              if (publisher) publisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
              try { telnyxWs.send(JSON.stringify({ type: 'agent_audio_24k', audio: m.delta })); } catch(_) {}
              if (!notified) {
                notified = true;
                try { telnyxWs.send(JSON.stringify({ type: 'first_audio_delta' })); } catch(_) {}
              }
            }
            if (m.type === 'response.done') {
              agentSpeaking = false;
              agentSpeakingSent = false;
              try { telnyxWs.send(JSON.stringify({ type: 'agent_speaking', speaking: false })); } catch(_) {}
              try { publisher && publisher.muteAgent(false); } catch(_) {}
            }
          } catch (_) {}
        });
        const closeAll = async () => { 
          try { oaWs.close(); } catch(_) {};
          try { publisher && await publisher.close(); } catch(_) {};
          
          // --- Finalize browser call recording ---
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
              console.log(`Browser recording saved locally: ${audioFilePath}`);

              const audioRecordingUrl = `/recordings/${path.basename(audioFilePath)}`;
              const callEndTime = new Date();
              
              // Update CallLogEntry with final details
              await CallLogEntry.findOneAndUpdate(
                { call_id: roomName },
                { 
                  audio_recording_url: audioRecordingUrl,
                  end_time: callEndTime,
                  call_status: 'success', // Or determine based on events
                  transcription: currentTranscription,
                },
                { new: true, runValidators: true }
              );
            }
          } catch (e) {
            console.error('Error finalizing browser WAV recording:', e);
          }
          // --- End finalization ---

          // Calculate session duration and costs when closing
          try {
            const sessionEndTime = new Date();
            const durationMinutes = (sessionEndTime - sessionStartTime) / (1000 * 60);
            
            // Create cost tracking record for agent studio session
            await costCalculationService.updateCallCosts(roomName, 'agent_studio', {
              llm: {
                audio_input_minutes: sessionAudioInputMinutes,
                audio_output_minutes: sessionAudioOutputMinutes,
                input_tokens: 0, // Text tokens would be tracked separately
                output_tokens: 0
              },
              transcription: {
                full_text: currentTranscription,
                language_detected: 'auto',
                confidence_score: 1.0
              }
            });
            
            console.log(`Agent studio session ${roomName} ended. Duration: ${durationMinutes.toFixed(2)} min`);
          } catch (error) {
            console.error('Error saving cost tracking for agent session:', error);
          }
        };
        telnyxWs.on('message', (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === 'audio' && m.audio && oaWs.readyState === WebSocket.OPEN) {
              const pcm24kBuffer = Buffer.from(m.audio, 'base64');

              // --- Write to recording file ---
              if (audioWriteStream) {
                const ulaw8kBuffer = pcm24kToUlaw8k(pcm24kBuffer);
                audioWriteStream.write(ulaw8kBuffer);
                bytesWritten += ulaw8kBuffer.length;
              }
              // --- End write ---

              // Server VAD onset for barge-in
              try {
                let sum = 0; let n = 0;
                for (let i = 0; i + 1 < pcm24kBuffer.length; i += 2) {
                  let v = pcm24kBuffer.readInt16LE(i);
                  sum += (v * v);
                  n++;
                }
                const rms = n ? Math.sqrt(sum / n) / 32768 : 0;
                if (rms > speakTh) { aboveCnt++; belowCnt = 0; } else if (rms < silentTh) { belowCnt++; aboveCnt = 0; } else { aboveCnt = 0; }
                const need = agentSpeaking ? onsetNeededWhileAgent : onsetNeededBase;
                if (!userSpeaking && aboveCnt >= need) {
                  userSpeaking = true; aboveCnt = 0;
                  // Cancel current agent response and flush playback
                  try { if (currentResponseId) { oaWs.send(JSON.stringify({ type: 'response.cancel', response: { id: currentResponseId }, response_id: currentResponseId })); } else { oaWs.send(JSON.stringify({ type: 'response.cancel' })); } } catch(_) {}
                  try { telnyxWs.send(JSON.stringify({ type: 'barge_in' })); } catch(_) {}
                  agentSpeaking = false; agentSpeakingSent = false;
                }
                if (userSpeaking && belowCnt >= 12) { userSpeaking = false; belowCnt = 0; }
              } catch(_) {}
              oaWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.audio }));
            } else if (m.type === 'commit' && oaWs.readyState === WebSocket.OPEN) {
              oaWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio'] } }));
            }
            // client VAD messages removed when using server_vad
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
    
    // Cost tracking variables
    let callStartTime = new Date();
    let audioInputMinutes = 0;
    let audioOutputMinutes = 0;
    let inputTokenCount = 0;
    let outputTokenCount = 0;
    
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
        // Prime a response with chosen voice from saved settings
        try {
          openaiWs.send(
            JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'], voice: settings?.voice || undefined } })
          );
        } catch (_) {}
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
              
              // Calculate costs (skip OneDrive upload)
              let onedriveUrl = ''; // Will be empty for now
              let costTrackingId = '';
              try {
                console.log(`Recording saved locally: ${audioFilePath}`);
                
                // Calculate call duration and costs
                const callEndTime = new Date();
                const durationMinutes = (callEndTime - callStartTime) / (1000 * 60);
                
                // Create comprehensive cost tracking
                const costTracking = await costCalculationService.updateCallCosts(roomName, 'pstn', {
                  llm: {
                    audio_input_minutes: audioInputMinutes,
                    audio_output_minutes: audioOutputMinutes,
                    input_tokens: inputTokenCount,
                    output_tokens: outputTokenCount
                  },
                  pstn: {
                    duration_minutes: durationMinutes
                  },
                  recording: {
                    local_path: audioFilePath,
                    onedrive_url: '', // Skip OneDrive for now
                    onedrive_file_id: '',
                    upload_status: 'local_only'
                  },
                  transcription: {
                    full_text: currentTranscription,
                    language_detected: 'auto',
                    confidence_score: 0.95
                  }
                });
                
                costTrackingId = costTracking.call_id;
                console.log(`Call costs calculated: $${costTracking.total_cost_usd.toFixed(4)}`);
              } catch (costError) {
                console.error('Cost calculation failed:', costError);
                // Still update CallLogEntry with basic info
                try {
                  const callEndTime = new Date();
                  const durationMinutes = (callEndTime - callStartTime) / (1000 * 60);
                  
                  const costTracking = await costCalculationService.updateCallCosts(roomName, 'pstn', {
                    llm: {
                      audio_input_minutes: audioInputMinutes,
                      audio_output_minutes: audioOutputMinutes,
                      input_tokens: inputTokenCount,
                      output_tokens: outputTokenCount
                    },
                    pstn: {
                      duration_minutes: durationMinutes
                    },
                    recording: {
                      local_path: audioFilePath,
                      upload_status: 'local_only'
                    },
                    transcription: {
                      full_text: currentTranscription,
                      language_detected: 'auto',
                      confidence_score: 0.95
                    }
                  });
                  
                  costTrackingId = costTracking.call_id;
                } catch (costError) {
                  console.error('Cost calculation failed:', costError);
                }
              }
              
              // Update CallLogEntry with enhanced information
              await CallLogEntry.findOneAndUpdate(
                { call_id: roomName },
                { 
                  audio_recording_url: audioRecordingUrl,
                  onedrive_recording_url: onedriveUrl,
                  cost_tracking_id: costTrackingId,
                  transcription_summary: currentTranscription.slice(0, 500) // First 500 chars as summary
                },
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
