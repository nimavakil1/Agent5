require('dotenv').config();
const express = require('express');
const http = require('http');
const { createWebSocketServer } = require('./websocket');
const callsRouter = require('./api/routes/calls');
const telnyxRouter = require('./api/routes/telnyx');
const campaignsRouter = require('./api/routes/campaigns');
const dashboardRouter = require('./api/routes/dashboard');
const customersRouter = require('./api/routes/customers');
const connectDB = require('./config/database');

// Connect to MongoDB
connectDB();

const app = express();
const server = http.createServer(app);
const wss = createWebSocketServer(server);

const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello, Gemini!');
});

app.use('/api/calls', callsRouter);
app.use('/api/telnyx', telnyxRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/customers', customersRouter);

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});