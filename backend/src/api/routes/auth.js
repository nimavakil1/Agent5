const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const { requireSession } = require('../../middleware/sessionAuth');
const { requirePrivilege } = require('../../middleware/priv');
const Role = require('../../models/Role');
const { getModuleAccessForUser, listAllModules } = require('../../util/privileges');
const {
  createInvitation,
  resendInvitation,
  sendInvitationEmail,
  validateInviteToken,
  completeRegistration
} = require('../services/invitationService');

// Configure multer for avatar uploads
const avatarDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'avatars');
if (!fs.existsSync(avatarDir)) {
  fs.mkdirSync(avatarDir, { recursive: true });
}

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${req.user.id}-${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  }
});

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
      if (anyUser && anyUser.status === 'pending') {
        console.warn('login: user-pending', lower);
        await logAuditEvent(anyUser._id.toString(), anyUser.email, 'login', 'auth', null, { reason: 'account_pending' }, req, false);
        return res.status(403).json({ message: 'Please complete your registration using the invitation link sent to your email' });
      }
      console.warn('login: user-not-found', lower);
      await logAuditEvent('unknown', lower, 'login', 'auth', null, { reason: 'user_not_found' }, req, false);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    // Check if user status is pending
    if (user.status === 'pending') {
      console.warn('login: user-pending', lower);
      await logAuditEvent(user._id.toString(), user.email, 'login', 'auth', null, { reason: 'account_pending' }, req, false);
      return res.status(403).json({ message: 'Please complete your registration using the invitation link sent to your email' });
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

router.get('/me', requireSession, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('email role avatar').lean();
    res.json({ id: req.user.id, email: user.email, role: user.role, avatar: user.avatar });
  } catch (e) {
    res.json({ id: req.user.id, email: req.user.email, role: req.user.role, avatar: null });
  }
});

// Upload avatar
router.post('/me/avatar', requireSession, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Delete old avatar if exists
    const user = await User.findById(req.user.id);
    if (user.avatar) {
      const oldPath = path.join(avatarDir, path.basename(user.avatar));
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    // Save new avatar URL
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await User.findByIdAndUpdate(req.user.id, { avatar: avatarUrl });

    res.json({ avatar: avatarUrl });
  } catch (e) {
    console.error('Avatar upload error:', e);
    res.status(500).json({ message: 'Upload failed' });
  }
});

// Delete avatar
router.delete('/me/avatar', requireSession, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user.avatar) {
      const oldPath = path.join(avatarDir, path.basename(user.avatar));
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
      await User.findByIdAndUpdate(req.user.id, { avatar: null });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Avatar delete error:', e);
    res.status(500).json({ message: 'Delete failed' });
  }
});

// Get modules user has access to
router.get('/me/modules', requireSession, async (req, res) => {
  try {
    const modules = await getModuleAccessForUser(req.user);
    res.json({ modules });
  } catch (e) {
    console.error('get modules error', e);
    res.status(500).json({ message: 'error' });
  }
});

// Get all available modules (admin only)
router.get('/modules/list', requireSession, requirePrivilege('roles.view'), async (req, res) => {
  res.json({ modules: listAllModules() });
});

// --- Admin user management ---
router.get('/users', requireSession, requirePrivilege('users.view'), async (req, res) => {
  try {
    const users = await User.find({}).select('_id email firstName lastName role roleId active status createdAt updatedAt').sort({ createdAt: -1 }).lean();
    // attach role names if ref present
    const ids = users.map(u=>u.roleId).filter(Boolean);
    const roleMap = new Map((await Role.find({ _id: { $in: ids } }).lean()).map(r=>[String(r._id), r.name]));
    const out = users.map(u=> ({...u, roleName: u.roleId ? roleMap.get(String(u.roleId)) || u.role : u.role }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ message: 'error' });
  }
});

router.put('/users/:id', requireSession, requirePrivilege('users.manage'), async (req, res) => {
  try {
    const { role, roleId, active, firstName, lastName } = req.body || {};
    const update = {};
    if (roleId) {
      update.roleId = roleId;
    } else if (role) {
      // do not allow setting superadmin via API
      if (role === 'superadmin') return res.status(400).json({ message: 'cannot assign superadmin' });
      update.role = role === 'admin' ? 'admin' : (role === 'manager' ? 'manager' : 'user');
    }
    if (typeof active === 'boolean') update.active = active;
    if (typeof firstName === 'string') update.firstName = firstName || null;
    if (typeof lastName === 'string') update.lastName = lastName || null;
    // prevent modifying superadmin record
    const target = await User.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ message: 'not found' });
    if (target.role === 'superadmin') return res.status(403).json({ message: 'superadmin immutable' });
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }).select('_id email firstName lastName role roleId active createdAt updatedAt');
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
router.post('/users', requireSession, requirePrivilege('users.manage'), async (req, res) => {
  try {
    const { email, password, role, roleId } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'email and password required' });
    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) return res.status(409).json({ message: 'user exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const body = { email: String(email).toLowerCase(), passwordHash };
    if (roleId) body.roleId = roleId; else body.role = role === 'admin' ? 'admin' : (role === 'manager' ? 'manager' : 'user');
    const user = await User.create(body);
    res.status(201).json({ id: user._id, email: user.email, role: user.role });
  } catch (e) {
    console.error('create user error', e);
    res.status(500).json({ message: 'error' });
  }
});

