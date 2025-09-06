const express = require('express');
const router = express.Router();
const { AccessToken } = require('livekit-server-sdk');

router.get('/token', async (req, res) => {
  try {
    const room = String(req.query.room || '').trim();
    const identity = String(req.query.identity || `viewer-${Date.now()}`);
    if (!room) return res.status(400).json({ message: 'room is required' });

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });

    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ room, roomJoin: true, canPublish: false, canSubscribe: true });
    const token = await at.toJwt();
    res.json({ token, room, identity, host: process.env.LIVEKIT_SERVER_URL });
  } catch (e) {
    console.error('livekit token error', e);
    res.status(500).json({ message: 'error' });
  }
});

module.exports = router;
