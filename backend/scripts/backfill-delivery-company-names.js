/**
 * Backfill company names for existing delivery addresses
 *
 * Finds Amazon orders that have company name data (from AI cleaning or buyerCompanyName)
 * and updates the corresponding Odoo delivery addresses if company_name is empty.
 *
 * Usage:
 *   node scripts/backfill-delivery-company-names.js [--dry-run] [--limit N]
 *
 * Options:
 *   --dry-run   Show what would be updated without making changes
 *   --limit N   Only process N orders (default: all)
 */
require('dotenv').config();

const { getDb, connectDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : 0;

  console.log('=== Backfill Delivery Address Company Names ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (limit) console.log(`Limit: ${limit} orders`);
  console.log('');

  // Connect to MongoDB
  await connectDb();
  const db = getDb();
  const ordersCollection = db.collection('unified_orders');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // Find orders with company name data that have Odoo orders
  const query = {
    channel: 'amazon_seller',
    'sourceIds.odooSaleOrderId': { $ne: null },
    $or: [
      { 'addressCleaningResult.company': { $exists: true, $ne: null, $ne: '' } },
      { 'buyerCompanyName': { $exists: true, $ne: null, $ne: '' } }
    ]
  };

  const cursor = ordersCollection.find(query);
  if (limit) cursor.limit(limit);
  const orders = await cursor.toArray();

  console.log(`Found ${orders.length} orders with company name data\n`);

  const stats = {
    processed: 0,
    updated: 0,
    skipped: 0,
    alreadySet: 0,
    noDeliveryAddress: 0,
    errors: 0
  };

  for (const order of orders) {
    stats.processed++;
    const amazonOrderId = order.sourceIds?.amazonOrderId;
    const odooOrderId = order.sourceIds?.odooSaleOrderId;
    const odooOrderName = order.sourceIds?.odooSaleOrderName;

    // Get company name from order data
    const companyName = order.addressCleaningResult?.company || order.buyerCompanyName;
    if (!companyName) {
      stats.skipped++;
      continue;
    }

    try {
      // Get the sale order to find delivery address
      const saleOrders = await odoo.searchRead('sale.order',
        [['id', '=', odooOrderId]],
        ['id', 'name', 'partner_shipping_id']
      );

      if (saleOrders.length === 0) {
        console.log(`  [SKIP] ${amazonOrderId}: Sale order ${odooOrderId} not found in Odoo`);
        stats.skipped++;
        continue;
      }

      const saleOrder = saleOrders[0];
      const shippingPartnerId = saleOrder.partner_shipping_id?.[0];

      if (!shippingPartnerId) {
        console.log(`  [SKIP] ${amazonOrderId}: No shipping partner on order ${odooOrderName}`);
        stats.noDeliveryAddress++;
        continue;
      }

      // Get the delivery address partner
      const partners = await odoo.searchRead('res.partner',
        [['id', '=', shippingPartnerId]],
        ['id', 'name', 'company_name', 'type']
      );

      if (partners.length === 0) {
        console.log(`  [SKIP] ${amazonOrderId}: Partner ${shippingPartnerId} not found`);
        stats.noDeliveryAddress++;
        continue;
      }

      const partner = partners[0];

      // Check if company_name is already set
      if (partner.company_name && partner.company_name.trim()) {
        console.log(`  [ALREADY SET] ${amazonOrderId}: "${partner.name}" already has company "${partner.company_name}"`);
        stats.alreadySet++;
        continue;
      }

      // Update the partner with company name
      if (dryRun) {
        console.log(`  [WOULD UPDATE] ${amazonOrderId}: "${partner.name}" -> company_name = "${companyName}"`);
      } else {
        await odoo.write('res.partner', [shippingPartnerId], {
          company_name: companyName
        });
        console.log(`  [UPDATED] ${amazonOrderId}: "${partner.name}" -> company_name = "${companyName}"`);
      }
      stats.updated++;

    } catch (error) {
      console.error(`  [ERROR] ${amazonOrderId}: ${error.message}`);
      stats.errors++;
    }
  }

  // Print summary
  console.log('\n=== Summary ===');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Updated: ${stats.updated}${dryRun ? ' (dry run)' : ''}`);
  console.log(`Already set (skipped): ${stats.alreadySet}`);
  console.log(`No delivery address: ${stats.noDeliveryAddress}`);
  console.log(`Skipped (no company): ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
