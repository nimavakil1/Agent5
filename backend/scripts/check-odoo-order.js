/**
 * Check Odoo order details
 * Usage: node scripts/check-odoo-order.js <odooOrderId>
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.log('Usage: node scripts/check-odoo-order.js <odooOrderId>');
    process.exit(1);
  }

  try {
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    const orders = await odoo.searchRead('sale.order', [['id', '=', parseInt(orderId)]], {
      fields: ['name', 'client_order_ref', 'partner_id', 'state', 'date_order']
    });

    if (orders.length === 0) {
      console.log(`Order ${orderId} not found in Odoo`);
    } else {
      console.log('Order details:');
      console.log(JSON.stringify(orders[0], null, 2));
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