// Delete user (admin only)
router.delete('/users/:id', requireSession, requirePrivilege('users.manage'), async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: 'User not found' });

    // Prevent deleting superadmin
    if (target.role === 'superadmin') {
      return res.status(403).json({ message: 'Cannot delete superadmin' });
    }

    // Prevent self-deletion
    if (String(target._id) === String(req.user.id)) {
      return res.status(403).json({ message: 'Cannot delete yourself' });
    }

    await User.findByIdAndDelete(req.params.id);

    // Log audit event
    await logAuditEvent(
      req.user.id,
      req.user.email,
      'user_delete',
      'user',
      req.params.id,
      { deletedEmail: target.email, status: target.status },
      req,
      true
    );

    res.json({ success: true, message: 'User deleted' });
  } catch (e) {
    console.error('Delete user error:', e);
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

// --- Invitation endpoints ---

// Multer config for invite avatar uploads (no req.user available)
const inviteAvatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `invite-${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;
    cb(null, filename);
  }
});

const inviteAvatarUpload = multer({
  storage: inviteAvatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  }
});

// Create invitation (admin only)
router.post('/invite', requireSession, requirePrivilege('users.manage'), async (req, res) => {
  try {
    const { email, roleId, role } = req.body || {};
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const { user, inviteToken } = await createInvitation(email, roleId, role);

    // Send invitation email
    await sendInvitationEmail(user.email, inviteToken);

    // Log audit event
    await logAuditEvent(
      req.user.id,
      req.user.email,
      'user_invite',
      'user',
      user._id.toString(),
      { invitedEmail: user.email, role: user.role },
      req,
      true
    );

    res.status(201).json({
      success: true,
      message: 'Invitation sent successfully',
      user: { id: user._id, email: user.email, status: user.status }
    });
  } catch (e) {
    console.error('Create invitation error:', e);
    res.status(400).json({ message: e.message || 'Failed to create invitation' });
  }
});

// Resend invitation (admin only)
router.post('/invite/resend', requireSession, requirePrivilege('users.manage'), async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ message: 'User ID is required' });

    const { user, inviteToken } = await resendInvitation(userId);

    // Send invitation email
    await sendInvitationEmail(user.email, inviteToken);

    // Log audit event
    await logAuditEvent(
      req.user.id,
      req.user.email,
      'user_invite_resend',
      'user',
      user._id.toString(),
      { invitedEmail: user.email },
      req,
      true
    );

    res.json({
      success: true,
      message: 'Invitation resent successfully'
    });
  } catch (e) {
    console.error('Resend invitation error:', e);
    res.status(400).json({ message: e.message || 'Failed to resend invitation' });
  }
});

// Validate invite token (public)
router.get('/invite/:token', async (req, res) => {
  try {
    const result = await validateInviteToken(req.params.token);
    res.json(result);
  } catch (e) {
    console.error('Validate invite token error:', e);
    res.status(500).json({ valid: false, message: 'Error validating invitation' });
  }
});

// Complete registration (public)
router.post('/invite/:token/complete', inviteAvatarUpload.single('avatar'), async (req, res) => {
  try {
    const { password, firstName, lastName } = req.body || {};
    if (!password) {
      return res.status(400).json({ message: 'Password is required' });
    }

    // Get avatar URL if uploaded
    let avatarUrl = null;
    if (req.file) {
      avatarUrl = `/uploads/avatars/${req.file.filename}`;
    }

    const user = await completeRegistration(req.params.token, password, avatarUrl, firstName, lastName);

    // Log audit event
    await logAuditEvent(
      user._id.toString(),
      user.email,
      'user_registration_complete',
      'user',
      user._id.toString(),
      {},
      req,
      true
    );

    res.json({
      success: true,
      message: 'Registration completed successfully'
    });
  } catch (e) {
    console.error('Complete registration error:', e);
    // Clean up uploaded file if registration fails
    if (req.file) {
      const filePath = path.join(avatarDir, req.file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    res.status(400).json({ message: e.message || 'Failed to complete registration' });
  }
});

module.exports = router;
