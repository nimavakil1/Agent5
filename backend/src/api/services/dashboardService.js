
const CallLogEntry = require('../../models/CallLogEntry');
const _CampaignDefinition = require('../../models/CampaignDefinition');
const _DashboardKpiSummary = require('../../models/DashboardKpiSummary');

async function getDashboardKpis() {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

    // Today's calls
    const todayCalls = await CallLogEntry.find({ start_time: { $gte: todayStart } });
    const totalCallsToday = todayCalls.length;
    
    // Success rate
    const successfulCalls = todayCalls.filter(call => call.call_status === 'success').length;
    const successRate = totalCallsToday > 0 ? Math.round((successfulCalls / totalCallsToday) * 100) : 0;
    
    // Average duration
    let totalDuration = 0;
    let durationCount = 0;
    for (const call of todayCalls) {
      if (call.end_time && call.start_time) {
        totalDuration += new Date(call.end_time) - new Date(call.start_time);
        durationCount++;
      }
    }
    const avgDurationMs = durationCount > 0 ? totalDuration / durationCount : 0;
    const avgDurationMin = Math.floor(avgDurationMs / 60000);
    const avgDurationSec = Math.floor((avgDurationMs % 60000) / 1000);
    const avgDuration = `${avgDurationMin}:${avgDurationSec.toString().padStart(2, '0')}`;

    // Language distribution
    const languageStats = await CallLogEntry.aggregate([
      { $group: { _id: '$language_detected', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    const languageDistribution = languageStats.reduce((acc, item) => {
      acc[item._id || 'Unknown'] = item.count;
      return acc;
    }, {});

    // Volume data for chart (last 24 hours, hourly)
    const hourlyData = {};
    for (let i = 23; i >= 0; i--) {
      const hour = new Date(now.getTime() - i * 60 * 60 * 1000);
      const hourKey = hour.getHours().toString().padStart(2, '0') + ':00';
      hourlyData[hourKey] = 0;
    }
    
    // Count calls per hour
    for (const call of todayCalls) {
      const callHour = new Date(call.start_time);
      const hourKey = callHour.getHours().toString().padStart(2, '0') + ':00';
      if (hourlyData[hourKey] !== undefined) {
        hourlyData[hourKey]++;
      }
    }

    const volumeData = {
      labels: Object.keys(hourlyData),
      values: Object.values(hourlyData)
    };

    // Performance metrics
    const allCalls = await CallLogEntry.find({ start_time: { $gte: yesterdayStart } });
    const answeredCalls = allCalls.filter(call => call.call_status !== 'no_answer').length;
    const failedCalls = allCalls.filter(call => call.call_status === 'failed').length;
    
    const answerRate = allCalls.length > 0 ? Math.round((answeredCalls / allCalls.length) * 100) : 0;
    const errorRate = allCalls.length > 0 ? Math.round((failedCalls / allCalls.length) * 100) : 0;

    // Estimate active sessions (calls started in last 30 minutes without end time)
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const activeSessions = await CallLogEntry.countDocuments({
      start_time: { $gte: thirtyMinutesAgo },
      end_time: null
    });

    // Simulated average latency (in a real implementation, this would come from actual measurements)
    const avgLatency = Math.floor(Math.random() * 200) + 100; // 100-300ms

    return {
      totalCallsToday,
      successRate,
      avgDuration,
      activeSessions,
      answerRate,
      errorRate,
      avgLatency,
      languageDistribution,
      volumeData,
      
      // Legacy fields for backward compatibility
      campaign_id: 'overall',
      current_queue_length: 0,
      active_calls: activeSessions,
      success_rate: successRate / 100,
      failure_rate: errorRate / 100,
      cost_per_conversion: 0,
      dropoff_rate: 0,
      language_usage_breakdown: languageDistribution,
      regional_performance: {}
    };
  } catch (error) {
    console.error('Error getting dashboard KPIs:', error);
    throw error;
  }
}

module.exports = {
  getDashboardKpis,
};
