const ScheduledJob = require('../models/ScheduledJob');
const CampaignDefinition = require('../models/CampaignDefinition');
const { getDb } = require('../db');
let shopifyTimer = null;
let amazonSettlementTimer = null;
let vendorOrdersTimer = null;

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
  // Periodic Shopify sync (inventory/prices)
  try {
    if (process.env.SHOPIFY_SYNC_ENABLED === '1') {
      const minutes = Number(process.env.SHOPIFY_SYNC_INTERVAL_MIN || '15');
      const periodMs = Math.max(1, minutes) * 60 * 1000;
      const { syncAllowed } = require('../api/services/shopifySyncService');
      const runSync = async () => {
        try { const r = await syncAllowed(); console.log(`[scheduler] Shopify sync:`, r); } catch (e) { console.error('[scheduler] Shopify sync error', e?.message || e); }
      };
      shopifyTimer = setInterval(runSync, periodMs);
      // kick off once at start
      runSync();
    }
  } catch (e) { console.error('[scheduler] Shopify sync init error', e); }

  // Amazon Settlement Report reminder check (runs daily)
  try {
    const settlementCheckInterval = 24 * 60 * 60 * 1000; // Once per day
    amazonSettlementTimer = setInterval(checkAmazonSettlementReminders, settlementCheckInterval);
    // Run immediately on start
    setTimeout(checkAmazonSettlementReminders, 5000); // Wait 5s for DB connection
    console.log('[scheduler] Amazon settlement reminder check initialized (daily)');
  } catch (e) { console.error('[scheduler] Amazon settlement check init error', e); }

  // Amazon Vendor Central PO polling (every 2 hours)
  try {
    if (process.env.VENDOR_POLLING_ENABLED === '1') {
      const minutes = Number(process.env.VENDOR_POLLING_INTERVAL_MIN || '120');
      const periodMs = Math.max(15, minutes) * 60 * 1000;
      vendorOrdersTimer = setInterval(pollVendorOrders, periodMs);
      // Run immediately on start (with delay for DB connection)
      setTimeout(pollVendorOrders, 10000);
      console.log(`[scheduler] Vendor Central PO polling initialized (every ${minutes} minutes)`);
    }
  } catch (e) { console.error('[scheduler] Vendor polling init error', e); }
}

/**
 * Poll Amazon Vendor Central for new purchase orders
 * Polls all configured marketplaces (DE, FR, NL)
 */
async function pollVendorOrders() {
  try {
    const { getVendorPOImporter } = require('../services/amazon/vendor');
    const importer = await getVendorPOImporter();

    // Poll orders from all configured marketplaces
    const marketplaces = ['DE', 'FR', 'NL'];
    let totalNew = 0;
    let totalUpdated = 0;

    for (const mp of marketplaces) {
      try {
        const result = await importer.pollMarketplace(mp, { daysBack: 7 });
        totalNew += result.newOrders || 0;
        totalUpdated += result.updatedOrders || 0;
        console.log(`[scheduler] Vendor poll ${mp}: ${result.newOrders || 0} new, ${result.updatedOrders || 0} updated`);
      } catch (e) {
        console.error(`[scheduler] Vendor poll ${mp} failed:`, e?.message || e);
      }
    }

    console.log(`[scheduler] Vendor polling complete: ${totalNew} new, ${totalUpdated} updated total`);
  } catch (e) {
    console.error('[scheduler] Vendor polling error:', e?.message || e);
  }
}

/**
 * Check for overdue Amazon settlement reports
 * Amazon releases settlements bi-weekly, so we check daily and warn if > 16 days since last one
 */
async function checkAmazonSettlementReminders() {
  try {
    const db = getDb();
    if (!db) {
      console.log('[scheduler] MongoDB not connected, skipping settlement check');
      return;
    }

    // Get the most recent settlement
    const lastSettlement = await db.collection('amazon_settlements')
      .findOne({}, { sort: { settlementEndDate: -1 } });

    const now = new Date();
    const daysSinceLastSettlement = lastSettlement?.settlementEndDate
      ? Math.floor((now - new Date(lastSettlement.settlementEndDate)) / (1000 * 60 * 60 * 24))
      : 999;

    if (daysSinceLastSettlement > 16) {
      console.log(`[scheduler] ⚠️ AMAZON SETTLEMENT OVERDUE! Last settlement was ${daysSinceLastSettlement} days ago.`);
      console.log('[scheduler] Please download the latest settlement report from Amazon Seller Central and upload it.');

      // Store reminder in database for UI display
      await db.collection('system_reminders').updateOne(
        { type: 'amazon_settlement' },
        {
          $set: {
            type: 'amazon_settlement',
            isOverdue: true,
            daysSince: daysSinceLastSettlement,
            lastSettlementDate: lastSettlement?.settlementEndDate,
            message: `Settlement report overdue! Last one was ${daysSinceLastSettlement} days ago.`,
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
    } else if (daysSinceLastSettlement > 12) {
      console.log(`[scheduler] Amazon settlement report should be available soon (${daysSinceLastSettlement} days since last).`);
    } else {
      // Clear any overdue reminder
      await db.collection('system_reminders').updateOne(
        { type: 'amazon_settlement' },
        {
          $set: {
            isOverdue: false,
            daysSince: daysSinceLastSettlement,
            lastSettlementDate: lastSettlement?.settlementEndDate,
            message: 'Settlement reports are up to date.',
            updatedAt: new Date()
          }
        }
      );
    }
  } catch (e) {
    console.error('[scheduler] Amazon settlement check error:', e?.message || e);
  }
}

module.exports = { start, checkAmazonSettlementReminders, pollVendorOrders };
