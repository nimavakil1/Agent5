const mongoose = require('mongoose');

const prospectFieldDefSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true },
    type: { type: String, enum: ['string','number','date','enum','boolean','phone','email'], required: true },
    required: { type: Boolean, default: false },
    options: [{ type: String }], // for enum
    regex: { type: String },
    default: { type: mongoose.Schema.Types.Mixed },
    visibility: { type: String, enum: ['invoice','delivery','both'], default: 'invoice' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProspectFieldDef', prospectFieldDefSchema);

