const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();

function signJwt(user) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const payload = { sub: user._id.toString(), email: user.email, role: user.role };
  return jwt.sign(payload, secret, { expiresIn: '15m' });
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
        return res.status(403).json({ message: 'Account disabled' });
      }
      console.warn('login: user-not-found', lower);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      console.warn('login: password-mismatch for', user.email);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const token = signJwt(user);
    const cookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 15 * 60 * 1000,
      path: '/',
    };
    res.cookie('access_token', token, cookieOpts);
    res.json({ id: user._id, email: user.email, role: user.role });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ message: 'error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('access_token', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireSession, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role });
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
