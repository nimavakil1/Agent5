/**
 * Export FBB orders with wrong warehouse (picking done) to CSV
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

async function exportOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // The 41 orders that cannot be fixed (picking already done)
  const orderNames = [
    'S14774', 'S14773', 'S14772', 'S14771', 'S14770', 'S14769', 'S14767', 'S14766',
    'S14765', 'S14764', 'S14762', 'S14761', 'S14760', 'S14759', 'S14758', 'S14757',
    'S14755', 'S14754', 'S14753', 'S14752', 'S14751', 'S14750', 'S14749', 'S14748',
    'S14747', 'S14746', 'S14745', 'S14744', 'S14743', 'S14741', 'S14740', 'S14739',
    'S14737', 'S14736', 'S14735', 'S14734', 'S14733', 'S14732', 'S14731', 'S14730', 'S14729'
  ];

  const orders = await odoo.searchRead('sale.order',
    [['name', 'in', orderNames]],
    ['id', 'name', 'client_order_ref', 'partner_id']
  );

  // Sort by order name
  orders.sort((a, b) => a.name.localeCompare(b.name));

  // Build CSV
  const lines = ['Odoo_Order,Bol_Order_ID,Customer_Name'];
  orders.forEach(o => {
    const bolOrderId = o.client_order_ref || '';
    const customerName = o.partner_id ? o.partner_id[1].replace(/"/g, "'") : '';
    lines.push(`${o.name},${bolOrderId},"${customerName}"`);
  });

  const csv = lines.join('\n');

  // Save to file
  const filename = '/tmp/fbb_orders_wrong_warehouse.csv';
  fs.writeFileSync(filename, csv);
  console.log('Exported', orders.length, 'orders to', filename);
  console.log('\n' + csv);
}

exportOrders().catch(console.error);
