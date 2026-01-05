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
const aiAgentsRouter = require('./api/routes/agents.api');
const knowledgeRouter = require('./api/routes/knowledge.api');
const amazonRouter = require('./api/routes/amazon.api');
const vendorRouter = require('./api/routes/vendor.api');
const sellerRouter = require('./api/routes/seller.api');
const amazonAdsRouter = require('./api/routes/amazonads.api');
const odooRouter = require('./api/routes/odoo.api');
const ms365Router = require('./api/routes/ms365.api');
const bolcomRouter = require('./api/routes/bolcom.api');
const carriersRouter = require('./api/routes/carriers.api');
const warehousesRouter = require('./api/routes/warehouses.api');
const categoriesRouter = require('./api/routes/categories.api');
const settingsRouter = require('./api/routes/settings.api');
const purchasingRouter = require('./api/routes/purchasing.api');
const { syncRouter: odooSyncRouter } = require('./api/routes/purchasing.api');
const inventoryRouter = require('./api/routes/inventory.api');
const printRouter = require('./api/routes/print.api');
const shippingRouter = require('./api/routes/shipping.api');
const fulfillmentRouter = require('./api/routes/fulfillment.api');
const accountingRouter = require('./api/routes/accounting.api');
const amazonMappingsRouter = require('./api/routes/amazonMappings.api');
const logsRouter = require('./api/routes/logs.api');
const odooMirrorRouter = require('./api/routes/odoo-sync.api');
const chatPermissionsRouter = require('./api/routes/chat-permissions.api');
const { checkPermissionRouter: chatCheckRouter } = require('./api/routes/chat-permissions.api');
const chatRouter = require('./api/routes/chat.api');
const ordersRouter = require('./api/routes/orders.api');
const alertsRouter = require('./api/routes/alerts.api');
const connectDB = require('./config/database');
const { createPlatform } = require('./core/Platform');
const { AgentModule } = require('./core/agents');
const validateEnv = require('./config/validateEnv');
const ensureAdmin = require('./util/ensureAdmin');
const { ensureDefaultRoles } = require('./util/ensureRoles');
const _auth = require('./middleware/auth');
const { requireSession, allowBearerOrSession } = require('./middleware/sessionAuth');
const scheduler = require('./scheduler');
// Initialize WebSocket handlers (Agent Studio, operator bridge)
const { createWebSocketServer } = require('./websocket');
const CallLogEntry = require('./models/CallLogEntry');
const { resolveAgentAndMcp } = require('./util/orchestrator');
const agentSettings = require('./config/agentSettings');

const _openai = new OpenAI({
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

    // Initialize RAG system for knowledge retrieval
    try {
      const { getRAGManager } = require('./core/agents/rag');
      const { getDb } = require('./db');
      const rag = getRAGManager();
      const db = getDb();
      await rag.init(db);
      console.log('RAG system initialized successfully');
    } catch (e) {
      console.warn('RAG system initialization skipped:', e.message);
    }

    // Initialize Purchasing Intelligence Agent and Data Sync if Odoo is configured
    try {
      if (process.env.ODOO_URL && process.env.ODOO_DB) {
        const { OdooDirectClient } = require('./core/agents/integrations/OdooMCP');
        const { initAgent: initPurchasingAgent } = require('./api/routes/purchasing.api');
        const { initAgent: initInventoryAgent } = require('./api/routes/inventory.api');
        const { getOdooDataSync } = require('./services/OdooDataSync');
        const { getDb } = require('./db');

        const odooClient = new OdooDirectClient();
        await odooClient.authenticate();

        const db = getDb();
        await initPurchasingAgent(odooClient, db);
        await initInventoryAgent(odooClient, db);

        // Initialize and start Odoo data sync
        const dataSync = getOdooDataSync();
        await dataSync.init(odooClient, db);
        dataSync.startScheduledSync();

        console.log('Purchasing Intelligence Agent initialized successfully');
        console.log('Inventory Optimization Agent initialized successfully');
        console.log('Odoo data sync started (every 6 hours)');
      }
    } catch (e) {
      console.warn('Purchasing Agent initialization skipped:', e.message);
    }

    // Initialize Amazon Seller order scheduler if configured
    try {
      if (process.env.AMAZON_SELLER_REFRESH_TOKEN) {
        const { startSellerScheduler } = require('./services/amazon/seller');
        await startSellerScheduler();
        console.log('Amazon Seller order scheduler started (every 15 minutes)');
      }
    } catch (e) {
      console.warn('Seller scheduler initialization skipped:', e.message);
    }

    // Initialize Bol.com sync scheduler if configured
    try {
      if (process.env.BOL_CLIENT_ID && process.env.BOL_CLIENT_SECRET) {
        const BolScheduler = require('./services/bol/BolScheduler');
        BolScheduler.start();
        console.log('Bol.com sync scheduler started (nightly at 3:00 AM)');
      }
    } catch (e) {
      console.warn('Bol.com scheduler initialization skipped:', e.message);
    }

    // Initialize CW Fulfillment sync scheduler
    try {
      const { getFulfillmentSync } = require('./services/fulfillment/FulfillmentSync');
      const fulfillmentSync = getFulfillmentSync();

      // Start regular sync (every 15 minutes)
      fulfillmentSync.startScheduledSync();

      // Schedule historical sync at 2:00 AM (one-time)
      fulfillmentSync.scheduleHistoricalSync();

      console.log('CW Fulfillment sync scheduler started (every 15 min + historical at 2:00 AM)');
    } catch (e) {
      console.warn('Fulfillment scheduler initialization skipped:', e.message);
    }

    // Initialize Odoo Mirror sync scheduler
    try {
      const { getOdooSyncScheduler } = require('./services/odoo');
      const odooSyncScheduler = getOdooSyncScheduler({
        incrementalIntervalMinutes: 10,  // Sync every 10 minutes
        fullSyncHour: 3,                 // Full sync at 3 AM
        enabled: true
      });
      await odooSyncScheduler.start();
      console.log('Odoo Mirror sync scheduler started (every 10 min + full sync at 3:00 AM)');
    } catch (e) {
      console.warn('Odoo Mirror scheduler initialization skipped:', e.message);
    }
  });
}

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

