require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { createWebSocketServer } = require('./websocket');
const callsRouter = require('./api/routes/calls');
const telnyxRouter = require('./api/routes/telnyx');
const agentRouter = require('./api/routes/agent');
const livekitRouter = require('./api/routes/livekit');
const campaignsRouter = require('./api/routes/campaigns');
const authRouter = require('./api/routes/auth');
const agentsRouter = require('./api/routes/agents');
const dashboardRouter = require('./api/routes/dashboard');
const customersRouter = require('./api/routes/customers');
const connectDB = require('./config/database');
const validateEnv = require('./config/validateEnv');
const ensureAdmin = require('./util/ensureAdmin');
const auth = require('./middleware/auth');
const { requireSession, allowBearerOrSession } = require('./middleware/sessionAuth');

// Validate env & connect to MongoDB (skip DB in tests)
if (process.env.NODE_ENV !== 'test') {
  validateEnv();
  connectDB().then(async () => {
    if (process.env.AUTO_SEED_ADMIN === '1') {
      await ensureAdmin();
    }
  });
}

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
// Relax security headers for the monitor page to load CDN module scripts
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
let wss = null;
if (process.env.NODE_ENV !== 'test') {
  wss = createWebSocketServer(server);
}

const port = process.env.PORT || 3000;

// Telnyx webhook must see raw body for signature verification; mount before JSON parser
app.use('/api/telnyx', telnyxRouter);

// CORS with comma-separated allowlist
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

// JSON parser with body size limit
app.use(express.json({ limit: process.env.BODY_LIMIT || '1mb' }));

// Root shows the login page (public)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'login.html'));
});

// Health endpoints
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/readyz', (req, res) => res.status(200).json({ ready: true }));

// Serve static monitor and call recordings (optionally protected)
const recordingsDir = path.join(__dirname, 'recordings');
// Public: login page
app.get('/app/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'login.html'));
});
// Protected: app shell and tools
app.use('/app', requireSession, express.static(path.join(__dirname, 'public', 'app')));
// Remove broad root-protected static to avoid intercepting /api/auth/login
// Legacy pages (monitor/admin) can be accessed during transition under /legacy if needed
if (process.env.PROTECT_RECORDINGS === '1') {
  app.use('/recordings', auth, express.static(recordingsDir));
} else {
  app.use('/recordings', express.static(recordingsDir));
}

// Rate limiting for API routes (exclude Telnyx webhook)
const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const max = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const limiter = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// Protect API routes with simple bearer auth
// Auth endpoints
app.use('/api/auth', authRouter);

// Use either bearer token (service) or session cookie (UI)
app.use('/api/calls', allowBearerOrSession, callsRouter);
app.use('/api/agent', allowBearerOrSession, agentRouter);
app.use('/api/livekit', allowBearerOrSession, livekitRouter);
app.use('/api/campaigns', allowBearerOrSession, campaignsRouter);
app.use('/api/dashboard', allowBearerOrSession, dashboardRouter);
app.use('/api/customers', allowBearerOrSession, customersRouter);
app.use('/api/agents', agentsRouter);

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = { app, server, wss };
