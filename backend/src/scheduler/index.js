const ScheduledJob = require('../models/ScheduledJob');
const CampaignDefinition = require('../models/CampaignDefinition');
const { getDb } = require('../db');
const cron = require('node-cron');

let _shopifyTimer = null;
let _amazonSettlementTimer = null;
let _vendorOrdersTimer = null;
let _productSyncTimer = null;
let _stockSyncTimer = null;
let _bolOrderSyncTimer = null;
let _bolStockSyncTimer = null;
let _bolShipmentCheckTimer = null;
let _bolCancellationCheckTimer = null;
let _lateOrdersAlertCronMorning = null;
let _lateOrdersAlertCronAfternoon = null;
let _trackingHealthTimer = null;
let _amazonFbmStockTimer = null;
let _amazonFbaInventoryTimer = null;
let _amazonFbaReportCheckTimer = null;

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
      _shopifyTimer = setInterval(runSync, periodMs);
      // kick off once at start
      runSync();
    }
  } catch (e) { console.error('[scheduler] Shopify sync init error', e); }

  // Amazon Settlement Report reminder check (runs daily)
  try {
    const settlementCheckInterval = 24 * 60 * 60 * 1000; // Once per day
    _amazonSettlementTimer = setInterval(checkAmazonSettlementReminders, settlementCheckInterval);
    // Run immediately on start
    setTimeout(checkAmazonSettlementReminders, 5000); // Wait 5s for DB connection
    console.log('[scheduler] Amazon settlement reminder check initialized (daily)');
  } catch (e) { console.error('[scheduler] Amazon settlement check init error', e); }

  // Amazon Vendor Central PO polling (every 2 hours)
  try {
    if (process.env.VENDOR_POLLING_ENABLED === '1') {
      const minutes = Number(process.env.VENDOR_POLLING_INTERVAL_MIN || '120');
      const periodMs = Math.max(15, minutes) * 60 * 1000;
      _vendorOrdersTimer = setInterval(pollVendorOrders, periodMs);
      // Run immediately on start (with delay for DB connection)
      setTimeout(pollVendorOrders, 10000);
      console.log(`[scheduler] Vendor Central PO polling initialized (every ${minutes} minutes)`);
    }
  } catch (e) { console.error('[scheduler] Vendor polling init error', e); }

  // Product sync from Odoo to MongoDB (every 15 minutes)
  try {
    const productSyncMinutes = Number(process.env.PRODUCT_SYNC_INTERVAL_MIN || '15');
    const productSyncMs = Math.max(5, productSyncMinutes) * 60 * 1000;
    _productSyncTimer = setInterval(syncProductsIncremental, productSyncMs);
    // Run initial sync after 30 seconds (after DB is ready)
    setTimeout(syncProductsIncremental, 30000);
    console.log(`[scheduler] Product sync initialized (every ${productSyncMinutes} minutes)`);
  } catch (e) { console.error('[scheduler] Product sync init error', e); }

  // Stock-only sync from Odoo (every 5 minutes - faster, just stock.quant)
  try {
    const stockSyncMinutes = Number(process.env.STOCK_SYNC_INTERVAL_MIN || '5');
    const stockSyncMs = Math.max(1, stockSyncMinutes) * 60 * 1000;
    _stockSyncTimer = setInterval(syncStockOnly, stockSyncMs);
    // Run initial stock sync after 2 minutes (after product sync has run)
    setTimeout(syncStockOnly, 120000);
    console.log(`[scheduler] Stock sync initialized (every ${stockSyncMinutes} minutes)`);
  } catch (e) { console.error('[scheduler] Stock sync init error', e); }

  // Bol.com integration syncs (15 minute intervals)
  try {
    if (process.env.BOL_SYNC_ENABLED === '1') {
      const bolSyncMinutes = Number(process.env.BOL_SYNC_INTERVAL_MIN || '15');
      const bolSyncMs = Math.max(5, bolSyncMinutes) * 60 * 1000;

      // Order sync and auto-creation (every 15 minutes)
      _bolOrderSyncTimer = setInterval(syncBolOrders, bolSyncMs);
      setTimeout(syncBolOrders, 45000); // Initial run after 45s

      // Stock sync to Bol.com (every 15 minutes)
      _bolStockSyncTimer = setInterval(syncBolStock, bolSyncMs);
      setTimeout(syncBolStock, 90000); // Initial run after 1.5min

      // Shipment check (every 5 minutes)
      _bolShipmentCheckTimer = setInterval(checkBolShipments, 5 * 60 * 1000);
      setTimeout(checkBolShipments, 180000); // Initial run after 3min

      // Cancellation check (every 5 minutes)
      _bolCancellationCheckTimer = setInterval(checkBolCancellations, 5 * 60 * 1000);
      setTimeout(checkBolCancellations, 240000); // Initial run after 4min

      console.log(`[scheduler] Bol.com sync initialized (orders/stock every ${bolSyncMinutes} min, shipments/cancellations every 5 min)`);
    }
  } catch (e) { console.error('[scheduler] Bol.com sync init error', e); }

  // Late Orders Alert (7:00 and 14:00 daily)
  try {
    if (process.env.LATE_ORDERS_ALERT_ENABLED === '1') {
      // 7:00 AM CET/CEST
      _lateOrdersAlertCronMorning = cron.schedule('0 7 * * *', async () => {
        await sendLateOrdersAlert();
      }, { timezone: 'Europe/Brussels' });

      // 14:00 (2:00 PM) CET/CEST
      _lateOrdersAlertCronAfternoon = cron.schedule('0 14 * * *', async () => {
        await sendLateOrdersAlert();
      }, { timezone: 'Europe/Brussels' });

      console.log('[scheduler] Late Orders Alert scheduled: 7:00 and 14:00 daily (Europe/Brussels timezone)');
    }
  } catch (e) { console.error('[scheduler] Late Orders Alert cron init error', e); }

  // Tracking Health Check - CRITICAL: Ensures no tracking confirmations are missed
  // Runs every 15 minutes to detect stuck orders and stale sync jobs
  try {
    const trackingCheckMinutes = Number(process.env.TRACKING_HEALTH_CHECK_INTERVAL_MIN || '15');
    const trackingCheckMs = Math.max(5, trackingCheckMinutes) * 60 * 1000;

    _trackingHealthTimer = setInterval(checkTrackingHealth, trackingCheckMs);
    // Initial check after 5 minutes (let other syncs run first)
    setTimeout(checkTrackingHealth, 5 * 60 * 1000);

    console.log(`[scheduler] Tracking Health Check initialized (every ${trackingCheckMinutes} min) - CRITICAL for tracking reliability`);
  } catch (e) { console.error('[scheduler] Tracking Health Check init error', e); }

  // Amazon Seller Stock Sync (FBM export + FBA import)
  // Replicates Emipro module functionality:
  // - FBM: Odoo CW → Amazon (every 30 min)
  // - FBA: Amazon → Odoo (every 1 hour)
  try {
    if (process.env.AMAZON_STOCK_SYNC_ENABLED === '1') {
      // FBM Stock Export: Odoo CW → Amazon (every 30 minutes)
      const fbmSyncMinutes = Number(process.env.AMAZON_FBM_STOCK_INTERVAL_MIN || '30');
      const fbmSyncMs = Math.max(15, fbmSyncMinutes) * 60 * 1000;
      _amazonFbmStockTimer = setInterval(syncAmazonFbmStock, fbmSyncMs);
      setTimeout(syncAmazonFbmStock, 2 * 60 * 1000); // Initial run after 2 min
      console.log(`[scheduler] Amazon FBM stock export initialized (every ${fbmSyncMinutes} min)`);

      // FBA Inventory Sync: Amazon → Odoo (every 1 hour)
      const fbaSyncMinutes = Number(process.env.AMAZON_FBA_INVENTORY_INTERVAL_MIN || '60');
      const fbaSyncMs = Math.max(30, fbaSyncMinutes) * 60 * 1000;
      _amazonFbaInventoryTimer = setInterval(syncAmazonFbaInventory, fbaSyncMs);
      setTimeout(syncAmazonFbaInventory, 5 * 60 * 1000); // Initial run after 5 min
      console.log(`[scheduler] Amazon FBA inventory sync initialized (every ${fbaSyncMinutes} min)`);

      // FBA Report Check (every 15 minutes - check pending reports)
      _amazonFbaReportCheckTimer = setInterval(checkAmazonFbaReports, 15 * 60 * 1000);
      setTimeout(checkAmazonFbaReports, 10 * 60 * 1000); // Initial run after 10 min
      console.log('[scheduler] Amazon FBA report check initialized (every 15 min)');
    }
  } catch (e) { console.error('[scheduler] Amazon stock sync init error', e); }
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

