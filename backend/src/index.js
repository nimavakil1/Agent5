require('dotenv').config();
const express = require('express');
const { execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const WebSocket = require('ws');
const url = require('url');
const OpenAI = require('openai');

const callsRouter = require('./api/routes/calls');
const telnyxRouter = require('./api/routes/telnyx');
const agentRouter = require('./api/routes/agent');
const livekitRouter = require('./api/routes/livekit');
const campaignsRouter = require('./api/routes/campaigns');
const authRouter = require('./api/routes/auth');
const agentsRouter = require('./api/routes/agents');
const dashboardRouter = require('./api/routes/dashboard');
const customersRouter = require('./api/routes/customers');
const adminRouter = require('./api/routes/admin');
const rolesRouter = require('./api/routes/roles');
const costsRouter = require('./api/routes/costs');
const emergencyRouter = require('./api/routes/emergency');
const orchestratorRouter = require('./api/routes/orchestrator');
const mcpRouter = require('./api/routes/mcp');
const shopifyRouter = require('./api/routes/shopify');
const productsRouter = require('./api/routes/products');
const notificationsRouter = require('./api/routes/notifications');
const prospectsRouter = require('./api/routes/prospects');
const connectDB = require('./config/database');
const validateEnv = require('./config/validateEnv');
const ensureAdmin = require('./util/ensureAdmin');
const { ensureDefaultRoles } = require('./util/ensureRoles');
const auth = require('./middleware/auth');
const { requireSession, allowBearerOrSession } = require('./middleware/sessionAuth');
const scheduler = require('./scheduler');
const CallLogEntry = require('./models/CallLogEntry');
const { resolveAgentAndMcp } = require('./util/orchestrator');
const agentSettings = require('./config/agentSettings');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Validate env & connect to MongoDB (skip DB in tests)
if (process.env.NODE_ENV !== 'test') {
  validateEnv();
  connectDB().then(async () => {
    try { await ensureDefaultRoles(); } catch(e) { console.error('roles seed error', e); }
    if (process.env.AUTO_SEED_ADMIN === '1') {
      await ensureAdmin();
    }
  });
}

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  pinoHttp({
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.body.to',
        'req.body.phone',
        'req.body.phone_number',
        'req.body.email',
      ],
      remove: true,
    },
  })
);
app.use(cookieParser());
const server = http.createServer(app);

const port = process.env.PORT || 3000;

// Telnyx webhook must see raw body for signature verification; mount before JSON parser
app.use('/api/telnyx', telnyxRouter);

if (process.env.CORS_ORIGIN) {
  const allowlist = process.env.CORS_ORIGIN.split(',').map((s) => s.trim());
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, false);
        if (allowlist.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: false,
    })
  );
}

