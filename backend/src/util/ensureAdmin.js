const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function ensureAdmin() {
  try {
    const count = await User.countDocuments();
    if (count > 0) return { created: false };
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || '';
    if (!email || !password) {
      console.warn('[auth] No users exist but ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping auto-seed');
      return { created: false, reason: 'missing env' };
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ email, passwordHash, role: 'admin', active: true });
    console.log('[auth] Auto-seeded initial admin user:', email);
    return { created: true };
  } catch (e) {
    console.warn('[auth] ensureAdmin failed:', e?.message || e);
    return { created: false, error: true };
  }
}

module.exports = ensureAdmin;