/**
 * Sync products from Odoo to MongoDB
 * Uses incremental sync (only products changed since last sync)
 * Falls back to full sync if no products exist yet
 */
async function syncProductsIncremental() {
  try {
    const { getProductSyncService } = require('../services/ProductSyncService');
    const Product = require('../models/Product');

    const syncService = getProductSyncService();

    // Check if we have any products - if not, do a full sync
    const count = await Product.countDocuments();

    if (count === 0) {
      console.log('[scheduler] No products in cache, running full sync...');
      const result = await syncService.fullSync();
      console.log(`[scheduler] Product full sync complete: ${result.synced} products`);
    } else {
      // Incremental sync - only changed products
      const result = await syncService.incrementalSync();
      if (result.synced > 0) {
        console.log(`[scheduler] Product incremental sync: ${result.synced} products updated`);
      }
    }
  } catch (e) {
    console.error('[scheduler] Product sync error:', e?.message || e);
  }
}

/**
 * Sync stock levels only from Odoo to MongoDB
 * Faster than full product sync - only fetches stock.quant data
 * Runs more frequently to keep stock levels up to date
 */
async function syncStockOnly() {
  try {
    const { getProductSyncService } = require('../services/ProductSyncService');
    const Product = require('../models/Product');

    // Skip if no products in cache yet (let product sync handle it)
    const count = await Product.countDocuments();
    if (count === 0) {
      return;
    }

    const syncService = getProductSyncService();
    const result = await syncService.syncStock();

    if (result.skipped) {
      // Another sync is running, skip silently
      return;
    }

    if (result.updated > 0) {
      console.log(`[scheduler] Stock sync: ${result.updated} products updated`);
    }
  } catch (e) {
    console.error('[scheduler] Stock sync error:', e?.message || e);
  }
}

