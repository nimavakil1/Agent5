/**
 * Call Log Entry Model
 *
 * Stores call records with transcription, sentiment, and analytics data
 * INDEXED for efficient dashboard queries
 */

const mongoose = require('mongoose');

const callLogEntrySchema = new mongoose.Schema({
  // Primary identifiers
  call_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  telnyx_call_id: {
    type: String,
    sparse: true,
    index: true,
  },

  // Relationships
  customer_id: {
    type: String,
    required: true,
    index: true,
  },
  campaign_id: {
    type: String,
    required: true,
    index: true,
  },

  // Timing (heavily queried)
  start_time: {
    type: Date,
    required: true,
    index: true,
  },
  end_time: { type: Date },
  duration_seconds: { type: Number }, // Computed on save

  // Language handling
  language_detected: {
    type: String,
    required: true,
    default: 'en',
  },
  fallback_language: { type: String },

  // Sentiment analysis
  sentiment_scores: [{
    timestamp: Date,
    sentiment: { type: String, enum: ['positive', 'negative', 'neutral'] },
    score: { type: Number, min: -1, max: 1 },
  }],
  overall_sentiment: {
    type: String,
    enum: ['positive', 'negative', 'neutral', 'mixed'],
  },

  // Call outcome
  call_status: {
    type: String,
    enum: ['initiated', 'in-progress', 'success', 'failed', 'dropped', 'no_answer', 'voicemail', 'busy'],
    required: true,
    index: true,
  },
  disposition: { type: String }, // Detailed outcome reason
  call_direction: {
    type: String,
    enum: ['inbound', 'outbound'],
    default: 'outbound',
  },

  // Transcription
  transcription: { type: String },
  transcription_summary: { type: String },
  transcription_word_count: { type: Number },

  // Recording
  audio_recording_url: { type: String },
  onedrive_recording_url: { type: String },
  recording_duration_seconds: { type: Number },

  // Business outcomes
  offers_recommended: [String],
  offers_accepted: [String],
  shopify_cart_link: { type: String },
  shopify_order_id: { type: String },
  conversion_value: { type: Number }, // USD value if converted

  // Intents and entities extracted
  intents: [String],
  entities: [{
    type: { type: String },
    value: String,
    confidence: Number,
  }],

  // Cost tracking
  cost_tracking_id: { type: String },
  total_cost_usd: { type: Number },

  // Quality metrics
  audio_quality_score: { type: Number, min: 0, max: 100 },
  agent_response_time_avg_ms: { type: Number },
  interruptions_count: { type: Number, default: 0 },

  // Provider info
  voice_provider: { type: String }, // openai-realtime, hybrid, etc.
  stt_provider: { type: String },
  tts_provider: { type: String },

  // Error tracking
  error_code: { type: String },
  error_message: { type: String },

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Compound indexes for common query patterns
callLogEntrySchema.index({ start_time: -1 }); // Recent calls
callLogEntrySchema.index({ customer_id: 1, start_time: -1 }); // Customer call history
callLogEntrySchema.index({ campaign_id: 1, start_time: -1 }); // Campaign analytics
callLogEntrySchema.index({ call_status: 1, start_time: -1 }); // Status filtering
callLogEntrySchema.index({ campaign_id: 1, call_status: 1 }); // Campaign success rates
callLogEntrySchema.index({ createdAt: -1 }); // Time-based queries

// TTL index for automatic cleanup (optional, disabled by default)
// Uncomment to auto-delete records older than retention period
// callLogEntrySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90 days

// Pre-save hook to compute derived fields
callLogEntrySchema.pre('save', function(next) {
  // Calculate duration if both times are set
  if (this.start_time && this.end_time) {
    this.duration_seconds = Math.floor((this.end_time - this.start_time) / 1000);
  }

  // Calculate overall sentiment from sentiment_scores
  if (this.sentiment_scores && this.sentiment_scores.length > 0) {
    const avgScore = this.sentiment_scores.reduce((sum, s) => sum + (s.score || 0), 0) / this.sentiment_scores.length;
    if (avgScore > 0.2) {
      this.overall_sentiment = 'positive';
    } else if (avgScore < -0.2) {
      this.overall_sentiment = 'negative';
    } else {
      this.overall_sentiment = 'neutral';
    }
  }

  // Count transcription words
  if (this.transcription) {
    this.transcription_word_count = this.transcription.split(/\s+/).filter(w => w.length > 0).length;
  }

  next();
});

// Virtual for call duration in friendly format
callLogEntrySchema.virtual('duration_formatted').get(function() {
  if (!this.duration_seconds) return null;
  const mins = Math.floor(this.duration_seconds / 60);
  const secs = this.duration_seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
});

// Static method for dashboard aggregations
callLogEntrySchema.statics.getDashboardStats = async function(startDate, endDate, campaignId = null) {
  const match = {
    start_time: { $gte: startDate, $lte: endDate },
  };
  if (campaignId) {
    match.campaign_id = campaignId;
  }

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        successfulCalls: {
          $sum: { $cond: [{ $eq: ['$call_status', 'success'] }, 1, 0] },
        },
        totalDuration: { $sum: '$duration_seconds' },
        avgDuration: { $avg: '$duration_seconds' },
        totalCost: { $sum: '$total_cost_usd' },
        byStatus: {
          $push: '$call_status',
        },
        byLanguage: {
          $push: '$language_detected',
        },
      },
    },
    {
      $project: {
        _id: 0,
        totalCalls: 1,
        successfulCalls: 1,
        successRate: {
          $cond: [
            { $gt: ['$totalCalls', 0] },
            { $multiply: [{ $divide: ['$successfulCalls', '$totalCalls'] }, 100] },
            0,
          ],
        },
        totalDuration: 1,
        avgDuration: { $round: ['$avgDuration', 0] },
        totalCost: { $round: ['$totalCost', 2] },
      },
    },
  ]);
};

// Static method for hourly distribution
callLogEntrySchema.statics.getHourlyDistribution = async function(date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  return this.aggregate([
    {
      $match: {
        start_time: { $gte: startOfDay, $lte: endOfDay },
      },
    },
    {
      $group: {
        _id: { $hour: '$start_time' },
        count: { $sum: 1 },
        successful: {
          $sum: { $cond: [{ $eq: ['$call_status', 'success'] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);
};

module.exports = mongoose.model('CallLogEntry', callLogEntrySchema);
