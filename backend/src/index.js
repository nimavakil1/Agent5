require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { createWebSocketServer } = require('./websocket');
const callsRouter = require('./api/routes/calls');
const telnyxRouter = require('./api/routes/telnyx');
const campaignsRouter = require('./api/routes/campaigns');
const dashboardRouter = require('./api/routes/dashboard');
const customersRouter = require('./api/routes/customers');
const connectDB = require('./config/database');
const auth = require('./middleware/auth');

// Connect to MongoDB (skip during tests)
if (process.env.NODE_ENV !== 'test') {
  connectDB();
}

const app = express();
const server = http.createServer(app);
let wss = null;
if (process.env.NODE_ENV !== 'test') {
  wss = createWebSocketServer(server);
}

const port = process.env.PORT || 3000;

// Telnyx webhook must see raw body for signature verification; mount before JSON parser
app.use('/api/telnyx', telnyxRouter);

// CORS
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: false }));
}

// JSON parser for most routes
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello, Gemini!');
});

// Serve call recordings (consider protecting behind auth in production)
const recordingsDir = path.join(__dirname, 'recordings');
app.use('/recordings', express.static(recordingsDir));

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