/**
 * Sync Bol.com orders and auto-create Odoo orders
 */
async function syncBolOrders() {
  try {
    const BolSyncService = require('../services/bol/BolSyncService');
    const { getBolOrderCreator } = require('../services/bol/BolOrderCreator');

    // Sync recent orders from Bol.com
    const syncResult = await BolSyncService.syncOrders('RECENT');
    console.log(`[scheduler] Bol orders synced: ${syncResult.synced} orders`);

    // Auto-create Odoo orders for new orders
    const creator = await getBolOrderCreator();
    const createResult = await creator.createPendingOrders({ limit: 20 });

    if (createResult.created > 0) {
      console.log(`[scheduler] Bol -> Odoo: ${createResult.created} orders created`);
    }
  } catch (e) {
    console.error('[scheduler] Bol order sync error:', e?.message || e);
  }
}

/**
 * Sync stock from Odoo to Bol.com
 */
async function syncBolStock() {
  try {
    const { runStockSync } = require('../services/bol/BolStockSync');
    const result = await runStockSync();

    if (result.updated > 0) {
      console.log(`[scheduler] Bol stock sync: ${result.updated} offers updated`);
    }
  } catch (e) {
    console.error('[scheduler] Bol stock sync error:', e?.message || e);
  }
}

/**
 * Check Odoo pickings and confirm shipments to Bol.com
 */
async function checkBolShipments() {
  try {
    const { runShipmentSync } = require('../services/bol/BolShipmentSync');
    const result = await runShipmentSync();

    if (result.confirmed > 0) {
      console.log(`[scheduler] Bol shipments confirmed: ${result.confirmed}`);
    }
  } catch (e) {
    console.error('[scheduler] Bol shipment check error:', e?.message || e);
  }
}

/**
 * Check and process Bol.com cancellation requests
 */
async function checkBolCancellations() {
  try {
    const { runCancellationCheck } = require('../services/bol/BolCancellationHandler');
    const result = await runCancellationCheck();

    if (result.accepted > 0 || result.rejected > 0) {
      console.log(`[scheduler] Bol cancellations: ${result.accepted} accepted, ${result.rejected} rejected`);
    }
  } catch (e) {
    console.error('[scheduler] Bol cancellation check error:', e?.message || e);
  }
}

/**
 * Send Late Orders Alert to Teams
 * Sends to channel webhook (configured via TEAMS_LATE_ORDERS_WEBHOOK_URL)
 * Or to group chat via MS Graph (if MS_LATE_ORDERS_CHAT_ID is configured)
 */
