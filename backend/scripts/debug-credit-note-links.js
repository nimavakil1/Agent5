require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check the specific credit note we created
  const cn = await odoo.searchRead('account.move',
    [['name', '=', 'RVDE/2025/12/00334']],
    ['id', 'name', 'move_type', 'invoice_origin']
  );

  console.log('Credit Note:', cn[0]);

  // Get its lines
  const lines = await odoo.searchRead('account.move.line',
    [
      ['move_id', '=', cn[0].id],
      ['display_type', '=', 'product']
    ],
    ['id', 'product_id', 'quantity', 'sale_line_ids']
  );

  console.log('\nCredit Note Lines:');
  for (const line of lines) {
    console.log('  Line ' + line.id + ': product=' + (line.product_id ? line.product_id[0] : 'N/A') + ', qty=' + line.quantity);
    console.log('    sale_line_ids:', line.sale_line_ids);

    if (line.sale_line_ids && line.sale_line_ids.length > 0) {
      const orderLines = await odoo.searchRead('sale.order.line',
        [['id', 'in', line.sale_line_ids]],
        ['id', 'order_id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice']
      );
      console.log('    Linked order lines:');
      for (const ol of orderLines) {
        console.log('      Line ' + ol.id + ': delivered=' + ol.qty_delivered + ', invoiced=' + ol.qty_invoiced + ', to_invoice=' + ol.qty_to_invoice);
      }
    }
  }
}

main().catch(e => console.error(e));
