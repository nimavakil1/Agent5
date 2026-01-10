/**
 * Diagnose BOL invoicing - understand why orders aren't ready for invoicing
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== BOL Invoicing Diagnostics ===\n');

  // 1. Count orders by invoice_status in Odoo
  const toInvoice = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['invoice_status', '=', 'to invoice']
  ]]);

  const invoiced = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['invoice_status', '=', 'invoiced']
  ]]);

  const noInvoice = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['invoice_status', '=', 'no']
  ]]);

  console.log('Odoo BOL orders by invoice_status:');
  console.log('  to invoice:', toInvoice);
  console.log('  invoiced:', invoiced);
  console.log('  no (nothing to invoice):', noInvoice);
  console.log('  Total:', toInvoice + invoiced + noInvoice);

  // 2. Get sample of "to invoice" orders and check their delivery status
  console.log('\n--- Analyzing "to invoice" orders delivery status ---');

  const toInvoiceOrderIds = await odoo.execute('sale.order', 'search', [[
    ['team_id', 'in', [9, 10]],
    ['invoice_status', '=', 'to invoice']
  ]], { limit: 500 });

  if (toInvoiceOrderIds.length === 0) {
    console.log('No orders to analyze');
    await mongoose.disconnect();
    process.exit(0);
  }

  const orders = await odoo.execute('sale.order', 'read', [toInvoiceOrderIds], {
    fields: ['name', 'state', 'invoice_status', 'order_line', 'date_order', 'client_order_ref']
  });

  let fullyDelivered = 0;
  let partiallyDelivered = 0;
  let notDelivered = 0;
  let draftOrders = 0;

  const deliveryDetails = {
    fullyDelivered: [],
    partial: [],
    notDelivered: []
  };

  for (const order of orders) {
    if (order.state === 'draft' || order.state === 'sent') {
      draftOrders++;
      continue;
    }

    // Get order lines
    const lines = await odoo.execute('sale.order.line', 'read', [order.order_line], {
      fields: ['product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'display_type']
    });

    const productLines = lines.filter(l => !l.display_type);

    let orderFullyDelivered = true;
    let anyDelivered = false;
    let totalQty = 0;
    let totalDelivered = 0;

    for (const line of productLines) {
      totalQty += line.product_uom_qty;
      totalDelivered += line.qty_delivered;

      if (line.qty_delivered < line.product_uom_qty) {
        orderFullyDelivered = false;
      }
      if (line.qty_delivered > 0) {
        anyDelivered = true;
      }
    }

    if (orderFullyDelivered && productLines.length > 0) {
      fullyDelivered++;
      if (deliveryDetails.fullyDelivered.length < 5) {
        deliveryDetails.fullyDelivered.push({
          name: order.name,
          ref: order.client_order_ref,
          date: order.date_order
        });
      }
    } else if (anyDelivered) {
      partiallyDelivered++;
      if (deliveryDetails.partial.length < 5) {
        deliveryDetails.partial.push({
          name: order.name,
          ref: order.client_order_ref,
          date: order.date_order,
          delivered: `${totalDelivered}/${totalQty}`
        });
      }
    } else {
      notDelivered++;
      if (deliveryDetails.notDelivered.length < 5) {
        deliveryDetails.notDelivered.push({
          name: order.name,
          ref: order.client_order_ref,
          date: order.date_order
        });
      }
    }
  }

  console.log(`\nAnalyzed ${orders.length} orders with invoice_status='to invoice':`);
  console.log('  Fully delivered (ready for invoicing):', fullyDelivered);
  console.log('  Partially delivered:', partiallyDelivered);
  console.log('  Not delivered at all:', notDelivered);
  console.log('  Draft/Sent state:', draftOrders);

  if (deliveryDetails.fullyDelivered.length > 0) {
    console.log('\nSample fully delivered orders:');
    deliveryDetails.fullyDelivered.forEach(o => console.log(`  ${o.name} (${o.ref}) - ${o.date}`));
  }

  if (deliveryDetails.partial.length > 0) {
    console.log('\nSample partially delivered orders:');
    deliveryDetails.partial.forEach(o => console.log(`  ${o.name} (${o.ref}) - ${o.delivered} - ${o.date}`));
  }

  if (deliveryDetails.notDelivered.length > 0) {
    console.log('\nSample NOT delivered orders:');
    deliveryDetails.notDelivered.forEach(o => console.log(`  ${o.name} (${o.ref}) - ${o.date}`));
  }

  // 3. Check if FBB delivery sync is working
  console.log('\n--- Checking FBB Delivery Sync Status ---');

  // Get a sample non-delivered order and check if it's FBB
  if (deliveryDetails.notDelivered.length > 0) {
    const sampleRef = deliveryDetails.notDelivered[0].ref;
    if (sampleRef) {
      const bolOrder = await mongoose.connection.db.collection('bol_orders').findOne({
        orderId: sampleRef
      });

      if (bolOrder) {
        console.log(`\nSample non-delivered order in MongoDB (${sampleRef}):`);
        console.log('  Fulfillment method:', bolOrder.orderItems?.[0]?.fulfilment?.method || 'unknown');
        console.log('  Order status:', bolOrder.status);
        if (bolOrder.shipments?.length > 0) {
          console.log('  Has shipments:', bolOrder.shipments.length);
          bolOrder.shipments.forEach((s, i) => {
            console.log(`    Shipment ${i + 1}:`, s.shipmentId, '-', s.shipmentDate);
          });
        } else {
          console.log('  Has shipments: NO');
        }
      } else {
        console.log(`Order ${sampleRef} not found in bol_orders collection`);
      }
    }
  }

  // 4. Check recent orders flow
  console.log('\n--- Recent Orders Analysis (last 7 days) ---');

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const recentOrderIds = await odoo.execute('sale.order', 'search', [[
    ['team_id', 'in', [9, 10]],
    ['date_order', '>=', weekAgo.toISOString().split('T')[0]]
  ]], { limit: 200 });

  const recentOrders = await odoo.execute('sale.order', 'read', [recentOrderIds], {
    fields: ['name', 'state', 'invoice_status', 'client_order_ref']
  });

  const recentStats = {
    total: recentOrders.length,
    byInvoiceStatus: {},
    byState: {}
  };

  for (const order of recentOrders) {
    recentStats.byInvoiceStatus[order.invoice_status] = (recentStats.byInvoiceStatus[order.invoice_status] || 0) + 1;
    recentStats.byState[order.state] = (recentStats.byState[order.state] || 0) + 1;
  }

  console.log('Recent Odoo BOL orders (last 7 days):', recentStats.total);
  console.log('By invoice_status:', recentStats.byInvoiceStatus);
  console.log('By state:', recentStats.byState);

  // 5. Check bol_orders collection
  const bolOrdersRecent = await mongoose.connection.db.collection('bol_orders').countDocuments({
    orderPlacedDateTime: { $gte: weekAgo.toISOString() }
  });

  console.log('\nBol_orders collection (last 7 days):', bolOrdersRecent);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