async function sendLateOrdersAlert() {
  try {
    const { getLateOrdersAlertService } = require('../services/alerts/LateOrdersAlertService');
    const service = getLateOrdersAlertService();

    // Get current status first to check if there are late orders
    const status = await service.getStatus();
    const totalLate = status.totals?.totalPending || 0;

    if (totalLate === 0) {
      console.log('[scheduler] Late Orders Alert: No late orders, skipping alert');
      return;
    }

    // Check if MS Graph chat ID is configured for group chat
    const chatId = process.env.MS_LATE_ORDERS_CHAT_ID;

    if (chatId && process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) {
      // Send to group chat via MS Graph
      console.log(`[scheduler] Sending Late Orders Alert to group chat: ${chatId}`);
      const result = await service.sendToGroupChat(chatId);
      console.log(`[scheduler] Late Orders Alert sent to group chat: ${result.success ? 'success' : 'failed'}`);
    } else {
      // Fall back to channel webhook
      console.log('[scheduler] Sending Late Orders Alert to Teams channel');
      const result = await service.sendToChannel();
      console.log(`[scheduler] Late Orders Alert sent to channel: ${result.success ? 'success' : 'failed'}`);
    }
  } catch (e) {
    console.error('[scheduler] Late Orders Alert error:', e?.message || e);
  }
}

/**
 * CRITICAL: Check tracking health across all channels
 * Detects stuck orders (shipped in Odoo but tracking not confirmed to marketplace)
 * Sends Teams alert if issues found
 *
 * Monitors:
 * - Bol.com FBR orders (shipping confirmation)
 * - Amazon FBM orders (tracking push)
 * - Amazon Vendor orders (ASN confirmation)
 */
async function checkTrackingHealth() {
  try {
    const { runTrackingHealthCheck, SYNC_STATUS } = require('../services/alerts/TrackingAlertService');

    // Record that this sync ran (for staleness detection)
    SYNC_STATUS.trackingHealthCheck = {
      lastRun: new Date(),
      success: true
    };

    const health = await runTrackingHealthCheck();

    // Log status
    const stuckTotal =
      health.stuckOrders.bol.length +
      health.stuckOrders.amazonFbm.length +
      health.stuckOrders.amazonVendor.length;

    if (stuckTotal > 0 || health.alerts.length > 0) {
      console.log(`[scheduler] ⚠️ Tracking Health: ${stuckTotal} stuck orders, ${health.alerts.length} alerts`);
      console.log(`[scheduler]   Bol: ${health.stuckOrders.bol.length}, FBM: ${health.stuckOrders.amazonFbm.length}, Vendor: ${health.stuckOrders.amazonVendor.length}`);
    } else {
      console.log('[scheduler] Tracking Health: OK - all channels synced, no stuck orders');
    }
  } catch (e) {
    console.error('[scheduler] Tracking Health Check error:', e?.message || e);

    // Record failure for staleness detection
    try {
      const { SYNC_STATUS } = require('../services/alerts/TrackingAlertService');
      SYNC_STATUS.trackingHealthCheck = {
        lastRun: new Date(),
        success: false,
        error: e?.message || String(e)
      };
    } catch (_) {}
  }
}

/**
 * Sync FBM stock from Odoo CW to Amazon (Rock-solid approach)
 *
 * Flow:
 * 1. Get all FBM Seller SKUs from Amazon (source of truth)
 * 2. Use SkuResolver to map Amazon SKU → Odoo SKU
 * 3. Get CW stock for resolved Odoo SKUs
 * 4. Apply safety stock deduction (amazonQty = cwFreeQty - safetyStock)
 * 5. Send stock to Amazon using original Seller SKU
 * 6. Generate Excel report and send Teams notification (if changes exist)
 * 7. On error: Generate fallback TSV and escalate to Teams
 */
