const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '' },
    privileges: [{ type: String }],
    protected: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);

