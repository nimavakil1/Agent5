// In-memory registry of active PSTN sessions keyed by room name.
// Allows control from HTTP routes and operator bridge.

const sessions = new Map();

function set(room, data) {
  if (!room) return;
  const r = String(room);
  const prev = sessions.get(r) || {};
  sessions.set(r, { ...prev, ...data });
}

function get(room) {
  if (!room) return null;
  return sessions.get(String(room)) || null;
}

function remove(room) {
  if (!room) return;
  sessions.delete(String(room));
}

async function stopAI(room) {
  const s = get(room);
  if (!s) return false;
  try {
    s.aiStopped = true;
    if (s.openaiWs && s.openaiWs.readyState === 1) {
      try { s.openaiWs.close(); } catch(_) {}
    }
    if (s.livekitPublisher && typeof s.livekitPublisher.muteAgent === 'function') {
      try { s.livekitPublisher.muteAgent(true); } catch(_) {}
    }
    return true;
  } catch (_) {
    return false;
  }
}

function sendPcmuToPstn(room, pcmuFrame, streamId) {
  const s = get(room);
  if (!s || !s.telnyxWs) return false;
  try {
    const payload = pcmuFrame.toString('base64');
    const msg = { event: 'media', media: { payload } };
    if (s.telnyxStreamId || streamId) msg.stream_id = streamId || s.telnyxStreamId;
    s.telnyxWs.send(JSON.stringify(msg));
    return true;
  } catch (e) {
    return false;
  }
}

function setAgentMute(room, mute) {
  const s = get(room);
  if (!s || !s.livekitPublisher) return false;
  try { s.livekitPublisher.muteAgent(!!mute); return true; } catch(_) { return false; }
}

module.exports = { set, get, remove, stopAI, sendPcmuToPstn, setAgentMute };

