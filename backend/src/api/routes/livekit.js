const express = require('express');
const router = express.Router();
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

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

// List active rooms (server-side)
router.get('/rooms', async (req, res) => {
  try {
    const host = process.env.LIVEKIT_SERVER_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!host || !apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });
    const svc = new RoomServiceClient(host, apiKey, apiSecret);
    const rooms = await svc.listRooms();
    // Return a compact summary
    res.json(rooms.map(r => ({ name: r.name, num_participants: r.numParticipants || r.num_participants, empty_timeout: r.emptyTimeout || r.empty_timeout, creation_time: r.creationTime || r.creation_time })));
  } catch (e) {
    console.error('livekit rooms error', e);
    res.status(500).json({ message: 'error' });
  }
});

// List participants for a given room
router.get('/rooms/:name/participants', async (req, res) => {
  try {
    const host = process.env.LIVEKIT_SERVER_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!host || !apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });
    const svc = new RoomServiceClient(host, apiKey, apiSecret);
    const parts = await svc.listParticipants(req.params.name);
    res.json(parts.map(p => ({ identity: p.identity, name: p.name, metadata: p.metadata, joined_at: p.joinedAt || p.joined_at })));
  } catch (e) {
    console.error('livekit participants error', e);
    res.status(500).json({ message: 'error' });
  }
});

module.exports = router;
