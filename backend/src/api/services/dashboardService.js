
const CallLogEntry = require('../../models/CallLogEntry');
const CampaignDefinition = require('../../models/CampaignDefinition');
const DashboardKpiSummary = require('../../models/DashboardKpiSummary');

async function getDashboardKpis() {
  try {
    // Placeholder values for now
    const current_queue_length = 0;
    const active_calls = 0;
    const cost_per_conversion = 0;
    const dropoff_rate = 0;

    // Calculate success/failure rates
    const totalCalls = await CallLogEntry.countDocuments();
    const successfulCalls = await CallLogEntry.countDocuments({ call_status: 'success' });
    const failedCalls = await CallLogEntry.countDocuments({ call_status: 'failed' });

    const success_rate = totalCalls > 0 ? successfulCalls / totalCalls : 0;
    const failure_rate = totalCalls > 0 ? failedCalls / totalCalls : 0;

    // Language usage breakdown
    const languageUsage = await CallLogEntry.aggregate([
      { $group: { _id: '$language_detected', count: { $sum: 1 } } },
    ]);
    const language_usage_breakdown = languageUsage.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    // Regional performance (placeholder)
    const regional_performance = {};

    return {
      campaign_id: 'overall', // Or specific campaign ID if filtered
      current_queue_length,
      active_calls,
      success_rate,
      failure_rate,
      cost_per_conversion,
      dropoff_rate,
      language_usage_breakdown,
      regional_performance,
    };
  } catch (error) {
    console.error('Error getting dashboard KPIs:', error);
    throw error;
  }
}

module.exports = {
  getDashboardKpis,
};
