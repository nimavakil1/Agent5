require('dotenv').config();
const fs = require('fs');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function investigateZeroPrice() {
  // The 10 orders with price=0 that were skipped
  const zeroPriceOrders = [
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

  console.log('Investigating', zeroPriceOrders.length, 'orders with price=0\n');

  // Check Odoo
  console.log('\n========================================');
  console.log('CHECKING ODOO');
  console.log('========================================\n');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  for (const orderId of zeroPriceOrders) {
    console.log('Order:', orderId);

    // Find sale order
    const saleOrders = await odoo.searchRead('sale.order',
      [['client_order_ref', '=', orderId]],
      ['id', 'name', 'amount_total', 'state']
    );

    if (saleOrders.length === 0) {
      console.log('  NOT FOUND IN ODOO!\n');
      continue;
    }

    for (const so of saleOrders) {
      console.log('  Sale Order:', so.name, '| Total:', so.amount_total, '| State:', so.state);

      // Get order lines
      const lines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', so.id]],
        ['id', 'name', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal']
      );

      console.log('  Lines:');
      for (const line of lines) {
        const productName = line.product_id ? line.product_id[1] : 'N/A';
        console.log('    - Qty:', line.product_uom_qty, '| Price:', line.price_unit, '| Subtotal:', line.price_subtotal);
        console.log('      Product:', productName.substring(0, 50));
      }
    }
    console.log('');
  }

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================\n');
  console.log('Check above to see if price=0 is from VCS or Odoo');
}

investigateZeroPrice().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
