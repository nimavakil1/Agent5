// Mongo-backed pooled room allocator to avoid double-booking across instances
const RoomLock = require('../models/RoomLock');

function poolNames(size) {
  const n = Math.max(1, Math.min(50, Number(size || process.env.ROOM_POOL_SIZE || 15)));
  return Array.from({ length: n }, (_, i) => `room${i + 1}`);
}

async function allocate({ owner = 'server', ttlMs } = {}) {
  const ttl = Number(ttlMs || process.env.ROOM_LOCK_TTL_MS || 30 * 60 * 1000);
  const names = poolNames();
  for (const name of names) {
    try {
      await RoomLock.create({ name, owner, expiresAt: new Date(Date.now() + ttl) });
      return name;
    } catch (_) {
      // duplicate key -> already taken, try next
    }
  }
  return null;
}

async function release(name) {
  if (!name) return false;
  try { await RoomLock.deleteOne({ name: String(name) }); return true; } catch { return false; }
}

function isInPool(name) {
  return poolNames().includes(String(name || ''));
}

module.exports = { allocate, release, isInPool, poolNames };