const app = express();
// Trust first proxy (nginx) - required for express-rate-limit behind reverse proxy
app.set('trust proxy', 1);
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
// Attach Agent Studio websocket server (handles /agent-stream, /operator-bridge)
// This must be registered before custom upgrade handlers to allow fallthrough.
try { createWebSocketServer(server); } catch (e) { console.error('Failed to init Agent WebSocket server:', e); }

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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
// Legacy UI at /old/
app.get('/old/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'old', 'login.html'));
});
app.get('/old/shell.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'old', 'shell.js'));
});
app.use('/old', requireSession, express.static(path.join(__dirname, 'public', 'old'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// New platform UI (v2) - public files
app.get('/shell-v2.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shell-v2.js'));
});
app.get('/accept-invite.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'accept-invite.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// New platform UI (v2) - protected sections
const protectedSections = ['vendor', 'settings', 'seller', 'inventory', 'accounting', 'analytics', 'ai', 'calls', 'bol', 'fulfillment', 'assistant'];
protectedSections.forEach(section => {
  app.use(`/${section}`, requireSession, express.static(path.join(__dirname, 'public', section), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
  }));
});

// New platform index (protected)
app.get('/index.html', requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Public warehouse dashboard (no auth required - for big screen display)
app.get('/warehouse', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app', 'warehouse-dashboard.html'));
});

