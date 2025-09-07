const TTL_MS = 30 * 60 * 1000; // 30 minutes
const rooms = new Map(); // name -> lastSeen

function touch(room) {
  if (!room) return;
  rooms.set(String(room), Date.now());
}

function list() {
  const now = Date.now();
  const out = [];
  for (const [name, ts] of rooms.entries()) {
    if (now - ts <= TTL_MS) out.push({ name, last_seen: ts });
  }
  out.sort((a, b) => b.last_seen - a.last_seen);
  return out;
}

module.exports = { touch, list };

