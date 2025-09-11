const mongoose = require('mongoose');

const dncSchema = new mongoose.Schema(
  {
    phone_e164: { type: String, required: true, unique: true, index: true },
    reason: { type: String },
    source: { type: String, enum: ['upload', 'ui', 'system'], default: 'ui' },
    addedBy: { type: String },
  },
  { timestamps: { createdAt: 'addedAt', updatedAt: 'updatedAt' } }
);

module.exports = mongoose.model('Dnc', dncSchema);

