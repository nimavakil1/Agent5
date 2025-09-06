const express = require('express');
const WebSocket = require('ws');
const { AccessToken } = require('livekit-server-sdk');
const router = express.Router();
const { getSettings, setSettings } = require('../../config/agentSettings');
const { createPublisher } = require('../../livekit/publisher');

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.post('/settings', (req, res) => {
  const { instructions, voice } = req.body || {};
  setSettings({ instructions, voice });
  res.json(getSettings());
});

// Demo: make the agent speak into a LiveKit room without Telnyx
// POST /api/agent/demo-speak { room: string, text?: string }
router.post('/demo-speak', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const roomName = String((body.room ?? req.query.room ?? '')).trim();
    const text = String((body.text ?? req.query.text ?? 'Please introduce yourself briefly.'));
    if (!roomName) return res.status(400).json({ message: 'room is required' });

    const host = process.env.LIVEKIT_SERVER_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!host || !apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });

    const identity = `demo-agent-${Date.now()}`;
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: false });
    const token = await at.toJwt();

    const publisher = await createPublisher({ host, token, roomName });
    if (!publisher) return res.status(500).json({ message: 'Failed to start LiveKit publisher' });

    // Connect directly to OpenAI Realtime WS (server-side)
    const { instructions, voice } = getSettings();
    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const OPENAI_REALTIME_WS_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    // Try explicit WS subprotocol used by some Realtime deployments
    const openaiWs = new WebSocket(OPENAI_REALTIME_WS_URL, 'realtime', {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWs.on('open', () => {
      try {
        // Update session settings
        openaiWs.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              instructions: instructions || 'You are a helpful AI assistant for a call center.',
              voice: voice || undefined,
            },
          })
        );
        // Provide an input text then request a response with audio
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            content: { type: 'input_text', text },
          })
        );
        openaiWs.send(
          JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'], voice: voice || undefined } })
        );
      } catch (e) {
        console.error('openai send error', e);
      }
    });

    openaiWs.on('message', (data) => {
      try {
        const str = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(str);
        if (msg.type) console.log('OpenAI msg type:', msg.type);
        if (msg.type === 'response.output_audio.delta' && msg.delta) {
          const pcm24k = Buffer.from(msg.delta, 'base64');
          publisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
        }
      } catch (e) {
        console.error('openai msg error', e);
      }
    });

    openaiWs.on('close', async (code, reason) => {
      console.log('OpenAI WS close', code, reason?.toString());
      try { await publisher.close(); } catch (_) {}
    });
    openaiWs.on('error', async (err) => {
      console.error('OpenAI WS error', err?.message || err);
      try { await publisher.close(); } catch (_) {}
    });

    res.json({ message: 'started', room: roomName, identity });
  } catch (e) {
    console.error('demo-speak error', e);
    res.status(500).json({ message: 'error' });
  }
});

// Demo: generate a test tone into the room without OpenAI
// POST /api/agent/demo-tone?room=...&freq=440&seconds=3
router.post('/demo-tone', async (req, res) => {
  try {
    const roomName = String((req.body?.room ?? req.query.room ?? '')).trim();
    const freq = Number(req.body?.freq ?? req.query.freq ?? 440);
    const seconds = Number(req.body?.seconds ?? req.query.seconds ?? 3);
    if (!roomName) return res.status(400).json({ message: 'room is required' });

    const host = process.env.LIVEKIT_SERVER_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!host || !apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });

    const identity = `tone-agent-${Date.now()}`;
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: false });
    const token = await at.toJwt();

    const publisher = await createPublisher({ host, token, roomName });
    if (!publisher) return res.status(500).json({ message: 'Failed to start LiveKit publisher' });

    // Generate 48kHz mono sine wave
    const sampleRate = 48000;
    const totalSamples = Math.floor(seconds * sampleRate);
    const int16 = new Int16Array(totalSamples);
    const amplitude = 0.2 * 32767;
    for (let i = 0; i < totalSamples; i++) {
      int16[i] = Math.floor(amplitude * Math.sin(2 * Math.PI * freq * (i / sampleRate)));
    }
    publisher.pushAgentFrom48kInt16(int16);

    // Close the publisher after playback
    setTimeout(async () => {
      try { await publisher.close(); } catch (_) {}
    }, (seconds + 0.5) * 1000);

    res.json({ message: 'started', room: roomName, seconds, freq });
  } catch (e) {
    console.error('demo-tone error', e);
    res.status(500).json({ message: 'error' });
  }
});

module.exports = router;
