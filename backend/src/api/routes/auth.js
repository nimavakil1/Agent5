const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();

// Helper function to log audit events
async function logAuditEvent(userId, userEmail, action, resource, resourceId, details, req, success = true) {
  try {
    const auditLog = new AuditLog({
      user_id: userId,
      user_email: userEmail,
      action,
      resource,
      resource_id: resourceId,
      details,
      ip_address: req.ip || req.connection.remoteAddress,
      user_agent: req.get('User-Agent'),
      success
    });
    await auditLog.save();
  } catch (err) {
    console.error('Failed to log audit event:', err);
  }
}

function signJwt(user) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const payload = { sub: user._id.toString(), email: user.email, role: user.role };
  return jwt.sign(payload, secret, { expiresIn: '4h' });
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'email and password required' });
    const lower = String(email).trim().toLowerCase();
    let user = await User.findOne({ email: lower, active: true });
    if (!user) {
      // Fallback: search without active flag to help diagnose mismatches
      const anyUser = await User.findOne({ email: lower });
      if (anyUser && anyUser.active === false) {
        console.warn('login: user-inactive', lower);
        await logAuditEvent(anyUser._id.toString(), anyUser.email, 'login', 'auth', null, { reason: 'account_disabled' }, req, false);
        return res.status(403).json({ message: 'Account disabled' });
      }
      console.warn('login: user-not-found', lower);
      await logAuditEvent('unknown', lower, 'login', 'auth', null, { reason: 'user_not_found' }, req, false);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      console.warn('login: password-mismatch for', user.email);
      await logAuditEvent(user._id.toString(), user.email, 'login', 'auth', null, { reason: 'invalid_password' }, req, false);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    // Log successful login
    await logAuditEvent(user._id.toString(), user.email, 'login', 'auth', null, { role: user.role }, req, true);
    
    const token = signJwt(user);
    // In dev (http://localhost), Secure cookies won't set. Enable Secure only in production
    const cookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: (process.env.COOKIE_SECURE === '1') || (process.env.NODE_ENV === 'production'),
      maxAge: 4 * 60 * 60 * 1000,
      path: '/',
    };
    res.cookie('access_token', token, cookieOpts);
    res.json({ id: user._id, email: user.email, role: user.role });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ message: 'error' });
  }
});

router.post('/logout', requireSession, async (req, res) => {
  try {
    // Log logout event
    const uid = (req.user && (req.user.id || req.user._id)) ? String(req.user.id || req.user._id) : 'unknown';
    await logAuditEvent(uid, req.user.email, 'logout', 'auth', null, {}, req, true);
    
    res.clearCookie('access_token', { path: '/' });
    res.json({ ok: true });
  } catch (e) {
    console.error('logout error', e);
    res.clearCookie('access_token', { path: '/' });
    res.json({ ok: true }); // Still clear cookie even if audit logging fails
  }
});

router.get('/me', requireSession, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role });
});

// --- Admin user management ---
router.get('/users', requireSession, async (req, res) => {
  try {
    if (!['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ message: 'forbidden' });
    const users = await User.find({}).select('_id email role active createdAt updatedAt').sort({ createdAt: -1 }).lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ message: 'error' });
  }
});

router.put('/users/:id', requireSession, async (req, res) => {
  try {
    if (!['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ message: 'forbidden' });
    const { role, active } = req.body || {};
    const update = {};
    if (role) {
      // do not allow setting superadmin via API
      if (role === 'superadmin') return res.status(400).json({ message: 'cannot assign superadmin' });
      update.role = role === 'admin' ? 'admin' : (role === 'manager' ? 'manager' : 'user');
    }
    if (typeof active === 'boolean') update.active = active;
    // prevent modifying superadmin record
    const target = await User.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ message: 'not found' });
    if (target.role === 'superadmin') return res.status(403).json({ message: 'superadmin immutable' });
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }).select('_id email role active createdAt updatedAt');
    if (!user) return res.status(404).json({ message: 'not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ message: 'error' });
  }
});

router.post('/users/:id/reset-password', requireSession, async (req, res) => {
  try {
    if (!['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ message: 'forbidden' });
    const { password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ message: 'password too short' });
    const target = await User.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ message: 'not found' });
    if (target.role === 'superadmin' && String(target._id) !== String(req.user.id)) return res.status(403).json({ message: 'cannot reset superadmin' });
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.findByIdAndUpdate(req.params.id, { passwordHash }, { new: true });
    if (!user) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: 'error' });
  }
});

// Self password change
router.post('/me/password', requireSession, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 6) return res.status(400).json({ message: 'password too short' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'not found' });
    // if a current password is provided, verify
    if (current_password) {
      const ok = await bcrypt.compare(String(current_password), user.passwordHash);
      if (!ok) return res.status(400).json({ message: 'current password invalid' });
    }
    user.passwordHash = await bcrypt.hash(String(new_password), 10);
    await user.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: 'error' });
  }
});

// Admin-only: create user (seed minimal)
router.post('/users', requireSession, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'forbidden' });
    const { email, password, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'email and password required' });
    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) return res.status(409).json({ message: 'user exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: String(email).toLowerCase(), passwordHash, role: role === 'admin' ? 'admin' : 'user' });
    res.status(201).json({ id: user._id, email: user.email, role: user.role });
  } catch (e) {
    console.error('create user error', e);
    res.status(500).json({ message: 'error' });
  }
});

module.exports = router;