// Public marketplace dashboard API (shows status from marketplace perspective)
app.get('/api/alerts/marketplace-display', async (req, res) => {
  try {
    const { getMarketplaceDashboardService } = require('./services/alerts/MarketplaceDashboardService');
    const service = getMarketplaceDashboardService();
    const data = await service.getDashboardData();
    res.json(data);
  } catch (error) {
    console.error('[Marketplace Dashboard] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

const protectedPages = ['dashboard.html', 'call-review.html', 'admin.html', 'monitor.html'];
protectedPages.forEach(page => {
  app.get(`/${page}`, requireSession, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', page));
  });
});

app.get('/customers.html', requireSession, (req, res) => {
  res.redirect(302, '/old/prospects.html');
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
const max = parseInt(process.env.RATE_LIMIT_MAX || '500', 10); // Increased to 500 for pages with many lookups
const limiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Exempt auth routes and internal product lookups from rate limiting
    if (req.path.startsWith('/auth')) return true;
    if (req.path.startsWith('/odoo/products') && req.query.q) return true;
    return false;
  },
  message: { error: 'Too many requests', message: 'Please try again later' } // Return JSON instead of text
});
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
app.use('/api/ai-agents', allowBearerOrSession, aiAgentsRouter);
app.use('/api/knowledge', requireSession, knowledgeRouter);
app.use('/api/amazon', amazonRouter); // Webhooks are public (validated by signature), GET routes need auth
app.use('/api/vendor', requireSession, vendorRouter); // Vendor Central requires auth
app.use('/api/seller', requireSession, sellerRouter); // Seller Central requires auth
app.use('/api/amazonads', requireSession, amazonAdsRouter); // Amazon Advertising API
app.use('/api/odoo', requireSession, odooRouter);
app.use('/api/ms365', requireSession, ms365Router);
app.use('/api/bolcom', requireSession, bolcomRouter);
app.use('/api/carriers', requireSession, carriersRouter);
app.use('/api/warehouses', requireSession, warehousesRouter);
app.use('/api/categories', requireSession, categoriesRouter);
app.use('/api/settings', requireSession, settingsRouter);
// Odoo sync endpoints without auth (internal use)
app.use('/api/odoo-sync', odooSyncRouter);
// Odoo Mirror - MongoDB cache of Odoo data
app.use('/api/odoo-mirror', requireSession, odooMirrorRouter);
// Purchasing endpoints require session
app.use('/api/purchasing', requireSession, purchasingRouter);
// Inventory optimization endpoints require session
app.use('/api/inventory', requireSession, inventoryRouter);
// Print service for QZ Tray integration
app.use('/api/print', requireSession, printRouter);
// Shipping carrier integrations (GLS, etc.)
app.use('/api/shipping', requireSession, shippingRouter);
// CW Fulfillment module
app.use('/api/fulfillment', requireSession, fulfillmentRouter);
// Accounting Agent module
app.use('/api/accounting', requireSession, accountingRouter);
app.use('/api/amazon/mappings', requireSession, amazonMappingsRouter);
// Module logs API (SSE streaming for real-time logs)
app.use('/api/logs', requireSession, logsRouter);
// Chat permissions API (superadmin only for management, session for checking)
app.use('/api/chat-permissions', requireSession, chatPermissionsRouter);
app.use('/api/chat/my-permissions', requireSession, chatCheckRouter);
// Module Assistant Chat API
app.use('/api/chat', requireSession, chatRouter);
// Unified Orders API (all channels: Amazon Seller, Vendor, Bol.com)
app.use('/api/orders', requireSession, ordersRouter);
// Alerts API - Public warehouse display endpoint (no auth for big screen display)
app.get('/api/alerts/warehouse-display', async (req, res) => {
  try {
    const { getLateOrdersAlertService } = require('./services/alerts/LateOrdersAlertService');
    const service = getLateOrdersAlertService();
    const status = await service.getStatus();
    res.json({
      timestamp: new Date().toISOString(),
      channelStats: status.channelStats,
      totals: status.totals
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Alerts API (Teams notifications, late orders alerts) - requires auth
app.use('/api/alerts', requireSession, alertsRouter);

const uiDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use('/ui', requireSession, express.static(uiDist));
app.get(/^\/ui(?:\/.*)?$/, requireSession, (req, res) => {
  res.sendFile(path.join(uiDist, 'index.html'));
});

// PSTN WebSocket server (Telnyx stream) using manual upgrade routing
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/pstn-websocket') {
    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
  } else {
    // Do not destroy: allow other websocket handlers (e.g., /agent-stream) to process
    return;
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

  let _aiPcmuQueue = Buffer.alloc(0);
  let aiSendTimer = null;
  const _AI_FRAME_SAMPLES = 160;

  let _ttsInFlight = false;
  let ttsAbort = null;
  let outBuf = '';

  // TTS stub function - actual TTS implementation needed
  async function startTTS(text, _isFinal = false) {
    console.warn('startTTS called but TTS is not fully implemented:', text?.substring(0, 50));
    _ttsInFlight = true;
    // TODO: Implement actual TTS synthesis and audio streaming
    _ttsInFlight = false;
    return;
  }

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
  server.listen(port, async () => {
    console.log(`Server is running on port ${port}`);

    // Initialize AI Agent Platform
    if (process.env.ENABLE_AI_AGENTS === '1') {
      try {
        const platform = createPlatform({ name: 'Agent5', version: '2.0.0' });
        const agentModule = new AgentModule({ defaultAgents: ['manager', 'finance'] });

        await platform.registerModule('agents', agentModule);
        await platform.initialize();
        await platform.start();

        console.log('AI Agent Platform initialized successfully');
      } catch (e) {
        console.error('AI Agent Platform initialization failed:', e.message);
      }
    }

    // Start marketplace dashboard cache refresh
    try {
      const { startCacheRefresh } = require('./services/alerts/MarketplaceDashboardService');
      startCacheRefresh();
    } catch (e) {
      console.error('Marketplace dashboard cache startup failed:', e.message);
    }
  });
  try { scheduler.start(); } catch (e) { console.error('scheduler start error', e); }
}

let COMMIT_SHA = process.env.COMMIT_SHA || '';
try { if (!COMMIT_SHA) COMMIT_SHA = execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch(_) {}
const STARTED_AT = new Date().toISOString();

module.exports = { app, server };
