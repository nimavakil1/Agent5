const express = require('express');
const WebSocket = require('ws');
const { AccessToken } = require('livekit-server-sdk');
const router = express.Router();
const { getSettings, setSettings } = require('../../config/agentSettings');
const { createPublisher } = require('../../livekit/publisher');

router.get('/settings', async (req, res) => {
  const s = await getSettings();
  res.json(s);
});

router.post('/settings', async (req, res) => {
  const { instructions, voice } = req.body || {};
  const s = await setSettings({ instructions, voice }, 'api');
  res.json(s);
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
    // Load saved agent settings (voice + instructions)
    const { instructions, voice } = await getSettings();
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
        // Update session settings (English-only). input_audio_format as string for compatibility.
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            // Use saved instructions as-is and enable server-side turn detection
            instructions: instructions || 'You are a helpful assistant.',
            voice: voice || undefined,
            input_audio_format: 'pcm16',
            turn_detection: { type: 'server_vad', threshold: 0.38, prefix_padding_ms: 180, silence_duration_ms: 220 },
          },
        }));
        // Log a short preview of the instructions used (for debugging)
        try {
          const preview = ((instructions || '').slice(0, 160) || '(default)')
            .replace(/\s+/g, ' ');
          console.log('Agent settings -> voice:', voice || '(default)', '| instructions:', preview);
        } catch (_) {}
        // Log a short preview of the demo-speak prompt text
        try {
          const textPreview = (text || '').slice(0, 160).replace(/\s+/g, ' ');
          console.log('Demo-speak prompt ->', textPreview || '(empty)');
        } catch (_) {}
        // Create input item then request a response (audio + text)
        // Some deployments require a 'message' item with content parts
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        }));
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio','text'], voice: voice || undefined },
        }));
      } catch (e) {
        console.error('openai send error', e);
      }
    });

    openaiWs.on('message', (data) => {
      try {
        const str = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(str);
        if (msg.type) console.log('OpenAI msg type:', msg.type);
        // Accept both legacy and current event names
        if ((msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta') && msg.delta) {
          const pcm24k = Buffer.from(msg.delta, 'base64');
          publisher.pushAgentFrom24kPcm16LEBuffer(pcm24k);
        }
        if (msg.type === 'error') {
          console.error('OpenAI error event:', msg);
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