app.use(express.json({ limit: process.env.BODY_LIMIT || '1mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'login.html'));
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/readyz', (req, res) => res.status(200).json({ ready: true }));
app.get('/version', (req, res) => res.status(200).json({ commit: COMMIT_SHA || null, startedAt: STARTED_AT }));

const recordingsDir = path.join(__dirname, 'recordings');
const crypto = require('crypto');
function signRecordingPath(u, ts){
  const secret = process.env.RECORDINGS_SIGNING_SECRET || process.env.AUTH_TOKEN || 'dev-secret';
  const h = crypto.createHmac('sha256', secret).update(String(u)+'|'+String(ts)).digest('hex');
  return h;
}
app.get('/app/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'login.html'));
});
app.get('/app/shell.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'shell.js'));
});
app.use('/app', requireSession, express.static(path.join(__dirname, 'public', 'app')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

const protectedPages = ['dashboard.html', 'call-review.html', 'admin.html', 'monitor.html'];
protectedPages.forEach(page => {
  app.get(`/${page}`, requireSession, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', page));
  });
});

app.get('/customers.html', requireSession, (req, res) => {
  res.redirect(302, '/app/prospects.html');
});

app.get('/monitor.js', requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor.js'));
});

if (process.env.PROTECT_RECORDINGS === '1') {
  app.get('/recordings-signed', async (req, res) => {
    try {
      const u = String(req.query.u || '');
      const ts = Number(req.query.ts || '0');
      const sig = String(req.query.sig || '');
      if (!u.startsWith('/recordings/')) return res.status(400).json({ message:'bad url' });
      const now = Date.now();
      if (!ts || Math.abs(now - ts) > 10 * 60 * 1000) return res.status(401).json({ message:'expired' });
      const expect = signRecordingPath(u, ts);
      if (sig !== expect) return res.status(401).json({ message:'bad signature' });
      return res.sendFile(path.join(recordingsDir, u.replace(/^\/recordings\//,'')));
    } catch (e) { return res.status(500).json({ message:'error' }); }
  });
  app.use('/recordings', requireSession, express.static(recordingsDir));
} else {
  app.use('/recordings', express.static(recordingsDir));
}

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const max = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const limiter = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

app.use('/api/auth', authRouter);
app.use('/api/calls', allowBearerOrSession, callsRouter);
app.use('/api/agent', allowBearerOrSession, agentRouter);
app.use('/api/livekit', allowBearerOrSession, livekitRouter);
app.use('/api/campaigns', allowBearerOrSession, campaignsRouter);
app.use('/api/dashboard', allowBearerOrSession, dashboardRouter);
app.use('/api/customers', allowBearerOrSession, customersRouter);
app.use('/api/admin', requireSession, adminRouter);
app.use('/api/admin/roles', requireSession, rolesRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/costs', costsRouter);
app.use('/api/emergency', emergencyRouter);
app.use('/api/orchestrator', requireSession, orchestratorRouter);
app.use('/api/mcp', allowBearerOrSession, mcpRouter);
app.use('/api/shopify', shopifyRouter);
app.use('/api/products', productsRouter);
app.use('/api/notifications', allowBearerOrSession, notificationsRouter);
app.use('/api/prospects', prospectsRouter);

const uiDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use('/ui', requireSession, express.static(uiDist));
app.get(/^\/ui(?:\/.*)?$/, requireSession, (req, res) => {
  res.sendFile(path.join(uiDist, 'index.html'));
});

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/pstn-websocket') {
    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (telnyxWs, req) => {
  console.log('=== PSTN WEBSOCKET CONNECTION ESTABLISHED ===');
  console.log('Connection time:', new Date().toISOString());
  console.log('Connection headers:', JSON.stringify(req.headers, null, 2));
  console.log('Request URL:', req.url);
  console.log('Client IP:', req.connection.remoteAddress);
  
  telnyxWs.on('error', (error) => {
    console.error('=== TELNYX WEBSOCKET ERROR ===');
    console.error('Error:', error);
  });
  
  telnyxWs.on('close', (code, reason) => {
    console.log('=== TELNYX WEBSOCKET CLOSED ===');
    console.log('Close code:', code);
    console.log('Close reason:', reason ? reason.toString() : 'No reason');
  });
  
  console.log('=== WEBSOCKET EVENT LISTENERS ATTACHED ===');
  
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

  let aiPcmuQueue = Buffer.alloc(0);
  let aiSendTimer = null;
  const AI_FRAME_SAMPLES = 160;

  let ttsInFlight = false;
  let ttsAbort = null;
  let outBuf = '';

  let recordingFile = null;
  let recordingPath = '';

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

  function pcmuToPcm16(ulawBuf) {
    const out = new Int16Array(ulawBuf.length);
    for (let i = 0; i < ulawBuf.length; i++) {
      out[i] = ulawDecode(ulawBuf[i]);
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
      const requestBody = {
        type: 'transcription',
        model,
        modalities: ['text'],
        instructions,
        voice,
      };

      console.log('OpenAI session request body:', JSON.stringify(requestBody, null, 2));

      const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorData = JSON.parse(errorText);
          console.error('OpenAI session creation failed with JSON error:', errorData);
          throw new Error(`Failed to create OpenAI session: ${response.status} ${response.statusText} - ${errorData.message || JSON.stringify(errorData)}`);
        } catch (e) {
          console.error('OpenAI session creation failed with non-JSON error:', errorText);
          throw new Error(`Failed to create OpenAI session: ${response.status} ${response.statusText} - ${errorText}`);
        }
      }

      const sessionData = await response.json();
      console.log('PSTN OpenAI session created:', sessionData);
      return sessionData;
    } catch (error) {
      console.error('Error creating PSTN OpenAI session:', error);
      throw error;
    }
  }

  try {
    const callLog = await CallLogEntry.findOne({ call_id: roomName });
    if (callLog && callLog.customer_id) {
      customerRecord = await require('./models/CustomerRecord').findOne({ customer_id: callLog.customer_id });
    }

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

    try {
      const recordingsDir = path.resolve(__dirname, 'recordings', 'pstn');
      if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
      recordingPath = path.join(recordingsDir, `${roomName}-${Date.now()}.wav`);
      
      recordingFile = fs.createWriteStream(recordingPath);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(0, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(1, 22);
      wavHeader.writeUInt32LE(8000, 24);
      wavHeader.writeUInt32LE(16000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(0, 40);
      recordingFile.write(wavHeader);
      
      console.log(`PSTN: Recording started: ${recordingPath}`);
    } catch (e) {
      console.error('PSTN: Failed to start recording:', e);
    }

    console.log('=== CREATING OPENAI SESSION ===');
    console.log('OpenAI API Key available:', process.env.OPENAI_API_KEY ? 'Yes' : 'No');
    console.log('Customer record:', customerRecord ? 'Present' : 'None');
    console.log('Session overrides:', JSON.stringify(sessionOverrides, null, 2));
    
    let session = null;
    try {
      session = await createOpenAISession(customerRecord, sessionOverrides);
      console.log('=== OPENAI SESSION CREATED ===');
      console.log('Session response:', JSON.stringify(session, null, 2));
    } catch (error) {
      console.warn('=== OPENAI SESSION CREATION FAILED ===');
      console.warn('Error:', error.message);
      console.warn('Continuing with direct WebSocket connection...');
    }
    
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
            modalities: ['text'],
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
        
        if (message.type === 'error') {
          console.log('=== OPENAI ERROR DETAILS ===');
          console.log('Error message:', JSON.stringify(message, null, 2));
        }
        
        if (message.type === 'response.text.delta' && message.delta) {
          console.log('=== OPENAI TEXT DELTA ===');
          console.log('Delta content:', message.delta);
          currentTranscription += message.delta;
          outBuf += message.delta;
          
          if (outBuf.length > 0) {
            const textToSynth = outBuf;
            console.log('Starting TTS for text:', textToSynth);
            outBuf = '';
            await startTTS(textToSynth);
          }
        }
        
        if (message.type === 'response.done') {
          if (outBuf.length > 0) {
            await startTTS(outBuf, true);
            outBuf = '';
          }
        }

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

  telnyxWs.on('message', async (message) => {
    console.log('=== RECEIVED TELNYX WEBSOCKET MESSAGE ===');
    console.log('Message type:', typeof message);
    console.log('Message size:', message.length, 'bytes');
    console.log('Current time:', new Date().toISOString());
    
    try {
      console.log('Raw message content (first 500 chars):', message.toString().substring(0, 500));
      const data = JSON.parse(message);
      console.log('=== PARSED TELNYX MESSAGE ===');
      console.log('Event type:', data.event);
      console.log('Full JSON data:', JSON.stringify(data, null, 2));
      
      if (data.event === 'start') {
        telnyxStreamId = data.stream_id || data.streamId || (data.start && data.start.stream_id) || null;
        console.log('=== TELNYX STREAM STARTED ===');
        console.log('Stream ID extracted:', telnyxStreamId);
        console.log('Full start event:', JSON.stringify(data, null, 2));
      }
      
      else if (data.event === 'media') {
        console.log('=== PROCESSING MEDIA MESSAGE ===');
        console.log('Media timestamp:', data.media?.timestamp);
        console.log('Media sequence number:', data.media?.sequence_number);
        console.log('OpenAI WebSocket state:', openaiWs ? openaiWs.readyState : 'null');
        console.log('OpenAI WebSocket ready states: CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3');
        console.log('Media payload length:', data.media?.payload?.length || 'no payload');
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          console.log('✅ OpenAI WebSocket is OPEN - sending audio...');
          const audioBase64 = data.media.payload;
          const ulawBuffer = Buffer.from(audioBase64, 'base64');
          console.log('Decoded μ-law buffer size:', ulawBuffer.length, 'bytes');
        
          const pcm16Samples = pcmuToPcm16(ulawBuffer);
          console.log('PCM16 samples array length:', pcm16Samples.length);
        
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
        
        if (recordingFile) {
          try {
            const pos = recordingFile.bytesWritten;
            recordingFile.end();
            
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

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
  try { scheduler.start(); } catch (e) { console.error('scheduler start error', e); }
}

let COMMIT_SHA = process.env.COMMIT_SHA || '';
try { if (!COMMIT_SHA) COMMIT_SHA = execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch(_) {}
const STARTED_AT = new Date().toISOString();

module.exports = { app, server };
