
const mongoose = require('mongoose');

const sentimentAnalysisBlockSchema = new mongoose.Schema({
  call_id: { type: String, required: true },
  timestamp: { type: Date, required: true },
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative', 'frustrated', 'other'], required: true },
  score: { type: Number, required: true },
});

module.exports = mongoose.model('SentimentAnalysisBlock', sentimentAnalysisBlockSchema);
