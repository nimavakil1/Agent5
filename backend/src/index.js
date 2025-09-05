require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { createWebSocketServer } = require('./websocket');
const callsRouter = require('./api/routes/calls');
const telnyxRouter = require('./api/routes/telnyx');
const campaignsRouter = require('./api/routes/campaigns');
const dashboardRouter = require('./api/routes/dashboard');
const customersRouter = require('./api/routes/customers');
const connectDB = require('./config/database');
const auth = require('./middleware/auth');

// Connect to MongoDB
connectDB();

const app = express();
const server = http.createServer(app);
const wss = createWebSocketServer(server);

const port = process.env.PORT || 3000;

// Telnyx webhook must see raw body for signature verification; mount before JSON parser
app.use('/api/telnyx', telnyxRouter);

// Optional CORS (configure CORS_ORIGIN to enable)
if (process.env.CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// JSON parser for most routes
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello, Gemini!');
});

// Serve call recordings (consider protecting behind auth in production)
const recordingsDir = path.join(__dirname, 'recordings');
app.use('/recordings', express.static(recordingsDir));

// Protect API routes with simple bearer auth
app.use('/api/calls', auth, callsRouter);
app.use('/api/campaigns', auth, campaignsRouter);
app.use('/api/dashboard', auth, dashboardRouter);
app.use('/api/customers', auth, customersRouter);

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
