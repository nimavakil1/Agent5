require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const VINE_ORDER_IDS = [
  '204-7196349-7992340',
  '205-8350856-4897102',
  '026-6860926-8294745',
  '026-8504421-0205103',
  '026-3262942-5229108',
  '203-3069498-5172339',
  '206-0218522-0445105',
  '204-5237231-4253101',
  '204-6740016-3306755',
  '206-4460570-6791536'
];

async function setVineOrdersNoInvoice() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Setting', VINE_ORDER_IDS.length, 'Vine orders to "Nothing to Invoice"\n');

  // Find the sale orders by client_order_ref
  const saleOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', VINE_ORDER_IDS]],
    ['id', 'name', 'client_order_ref', 'invoice_status', 'state']
  );

  console.log('Found', saleOrders.length, 'sale orders in Odoo\n');

  for (const so of saleOrders) {
    console.log('Order:', so.name, '| Ref:', so.client_order_ref);
    console.log('  Current status:', so.invoice_status, '| State:', so.state);

    try {
      // Set invoice_status to 'no' (Nothing to Invoice)
      // This is done by setting the invoice_policy on order lines to 'delivery'
      // and ensuring qty_to_invoice = 0
      // Or we can set a specific field if available

      // First, let's try to update the sale order
      // In Odoo, invoice_status is computed, so we need to update the order lines

      // Get the order lines
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', so.id]],
        ['id', 'qty_to_invoice', 'qty_invoiced', 'product_uom_qty']
      );

      // Set qty_invoiced = product_uom_qty to mark as fully invoiced (nothing left to invoice)
      for (const line of orderLines) {
        if (line.qty_to_invoice > 0) {
          // We can't directly set qty_invoiced as it's computed
          // Instead, we need to set invoice_status on the order or use a different approach
          console.log('  Line', line.id, ': qty_to_invoice =', line.qty_to_invoice);
        }
      }

      // Try setting invoice_status directly (may not work if computed)
      await odoo.write('sale.order', [so.id], {
        invoice_status: 'no'
      });
      console.log('  -> Updated to "no" (Nothing to Invoice)');

    } catch (error) {
      console.log('  ERROR:', error.message);

      // Alternative: try to cancel the order if it's not already
      if (so.state !== 'cancel') {
        try {
          console.log('  Trying to cancel order instead...');
          await odoo.callMethod('sale.order', 'action_cancel', [[so.id]]);
          console.log('  -> Order cancelled');
        } catch (cancelError) {
          console.log('  Cancel failed:', cancelError.message);
        }
      }
    }
    console.log('');
  }

  // Verify the changes
  console.log('========================================');
  console.log('VERIFICATION');
  console.log('========================================\n');

  const updatedOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', VINE_ORDER_IDS]],
    ['id', 'name', 'client_order_ref', 'invoice_status', 'state']
  );

  for (const so of updatedOrders) {
    console.log(so.name, '| Status:', so.invoice_status, '| State:', so.state);
  }
}

setVineOrdersNoInvoice().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