async function syncAmazonFbmStock() {
  try {
    const { getSellerFbmStockExport } = require('../services/amazon/seller/SellerFbmStockExport');
    const { getFbmStockReportService } = require('../services/amazon/seller/FbmStockReportService');
    const { getFbmStockFallbackGenerator } = require('../services/amazon/seller/FbmStockFallbackGenerator');

    const exporter = await getSellerFbmStockExport();
    const result = await exporter.syncStock();

    // Initialize reporting services
    const reportService = getFbmStockReportService();
    const fallbackGenerator = getFbmStockFallbackGenerator();

    if (result.success) {
      if (result.updateId) {
        const summary = result.summary || {};
        console.log(`[scheduler] Amazon FBM stock: Updated ${result.itemsUpdated || 0} items via Listings API`);
        console.log(`[scheduler]   Resolved: ${result.resolved}, Unresolved: ${result.unresolved}`);
        console.log(`[scheduler]   Changes: +${summary.increases || 0} / -${summary.decreases || 0} / =${summary.unchanged || 0}`);

        // Generate and send report (only if there are changes)
        try {
          const reportResult = await reportService.generateAndSendReport(result);
          if (reportResult.reported) {
            console.log(`[scheduler]   Report sent: Excel=${reportResult.excelUrl ? 'Yes' : 'No'}, Teams=${reportResult.teamsNotified}`);
          }
        } catch (reportError) {
          console.error('[scheduler]   Report generation failed:', reportError.message);
        }
      } else {
        console.log(`[scheduler] Amazon FBM stock: ${result.message || 'No items to sync'}`);
      }
    } else {
      console.error(`[scheduler] Amazon FBM stock failed: ${result.error}`);

      // Generate fallback TSV and escalate
      try {
        if (result.detailedResults && result.detailedResults.length > 0) {
          const fallbackResult = await fallbackGenerator.generateAndUploadFallback(result, result.error);

          if (fallbackResult.success) {
            console.log(`[scheduler]   Fallback TSV generated: ${fallbackResult.filename} (${fallbackResult.itemCount} items)`);

            // Send error escalation to Teams
            await reportService.sendErrorEscalation(
              {
                error: result.error,
                affectedSkus: result.detailedResults.length
              },
              fallbackResult.url
            );
          }
        }
      } catch (fallbackError) {
        console.error('[scheduler]   Fallback generation failed:', fallbackError.message);
      }
    }

    return result;
  } catch (e) {
    console.error('[scheduler] Amazon FBM stock sync error:', e?.message || e);

    // Try to send error escalation even on complete failure
    try {
      const { getFbmStockReportService } = require('../services/amazon/seller/FbmStockReportService');
      const reportService = getFbmStockReportService();
      await reportService.sendErrorEscalation({
        error: e?.message || String(e),
        affectedSkus: 'Unknown - sync failed completely'
      });
    } catch (_) {}

    return { success: false, error: e?.message || e };
  }
}

/**
 * Sync FBA inventory from Amazon to Odoo
 * Replicates Emipro's FBA inventory import functionality
 */
async function syncAmazonFbaInventory() {
  try {
    const { getSellerFbaInventorySync } = require('../services/amazon/seller/SellerFbaInventorySync');

    const fbaSync = await getSellerFbaInventorySync();

    // First process any completed reports
    const processResult = await fbaSync.processReports();

    // Then request a new report
    const requestResult = await fbaSync.requestReport();

    if (processResult.processed > 0) {
      console.log(`[scheduler] Amazon FBA inventory: ${processResult.processed} reports processed`);
    }
    if (requestResult.success) {
      console.log(`[scheduler] Amazon FBA inventory: New report requested (${requestResult.reportId})`);
    }

    return {
      processed: processResult.processed || 0,
      newReportId: requestResult.reportId
    };
  } catch (e) {
    console.error('[scheduler] Amazon FBA inventory sync error:', e?.message || e);
    return { success: false, error: e?.message || e };
  }
}

/**
 * Check for completed FBA inventory reports
 * Runs more frequently than the full FBA sync to process reports as soon as they're ready
 */
async function checkAmazonFbaReports() {
  try {
    const { getSellerFbaInventorySync } = require('../services/amazon/seller/SellerFbaInventorySync');

    const fbaSync = await getSellerFbaInventorySync();
    const result = await fbaSync.processReports();

    if (result.processed > 0) {
      console.log(`[scheduler] Amazon FBA reports: ${result.processed} processed`);
    }

    return result;
  } catch (e) {
    console.error('[scheduler] Amazon FBA report check error:', e?.message || e);
    return { success: false, error: e?.message || e };
  }
}

module.exports = {
  start,
  checkAmazonSettlementReminders,
  pollVendorOrders,
  syncProductsIncremental,
  syncStockOnly,
  syncBolOrders,
  syncBolStock,
  checkBolShipments,
  checkBolCancellations,
  sendLateOrdersAlert,
  checkTrackingHealth,
  // Amazon stock sync functions
  syncAmazonFbmStock,
  syncAmazonFbaInventory,
  checkAmazonFbaReports
};
