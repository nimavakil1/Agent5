#!/usr/bin/env node
/**
 * Process all pending VCS orders - invoices and credit notes
 *
 * Usage:
 *   node scripts/process-all-vcs-orders.js --dry-run          # Preview what would be done
 *   node scripts/process-all-vcs-orders.js --enrich           # Only run fulfillment channel enrichment
 *   node scripts/process-all-vcs-orders.js --execute          # Actually create invoices/credit notes
 *   node scripts/process-all-vcs-orders.js --execute --batch=100  # Process in batches of 100
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { connectDb, getDb } = require('../src/db');
const { VcsOdooInvoicer } = require('../src/services/amazon/VcsOdooInvoicer');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const enrichOnly = args.includes('--enrich');
  const execute = args.includes('--execute');
  const batchArg = args.find(a => a.startsWith('--batch='));
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1]) : 100;
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
  const salesOnly = args.includes('--sales-only');
  const returnsOnly = args.includes('--returns-only');

  if (!dryRun && !enrichOnly && !execute) {
    console.log('Usage:');
    console.log('  node scripts/process-all-vcs-orders.js --dry-run           # Preview');
    console.log('  node scripts/process-all-vcs-orders.js --enrich            # Enrich fulfillment channels');
    console.log('  node scripts/process-all-vcs-orders.js --execute           # Create invoices/credit notes');
    console.log('  node scripts/process-all-vcs-orders.js --execute --batch=100');
    console.log('  node scripts/process-all-vcs-orders.js --dry-run --limit=10');
    console.log('  node scripts/process-all-vcs-orders.js --execute --sales-only');
    console.log('  node scripts/process-all-vcs-orders.js --execute --returns-only');
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? 'DRY RUN' : enrichOnly ? 'ENRICH ONLY' : 'EXECUTE'}`);
  console.log(`Batch size: ${batchSize}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log('');

  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo and MongoDB');

  const invoicer = new VcsOdooInvoicer(odoo);
  await invoicer.loadCache();
  console.log('VcsOdooInvoicer cache loaded\n');

  // Get all pending orders (sales and returns)
  const pendingQuery = { status: 'pending' };

  // Get unique orders (deduplicated by orderId, taking most recent)
  const allPendingOrders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: pendingQuery },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  // Separate sales and returns
  const salesOrders = allPendingOrders.filter(o => {
    // Sales have positive totalExclusive OR transactionType is not RETURN
    if (o.transactionType === 'RETURN') return false;
    if ((o.totalExclusive || 0) < 0) return false;
    return true;
  });

  const returnOrders = allPendingOrders.filter(o => {
    // Returns have transactionType RETURN or negative totalExclusive
    if (o.transactionType === 'RETURN') return true;
    if ((o.totalExclusive || 0) < 0) return true;
    return false;
  });

  console.log(`Total pending orders: ${allPendingOrders.length}`);
  console.log(`  Sales: ${salesOrders.length}`);
  console.log(`  Returns: ${returnOrders.length}`);
  console.log('');

  // Phase 1: Enrich fulfillment channels if needed
  if (enrichOnly || execute) {
    const ordersWithoutChannel = allPendingOrders.filter(o => !o.fulfillmentChannel);
    console.log(`Orders without fulfillment channel: ${ordersWithoutChannel.length}`);

    if (ordersWithoutChannel.length > 0) {
      console.log('Running batch enrichment...');
      const orderIdsToEnrich = ordersWithoutChannel.map(o => o.orderId);
      const enrichResult = await invoicer.enrichFulfillmentChannels(orderIdsToEnrich);
      console.log(`Enrichment result: ${JSON.stringify(enrichResult)}`);
    }
    console.log('');

    if (enrichOnly) {
      console.log('Enrichment complete. Exiting.');
      process.exit(0);
    }
  }

  // Phase 2: Process sales invoices
  if (!returnsOnly) {
    console.log('=== PROCESSING SALES INVOICES ===');
    const salesToProcess = limit ? salesOrders.slice(0, limit) : salesOrders;
    console.log(`Processing ${salesToProcess.length} sales orders...`);

    let salesCreated = 0, salesSkipped = 0, salesErrors = 0;

    // Process in batches
    for (let i = 0; i < salesToProcess.length; i += batchSize) {
      const batch = salesToProcess.slice(i, Math.min(i + batchSize, salesToProcess.length));
      const batchIds = batch.map(o => o._id.toString());

      console.log(`\nBatch ${Math.floor(i / batchSize) + 1}: Processing ${batch.length} sales (${i + 1} to ${i + batch.length})...`);

      try {
        const result = await invoicer.createInvoices({ orderIds: batchIds, dryRun });

        if (dryRun) {
          // In dry run, count previews
          const previews = result.invoices || [];
          for (const preview of previews) {
            if (preview.dryRun) {
              console.log(`  [DRY RUN] ${preview.orderId}: Would create invoice`);
              console.log(`    Order: ${preview.odooOrderName || 'Would create new'}`);
              console.log(`    Date: ${preview.preview?.invoiceDate}`);
              console.log(`    Journal: ${preview.preview?.journalName}`);
              console.log(`    FP: ${preview.preview?.fiscalPositionName}`);
              console.log(`    Total: €${preview.preview?.totalInclVat}`);
              salesCreated++;
            }
          }
          for (const skipped of result.skippedOrders || []) {
            console.log(`  [SKIP] ${skipped.orderId}: ${skipped.reason}`);
            salesSkipped++;
          }
        } else {
          salesCreated += result.created || 0;
          salesSkipped += result.skipped || 0;
          salesErrors += (result.errors || []).length;

          for (const invoice of result.invoices || []) {
            console.log(`  [CREATED] ${invoice.orderId}: ${invoice.name}`);
          }
          for (const skipped of result.skippedOrders || []) {
            console.log(`  [SKIP] ${skipped.orderId}: ${skipped.reason}`);
          }
          for (const error of result.errors || []) {
            console.log(`  [ERROR] ${error.orderId}: ${error.error}`);
          }
        }
      } catch (err) {
        console.error(`Batch error: ${err.message}`);
        salesErrors++;
      }
    }

    console.log(`\nSales summary: ${salesCreated} ${dryRun ? 'would create' : 'created'}, ${salesSkipped} skipped, ${salesErrors} errors`);
  }

  // Phase 3: Process return credit notes
  if (!salesOnly) {
    console.log('\n=== PROCESSING RETURN CREDIT NOTES ===');
    const returnsToProcess = limit ? returnOrders.slice(0, limit) : returnOrders;
    console.log(`Processing ${returnsToProcess.length} returns...`);

    let returnsCreated = 0, returnsSkipped = 0, returnsErrors = 0;

    // Process in batches
    for (let i = 0; i < returnsToProcess.length; i += batchSize) {
      const batch = returnsToProcess.slice(i, Math.min(i + batchSize, returnsToProcess.length));
      const batchIds = batch.map(o => o._id.toString());

      console.log(`\nBatch ${Math.floor(i / batchSize) + 1}: Processing ${batch.length} returns (${i + 1} to ${i + batch.length})...`);

      try {
        const result = await invoicer.createCreditNotes({ orderIds: batchIds, dryRun });

        if (dryRun) {
          for (const preview of result.creditNotes || []) {
            if (preview.dryRun) {
              console.log(`  [DRY RUN] ${preview.orderId}: Would create ${preview.standalone ? 'STANDALONE' : ''} credit note`);
              console.log(`    Linked to: ${preview.odooOrderName || 'None (standalone)'}`);
              console.log(`    Total: €${preview.preview?.totalInclVat}`);
              returnsCreated++;
            }
          }
        } else {
          returnsCreated += result.created || 0;
          returnsSkipped += result.skipped || 0;
          returnsErrors += (result.errors || []).length;

          for (const cn of result.creditNotes || []) {
            if (!cn.dryRun) {
              console.log(`  [CREATED] ${cn.orderId}: ${cn.name}${cn.standalone ? ' (standalone)' : ''}`);
            }
          }
        }
      } catch (err) {
        console.error(`Batch error: ${err.message}`);
        returnsErrors++;
      }
    }

    console.log(`\nReturns summary: ${returnsCreated} ${dryRun ? 'would create' : 'created'}, ${returnsSkipped} skipped, ${returnsErrors} errors`);
  }

  console.log('\n=== COMPLETE ===');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
