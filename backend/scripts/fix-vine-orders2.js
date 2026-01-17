require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixVineOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // The 10 zero invoices we just created
  const invoiceIds = [366058, 366059, 366060, 366061, 366062, 366063, 366064, 366065, 366066, 366067];

  console.log('Posting', invoiceIds.length, 'zero Vine invoices...\n');

  for (const invoiceId of invoiceIds) {
    try {
      // Get invoice details first
      const invoice = await odoo.searchRead('account.move',
        [['id', '=', invoiceId]],
        ['id', 'name', 'state', 'amount_total', 'invoice_origin']
      );

      if (invoice.length === 0) {
        console.log('Invoice', invoiceId, 'not found');
        continue;
      }

      const inv = invoice[0];
      console.log('Invoice ID:', inv.id, '| Name:', inv.name, '| State:', inv.state);
      console.log('  Origin:', inv.invoice_origin, '| Amount:', inv.amount_total);

      if (inv.state === 'draft') {
        // Post the invoice using execute method
        await odoo.execute('account.move', 'action_post', [[invoiceId]]);
        console.log('  -> Posted successfully');
      } else {
        console.log('  -> Already', inv.state);
      }
    } catch (error) {
      console.log('  ERROR posting invoice', invoiceId, ':', error.message);
    }
    console.log('');
  }

  // Now try to reactivate the cancelled orders
  console.log('\n========================================');
  console.log('REACTIVATING CANCELLED ORDERS');
  console.log('========================================\n');

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

  const saleOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', VINE_ORDER_IDS]],
    ['id', 'name', 'state', 'invoice_status']
  );

  for (const so of saleOrders) {
    console.log('Order:', so.name, '| State:', so.state);

    if (so.state === 'cancel') {
      try {
        // Try action_draft first
        await odoo.execute('sale.order', 'action_draft', [[so.id]]);
        console.log('  -> Set to draft');

        // Then confirm
        await odoo.execute('sale.order', 'action_confirm', [[so.id]]);
        console.log('  -> Confirmed (sale)');
      } catch (error) {
        console.log('  -> Reactivation failed:', error.message);

        // Alternative: just update state directly
        try {
          await odoo.write('sale.order', [so.id], { state: 'sale' });
          console.log('  -> Forced state to sale');
        } catch (e2) {
          console.log('  -> Force state failed:', e2.message);
        }
      }
    }
    console.log('');
  }

  // Final verification
  console.log('\n========================================');
  console.log('FINAL STATUS');
  console.log('========================================\n');

  const finalOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', VINE_ORDER_IDS]],
    ['id', 'name', 'state', 'invoice_status', 'invoice_ids']
  );

  for (const so of finalOrders) {
    // Get invoice state
    let invoiceState = 'N/A';
    if (so.invoice_ids && so.invoice_ids.length > 0) {
      const invs = await odoo.searchRead('account.move',
        [['id', 'in', so.invoice_ids]],
        ['state']
      );
      invoiceState = invs.map(i => i.state).join(', ');
    }

    console.log(so.name);
    console.log('  Order State:', so.state, '| Invoice Status:', so.invoice_status);
    console.log('  Invoices:', so.invoice_ids?.length || 0, '| Invoice State:', invoiceState);
  }
}

fixVineOrders().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
