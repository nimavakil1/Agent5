const mongoose = require('mongoose');

const roomLockSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true },
  owner: { type: String, default: '' },
  expiresAt: { type: Date, index: { expires: 0 } }, // TTL: expire at date
}, { timestamps: true });

module.exports = mongoose.model('RoomLock', roomLockSchema);

