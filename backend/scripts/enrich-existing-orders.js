#!/usr/bin/env node
/**
 * Enrich Existing Orders with SP-API CompanyName
 *
 * Finds orders in unified_orders that are missing the shipping company name
 * and fetches it from Amazon SP-API.
 *
 * Usage:
 *   node scripts/enrich-existing-orders.js                    # Dry run (preview only)
 *   node scripts/enrich-existing-orders.js --apply            # Apply changes to database
 *   node scripts/enrich-existing-orders.js --apply --limit=10 # Limit to 10 orders
 *   node scripts/enrich-existing-orders.js --order=303-2842054-9726706  # Single order
 *
 * Options:
 *   --apply       Actually update the database (default is dry-run)
 *   --limit=N     Limit to N orders (default: no limit)
 *   --order=ID    Enrich a specific order by Amazon Order ID
 *   --force       Re-enrich even if already enriched
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { getSellerAddressEnricher } = require('../src/services/amazon/seller/SellerAddressEnricher');

// Parse command line arguments
const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const forceReenrich = args.includes('--force');
const limitArg = args.find(a => a.startsWith('--limit='));
const orderArg = args.find(a => a.startsWith('--order='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const specificOrderId = orderArg ? orderArg.split('=')[1] : null;

async function enrichExistingOrders() {
  console.log('='.repeat(70));
  console.log('Enrich Existing Orders with SP-API CompanyName');
  console.log('='.repeat(70));
  console.log(`Mode: ${applyChanges ? '🔴 APPLY CHANGES' : '🟢 DRY RUN (preview only)'}`);
  if (limit) console.log(`Limit: ${limit} orders`);
  if (specificOrderId) console.log(`Specific order: ${specificOrderId}`);
  if (forceReenrich) console.log(`Force re-enrich: YES`);
  console.log('');

  // Connect to MongoDB
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();
  const collection = db.collection('unified_orders');

  console.log('Connected to MongoDB\n');

  // Build query for orders needing enrichment
  // Note: channel can be 'amazon-seller' or 'amazon_seller' depending on when imported
  let query = {
    channel: { $in: ['amazon-seller', 'amazon_seller'] },
    'sourceIds.amazonOrderId': { $exists: true, $ne: null }
  };

  if (specificOrderId) {
    // Enrich specific order
    query['sourceIds.amazonOrderId'] = specificOrderId;
  } else if (!forceReenrich) {
    // Only orders not yet enriched
    query.$or = [
      { spApiEnrichment: { $exists: false } },
      { 'spApiEnrichment.success': { $ne: true } },
      { 'shippingAddress.companyName': { $exists: false } },
      { 'shippingAddress.companyName': null }
    ];
  }

  // Find orders
  let cursor = collection.find(query).sort({ createdAt: -1 });
  if (limit) {
    cursor = cursor.limit(limit);
  }

  const orders = await cursor.toArray();
  console.log(`Found ${orders.length} orders to enrich\n`);

  if (orders.length === 0) {
    console.log('No orders need enrichment. Exiting.');
    await client.close();
    return;
  }

  // Initialize enricher
  const enricher = getSellerAddressEnricher();

  // Results tracking
  const results = {
    total: orders.length,
    enriched: 0,
    noCompany: 0,
    failed: 0,
    skipped: 0,
    updated: 0,
    details: []
  };

  console.log('-'.repeat(70));
  console.log('Processing orders...\n');

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const amazonOrderId = order.sourceIds?.amazonOrderId;
    const existingCompany = order.shippingAddress?.companyName || order.shippingCompanyName;

    console.log(`[${i + 1}/${orders.length}] ${amazonOrderId}`);
    console.log(`  Current company: ${existingCompany || '(none)'}`);
    console.log(`  Odoo order: ${order.sourceIds?.odooSaleOrderName || '(not created)'}`);

    // Skip if already has company and not forcing
    if (existingCompany && !forceReenrich) {
      console.log(`  ⏭️  Skipping - already has company name`);
      results.skipped++;
      results.details.push({
        orderId: amazonOrderId,
        status: 'skipped',
        reason: 'Already has company name',
        existingCompany
      });
      continue;
    }

    // Fetch from SP-API
    try {
      const spApiAddress = await enricher.fetchOrderAddress(amazonOrderId);

      if (spApiAddress?.companyName) {
        console.log(`  ✅ SP-API CompanyName: "${spApiAddress.companyName}"`);
        results.enriched++;

        const detail = {
          orderId: amazonOrderId,
          status: 'enriched',
          companyName: spApiAddress.companyName,
          odooOrder: order.sourceIds?.odooSaleOrderName
        };
        results.details.push(detail);

        // Update database if --apply
        if (applyChanges) {
          const updateResult = await collection.updateOne(
            { _id: order._id },
            {
              $set: {
                'shippingAddress.companyName': spApiAddress.companyName,
                'shippingCompanyName': spApiAddress.companyName,
                'spApiEnrichment': {
                  attempted: true,
                  success: true,
                  companyName: spApiAddress.companyName,
                  enrichedAt: new Date(),
                  enrichedBy: 'enrich-existing-orders.js'
                },
                'isBusinessOrder': true,
                updatedAt: new Date()
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            console.log(`  💾 Database updated`);
            results.updated++;
          }
        } else {
          console.log(`  📝 Would update (dry run)`);
        }

      } else {
        console.log(`  ➖ No CompanyName (B2C order)`);
        results.noCompany++;
        results.details.push({
          orderId: amazonOrderId,
          status: 'no_company',
          reason: 'B2C order - no company in SP-API'
        });

        // Still mark as enrichment attempted
        if (applyChanges) {
          await collection.updateOne(
            { _id: order._id },
            {
              $set: {
                'spApiEnrichment': {
                  attempted: true,
                  success: true,
                  companyName: null,
                  enrichedAt: new Date(),
                  enrichedBy: 'enrich-existing-orders.js',
                  note: 'B2C order - no company name'
                },
                updatedAt: new Date()
              }
            }
          );
        }
      }

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
      results.failed++;
      results.details.push({
        orderId: amazonOrderId,
        status: 'error',
        error: error.message
      });

      // Mark enrichment as failed
      if (applyChanges) {
        await collection.updateOne(
          { _id: order._id },
          {
            $set: {
              'spApiEnrichment': {
                attempted: true,
                success: false,
                error: error.message,
                attemptedAt: new Date(),
                enrichedBy: 'enrich-existing-orders.js'
              },
              updatedAt: new Date()
            }
          }
        );
      }
    }

    console.log('');
  }

  // Summary
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total orders processed: ${results.total}`);
  console.log(`Enriched with company:  ${results.enriched}`);
  console.log(`No company (B2C):       ${results.noCompany}`);
  console.log(`Skipped:                ${results.skipped}`);
  console.log(`Failed:                 ${results.failed}`);
  if (applyChanges) {
    console.log(`Database updated:       ${results.updated}`);
  }
  console.log('');

  // List enriched orders
  const enrichedOrders = results.details.filter(d => d.status === 'enriched');
  if (enrichedOrders.length > 0) {
    console.log('Orders with CompanyName found:');
    console.log('-'.repeat(70));
    for (const d of enrichedOrders) {
      console.log(`  ${d.orderId}: "${d.companyName}"`);
      if (d.odooOrder) {
        console.log(`    → Odoo: ${d.odooOrder}`);
      }
    }
    console.log('');
  }

  // Warning for orders already in Odoo
  const enrichedWithOdoo = enrichedOrders.filter(d => d.odooOrder);
  if (enrichedWithOdoo.length > 0 && applyChanges) {
    console.log('⚠️  NOTE: The following orders already exist in Odoo.');
    console.log('   The unified_orders database was updated, but Odoo partners');
    console.log('   may need manual update to add the company name:');
    console.log('-'.repeat(70));
    for (const d of enrichedWithOdoo) {
      console.log(`  ${d.odooOrder}: Add company "${d.companyName}"`);
    }
    console.log('');
  }

  if (!applyChanges) {
    console.log('💡 This was a DRY RUN. To apply changes, run with --apply flag:');
    console.log('   node scripts/enrich-existing-orders.js --apply');
    console.log('');
  }

  await client.close();
  console.log('Done.');
}

// Run
enrichExistingOrders().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
