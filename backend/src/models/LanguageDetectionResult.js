
const mongoose = require('mongoose');

const languageDetectionResultSchema = new mongoose.Schema({
  call_id: { type: String, required: true },
  detected_language: { type: String, required: true },
  confidence: { type: Number, required: true },
  alternatives: [String],
});

module.exports = mongoose.model('LanguageDetectionResult', languageDetectionResultSchema);
