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

async function fixVineOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Fixing', VINE_ORDER_IDS.length, 'Vine orders\n');
  console.log('Goal: State=sale, Delivered, Invoice status=invoiced (via zero invoice)\n');

  // Find the sale orders
  const saleOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', VINE_ORDER_IDS]],
    ['id', 'name', 'client_order_ref', 'invoice_status', 'state', 'partner_id', 'partner_invoice_id', 'order_line']
  );

  console.log('Found', saleOrders.length, 'sale orders\n');

  for (const so of saleOrders) {
    console.log('========================================');
    console.log('Order:', so.name);
    console.log('Current state:', so.state, '| Invoice status:', so.invoice_status);

    try {
      // Step 1: If cancelled, try to set back to draft then confirm
      if (so.state === 'cancel') {
        console.log('  Attempting to reactivate cancelled order...');

        // Try action_draft to set back to draft
        try {
          await odoo.callMethod('sale.order', 'action_draft', [[so.id]]);
          console.log('  -> Set to draft');
        } catch (e) {
          console.log('  -> action_draft failed:', e.message);
        }

        // Try action_confirm to confirm
        try {
          await odoo.callMethod('sale.order', 'action_confirm', [[so.id]]);
          console.log('  -> Confirmed');
        } catch (e) {
          console.log('  -> action_confirm failed:', e.message);
        }
      }

      // Step 2: Check order lines and set qty_delivered
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', so.id]],
        ['id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'price_unit']
      );

      console.log('  Order lines:', orderLines.length);
      for (const line of orderLines) {
        console.log('    Line', line.id, ': qty=', line.product_uom_qty,
                    ', delivered=', line.qty_delivered,
                    ', invoiced=', line.qty_invoiced,
                    ', price=', line.price_unit);

        // Set qty_delivered = product_uom_qty if not already
        if (line.qty_delivered < line.product_uom_qty) {
          await odoo.write('sale.order.line', [line.id], {
            qty_delivered: line.product_uom_qty
          });
          console.log('    -> Set qty_delivered to', line.product_uom_qty);
        }
      }

      // Step 3: Create a zero invoice for this order
      // Get refreshed order data
      const refreshedOrder = await odoo.searchRead('sale.order',
        [['id', '=', so.id]],
        ['id', 'name', 'state', 'invoice_status', 'partner_id', 'partner_invoice_id']
      );
      const order = refreshedOrder[0];

      console.log('  After updates - State:', order.state, '| Invoice status:', order.invoice_status);

      if (order.invoice_status !== 'invoiced') {
        console.log('  Creating zero invoice...');

        // Get order lines again
        const lines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', so.id]],
          ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id']
        );

        // Build invoice lines with zero price
        const invoiceLines = [];
        for (const line of lines) {
          invoiceLines.push([0, 0, {
            product_id: line.product_id ? line.product_id[0] : false,
            name: line.name + ' [VINE - No charge]',
            quantity: line.product_uom_qty,
            price_unit: 0,  // Zero price for Vine
            tax_ids: [[6, 0, []]],  // No tax
            sale_line_ids: [[6, 0, [line.id]]]
          }]);
        }

        // Create the invoice
        const invoiceData = {
          move_type: 'out_invoice',
          partner_id: order.partner_invoice_id ? order.partner_invoice_id[0] : order.partner_id[0],
          invoice_origin: so.client_order_ref,
          ref: so.client_order_ref + ' [VINE]',
          invoice_date: '2024-08-05',  // Date when shipped
          invoice_line_ids: invoiceLines
        };

        const invoiceId = await odoo.create('account.move', invoiceData);
        console.log('  -> Created zero invoice ID:', invoiceId);

        // Post the invoice
        try {
          await odoo.callMethod('account.move', 'action_post', [[invoiceId]]);
          console.log('  -> Invoice posted');
        } catch (e) {
          console.log('  -> Post failed:', e.message);
        }
      }

    } catch (error) {
      console.log('  ERROR:', error.message);
    }
    console.log('');
  }

  // Final verification
  console.log('\n========================================');
  console.log('FINAL VERIFICATION');
  console.log('========================================\n');

  const finalOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', VINE_ORDER_IDS]],
    ['id', 'name', 'client_order_ref', 'invoice_status', 'state', 'invoice_ids']
  );

  for (const so of finalOrders) {
    console.log(so.name);
    console.log('  State:', so.state, '| Invoice status:', so.invoice_status);
    console.log('  Invoices:', so.invoice_ids?.length || 0);
  }
}

fixVineOrders().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
