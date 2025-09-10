const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['superadmin', 'admin', 'manager', 'user'], default: 'user' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
