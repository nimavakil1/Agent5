require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Finding and fixing remaining duplicate orders...\n');

  // Get orders with 'to invoice' status
  const toInvoiceOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name'],
    { limit: 5000 }
  );

  console.log('Orders with "to invoice": ' + toInvoiceOrders.length);

  // Group by name
  const byName = {};
  for (const o of toInvoiceOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  // For each name, check if there are other orders with same name
  let duplicateCount = 0;
  for (const [name, orders] of Object.entries(byName)) {
    const allWithName = await odoo.searchRead('sale.order',
      [['name', '=', name]],
      ['id'],
      { limit: 10 }
    );

    if (allWithName.length > 1) {
      duplicateCount++;
      console.log('\nDuplicate: ' + name + ' (total orders: ' + allWithName.length + ')');

      for (const o of orders) {
        console.log('  Fixing order ' + o.id + '...');
        const lines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', o.id]],
          ['id']
        );
        const lineIds = lines.map(l => l.id);
        if (lineIds.length > 0) {
          await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
          console.log('    Marked ' + lineIds.length + ' lines as invoiced');
        }
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Fixed ' + duplicateCount + ' duplicate order groups');
}

main().catch(e => console.error(e));
