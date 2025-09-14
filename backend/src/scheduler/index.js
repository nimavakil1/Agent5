const ScheduledJob = require('../models/ScheduledJob');
const CampaignDefinition = require('../models/CampaignDefinition');

async function runDueJobs(now = new Date()) {
  const due = await ScheduledJob.find({ status: 'pending', run_at: { $lte: now } }).sort({ run_at: 1 }).limit(10);
  for (const job of due) {
    try {
      job.status = 'running';
      await job.save();
      if (job.type === 'start_campaign') {
        const id = job.payload?.campaignObjectId;
        if (id) {
          await CampaignDefinition.findByIdAndUpdate(id, { status: 'running' });
          console.log(`[scheduler] Campaign ${id} started`);
          // Schedule first goal check in 1 minute
          const next = new Date(Date.now() + 60 * 1000);
          await ScheduledJob.create({ type: 'goal_check', run_at: next, payload: { campaignObjectId: id } });
        }
      } else if (job.type === 'goal_check') {
        const id = job.payload?.campaignObjectId;
        if (id) {
          const camp = await CampaignDefinition.findById(id).lean();
          if (!camp) { throw new Error('campaign not found'); }
          // TODO: integrate Shopify to compute units_sold for sku since start_date
          // For MVP: keep checking; do not complete automatically.
          console.log(`[scheduler] Goal check for ${id} (MVP placeholder)`);
          // Re-schedule another check in 5 minutes if still active
          if (camp.status === 'running') {
            const next = new Date(Date.now() + 5 * 60 * 1000);
            await ScheduledJob.create({ type: 'goal_check', run_at: next, payload: { campaignObjectId: id } });
          }
        }
      } else if (job.type === 'stop_campaign') {
        const id = job.payload?.campaignObjectId;
        if (id) {
          await CampaignDefinition.findByIdAndUpdate(id, { status: 'ended' });
          console.log(`[scheduler] Campaign ${id} stopped`);
        }
      } else if (job.type === 'callback') {
        // Place an outbound call for a scheduled callback
        const to = job.payload?.to;
        if (!to) throw new Error('callback payload missing "to"');
        const { createOutboundCall } = require('../api/services/callService');
        try {
          await createOutboundCall(to, { campaign_id: job.payload?.campaign_id || 'callback', customer_name: job.payload?.customer_name || '' });
          console.log(`[scheduler] Callback call queued to ${to}`);
        } catch (e) {
          throw new Error('failed to create outbound call: ' + (e?.message || e));
        }
      }
      job.status = 'completed';
      job.last_error = '';
      await job.save();
    } catch (e) {
      console.error('[scheduler] job failed', job.type, e?.message || e);
      job.status = 'failed';
      job.last_error = String(e?.message || e);
      await job.save();
    }
  }
}

function start() {
  setInterval(() => {
    runDueJobs().catch((e) => console.error('[scheduler] tick error', e));
  }, 5000);
  console.log('[scheduler] started');
}

module.exports = { start };
