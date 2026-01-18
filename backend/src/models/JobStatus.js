const mongoose = require('mongoose');

const jobStatusSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String },
  status: { type: String, enum: ['ok', 'error', 'warning', 'unknown'], default: 'unknown' },
  lastUpdate: { type: Date },
  lastSuccess: { type: Date },
  lastError: { type: Date },
  error: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true
});

// Static method to update job status
jobStatusSchema.statics.updateJobStatus = async function(jobId, name, status, error = null, category = null, metadata = null) {
  const update = {
    name,
    status,
    lastUpdate: new Date(),
    error: status === 'error' ? error : null,
    ...(category && { category }),
    ...(metadata && { metadata })
  };

  if (status === 'ok') {
    update.lastSuccess = new Date();
  } else if (status === 'error') {
    update.lastError = new Date();
  }

  return this.findOneAndUpdate(
    { jobId },
    update,
    { upsert: true, new: true }
  );
};

// Static method to mark job as OK
jobStatusSchema.statics.markOk = async function(jobId, name, category = null, metadata = null) {
  return this.updateJobStatus(jobId, name, 'ok', null, category, metadata);
};

// Static method to mark job as error
jobStatusSchema.statics.markError = async function(jobId, name, error, category = null, metadata = null) {
  return this.updateJobStatus(jobId, name, 'error', error, category, metadata);
};

// Static method to mark job as warning
jobStatusSchema.statics.markWarning = async function(jobId, name, warning, category = null, metadata = null) {
  return this.updateJobStatus(jobId, name, 'warning', warning, category, metadata);
};

module.exports = mongoose.model('JobStatus', jobStatusSchema);
