const express = require('express');
const router = express.Router();
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const roomsStore = require('../../util/roomsStore');
const sessionRegistry = require('../../util/sessionRegistry');

function toHttpUrl(u) {
  if (!u) return '';
  if (u.startsWith('https://') || u.startsWith('http://')) return u;
  if (u.startsWith('wss://')) return 'https://' + u.slice(6);
  if (u.startsWith('ws://')) return 'http://' + u.slice(5);
  return u;
}

router.get('/token', async (req, res) => {
  try {
    const room = String(req.query.room || '').trim();
    const identity = String(req.query.identity || `viewer-${Date.now()}`);
    if (!room) return res.status(400).json({ message: 'room is required' });

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });

    const at = new AccessToken(apiKey, apiSecret, { identity });
    const canPublish = String(req.query.pub || req.query.publish || '').toLowerCase() === '1';
    at.addGrant({ room, roomJoin: true, canPublish, canSubscribe: true });
    const token = await at.toJwt();
    try { roomsStore.touch(room); } catch(_) {}
    res.json({ token, room, identity, host: process.env.LIVEKIT_SERVER_URL });
  } catch (e) {
    console.error('livekit token error', e);
    res.status(500).json({ message: 'error' });
  }
});

// List active rooms (server-side)
router.get('/rooms', async (req, res) => {
  try {
    const host = process.env.LIVEKIT_API_URL || toHttpUrl(process.env.LIVEKIT_SERVER_URL);
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!host || !apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit not configured' });
    const svc = new RoomServiceClient(host, apiKey, apiSecret);
    const rooms = await svc.listRooms();
    // Return a compact summary (coerce BigInt to Number)
    const out = rooms.map((r) => ({
      name: r.name,
      num_participants: Number(r.numParticipants ?? r.num_participants ?? 0),
      empty_timeout: Number(r.emptyTimeout ?? r.empty_timeout ?? 0),
      creation_time: Number(r.creationTime ?? r.creation_time ?? 0),
    }));
    res.json(out);
  } catch (e) {
    console.error('livekit rooms error', e);
    // Fallback to recent rooms in memory
    try { return res.json(roomsStore.list()); } catch(_) {}
    res.status(500).json({ message: 'error' });
  }
});

// List participants for a given room
router.get('/rooms/:name/participants', async (req, res) => {
  try {
    const host = process.env.LIVEKIT_API_URL || toHttpUrl(process.env.LIVEKIT_SERVER_URL);
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

// Fallback: recent rooms seen by this backend (no admin API)
router.get('/recent-rooms', (req, res) => {
  try { res.json(roomsStore.list()); } catch (_) { res.json([]); }
});

// Control: stop AI in a room (cancel OpenAI + mute agent track)
router.post('/rooms/:name/stop_ai', async (req, res) => {
  try {
    const ok = await sessionRegistry.stopAI(req.params.name);
    if (!ok) return res.status(404).json({ message: 'room not found or no AI session' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: 'error', error: e.message });
  }
});

// Control: mute/unmute agent track in LiveKit
router.post('/rooms/:name/mute_agent', async (req, res) => {
  try {
    const mute = String(req.query.mute || req.body?.mute || '').toLowerCase();
    const v = mute === '1' || mute === 'true' || mute === 'yes';
    const ok = sessionRegistry.setAgentMute(req.params.name, v);
    if (!ok) return res.status(404).json({ message: 'room not found' });
    res.json({ ok: true, muted: v });
  } catch (e) {
    res.status(500).json({ message: 'error', error: e.message });
  }
});

// Diagnostics: connectivity, recent rooms, sessions
router.get('/debug', async (req, res) => {
  const out = { ok: true, api: {}, recent_rooms: [], sessions: [] };
  try {
    const host = process.env.LIVEKIT_API_URL || toHttpUrl(process.env.LIVEKIT_SERVER_URL);
    out.api.host = host || null;
    out.api.hasKeys = !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    if (host && out.api.hasKeys) {
      try {
        const svc = new RoomServiceClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
        const rooms = await svc.listRooms();
        out.api.listRooms = { ok: true, count: rooms.length };
      } catch (e) {
        out.api.listRooms = { ok: false, error: e.message };
      }
    }
  } catch (e) {
    out.api.error = e.message;
  }
  try { out.recent_rooms = roomsStore.list(); } catch (_) {}
  try { out.sessions = sessionRegistry._list(); } catch (_) {}
  res.json(out);
});

module.exports = router;
