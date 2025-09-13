// Fixed-size room pool allocator (room1..roomN). In-memory only.
const DEFAULT_SIZE = 15;
const state = {
  size: DEFAULT_SIZE,
  inUse: new Set(), // names currently allocated
};

function list(size = state.size) {
  const n = Math.max(1, Math.min(50, Number(size||state.size)));
  return Array.from({ length: n }, (_, i) => `room${i+1}`);
}

function configure(size) {
  const n = Math.max(1, Math.min(50, Number(size||DEFAULT_SIZE)));
  state.size = n;
}

function allocate() {
  const pool = list();
  for (const name of pool) {
    if (!state.inUse.has(name)) {
      state.inUse.add(name);
      return name;
    }
  }
  return null; // none available
}

function release(name) {
  if (!name) return false;
  return state.inUse.delete(String(name));
}

function markActive(name) {
  if (!name) return;
  const pool = list();
  if (pool.includes(String(name))) state.inUse.add(String(name));
}

function isInPool(name) {
  return list().includes(String(name||''));
}

module.exports = { list, configure, allocate, release, markActive, isInPool };

