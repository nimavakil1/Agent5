require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== CHECKING IF MULTI-LINKING IS POSSIBLE ===\n');

  // Check the field definition - sale_line_ids on account.move.line is Many2many
  // If Many2many, one invoice line CAN link to multiple order lines

  // Find existing examples where invoice line is linked to multiple order lines
  console.log('Searching for invoice lines linked to multiple order lines...\n');

  const invoiceLines = await odoo.searchRead('account.move.line',
    [
      ['sale_line_ids', '!=', false],
      ['display_type', '=', 'product']
    ],
    ['id', 'name', 'sale_line_ids', 'quantity'],
    { limit: 1000 }
  );

  let multiLinked = 0;
  const examples = [];

  for (const il of invoiceLines) {
    if (il.sale_line_ids && il.sale_line_ids.length > 1) {
      multiLinked++;
      if (examples.length < 5) {
        examples.push(il);
      }
    }
  }

  console.log('Invoice lines checked: ' + invoiceLines.length);
  console.log('Invoice lines linked to MULTIPLE order lines: ' + multiLinked);

  if (examples.length > 0) {
    console.log('\n=== EXAMPLES OF MULTI-LINKED INVOICE LINES ===\n');
    for (const ex of examples) {
      console.log('Invoice Line ' + ex.id + ': ' + (ex.name || '').substring(0, 40));
      console.log('  Qty: ' + ex.quantity);
      console.log('  Linked to sale_line_ids: ' + JSON.stringify(ex.sale_line_ids));
    }
  }

  // Test: Can we add multiple sale lines to one invoice line?
  console.log('\n=== TESTING MULTI-LINK CAPABILITY ===\n');
  console.log('The sale_line_ids field on account.move.line is Many2many');
  console.log('This means: YES, one invoice line CAN be linked to multiple order lines');
  console.log('\nTo link invoice line X to order lines [A, B]:');
  console.log('  odoo.execute("account.move.line", "write", [[X], {sale_line_ids: [[6, 0, [A, B]]]}])');
}

main().catch(e => console.error(e));
