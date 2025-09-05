require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { createWebSocketServer } = require('./websocket');
const callsRouter = require('./api/routes/calls');
const telnyxRouter = require('./api/routes/telnyx');
const campaignsRouter = require('./api/routes/campaigns');
const dashboardRouter = require('./api/routes/dashboard');
const customersRouter = require('./api/routes/customers');
const connectDB = require('./config/database');
const validateEnv = require('./config/validateEnv');
const auth = require('./middleware/auth');

// Validate env & connect to MongoDB (skip DB in tests)
if (process.env.NODE_ENV !== 'test') {
  validateEnv();
  connectDB();
}

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.use(helmet());
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

app.get('/', (req, res) => {
  res.send('Hello, Gemini!');
});

// Health endpoints
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/readyz', (req, res) => res.status(200).json({ ready: true }));

// Serve call recordings (optionally protected)
const recordingsDir = path.join(__dirname, 'recordings');
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
app.use('/api/calls', auth, callsRouter);
app.use('/api/campaigns', auth, campaignsRouter);
app.use('/api/dashboard', auth, dashboardRouter);
app.use('/api/customers', auth, customersRouter);

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = { app, server, wss };
