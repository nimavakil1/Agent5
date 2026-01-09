require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb } = require('./src/db');

async function investigateOrder() {
  const amazonOrderId = '305-2501197-5144368';

  console.log('=== Investigating order ' + amazonOrderId + ' ===\n');

  // Check Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find the sale order
  console.log('1. SALE ORDER IN ODOO:');
  const saleOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'ilike', amazonOrderId]],
    ['name', 'client_order_ref', 'partner_id', 'amount_total', 'date_order', 'invoice_ids', 'invoice_status', 'state', 'team_id', 'create_date', 'write_date'],
    { limit: 10 }
  );

  if (saleOrders.length === 0) {
    console.log('  No sale order found with client_order_ref containing ' + amazonOrderId);
  } else {
    for (const so of saleOrders) {
      console.log('  ID: ' + so.id);
      console.log('  Name: ' + so.name);
      console.log('  Client Order Ref: ' + so.client_order_ref);
      console.log('  Partner: ' + (so.partner_id ? so.partner_id[1] : 'N/A'));
      console.log('  Amount: EUR ' + so.amount_total);
      console.log('  Order Date: ' + so.date_order);
      console.log('  State: ' + so.state);
      console.log('  Invoice Status: ' + so.invoice_status);
      console.log('  Linked Invoice IDs: ' + JSON.stringify(so.invoice_ids));
      console.log('  Team: ' + (so.team_id ? so.team_id[1] : 'N/A'));
      console.log('  Created: ' + so.create_date);
      console.log('  Last Modified: ' + so.write_date);
    }
  }

  // Find the invoice
  console.log('\n2. INVOICES IN ODOO (by origin):');
  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      '|',
      ['invoice_origin', 'ilike', amazonOrderId],
      ['invoice_origin', 'ilike', 'FBA305-2501197-5144368']
    ],
    ['name', 'invoice_origin', 'ref', 'partner_id', 'amount_total', 'state', 'invoice_date', 'create_date', 'write_date'],
    { limit: 10 }
  );

  if (invoices.length === 0) {
    console.log('  No invoices found with origin containing ' + amazonOrderId);
  } else {
    for (const inv of invoices) {
      console.log('  ID: ' + inv.id);
      console.log('  Name: ' + inv.name);
      console.log('  Origin: ' + inv.invoice_origin);
      console.log('  Ref: ' + inv.ref);
      console.log('  Partner: ' + (inv.partner_id ? inv.partner_id[1] : 'N/A'));
      console.log('  Amount: EUR ' + inv.amount_total);
      console.log('  State: ' + inv.state);
      console.log('  Invoice Date: ' + inv.invoice_date);
      console.log('  Created: ' + inv.create_date);
      console.log('  Last Modified: ' + inv.write_date);
    }
  }

  // Check MongoDB unified_orders
  console.log('\n3. MONGODB unified_orders:');
  const db = await connectDb();
  const unifiedOrder = await db.collection('unified_orders').findOne({
    'sourceIds.amazonOrderId': amazonOrderId
  });

  if (!unifiedOrder) {
    console.log('  No unified order found');
  } else {
    console.log('  unifiedOrderId: ' + unifiedOrder.unifiedOrderId);
    console.log('  channel: ' + unifiedOrder.channel);
    console.log('  subChannel: ' + unifiedOrder.subChannel);
    console.log('  sourceIds: ' + JSON.stringify(unifiedOrder.sourceIds));
    console.log('  odoo: ' + JSON.stringify(unifiedOrder.odoo));
    console.log('  status: ' + JSON.stringify(unifiedOrder.status));
    console.log('  importedAt: ' + unifiedOrder.importedAt);
    console.log('  createdAt: ' + unifiedOrder.createdAt);
    console.log('  updatedAt: ' + unifiedOrder.updatedAt);
  }

  // Check MongoDB seller_orders
  console.log('\n4. MONGODB seller_orders:');
  const sellerOrder = await db.collection('seller_orders').findOne({
    amazonOrderId: amazonOrderId
  });

  if (!sellerOrder) {
    console.log('  No seller order found');
  } else {
    console.log('  amazonOrderId: ' + sellerOrder.amazonOrderId);
    console.log('  odooSaleOrderId: ' + sellerOrder.odooSaleOrderId);
    console.log('  odooSaleOrderName: ' + sellerOrder.odooSaleOrderName);
    console.log('  odooInvoiceId: ' + sellerOrder.odooInvoiceId);
    console.log('  odooInvoiceName: ' + sellerOrder.odooInvoiceName);
    console.log('  syncedAt: ' + sellerOrder.syncedAt);
    console.log('  createdAt: ' + sellerOrder.createdAt);
  }

  process.exit(0);
}

investigateOrder().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
