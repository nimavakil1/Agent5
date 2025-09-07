const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');

// Middleware to check admin role
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

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

// Get all users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}, '-passwordHash').sort({ createdAt: -1 });
    
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'users_list_viewed',
      'users',
      null,
      { count: users.length },
      req
    );
    
    res.json(users);
  } catch (error) {
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'users_list_viewed',
      'users',
      null,
      { error: error.message },
      req,
      false
    );
    res.status(500).json({ message: 'Failed to fetch users', error: error.message });
  }
});

// Create new user
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { email, password, role = 'user', active = true } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      await logAuditEvent(
        req.user._id,
        req.user.email,
        'user_create',
        'user',
        null,
        { email, error: 'User already exists' },
        req,
        false
      );
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = new User({
      email,
      passwordHash,
      role,
      active
    });

    await user.save();

    await logAuditEvent(
      req.user._id,
      req.user.email,
      'user_create',
      'user',
      user._id.toString(),
      { email, role, active },
      req
    );

    // Return user without password hash
    const { passwordHash: _, ...userResponse } = user.toObject();
    res.status(201).json(userResponse);
  } catch (error) {
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'user_create',
      'user',
      null,
      { email: req.body.email, error: error.message },
      req,
      false
    );
    res.status(500).json({ message: 'Failed to create user', error: error.message });
  }
});

// Update user
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { email, password, role, active } = req.body;
    const updateData = { email, role, active };

    // If password is provided, hash it
    if (password) {
      const saltRounds = 10;
      updateData.passwordHash = await bcrypt.hash(password, saltRounds);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-passwordHash');

    if (!user) {
      await logAuditEvent(
        req.user._id,
        req.user.email,
        'user_update',
        'user',
        req.params.id,
        { error: 'User not found' },
        req,
        false
      );
      return res.status(404).json({ message: 'User not found' });
    }

    await logAuditEvent(
      req.user._id,
      req.user.email,
      'user_update',
      'user',
      user._id.toString(),
      { email, role, active, passwordChanged: !!password },
      req
    );

    res.json(user);
  } catch (error) {
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'user_update',
      'user',
      req.params.id,
      { error: error.message },
      req,
      false
    );
    res.status(500).json({ message: 'Failed to update user', error: error.message });
  }
});

// Delete user
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user._id.toString()) {
      await logAuditEvent(
        req.user._id,
        req.user.email,
        'user_delete',
        'user',
        req.params.id,
        { error: 'Cannot delete own account' },
        req,
        false
      );
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      await logAuditEvent(
        req.user._id,
        req.user.email,
        'user_delete',
        'user',
        req.params.id,
        { error: 'User not found' },
        req,
        false
      );
      return res.status(404).json({ message: 'User not found' });
    }

    await User.findByIdAndDelete(req.params.id);

    await logAuditEvent(
      req.user._id,
      req.user.email,
      'user_delete',
      'user',
      req.params.id,
      { email: user.email },
      req
    );

    res.status(204).send();
  } catch (error) {
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'user_delete',
      'user',
      req.params.id,
      { error: error.message },
      req,
      false
    );
    res.status(500).json({ message: 'Failed to delete user', error: error.message });
  }
});

// Get audit log
router.get('/audit-log', requireAdmin, async (req, res) => {
  try {
    const { action, limit = 50, export: isExport } = req.query;
    const query = {};
    
    if (action) {
      query.action = action;
    }

    const auditLogs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(isExport ? 0 : parseInt(limit))
      .lean();

    if (!isExport) {
      await logAuditEvent(
        req.user._id,
        req.user.email,
        'audit_log_viewed',
        'audit_log',
        null,
        { filter: action, count: auditLogs.length },
        req
      );
    }

    res.json(auditLogs);
  } catch (error) {
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'audit_log_viewed',
      'audit_log',
      null,
      { error: error.message },
      req,
      false
    );
    res.status(500).json({ message: 'Failed to fetch audit log', error: error.message });
  }
});

// Clean up old audit logs
router.delete('/audit-log/cleanup', requireAdmin, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await AuditLog.deleteMany({ timestamp: { $lt: thirtyDaysAgo } });

    await logAuditEvent(
      req.user._id,
      req.user.email,
      'audit_log_cleanup',
      'audit_log',
      null,
      { deletedCount: result.deletedCount, cutoffDate: thirtyDaysAgo },
      req
    );

    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    await logAuditEvent(
      req.user._id,
      req.user.email,
      'audit_log_cleanup',
      'audit_log',
      null,
      { error: error.message },
      req,
      false
    );
    res.status(500).json({ message: 'Failed to cleanup audit logs', error: error.message });
  }
});

module.exports = router;