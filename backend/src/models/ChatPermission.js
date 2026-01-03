/**
 * ChatPermission Model
 *
 * Defines per-user, per-module chat permissions.
 * Only super admin can modify these permissions.
 *
 * Modules: bol, amazon_seller, amazon_vendor, odoo, purchasing
 */

const mongoose = require('mongoose');

// Modules available for chat assistant
const CHAT_MODULES = ['bol', 'amazon_seller', 'amazon_vendor', 'odoo', 'purchasing'];

// Permission schema for each module
const modulePermissionSchema = new mongoose.Schema({
  canChat: { type: Boolean, default: false },      // Can send messages and ask questions
  canExecute: { type: Boolean, default: false }    // Can execute commands that modify data
}, { _id: false });

const chatPermissionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    index: true
  },

  // Per-module permissions
  modules: {
    bol: { type: modulePermissionSchema, default: () => ({ canChat: false, canExecute: false }) },
    amazon_seller: { type: modulePermissionSchema, default: () => ({ canChat: false, canExecute: false }) },
    amazon_vendor: { type: modulePermissionSchema, default: () => ({ canChat: false, canExecute: false }) },
    odoo: { type: modulePermissionSchema, default: () => ({ canChat: false, canExecute: false }) },
    purchasing: { type: modulePermissionSchema, default: () => ({ canChat: false, canExecute: false }) }
  },

  // Audit trail
  updatedBy: { type: String, required: true },  // Email of super admin who made the change
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Static method: Get permissions for a user
chatPermissionSchema.statics.getForUser = async function(userId) {
  return this.findOne({ userId });
};

// Static method: Check if user can chat with a module
chatPermissionSchema.statics.canUserChat = async function(userId, module) {
  if (!CHAT_MODULES.includes(module)) {
    return false;
  }

  const perm = await this.findOne({ userId });
  if (!perm) return false;

  return perm.modules[module]?.canChat === true;
};

// Static method: Check if user can execute commands for a module
chatPermissionSchema.statics.canUserExecute = async function(userId, module) {
  if (!CHAT_MODULES.includes(module)) {
    return false;
  }

  const perm = await this.findOne({ userId });
  if (!perm) return false;

  return perm.modules[module]?.canExecute === true;
};

// Static method: Get all users with chat permissions (for admin UI)
chatPermissionSchema.statics.getAllWithUsers = async function() {
  return this.aggregate([
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        userId: 1,
        email: 1,
        modules: 1,
        updatedBy: 1,
        updatedAt: 1,
        'user.firstName': 1,
        'user.lastName': 1,
        'user.role': 1,
        'user.active': 1
      }
    },
    { $sort: { email: 1 } }
  ]);
};

// Static method: Update or create permissions for a user
chatPermissionSchema.statics.setPermissions = async function(userId, email, modules, updatedBy) {
  const updateData = {
    email,
    modules,
    updatedBy,
    updatedAt: new Date()
  };

  return this.findOneAndUpdate(
    { userId },
    { $set: updateData },
    { upsert: true, new: true }
  );
};

// Static method: Get summary of all users who have chat access
chatPermissionSchema.statics.getSummary = async function() {
  const all = await this.find({});

  const summary = {
    totalUsers: all.length,
    byModule: {}
  };

  for (const mod of CHAT_MODULES) {
    summary.byModule[mod] = {
      canChat: 0,
      canExecute: 0
    };
  }

  for (const perm of all) {
    for (const mod of CHAT_MODULES) {
      if (perm.modules[mod]?.canChat) summary.byModule[mod].canChat++;
      if (perm.modules[mod]?.canExecute) summary.byModule[mod].canExecute++;
    }
  }

  return summary;
};

module.exports = mongoose.model('ChatPermission', chatPermissionSchema);
module.exports.CHAT_MODULES = CHAT_MODULES;
