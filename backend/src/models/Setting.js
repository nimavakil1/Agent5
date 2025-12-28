/**
 * Setting Model
 *
 * Simple key-value store for application settings.
 */

const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  description: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  collection: 'settings'
});

// Static method to get a setting
settingSchema.statics.get = async function(key, defaultValue = null) {
  const setting = await this.findOne({ key });
  return setting ? setting.value : defaultValue;
};

// Static method to set a setting
settingSchema.statics.set = async function(key, value, description = null) {
  const update = { value };
  if (description) update.description = description;

  await this.updateOne(
    { key },
    { $set: update },
    { upsert: true }
  );
};

// Static method to get multiple settings
settingSchema.statics.getMany = async function(keys) {
  const settings = await this.find({ key: { $in: keys } });
  const result = {};
  settings.forEach(s => {
    result[s.key] = s.value;
  });
  return result;
};

module.exports = mongoose.model('Setting', settingSchema);
