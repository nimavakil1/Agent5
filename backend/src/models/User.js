const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, default: null }, // Null for pending invited users
    role: { type: String, enum: ['superadmin', 'admin', 'manager', 'user'], default: 'user' },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
    active: { type: Boolean, default: true },
    avatar: { type: String, default: null }, // URL to profile picture
    // Invitation fields
    inviteToken: { type: String, default: null, index: true },
    inviteTokenExpires: { type: Date, default: null },
    status: {
      type: String,
      enum: ['pending', 'active', 'inactive'],
      default: 'active' // Default to active for backward compatibility with existing users
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
