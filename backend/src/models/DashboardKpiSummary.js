
const mongoose = require('mongoose');

const dashboardKpiSummarySchema = new mongoose.Schema({
  campaign_id: { type: String, required: true },
  current_queue_length: { type: Number, required: true },
  active_calls: { type: Number, required: true },
  success_rate: { type: Number, required: true },
  failure_rate: { type: Number, required: true },
  cost_per_conversion: { type: Number, required: true },
  dropoff_rate: { type: Number, required: true },
  language_usage_breakdown: {
    fr: { type: Number },
    nl: { type: Number },
    de: { type: Number },
  },
  regional_performance: {
    type: Map,
    of: {
      calls: { type: Number },
      conversions: { type: Number },
    },
  },
});

module.exports = mongoose.model('DashboardKpiSummary', dashboardKpiSummarySchema);
