const mongoose = require('mongoose');

const scheduledJobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true }, // start_campaign | stop_campaign | goal_check
    run_at: { type: Date, required: true, index: true },
    status: { type: String, enum: ['pending', 'running', 'completed', 'failed'], default: 'pending', index: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    last_error: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScheduledJob', scheduledJobSchema);

