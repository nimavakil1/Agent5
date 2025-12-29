/**
 * Recreate FBB orders with correct warehouse
 *
 * For each order:
 * 1. Cancel stock moves (set state to 'cancel')
 * 2. Cancel picking (set state to 'cancel')
 * 3. Cancel sale order
 * 4. Re-create order with correct warehouse (BOL)
 *
 * Usage:
 *   node scripts/recreate-fbb-orders.js --dry-run     # Show what would happen
 *   node scripts/recreate-fbb-orders.js --test        # Test on first order only
 *   node scripts/recreate-fbb-orders.js               # Run on all orders
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { getBolOrderCreator } = require('../src/services/bol/BolOrderCreator');
const BolOrder = require('../src/models/BolOrder');
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Orders to recreate
const ORDER_NAMES = [
  'S14729', 'S14730', 'S14731', 'S14732', 'S14733', 'S14734', 'S14735', 'S14736',
  'S14737', 'S14739', 'S14740', 'S14741', 'S14743', 'S14744', 'S14745', 'S14746',
  'S14747', 'S14748', 'S14749', 'S14750', 'S14751', 'S14752', 'S14753', 'S14754',
  'S14755', 'S14757', 'S14758', 'S14759', 'S14760', 'S14761', 'S14762', 'S14764',
  'S14765', 'S14766', 'S14767', 'S14769', 'S14770', 'S14771', 'S14772', 'S14773', 'S14774'
];

async function recreateOrders(options = {}) {
  const { dryRun = false, testOnly = false } = options;

  // Connect to MongoDB
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  const ordersToProcess = testOnly ? ORDER_NAMES.slice(0, 1) : ORDER_NAMES;
  console.log(`\nProcessing ${ordersToProcess.length} orders (dryRun: ${dryRun}, testOnly: ${testOnly})\n`);

  const results = {
    processed: 0,
    success: 0,
    failed: 0,
    errors: []
  };

  for (const orderName of ordersToProcess) {
    console.log(`\n=== Processing ${orderName} ===`);
    results.processed++;

    try {
      // Step 1: Get the sale order
      const orders = await odoo.searchRead('sale.order',
        [['name', '=', orderName]],
        ['id', 'name', 'client_order_ref', 'state', 'partner_id', 'order_line']
      );

      if (orders.length === 0) {
        console.log(`  Order not found: ${orderName}`);
        results.failed++;
        results.errors.push({ order: orderName, error: 'Order not found' });
        continue;
      }

      const order = orders[0];
      const bolOrderId = order.client_order_ref.replace('FBB', '');
      console.log(`  Bol Order ID: ${bolOrderId}`);
      console.log(`  Current state: ${order.state}`);

      // Step 2: Get pickings for this order
      const pickings = await odoo.searchRead('stock.picking',
        [['sale_id', '=', order.id]],
        ['id', 'name', 'state', 'picking_type_code']
      );
      console.log(`  Pickings: ${pickings.length}`);

      // Step 3: Get stock moves for these pickings
      const pickingIds = pickings.map(p => p.id);
      let moves = [];
      if (pickingIds.length > 0) {
        moves = await odoo.searchRead('stock.move',
          [['picking_id', 'in', pickingIds]],
          ['id', 'state', 'product_id', 'quantity_done', 'picking_id']
        );
        console.log(`  Stock moves: ${moves.length}`);
      }

      // Step 4: Check if Bol order exists in MongoDB
      const bolOrder = await BolOrder.findOne({ orderId: bolOrderId }).lean();
      if (!bolOrder) {
        console.log(`  WARNING: Bol order not found in MongoDB: ${bolOrderId}`);
        results.failed++;
        results.errors.push({ order: orderName, error: 'Bol order not in MongoDB' });
        continue;
      }

      if (dryRun) {
        console.log(`  [DRY RUN] Would cancel ${moves.length} moves, ${pickings.length} pickings, and order ${orderName}`);
        console.log(`  [DRY RUN] Would recreate order from Bol order ${bolOrderId}`);
        results.success++;
        continue;
      }

      // Step 5: Cancel stock moves
      for (const move of moves) {
        try {
          await odoo.write('stock.move', [move.id], { state: 'cancel' });
          console.log(`  Cancelled move ${move.id}`);
        } catch (e) {
          console.log(`  Failed to cancel move ${move.id}: ${e.message}`);
        }
      }

      // Step 6: Cancel pickings
      for (const picking of pickings) {
        try {
          await odoo.write('stock.picking', [picking.id], { state: 'cancel' });
          console.log(`  Cancelled picking ${picking.name}`);
        } catch (e) {
          console.log(`  Failed to cancel picking ${picking.name}: ${e.message}`);
        }
      }

      // Step 7: Cancel sale order
      try {
        // First try action_cancel
        await odoo.execute('sale.order', 'action_cancel', [[order.id]]);
        console.log(`  Cancelled order ${orderName} via action_cancel`);
      } catch (e) {
        // If action_cancel fails, try setting state directly
        try {
          await odoo.write('sale.order', [order.id], { state: 'cancel' });
          console.log(`  Cancelled order ${orderName} via state write`);
        } catch (e2) {
          console.log(`  Failed to cancel order: ${e2.message}`);
          results.failed++;
          results.errors.push({ order: orderName, error: `Cancel failed: ${e2.message}` });
          continue;
        }
      }

      // Step 8: Clear MongoDB link so order can be recreated
      await BolOrder.updateOne(
        { orderId: bolOrderId },
        { $unset: { 'odoo.saleOrderId': '', 'odoo.saleOrderName': '', 'odoo.linkedAt': '' } }
      );
      console.log(`  Cleared MongoDB link for ${bolOrderId}`);

      // Step 9: Recreate order using BolOrderCreator
      const creator = await getBolOrderCreator();
      const createResult = await creator.createOrder(bolOrderId, { autoConfirm: true });

      if (createResult.success && !createResult.skipped) {
        console.log(`  ✓ Recreated as ${createResult.odooOrderName} (ID: ${createResult.odooOrderId})`);
        results.success++;
      } else if (createResult.skipped) {
        console.log(`  ⚠ Skipped - found existing order: ${createResult.odooOrderName}`);
        results.failed++;
        results.errors.push({ order: orderName, error: `Skipped: ${createResult.skipReason}` });
      } else {
        console.log(`  ✗ Failed to recreate: ${createResult.errors.join(', ')}`);
        results.failed++;
        results.errors.push({ order: orderName, error: createResult.errors.join(', ') });
      }

    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      results.failed++;
      results.errors.push({ order: orderName, error: error.message });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Processed: ${results.processed}`);
  console.log(`Success: ${results.success}`);
  console.log(`Failed: ${results.failed}`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(e => console.log(`  ${e.order}: ${e.error}`));
  }

  await mongoose.disconnect();
  return results;
}

// Parse command line args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const testOnly = args.includes('--test');

recreateOrders({ dryRun, testOnly }).catch(console.error);
