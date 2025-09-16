const WebSocket = require('ws');
const OpenAI = require('openai');
// use global fetch (Node >= 18)
const url = require('url'); // Import url module
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk'); // Import LiveKit SDK
const { startRoomAudioEgress, stopEgress } = require('../livekit/egress');
const { createPublisher, toWsUrl } = require('../livekit/publisher');
const CallLogEntry = require('../models/CallLogEntry'); // Import CallLogEntry model
const CustomerRecord = require('../models/CustomerRecord'); // Import CustomerRecord model
const CallCostTracking = require('../models/CallCostTracking'); // Import CallCostTracking model
const { getToolsSpec, callTool } = require('../services/mcpTools');
const { resolveAgentAndMcp } = require('../util/orchestrator');
const CampaignDefinition = require('../models/CampaignDefinition');
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

// --- Simple server-side PCM16 mono mixer (24kHz) ---
class Pcm16MonoMixer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.agentQ = Buffer.alloc(0);   // 16-bit LE @ sampleRate
    this.calleeQ = Buffer.alloc(0);  // 16-bit LE @ sampleRate
    this.fd = null;
    this.bytesWritten = 0;
  }
  start(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.fd = fs.openSync(filePath, 'w');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(0, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(this.sampleRate, 24);
    const byteRate = this.sampleRate * 2;
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(0, 40);
    fs.writeSync(this.fd, header);
    this.bytesWritten = 44;
  }
  appendAgent(buf24kLe) { if (buf24kLe?.length) { this.agentQ = Buffer.concat([this.agentQ, buf24kLe]); this._drain(); } }
  appendCallee(buf24kLe) { if (buf24kLe?.length) { this.calleeQ = Buffer.concat([this.calleeQ, buf24kLe]); this._drain(); } }
  _drain() {
    if (!this.fd) return;
    const CHUNK_SAMPLES = 2400; // 100ms @24k
    const CHUNK_BYTES = CHUNK_SAMPLES * 2;
    while (this.agentQ.length >= CHUNK_BYTES || this.calleeQ.length >= CHUNK_BYTES) {
      const a = this.agentQ.length >= CHUNK_BYTES ? this.agentQ.subarray(0, CHUNK_BYTES) : null;
      const c = this.calleeQ.length >= CHUNK_BYTES ? this.calleeQ.subarray(0, CHUNK_BYTES) : null;
      if (!a && !c) break;
      let out;
      if (a && c) {
        out = Buffer.alloc(CHUNK_BYTES);
        for (let i = 0; i < CHUNK_BYTES; i += 2) {
          const va = a.readInt16LE(i);
          const vc = c.readInt16LE(i);
          // -6 dB per source to avoid clipping then sum
          let s = (va >> 1) + (vc >> 1);
          if (s > 32767) s = 32767; if (s < -32768) s = -32768;
          out.writeInt16LE(s, i);
        }
        this.agentQ = this.agentQ.subarray(CHUNK_BYTES);
        this.calleeQ = this.calleeQ.subarray(CHUNK_BYTES);
      } else if (a) { out = a; this.agentQ = this.agentQ.subarray(CHUNK_BYTES); }
      else { out = c; this.calleeQ = this.calleeQ.subarray(CHUNK_BYTES); }
      fs.writeSync(this.fd, out);
      this.bytesWritten += out.length;
    }
  }
  async finalize() {
    if (!this.fd) return;
    this._drain();
    const fd = this.fd; this.fd = null;
    const dataSize = Math.max(0, this.bytesWritten - 44);
    const fileSize = dataSize + 36;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(fileSize, 0); fs.writeSync(fd, buf, 0, 4, 4);
    buf.writeUInt32LE(dataSize, 0); fs.writeSync(fd, buf, 0, 4, 40);
    fs.closeSync(fd);
  }
}

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
  // Linear interpolation upsample x3 for smoother audio
  const n = pcm8k.length;
  const out = new Int16Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v0 = pcm8k[i];
    const v1 = i + 1 < n ? pcm8k[i + 1] : v0;
    const j = i * 3;
    out[j] = v0;
    // Insert two interpolated samples between v0 and v1
    out[j + 1] = ((2 * v0 + v1) / 3) | 0;
    out[j + 2] = ((v0 + 2 * v1) / 3) | 0;
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
  const sessionRegistry = require('../util/sessionRegistry');

  // --- Start Shared Audio Helpers ---
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

  // Helper to convert 24kHz PCM to 8kHz u-law for recording browser audio
  function pcm24kToUlaw8k(pcm24kLeBuf) {
    const pcm16kArr = new Int16Array(pcm24kLeBuf.buffer, pcm24kLeBuf.byteOffset, pcm24kLeBuf.length / 2);
    if (pcm16kArr.length < 3) {
      return Buffer.alloc(0); // Not enough data to downsample
    }
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
  // --- End Shared Audio Helpers ---

  wss.on('connection', async (telnyxWs, req) => { // Add req parameter
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '';
    // Operator bridge: stream browser mic to PSTN for takeover
    if (pathname === '/operator-bridge') {
      try {
        const query = parsedUrl.query || {};
        const roomName = String(query.room || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!roomName) { telnyxWs.close(); return; }
        // Mute agent while operator is speaking
        try { sessionRegistry.setAgentMute(roomName, true); } catch(_) {}
        telnyxWs.on('message', (data) => {
          try {
            const m = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
            if (m.type === 'audio' && m.audio) {
              const buf = Buffer.from(m.audio, 'base64');
              const outLen = Math.floor(buf.length / 6);
              const pcm8k = new Int16Array(outLen);
              for (let i = 0, j = 0; j < outLen; i += 6, j++) pcm8k[j] = buf.readInt16LE(i);
              const s = sessionRegistry.get(roomName);
              // 1) Publish to LiveKit so browser listeners (monitor) can hear operator
              if (s && s.livekitPublisher && typeof s.livekitPublisher.pushCalleeFrom8kPcm16 === 'function') {
                try { s.livekitPublisher.pushCalleeFrom8kPcm16(pcm8k); } catch(e) { console.error('operator-bridge livekit push error:', e); }
              }
              // 2) Always send to PSTN so the person on the phone hears operator
              const mu = Buffer.alloc(pcm8k.length);
              for (let i = 0; i < pcm8k.length; i++) mu[i] = linearToUlaw(pcm8k[i]);
              sessionRegistry.sendPcmuToPstn(roomName, mu);
            }
          } catch (e) { console.error('operator-bridge error', e); }
        });
        const unmute = () => { try { sessionRegistry.setAgentMute(roomName, false); } catch(_) {} };
        telnyxWs.on('close', unmute); telnyxWs.on('error', unmute);
      } catch (e) { try { telnyxWs.close(); } catch(_) {} }
      return;
    }
    // Browser mic bridge: /agent-stream?room=<roomName>
    if (pathname === '/agent-stream') {
      try {
        const query = parsedUrl.query || {};
        const roomName = String(query.room || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!roomName) { telnyxWs.close(); return; }
        try { require('../util/roomsStore').touch(roomName); } catch(e) { console.error('Error touching room store:', e); }
        try { sessionRegistry.set(roomName, {}); } catch(_) {}
        const primeText = typeof query.text === 'string' ? String(query.text) : '';

        const { AccessToken } = require('livekit-server-sdk');
        const { createPublisher } = require('../livekit/publisher');
        // Load saved settings for this bridge session
        let settings = await agentSettings.getSettings();
        let campaignDoc = null;
        console.log('Base settings loaded:', { hasInstructions: !!settings.instructions, voice: settings.voice });
        try {
          if (query.profile) {
            console.log('Loading profile:', String(query.profile));
            const AgentProfile = require('../models/AgentProfile');
            const p = await AgentProfile.findById(String(query.profile)).lean();
            if (p) {
              console.log('Profile loaded:', { name: p.name, hasInstructions: !!p.instructions, voice: p.voice });
              settings = { instructions: p.instructions || settings.instructions, voice: p.voice || settings.voice, language: p.language || settings.language };
            } else {
              console.log('Profile not found');
            }
          } else {
            console.log('No profile parameter provided');
            // Try campaign/language-based routing if hints are provided
            try {
              const campaign = String(query.campaign || query.campaign_id || query.id || '');
              const langHint = String(query.lang || query.language || '').toLowerCase();
              if (campaign || langHint) {
                if (campaign) { try { campaignDoc = await CampaignDefinition.findOne({ $or: [{ _id: campaign }, { campaign_id: campaign }, { name: campaign }, { title: campaign }] }).lean(); } catch(_) {} }
                const out = await resolveAgentAndMcp({ campaignId: campaign, detectedLanguage: langHint });
                if (out?.agent) {
                  console.log('Resolved Studio agent via orchestrator:', { name: out.agent.name, lang: out.agent.language });
                  settings = {
                    instructions: out.agent.instructions || settings.instructions,
                    voice: out.agent.voice || settings.voice,
                    language: out.agent.language || settings.language,
                  };
                } else {
                  console.log('Orchestrator resolution returned no agent; keeping defaults');
                }
              }
            } catch (e) {
              console.error('Studio resolver error:', e?.message || e);
            }
          }
        } catch (e) {
          console.error('Error loading profile:', e);
        }
        console.log('Final settings:', { hasInstructions: !!settings.instructions, instructionsLength: settings.instructions?.length, voice: settings.voice });

        // Initialize cost tracking for this session
        let sessionStartTime = new Date();
        let sessionAudioInputMinutes = 0;
        let sessionAudioOutputMinutes = 0;

        // --- Recording via LiveKit Egress for Agent Studio sessions ---
        const uniqueSuffix = Date.now();
        const callId = `${roomName}-${uniqueSuffix}`;
        let egressId = null;
        let currentTranscription = '';

        // Create a CallLogEntry for the browser session (unique call_id)
        await CallLogEntry.findOneAndUpdate(
          { call_id: callId },
          {
            $setOnInsert: {
              call_id: callId,
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
        // Studio local mixer fallback (24kHz PCM16 mono) — independent of LiveKit
        let studioMixer = new Pcm16MonoMixer(24000);
        let studioMixPath = '';
        try {
          const recDir = path.resolve(__dirname, '..', 'recordings', 'studio');
          if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
          studioMixPath = path.join(recDir, `${roomName}-${Date.now()}.wav`);
          studioMixer.start(studioMixPath);
          console.log('Studio mixer started:', studioMixPath);
        } catch (e) { console.error('Studio mixer init failed:', e?.message || e); }
        let livekitRecorder = null; // Studio fallback recorder
        // Ensure room exists for monitor/egress
        try {
          await roomService.getRoom(roomName);
        } catch {
          try { await roomService.createRoom({ name: roomName }); } catch (e) { console.error('createRoom error:', e?.message || e); }
        }
        let publisher = null;
        if (process.env.AGENTSTREAM_PUBLISH_LIVEKIT !== '0') {
          try {
            const at = new AccessToken(apiKey, apiSecret, { identity });
            at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: false });
            const token = await at.toJwt();
            publisher = await createPublisher({ host: livekitHost, token, roomName });
          } catch (e) {
            console.error('LiveKit publisher error (continuing without LiveKit):', e?.message || e);
          }
        }

        // Determine TTS provider (allow runtime override via ?tts=elevenlabs)
        const qsTts = String((parsedUrl.query && parsedUrl.query.tts) || '').toLowerCase();
        const useElevenTts = qsTts === 'elevenlabs' || (String(process.env.TTS_PROVIDER || '').toLowerCase() === 'elevenlabs');
        try { console.log('Studio TTS provider:', useElevenTts ? 'elevenlabs' : 'openai', '| qs=', qsTts||'-', '| env=', (process.env.TTS_PROVIDER||'-')); } catch(_) {}

        // OpenAI Realtime WS
        const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
        const OA_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
        const oaWs = new WebSocket(OA_URL, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
        });
        let currentResponseId = null;
        let agentSpeaking = false;
        let agentSpeakingSent = false;
        let studioSuppressAgentAudio = false; // guard for barge-in
        // Simple server-side VAD for barge-in (raised thresholds to reduce false triggers)
        let userSpeaking = false;
        let aboveCnt = 0;
        let belowCnt = 0;
        const speakTh = Number(process.env.SERVER_VAD_SPEAK_TH || '0.020');
        const silentTh = Number(process.env.SERVER_VAD_SILENT_TH || '0.006');
        const onsetNeededBase = Number(process.env.SERVER_VAD_ONSET_FRAMES || '4');
        const onsetNeededWhileAgent = Number(process.env.SERVER_VAD_ONSET_FRAMES_AGENT || '8');
        // Expose handles to the session registry so control endpoints can stop the agent
        try { sessionRegistry.set(roomName, { openaiWs: oaWs, livekitPublisher: publisher }); } catch(_) {}

        let outBuf = '';
        let ttsInFlight = false;
        let ttsAbort = null;
        let ttsResid = Buffer.alloc(0); // carry to keep PCM16 even-byte alignment
        async function maybeStartTts(force=false) {
          if (!useElevenTts) return;
          const apiKey = process.env.ELEVENLABS_API_KEY || '';
          const voiceId = process.env.ELEVENLABS_VOICE_ID || '';
          if (!apiKey || !voiceId) return;
          if (ttsInFlight) return;
          const text = outBuf.trim();
          if (!text) return;
          if (!force && text.length < 60 && !/[\.!?;:]/.test(text)) return;
          outBuf = '';
          ttsInFlight = true;
          const { streamTextToElevenlabs } = require('../services/ttsElevenlabs');
          const ctrl = new AbortController();
          ttsAbort = ctrl;
          try {
            const dbg = process.env.TTS_DEBUG === '1';
            await streamTextToElevenlabs({
              apiKey,
              voiceId,
              text,
              optimize: Number(process.env.ELEVENLABS_OPTIMIZE || '4') || 4,
              abortSignal: ctrl.signal,
              debug: dbg,
              onChunk: async (pcm24k) => {
                try {
                  // Append to residual to ensure even-length (PCM16 LE)
                  if (pcm24k && pcm24k.length) {
                    ttsResid = Buffer.concat([ttsResid, pcm24k]);
                  }
                  const evenLen = ttsResid.length & ~1; // drop last odd byte if any
                  if (!evenLen) return;
                  const toPush = ttsResid.subarray(0, evenLen);
                  ttsResid = ttsResid.subarray(evenLen);

                  if (!agentSpeakingSent) {
                    agentSpeakingSent = true; agentSpeaking = true;
                    try { telnyxWs.send(JSON.stringify({ type: 'agent_speaking', speaking: true })); } catch(_) {}
                    try { telnyxWs.send(JSON.stringify({ type: 'first_audio_delta' })); } catch(_) {}
                  }
                  if (publisher) {
                    try { publisher.pushAgentFrom24kPcm16LEBuffer(toPush); } catch(e) { console.error('Studio ElevenLabs push error:', e?.message||e); }
                  }
                  try { studioMixer.appendAgent(toPush); } catch(_) {}
                } catch(_) {}
              },
            });
          } catch (e) { console.error('ElevenLabs TTS error:', e?.message || e); }
          finally { ttsInFlight = false; ttsAbort = null; setTimeout(()=>{ try { maybeStartTts(true); } catch(_){} }, 0); }
        }

        oaWs.on('open', async () => {
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
                input_audio_transcription: { model: 'whisper-1', language: settings.language || 'en' },
                turn_detection: { type: 'server_vad', threshold: tdThresh, prefix_padding_ms: tdPrefix, silence_duration_ms: tdSilence },
              }
            };
            try {
              const instrPrev = String(sessionData.session.instructions || '').slice(0, 220).replace(/\s+/g, ' ');
              const langPrev = sessionData.session?.input_audio_transcription?.language || '';
              console.log('Studio session.update -> lang:', langPrev, '| len:', (sessionData.session.instructions||'').length, '| instr:', instrPrev);
            } catch(_) {}
            oaWs.send(JSON.stringify(sessionData));
            // Start LiveKit Egress (audio-only) for this room, fallback to local recorder
            try {
              const eg = await startRoomAudioEgress(roomName);
              egressId = eg?.egressId || eg?.egress_id || null;
              console.log('LiveKit egress started (studio):', egressId || eg);
            } catch (egErr) {
              console.error('Failed to start LiveKit egress (studio):', egErr?.message || egErr);
              try {
                const { createRecorder } = require('../livekit/recorder');
                const at = new AccessToken(apiKey, apiSecret, { identity: `recorder-${roomName}-${Date.now()}` });
                at.addGrant({ room: roomName, roomJoin: true, canPublish: false, canSubscribe: true });
                const token = at.toJwt();
                livekitRecorder = await createRecorder({ host: livekitHost, token, roomName, outFileBase: `${roomName}-${Date.now()}` });
                console.log('Local recorder started (studio):', livekitRecorder?.outPath || '(unknown)');
              } catch (recErr) {
                console.error('Failed to start local recorder (studio):', recErr?.message || recErr);
              }
            }
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
              oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: useElevenTts ? ['text'] : ['audio','text'] } }));
            } else {
              // No prime text: proactively create a first turn with a strict opening directive to avoid small talk
              try {
                const lang = (settings.language || 'fr').toLowerCase();
                const opening = lang.startsWith('fr')
                  ? "Bonjour, je vous appelle d’ACROPAQ au sujet de vos rouleaux thermiques de caisse. Utilisez-vous actuellement des rouleaux thermiques pour vos caisses/imprimantes ?"
                  : (lang.startsWith('nl')
                    ? "Goedemiddag, ik bel u namens ACROPAQ over uw thermische kassarollen. Gebruikt u momenteel thermische rollen voor uw kassa’s/printers?"
                    : "Hello, I’m calling from ACROPAQ about your thermal receipt rolls. Do you currently use thermal rolls for your tills/printers?");
                const guard = (lang.startsWith('fr')
                  ? "Parlez uniquement en français (Belgique). Pas de small talk (« comment ça va » interdit). Posez une seule question à la fois."
                  : lang.startsWith('nl')
                  ? "Spreek alleen Nederlands (België). Geen small talk. Stel één vraag tegelijk."
                  : "Speak only English. No small talk. Ask one question at a time.");
                const directive = `${guard}\n\nOUVERTURE OBLIGATOIRE:\n${opening}`;
                oaWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: directive }],
                  },
                }));
                oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: useElevenTts ? ['text'] : ['audio','text'] } }));
              } catch (e) {
                console.error('Failed to prime first turn:', e?.message || e);
              }
            }
          } catch (e) { console.error('Error on OA open:', e); }
        });
        let notified = false;
        let lastSpeaker = ''; // To track turns for formatting
        let studioAppendedMs = 0; // ms of user audio since last commit
        const STUDIO_FRAME_MS = 21; // ~1024/48k -> 512/24k ≈ 21ms
        const STUDIO_MIN_COMMIT_MS = Number(process.env.MIN_COMMIT_MS || '120');
        const studioToolArgs = new Map();
        let studioRuleLangSwitched = false;
        const studioTagged = new Set();
        function guessLangFromText(txt){
          const s = (txt||'').toLowerCase();
          const frHits = [' le ', ' la ', ' et ', ' je ', ' vous ', ' merci ', 'bonjour','rappeler','facture'];
          const nlHits = [' de ', ' het ', ' en ', ' jij ', ' u ', ' dank u','goeden','factuur'];
          let fr=0, nl=0; for(const w of frHits) if(s.includes(w)) fr++; for(const w of nlHits) if(s.includes(w)) nl++; return fr>nl? 'fr' : (nl>fr? 'nl' : '');
        }
        async function studioApplyRules(){
          try {
            if (!campaignDoc || !campaignDoc.orchestrator) return;
            const orch = campaignDoc.orchestrator || {};
            // Auto language switch
            if (orch.auto_lang_switch && !studioRuleLangSwitched) {
              const g = guessLangFromText(currentTranscription);
              if (g && g !== (settings.language||'').toLowerCase()) {
                const out = await resolveAgentAndMcp({ campaignId: campaignDoc._id || campaignDoc.campaign_id || campaignDoc.name, detectedLanguage: g });
                if (out?.agent) {
                  settings = { instructions: out.agent.instructions || settings.instructions, voice: out.agent.voice || settings.voice, language: out.agent.language || g };
                  const tdThresh = Number(process.env.TURN_DETECTION_THRESHOLD || '0.60');
                  const tdPrefix = Number(process.env.TURN_DETECTION_PREFIX_MS || '180');
                  const tdSilence = Number(process.env.TURN_DETECTION_SILENCE_MS || '250');
                  oaWs.send(JSON.stringify({ type:'session.update', session:{ instructions: settings.instructions, voice: settings.voice, input_audio_transcription: { model: 'whisper-1', language: settings.language }, turn_detection: { type:'server_vad', threshold: tdThresh, prefix_padding_ms: tdPrefix, silence_duration_ms: tdSilence } } }));
                  studioRuleLangSwitched = true;
                }
              }
            }
            // Intent keywords -> tag
            if (Array.isArray(orch.intent_keywords)) {
              for (const r of orch.intent_keywords) {
                const pat = String(r.pattern||'').toLowerCase();
                const tag = String(r.tag||'').trim();
                if (!pat || !tag || studioTagged.has(tag)) continue;
                if ((currentTranscription||'').toLowerCase().includes(pat)) {
                  studioTagged.add(tag);
                  try { await CallLogEntry.findOneAndUpdate({ call_id: callId }, { $addToSet: { intents: tag } }, { upsert: true }); } catch(_) {}
                }
              }
            }
          } catch (e) { console.error('Studio rules error:', e); }
        }
        oaWs.on('message', async (data) => {
          try {
            const s = typeof data === 'string' ? data : data.toString('utf8');
            const m = JSON.parse(s);
            // --- Realtime tool calling (Studio) ---
            if (m.type === 'response.function_call.created' && m.response?.id && m.response?.name) {
              studioToolArgs.set(m.response.id, { name: m.response.name, args: '' });
            }
            if (m.type === 'response.function_call.arguments.delta' && m.response?.id && typeof m.delta === 'string') {
              const rec = studioToolArgs.get(m.response.id);
              if (rec) rec.args += m.delta;
            }
            if ((m.type === 'response.function_call.arguments.done' || m.type === 'response.function_call.completed') && m.response?.id) {
              const rec = studioToolArgs.get(m.response.id);
              if (rec) {
                studioToolArgs.delete(m.response.id);
                try {
                  const parsed = rec.args ? JSON.parse(rec.args) : {};
                  const result = await callTool(rec.name, parsed, {});
                  // Send tool output back into conversation and request next response
                  oaWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: { type: 'tool', tool_call_id: m.response.id, name: rec.name, content: [{ type: 'output_text', text: JSON.stringify(result) }] },
                  }));
                  oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: useElevenTts ? ['text'] : ['audio','text'] } }));
                } catch (e) {
                  console.error('Studio tool call error:', e?.message || e);
                }
              }
            }
            
            if (m.type === 'session.updated') {
              console.log('OpenAI session.updated:', JSON.stringify(m, null, 2));
            }
            if (m.type === 'error') {
              console.error('OpenAI ERROR:', JSON.stringify(m, null, 2));
            }
            if (m.type === 'response.created' && m.response) {
              currentResponseId = m.response.id || null;
              try { if (publisher) publisher.muteAgent(false); } catch(e) { console.error('Error muting agent:', e); }
            }

            // Handle USER transcription
            if (m.type === 'conversation.item.input_audio_transcription.delta' && m.delta) {
                if (lastSpeaker !== 'callee') {
                    currentTranscription += (currentTranscription ? '\n---\n' : '') + 'Callee: ';
                    lastSpeaker = 'callee';
                }
                currentTranscription += m.delta;
            }

            // Handle AGENT transcription (text deltas)
            if ((m.type === 'response.audio_transcript.delta' || m.type === 'response.output_text.delta') && m.delta) {
              if (lastSpeaker !== 'agent') {
                  currentTranscription += (currentTranscription ? '\n---\n' : '') + 'Agent: ';
                  lastSpeaker = 'agent';
              }
              currentTranscription += m.delta;
              try { telnyxWs.send(JSON.stringify({ type: 'transcript_delta', text: m.delta })); } catch(e) { console.error('Error sending transcript delta:', e); }
              // If ElevenLabs TTS is active, accumulate text and attempt streaming
              try { if (useElevenTts) { outBuf += m.delta; maybeStartTts(false); } } catch(_) {}
            }

            if (useElevenTts && m.type === 'response.output_text.delta' && typeof m.delta === 'string') {
              outBuf += m.delta;
              try { maybeStartTts(false); } catch(_) {}
            }
            if ((m.type === 'response.audio.delta' || m.type === 'response.output_audio.delta') && m.delta && !useElevenTts) {
              if (studioSuppressAgentAudio) return;
              agentSpeaking = true;
              if (!agentSpeakingSent) {
                agentSpeakingSent = true;
                try { telnyxWs.send(JSON.stringify({ type: 'agent_speaking', speaking: true })); } catch(e) { console.error('Error sending agent_speaking=true:', e); }
              }
              const pcm24k = Buffer.from(m.delta, 'base64');
              if (publisher) publisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
              try { studioMixer.appendAgent(pcm24k); } catch(_) {}
              try { telnyxWs.send(JSON.stringify({ type: 'agent_audio_24k', audio: m.delta })); } catch(e) { console.error('Error sending agent_audio_24k:', e); }
              if (!notified) {
                notified = true;
                try { telnyxWs.send(JSON.stringify({ type: 'first_audio_delta' })); } catch(e) { console.error('Error sending first_audio_delta:', e); }
              }
            }
            if (m.type === 'response.done') {
              agentSpeaking = false;
              agentSpeakingSent = false;
              try { telnyxWs.send(JSON.stringify({ type: 'agent_speaking', speaking: false })); } catch(e) { console.error('Error sending agent_speaking=false:', e); }
              try { if (publisher) publisher.muteAgent(false); } catch(e) { console.error('Error muting agent on done:', e); }
              try { if (useElevenTts) maybeStartTts(true); } catch(_) {}
            }
            // Evaluate rules on each message (cheap heuristics)
            try { await studioApplyRules(); } catch(_) {}
          } catch (e) { console.error('Error processing OA message:', e); }
        });
        const closeAll = async () => { 
          try { oaWs.close(); } catch(e) { console.error('Error closing OA ws:', e); };
          try { publisher && await publisher.close(); } catch(e) { console.error('Error closing publisher:', e); };
          try { await studioMixer.finalize(); } catch(_) {}
          // Stop LiveKit egress and capture file result
          let egressFile = '';
          if (egressId) {
            try {
              const info = await stopEgress(egressId);
              const fr = info?.fileResults || info?.results || [];
              if (Array.isArray(fr) && fr.length) {
                egressFile = fr[0]?.filename || fr[0]?.filepath || '';
              } else if (info?.file?.filename || info?.file?.filepath) {
                egressFile = info.file.filename || info.file.filepath;
              }
              console.log('LiveKit egress stopped (studio):', egressId, 'file:', egressFile);
            } catch (stopErr) {
              console.error('Failed to stop LiveKit egress (studio):', stopErr?.message || stopErr);
            }
          }

          // Update CallLogEntry with egress file or local recorder/studio mixer fallback
          try {
            let chosenPath = egressFile || '';
            if (!chosenPath && livekitRecorder && livekitRecorder.outPath) {
              try {
                const recPath = String(livekitRecorder.outPath);
                const idx = recPath.lastIndexOf('/recordings/');
                chosenPath = idx >= 0 ? recPath.slice(idx + '/recordings/'.length) : require('path').basename(recPath);
              } catch (_) {}
            }
            if (!chosenPath && studioMixPath) {
              try {
                const idx2 = studioMixPath.lastIndexOf('/recordings/');
                chosenPath = idx2 >= 0 ? studioMixPath.slice(idx2 + '/recordings/'.length) : require('path').basename(studioMixPath);
              } catch(_) {}
            }
            const audioRecordingUrl = chosenPath ? ('/recordings/' + String(chosenPath).replace(/^\/+/, '')) : '';
            const callEndTime = new Date();
            await CallLogEntry.findOneAndUpdate(
              { call_id: callId },
              { 
                audio_recording_url: audioRecordingUrl,
                end_time: callEndTime,
                call_status: 'success',
                transcription: currentTranscription,
              },
              { new: true, runValidators: true }
            );
          } catch (e) {
            console.error('Error updating call log with recorder file:', e);
          }

          // Calculate session duration and costs when closing
          try {
            const sessionEndTime = new Date();
            const durationMinutes = (sessionEndTime - sessionStartTime) / (1000 * 60);
            
            // Create cost tracking record for agent studio session
            await costCalculationService.updateCallCosts(callId, 'agent_studio', {
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
          try { sessionRegistry.remove(roomName); } catch(_) {}
        };
        telnyxWs.on('message', (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === 'audio' && m.audio && oaWs.readyState === WebSocket.OPEN) {
              const pcm24kBuffer = Buffer.from(m.audio, 'base64');
              // Mix callee (browser mic) into local studio WAV
              try { if (studioMixer) studioMixer.appendCallee(pcm24kBuffer); } catch(_) {}
              // Publish callee (browser mic) into LiveKit so the recorder/egress can capture it
              try {
                if (publisher) {
                  const pcm8k = downsample24kTo8k(pcm24kBuffer);
                  publisher.pushCalleeFrom8kPcm16(pcm8k);
                }
              } catch (e) {
                console.error('Error feeding callee to LiveKit (Agent Studio):', e);
              }

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
              try {
                if (currentResponseId) {
                  oaWs.send(JSON.stringify({ type: 'response.cancel', response_id: currentResponseId }));
                } else {
                  oaWs.send(JSON.stringify({ type: 'response.cancel' }));
                }
              } catch(e) { console.error('Error sending response.cancel:', e); }
              try { telnyxWs.send(JSON.stringify({ type: 'barge_in' })); } catch(e) { console.error('Error sending barge_in:', e); }
              agentSpeaking = false; agentSpeakingSent = false; studioSuppressAgentAudio = true;
              try { if (ttsAbort) ttsAbort.abort(); } catch(_) {}
              // If publishing to LiveKit, immediately mute and clear the agent track queue
              try { if (publisher) { publisher.muteAgent(true); publisher.clearAgentQueue(); } } catch (e) { console.error('Error muting LiveKit agent on barge-in:', e); }
              studioAppendedMs = 0;
            }
            // When user stops speaking for sustained frames, commit and ask for response
            if (userSpeaking && belowCnt >= 12) {
              userSpeaking = false; belowCnt = 0;
              try {
                if (studioAppendedMs >= STUDIO_MIN_COMMIT_MS) {
                  oaWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                  oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: useElevenTts ? ['text'] : ['audio','text'] } }));
                  studioAppendedMs = 0; studioSuppressAgentAudio = false;
                } else {
                  // Not enough audio to commit; wait for more frames
                }
              } catch (e) { console.error('Error auto-committing on silence (studio):', e); }
            }
          } catch(e) { console.error('Error in VAD logic:', e); }
          oaWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.audio }));
          studioAppendedMs += STUDIO_FRAME_MS;
            } else if (m.type === 'commit' && oaWs.readyState === WebSocket.OPEN) {
              oaWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              oaWs.send(JSON.stringify({ type: 'response.create', response: { modalities: useElevenTts ? ['text'] : ['audio','text'] } }));
            }
            // client VAD messages removed when using server_vad
          } catch(e) {
            console.error('Error in agent-stream message handler:', e);
          }
        });
        telnyxWs.on('close', closeAll); telnyxWs.on('error', closeAll); oaWs.on('close', closeAll); oaWs.on('error', closeAll);
      } catch (e) { 
        console.error('Error in agent-stream connection setup:', e);
        try { telnyxWs.close(); } catch(e) { console.error('Error closing ws on setup fail:', e); } 
      }
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
    let livekitRecorder = null; // Recorder participant
    let customerRecord = null; // Customer Record for personalization
    let currentTranscription = ''; // To accumulate transcription
    
    // Cost tracking variables
    let callStartTime = new Date();
    let audioInputMinutes = 0;
    let audioOutputMinutes = 0;
    let inputTokenCount = 0;
    let outputTokenCount = 0;
    
    // PSTN turn-taking state
    let pstnUserSpeaking = false;
    let pstnAboveCnt = 0;
    let pstnBelowCnt = 0;
    let pstnAgentSpeaking = false;
    let pstnAppendedMs = 0;
    const PSTN_FRAME_MS = 20; // Telnyx media frames are ~20ms
    const PSTN_MIN_COMMIT_MS = Number(process.env.MIN_COMMIT_MS || '120');
    const speakTh = Number(process.env.SERVER_VAD_SPEAK_TH || '0.020');
    const silentTh = Number(process.env.SERVER_VAD_SILENT_TH || '0.006');
    const onsetNeededBase = Number(process.env.SERVER_VAD_ONSET_FRAMES || '4');
    const onsetNeededWhileAgent = Number(process.env.SERVER_VAD_ONSET_FRAMES_AGENT || '8');

    // Recording stream state
    let audioFilePath = null;
    let audioWriteStream = null;
    let bytesWritten = 0;
    let telnyxStreamId = null; // Stream ID from Telnyx 'start' event
    // Disable legacy PSTN mixer (we use LiveKit Egress)
    const pstnMixPath = '';
    const pstnMixer = { appendAgent() {}, appendCallee() {}, async finalize() {} };

    // Outgoing AI speech queue (PCMU @8kHz)
    let aiPcmuQueue = Buffer.alloc(0);
    let aiSendTimer = null;
    const AI_FRAME_SAMPLES = 160; // 20ms @8kHz

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
      let sentFrames = 0;
      aiSendTimer = setInterval(() => {
        try {
          if (!telnyxWs || telnyxWs.readyState !== WebSocket.OPEN) return;
          // Do not consume or send frames until Telnyx provided a stream_id (start event)
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
            console.log(`AI->PSTN sent frames: ${sentFrames}`);
          }
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
        // Remove legacy in-room recorder; we will use LiveKit Egress instead
      } catch (e) {
        console.error('Failed to start LiveKit publisher:', e);
      }


      // Prepare routing context from query and DB, then create OpenAI Session
      const q = parsedUrl.query || {};
      const campaignHint = String(q.campaign || q.campaign_id || q.id || '').trim();
      let languageHint = String(q.lang || q.language || '').toLowerCase();
      if (!languageHint && customerRecord?.preferred_language) languageHint = String(customerRecord.preferred_language).toLowerCase();

      let resolved = null;
      let sessionOverrides = { instructions: null, voice: null, language: null };
      try {
        const out = await resolveAgentAndMcp({ campaignId: (campaignHint || (callLog?.campaign_id || '')), detectedLanguage: languageHint });
        resolved = out;
        if (out?.agent) {
          sessionOverrides.instructions = out.agent.instructions || null;
          sessionOverrides.voice = out.agent.voice || null;
          sessionOverrides.language = (out.agent.language || languageHint || null) || null;
          console.log('Resolved PSTN agent via orchestrator:', { name: out.agent.name, lang: sessionOverrides.language });
        } else {
          console.log('Orchestrator resolution (PSTN) returned no agent; using defaults');
        }
      } catch (e) {
        console.error('PSTN resolver error:', e?.message || e);
      }

      // 2. Create OpenAI Session and connect WebSocket
      const session = await createOpenAISession(customerRecord);
      const OPENAI_REALTIME_API_URL = session.websocket_url;

      openaiWs = new WebSocket(OPENAI_REALTIME_API_URL, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });

      // Register session references for operator control
      try { sessionRegistry.set(roomName, { openaiWs, livekitPublisher }); } catch(_) {}

      openaiWs.on('open', async () => {
        console.log('Connected to OpenAI Realtime API');
        // Apply session overrides from orchestrator resolution (if any)
        try {
          const tdThresh = Number(process.env.TURN_DETECTION_THRESHOLD || '0.60');
          const tdPrefix = Number(process.env.TURN_DETECTION_PREFIX_MS || '180');
          const tdSilence = Number(process.env.TURN_DETECTION_SILENCE_MS || '250');
          const sessionUpdate = {
            type: 'session.update',
            session: {
              ...(sessionOverrides.instructions ? { instructions: sessionOverrides.instructions } : {}),
              ...(sessionOverrides.voice ? { voice: sessionOverrides.voice } : {}),
              ...(sessionOverrides.language ? { input_audio_transcription: { model: 'whisper-1', language: sessionOverrides.language } } : {}),
              turn_detection: { type: 'server_vad', threshold: tdThresh, prefix_padding_ms: tdPrefix, silence_duration_ms: tdSilence },
            },
          };
          try {
            const instrPrev = String(sessionUpdate.session?.instructions || '').slice(0, 220).replace(/\s+/g, ' ');
            const langPrev = sessionUpdate.session?.input_audio_transcription?.language || '';
            console.log('PSTN session.update -> lang:', langPrev, '| len:', (sessionUpdate.session?.instructions||'').length, '| instr:', instrPrev);
          } catch(_) {}
          openaiWs.send(JSON.stringify(sessionUpdate));
        } catch (e) {
          console.error('Failed to apply session overrides (PSTN):', e?.message || e);
        }
        // Do not prime an immediate response on PSTN path; wait for caller speech
        // Start LiveKit Room Composite Egress (audio-only)
        try {
          const eg = await startRoomAudioEgress(roomName);
          egressId = eg?.egressId || eg?.egress_id || null;
          console.log('LiveKit egress started:', egressId || eg);
        } catch (egErr) {
          console.error('Failed to start LiveKit egress:', egErr?.message || egErr);
          // Fallback to local LiveKit recorder
          try {
            const { createRecorder } = require('../livekit/recorder');
            const at = new AccessToken(apiKey, apiSecret, { identity: `recorder-${roomName}-${Date.now()}` });
            at.addGrant({ room: roomName, roomJoin: true, canPublish: false, canSubscribe: true });
            const token = at.toJwt();
            livekitRecorder = await createRecorder({ host: livekitHost, token, roomName, outFileBase: `${roomName}-${Date.now()}` });
            console.log('Local recorder started:', livekitRecorder?.outPath || '(unknown)');
          } catch (recErr) {
            console.error('Failed to start local recorder:', recErr?.message || recErr);
          }
        }
      });

      const pstnToolArgs = new Map();
      let pstnRuleLangSwitched = false;
      const pstnTagged = new Set();
      async function pstnApplyRules(){
        try {
          let campaignDoc = null;
          if (campaignHint) { try { campaignDoc = await CampaignDefinition.findOne({ $or: [{ _id: campaignHint }, { campaign_id: campaignHint }, { name: campaignHint }, { title: campaignHint }] }).lean(); } catch(_) {} }
          if (!campaignDoc || !campaignDoc.orchestrator) return;
          const orch = campaignDoc.orchestrator || {};
          // Auto language switch
          if (orch.auto_lang_switch && !pstnRuleLangSwitched) {
            const g = guessLangFromText(currentTranscription);
            if (g && g !== (sessionOverrides.language||'').toLowerCase()) {
              const out = await resolveAgentAndMcp({ campaignId: (campaignDoc._id || campaignDoc.campaign_id || campaignDoc.name), detectedLanguage: g });
              if (out?.agent) {
                const tdThresh = Number(process.env.TURN_DETECTION_THRESHOLD || '0.60');
                const tdPrefix = Number(process.env.TURN_DETECTION_PREFIX_MS || '180');
                const tdSilence = Number(process.env.TURN_DETECTION_SILENCE_MS || '250');
                openaiWs.send(JSON.stringify({ type:'session.update', session:{ instructions: out.agent.instructions || undefined, voice: out.agent.voice || undefined, input_audio_transcription: { model: 'whisper-1', language: out.agent.language || g }, turn_detection: { type:'server_vad', threshold: tdThresh, prefix_padding_ms: tdPrefix, silence_duration_ms: tdSilence } } }));
                pstnRuleLangSwitched = true;
              }
            }
          }
          // Intent keywords -> tag
          if (Array.isArray(orch.intent_keywords)) {
            for (const r of orch.intent_keywords) {
              const pat = String(r.pattern||'').toLowerCase();
              const tag = String(r.tag||'').trim();
              if (!pat || !tag || pstnTagged.has(tag)) continue;
              if ((currentTranscription||'').toLowerCase().includes(pat)) {
                pstnTagged.add(tag);
                try { await CallLogEntry.findOneAndUpdate({ call_id: roomName }, { $addToSet: { intents: tag } }, { upsert: true }); } catch(_) {}
              }
            }
          }
        } catch (e) { console.error('PSTN rules error:', e); }
      }
      function guessLangFromText(txt){
        const s = (txt||'').toLowerCase();
        const frHits = [' le ', ' la ', ' et ', ' je ', ' vous ', ' merci ', 'bonjour','rappeler','facture'];
        const nlHits = [' de ', ' het ', ' en ', ' jij ', ' u ', ' dank u','goeden','factuur'];
        let fr=0, nl=0; for(const w of frHits) if(s.includes(w)) fr++; for(const w of nlHits) if(s.includes(w)) nl++; return fr>nl? 'fr' : (nl>fr? 'nl' : '');
      }
      openaiWs.on('message', async (data) => {
        try {
          const str = typeof data === 'string' ? data : data.toString('utf8');
          const openaiResponse = JSON.parse(str);
          // console.log('Received from OpenAI:', openaiResponse.type); // Too noisy

          // --- Realtime tool calling (PSTN) ---
          if (openaiResponse.type === 'response.function_call.created' && openaiResponse.response?.id && openaiResponse.response?.name) {
            pstnToolArgs.set(openaiResponse.response.id, { name: openaiResponse.response.name, args: '' });
          }
          if (openaiResponse.type === 'response.function_call.arguments.delta' && openaiResponse.response?.id && typeof openaiResponse.delta === 'string') {
            const rec = pstnToolArgs.get(openaiResponse.response.id);
            if (rec) rec.args += openaiResponse.delta;
          }
          if ((openaiResponse.type === 'response.function_call.arguments.done' || openaiResponse.type === 'response.function_call.completed') && openaiResponse.response?.id) {
            const rec = pstnToolArgs.get(openaiResponse.response.id);
            if (rec) {
              pstnToolArgs.delete(openaiResponse.response.id);
              try {
                const parsed = rec.args ? JSON.parse(rec.args) : {};
                const result = await callTool(rec.name, parsed, {});
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: { type: 'tool', tool_call_id: openaiResponse.response.id, name: rec.name, content: [{ type: 'output_text', text: JSON.stringify(result) }] },
                }));
                openaiWs.send(JSON.stringify({ type: 'response.create' }));
              } catch (e) {
                console.error('PSTN tool call error:', e?.message || e);
              }
            }
          }

          // Text streaming per Realtime events
          if (openaiResponse.type === 'response.output_text.delta' && openaiResponse.delta) {
            const textContent = openaiResponse.delta;
            currentTranscription += textContent + ' '; // Append to transcription

            await ensureCallLogDefaults();
            // Update CallLogEntry with transcription
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              { transcription: currentTranscription },
              { new: true, runValidators: true }
            );
          }

          // Audio streaming deltas (OpenAI -> Telnyx + LiveKit agent track)
          if (openaiResponse.type === 'response.output_audio.delta' && openaiResponse.delta) {
            const audioBase64 = openaiResponse.delta;
            appendAiPcmuFromOpenAIBase64(audioBase64);
            try {
              if (livekitPublisher && !pstnUserSpeaking) {
                try { livekitPublisher.muteAgent(false); } catch(_) {}
                const pcm24k = Buffer.from(audioBase64, 'base64');
                livekitPublisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
              }
            } catch (e) {
              console.error('Error feeding agent audio to LiveKit:', e);
            }
            // also feed PSTN mixer (agent)
            try {
              if (!pstnUserSpeaking) { // drop agent frames during barge-in
                const pcm24k = Buffer.from(audioBase64, 'base64');
                pstnMixer.appendAgent(pcm24k);
              }
            } catch(_) {}
            pstnAgentSpeaking = true;
          }
          if (openaiResponse.type === 'response.done') { pstnAgentSpeaking = false; try { if (livekitPublisher) livekitPublisher.muteAgent(false); } catch(_) {} }
          // Evaluate rules on each message
          try { await pstnApplyRules(); } catch(_) {}

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
          telnyxStreamId = data.stream_id || data.streamId || (data.start && data.start.stream_id) || null;
          console.log('Telnyx stream started; stream_id=', telnyxStreamId);
          try { sessionRegistry.set(roomName, { telnyxWs, telnyxStreamId }); } catch(_) {}
          try { require('../util/roomsStore').touch(roomName); } catch(_) {}
          bytesWritten = 0;
          await ensureCallLogDefaults();
        } else if (data.event === 'media') {
          const audioBase64 = data.media.payload;
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          // Legacy raw recorder disabled

          // Transcode Telnyx PCMU 8kHz to OpenAI PCM16 24kHz mono and send to Realtime API
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const pcm8k = decodePCMUtoPCM16(audioBuffer);
            const pcm24k = upsampleTo24kHz(pcm8k);
            const pcmBuf = int16ToLEBuffer(pcm24k);
            const b64 = pcmBuf.toString('base64');
            // Append chunk to input buffer
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
            // Feed PSTN mixer (callee)
            try { pstnMixer.appendCallee(pcmBuf); } catch(_) {}
            pstnAppendedMs += PSTN_FRAME_MS;
            // PSTN server-side VAD for barge-in + auto-commit
            try {
              // Compute RMS from pcm24k Int16Array via buffer
              let sum = 0; let n = pcm24k.length;
              for (let i = 0; i < n; i++) { const v = pcm24k[i]; sum += v * v; }
              const rms = n ? Math.sqrt(sum / n) / 32768 : 0;
              if (rms > speakTh) { pstnAboveCnt++; pstnBelowCnt = 0; } else if (rms < silentTh) { pstnBelowCnt++; pstnAboveCnt = 0; } else { pstnAboveCnt = 0; }
              const need = pstnAgentSpeaking ? onsetNeededWhileAgent : onsetNeededBase;
              if (!pstnUserSpeaking && pstnAboveCnt >= need) {
                pstnUserSpeaking = true; pstnAboveCnt = 0;
                // Cancel agent speech immediately
                try { openaiWs.send(JSON.stringify({ type: 'response.cancel' })); } catch(e) { console.error('PSTN: error sending response.cancel:', e); }
                // Also clear queued Telnyx agent frames
                try { aiPcmuQueue = Buffer.alloc(0); } catch(_) {}
                // Mute and clear LiveKit agent audio immediately
                try { if (livekitPublisher) { livekitPublisher.muteAgent(true); livekitPublisher.clearAgentQueue(); } } catch (e) { console.error('LiveKit mute/clear error:', e); }
              }
              if (pstnUserSpeaking && pstnBelowCnt >= 12) {
                pstnUserSpeaking = false; pstnBelowCnt = 0;
                try {
                  if (pstnAppendedMs >= PSTN_MIN_COMMIT_MS) {
                    openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                    openaiWs.send(JSON.stringify({ type: 'response.create' }));
                    pstnAppendedMs = 0;
                  }
                } catch (e) { console.error('PSTN: error auto-committing on silence:', e); }
              }
            } catch(e) { console.error('PSTN VAD error:', e); }
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
          // PSTN mixer disabled
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
          if (livekitPublisher) { try { await livekitPublisher.close(); } catch (e) { console.error('Error closing publisher on stop:', e); } }
          // Stop egress and update DB with resulting file
          try {
            let egressFile = '';
            if (egressId) {
              try {
                const info = await stopEgress(egressId);
                const fr = info?.fileResults || info?.results || [];
                if (Array.isArray(fr) && fr.length) {
                  egressFile = fr[0]?.filename || fr[0]?.filepath || '';
                } else if (info?.file?.filename || info?.file?.filepath) {
                  egressFile = info.file.filename || info.file.filepath;
                }
                console.log('LiveKit egress stopped:', egressId, 'file:', egressFile);
              } catch (stopErr) {
                console.error('Failed to stop LiveKit egress:', stopErr?.message || stopErr);
              }
            }

            await ensureCallLogDefaults();

            // Calculate costs and update CallLogEntry
            let onedriveUrl = '';
            let costTrackingId = '';
            const callEndTime = new Date();
            try {
              const durationMinutes = (callEndTime - callStartTime) / (1000 * 60);
              const costTracking = await costCalculationService.updateCallCosts(roomName, 'pstn', {
                llm: {
                  audio_input_minutes: audioInputMinutes,
                  audio_output_minutes: audioOutputMinutes,
                  input_tokens: inputTokenCount,
                  output_tokens: outputTokenCount
                },
                pstn: { duration_minutes: durationMinutes },
                recording: {
                  local_path: recorderPath || audioFilePath || '',
                  onedrive_url: '',
                  onedrive_file_id: '',
                  upload_status: 'local_only'
                },
                transcription: { full_text: currentTranscription, language_detected: 'auto', confidence_score: 0.95 }
              });
              costTrackingId = costTracking.call_id;
            } catch (costError) {
              console.error('Cost calculation failed:', costError);
            }

            // Prefer LiveKit Egress; fallback to local recorder outPath
            let chosenPath = egressFile || '';
            if (!chosenPath && livekitRecorder && livekitRecorder.outPath) {
              try {
                const recPath = String(livekitRecorder.outPath);
                const idx = recPath.lastIndexOf('/recordings/');
                chosenPath = idx >= 0 ? recPath.slice(idx + '/recordings/'.length) : require('path').basename(recPath);
              } catch (_) {}
            }
            const audioRecordingUrl = chosenPath ? ('/recordings/' + String(chosenPath).replace(/^\/+/, '')) : '';
            await CallLogEntry.findOneAndUpdate(
              { call_id: roomName },
              { 
                audio_recording_url: audioRecordingUrl,
                onedrive_recording_url: onedriveUrl,
                cost_tracking_id: costTrackingId,
                end_time: callEndTime,
                call_status: 'success',
                transcription_summary: currentTranscription.slice(0, 500)
              },
              { new: true, runValidators: true }
            );
          } catch (e) {
            console.error('Error finalizing WAV recording:', e);
          }
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
        try { await livekitPublisher.close(); } catch (e) { console.error('Error closing publisher on close:', e); }
      }
      if (livekitRecorder) {
        try { await livekitRecorder.close(); } catch (e) { console.error('Error closing recorder on close:', e); }
      }
      try { await pstnMixer.finalize(); } catch(_) {}
      // Release pooled room if used
      try { const alloc = require('../util/mongoAllocator'); if (alloc.isInPool && alloc.isInPool(roomName)) { await alloc.release(roomName); } } catch(_) {}
      try { sessionRegistry.remove(roomName); } catch(_) {}

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
    });

    telnyxWs.on('error', (error) => {
      console.error('Telnyx WebSocket error:', error);
      if (openaiWs) {
        openaiWs.close();
      }
    });
  });

  return wss;
}

module.exports = { createWebSocketServer };
