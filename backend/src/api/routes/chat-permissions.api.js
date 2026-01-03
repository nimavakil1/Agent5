/**
 * Chat Permissions API
 *
 * Manages per-user, per-module chat permissions.
 * ONLY super admins can access these endpoints.
 *
 * Endpoints:
 * - GET /api/chat-permissions - List all users with their chat permissions
 * - GET /api/chat-permissions/summary - Get summary statistics
 * - GET /api/chat-permissions/users - Get all users for permission management
 * - GET /api/chat-permissions/:userId - Get permissions for a specific user
 * - PUT /api/chat-permissions/:userId - Update permissions for a user
 * - POST /api/chat-permissions/bulk - Bulk update permissions
 * - DELETE /api/chat-permissions/:userId - Remove all permissions for a user
 */

const express = require('express');
const router = express.Router();
const ChatPermission = require('../../models/ChatPermission');
const User = require('../../models/User');
const { CHAT_MODULES } = require('../../models/ChatPermission');

/**
 * Middleware: Require superadmin role
 */
function requireSuperAdmin(req, res, next) {
  const user = req.user || {};

  if (user.role !== 'superadmin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Only super administrators can manage chat permissions'
    });
  }

  next();
}

// Apply superadmin check to all routes
router.use(requireSuperAdmin);

/**
 * GET /api/chat-permissions
 * List all users with their chat permissions
 */
router.get('/', async (req, res) => {
  try {
    const permissions = await ChatPermission.getAllWithUsers();
    res.json({
      permissions,
      modules: CHAT_MODULES
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error listing permissions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat-permissions/summary
 * Get summary statistics
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = await ChatPermission.getSummary();
    res.json(summary);
  } catch (error) {
    console.error('[ChatPermissions API] Error getting summary:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat-permissions/users
 * Get all users for the permission management dropdown
 */
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ status: { $ne: 'inactive' } })
      .select('_id email firstName lastName role active')
      .sort({ email: 1 })
      .lean();

    // Get existing permissions
    const permissions = await ChatPermission.find({}).lean();
    const permMap = new Map(permissions.map(p => [String(p.userId), p]));

    // Combine user data with permissions
    const usersWithPerms = users.map(user => ({
      ...user,
      hasPermissions: permMap.has(String(user._id)),
      permissions: permMap.get(String(user._id))?.modules || null
    }));

    res.json({
      users: usersWithPerms,
      modules: CHAT_MODULES
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error listing users:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat-permissions/:userId
 * Get permissions for a specific user
 */
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const permission = await ChatPermission.findOne({ userId });
    if (!permission) {
      // Return default (no permissions)
      const defaultModules = {};
      CHAT_MODULES.forEach(mod => {
        defaultModules[mod] = { canChat: false, canExecute: false };
      });

      return res.json({
        userId,
        modules: defaultModules,
        isDefault: true
      });
    }

    res.json(permission);
  } catch (error) {
    console.error('[ChatPermissions API] Error getting user permissions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/chat-permissions/:userId
 * Update permissions for a user
 */
router.put('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { modules } = req.body;

    if (!modules || typeof modules !== 'object') {
      return res.status(400).json({ error: 'modules object is required' });
    }

    // Validate module names
    for (const mod of Object.keys(modules)) {
      if (!CHAT_MODULES.includes(mod)) {
        return res.status(400).json({
          error: `Invalid module: ${mod}. Valid modules: ${CHAT_MODULES.join(', ')}`
        });
      }
    }

    // Get user to verify they exist
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Normalize permissions (ensure all modules have values)
    const normalizedModules = {};
    for (const mod of CHAT_MODULES) {
      normalizedModules[mod] = {
        canChat: modules[mod]?.canChat === true,
        canExecute: modules[mod]?.canExecute === true
      };
    }

    // Update permissions
    const permission = await ChatPermission.setPermissions(
      userId,
      user.email,
      normalizedModules,
      req.user.email
    );

    console.log(`[ChatPermissions] Updated permissions for ${user.email} by ${req.user.email}`);

    res.json({
      success: true,
      permission
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error updating permissions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat-permissions/bulk
 * Bulk update permissions for multiple users
 */
router.post('/bulk', async (req, res) => {
  try {
    const { updates } = req.body;

    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates array is required' });
    }

    const results = [];

    for (const update of updates) {
      const { userId, modules } = update;

      if (!userId || !modules) {
        results.push({ userId, success: false, error: 'userId and modules required' });
        continue;
      }

      try {
        const user = await User.findById(userId);
        if (!user) {
          results.push({ userId, success: false, error: 'User not found' });
          continue;
        }

        // Normalize permissions
        const normalizedModules = {};
        for (const mod of CHAT_MODULES) {
          normalizedModules[mod] = {
            canChat: modules[mod]?.canChat === true,
            canExecute: modules[mod]?.canExecute === true
          };
        }

        await ChatPermission.setPermissions(
          userId,
          user.email,
          normalizedModules,
          req.user.email
        );

        results.push({ userId, email: user.email, success: true });
      } catch (err) {
        results.push({ userId, success: false, error: err.message });
      }
    }

    console.log(`[ChatPermissions] Bulk update by ${req.user.email}: ${results.filter(r => r.success).length} succeeded`);

    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error in bulk update:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/chat-permissions/:userId
 * Remove all permissions for a user (revokes all chat access)
 */
router.delete('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await ChatPermission.deleteOne({ userId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'No permissions found for this user' });
    }

    console.log(`[ChatPermissions] Deleted permissions for user ${userId} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Permissions removed'
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error deleting permissions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat-permissions/check/:module
 * Check if current user has chat permission for a module
 * (This endpoint does NOT require superadmin - used by chat UI)
 */
router.get('/check/:module', async (req, res) => {
  // Override the superadmin middleware for this endpoint
  // by returning before it's called (we register this before router.use)
});

module.exports = router;

// Export a separate router for permission checking (used by chat UI)
module.exports.checkPermissionRouter = express.Router();

module.exports.checkPermissionRouter.get('/:module', async (req, res) => {
  try {
    const { module } = req.params;

    if (!CHAT_MODULES.includes(module)) {
      return res.status(400).json({
        error: `Invalid module: ${module}. Valid modules: ${CHAT_MODULES.join(', ')}`
      });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const canChat = await ChatPermission.canUserChat(userId, module);
    const canExecute = await ChatPermission.canUserExecute(userId, module);

    res.json({
      module,
      canChat,
      canExecute
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error checking permissions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all modules current user has access to
module.exports.checkPermissionRouter.get('/', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const permission = await ChatPermission.getForUser(userId);

    const access = {};
    for (const mod of CHAT_MODULES) {
      access[mod] = {
        canChat: permission?.modules[mod]?.canChat === true,
        canExecute: permission?.modules[mod]?.canExecute === true
      };
    }

    res.json({
      modules: access,
      hasAnyAccess: Object.values(access).some(a => a.canChat)
    });
  } catch (error) {
    console.error('[ChatPermissions API] Error checking user access:', error);
    res.status(500).json({ error: error.message });
  }
});
