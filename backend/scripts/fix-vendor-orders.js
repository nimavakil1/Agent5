/**
 * Fix Amazon Vendor orders created today
 * - Set warehouse_id to Central Warehouse (ID: 1)
 * - Set journal_id to VBE (ID: 1)
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const CENTRAL_WAREHOUSE_ID = 1;  // CW
const INVOICE_JOURNAL_ID = 1;    // VBE
const VENDOR_TEAM_ID = 6;        // Amazon Vendor

async function updateOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const today = new Date().toISOString().split('T')[0];
  const orders = await odoo.searchRead('sale.order',
    [['create_date', '>=', today], ['team_id', '=', VENDOR_TEAM_ID]],
    ['id', 'name', 'warehouse_id', 'journal_id']
  );

  console.log('Found', orders.length, 'Amazon Vendor orders to update');

  let updated = 0;
  for (const order of orders) {
    const whId = order.warehouse_id ? order.warehouse_id[0] : null;
    const jId = order.journal_id ? order.journal_id[0] : null;
    const needsUpdate = whId !== CENTRAL_WAREHOUSE_ID || jId !== INVOICE_JOURNAL_ID;

    if (needsUpdate) {
      await odoo.write('sale.order', [order.id], {
        warehouse_id: CENTRAL_WAREHOUSE_ID,
        journal_id: INVOICE_JOURNAL_ID
      });
      const oldWh = order.warehouse_id ? order.warehouse_id[1] : 'None';
      const oldJ = order.journal_id ? order.journal_id[1] : 'None';
      console.log('  Updated', order.name, '- WH:', oldWh, '-> CW | Journal:', oldJ, '-> VBE');
      updated++;
    }
  }

  console.log('\nUpdated', updated, 'orders');
}

updateOrders().catch(console.error);
