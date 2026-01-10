require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX BAD CREDIT NOTE LINKAGES ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Find credit note lines (from out_refund) that are linked to order lines
  // These are potentially problematic - we may have linked them incorrectly

  // Get all posted credit notes
  // Note: invoice_origin may not have FBA/FBM prefix, so we check for Amazon order ID patterns
  const creditNotes = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_refund'],
      ['state', '=', 'posted']
    ],
    ['id', 'name', 'invoice_origin'],
    { limit: 2000 }
  );

  console.log('Found ' + creditNotes.length + ' posted credit notes\n');

  let fixed = 0;
  let errors = 0;

  for (const cn of creditNotes) {
    if (fixed >= limit) break;

    // Get credit note lines with sale_line_ids
    const cnLines = await odoo.searchRead('account.move.line',
      [
        ['move_id', '=', cn.id],
        ['display_type', '=', 'product'],
        ['sale_line_ids', '!=', false]
      ],
      ['id', 'product_id', 'quantity', 'sale_line_ids']
    );

    if (cnLines.length === 0) continue;

    // Check each credit note line
    for (const cnLine of cnLines) {
      if (!cnLine.sale_line_ids || cnLine.sale_line_ids.length === 0) continue;

      // Get the linked order lines
      const orderLines = await odoo.searchRead('sale.order.line',
        [['id', 'in', cnLine.sale_line_ids]],
        ['id', 'order_id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice']
      );

      // Find order lines where qty_invoiced is negative (wrongly linked to credit note)
      const badLinks = orderLines.filter(ol => ol.qty_invoiced < 0);

      if (badLinks.length === 0) continue;

      console.log('Credit Note: ' + cn.name + ' (ID: ' + cn.id + ')');
      console.log('  Origin: ' + cn.invoice_origin);
      console.log('  CN Line ' + cnLine.id + ' linked to: ' + JSON.stringify(cnLine.sale_line_ids));

      // Remove the bad links - keep only order lines that don't have negative qty_invoiced
      const goodLinks = orderLines.filter(ol => ol.qty_invoiced >= 0).map(ol => ol.id);

      console.log('  Bad links (qty_invoiced < 0): ' + JSON.stringify(badLinks.map(ol => ol.id)));
      console.log('  Keeping links: ' + JSON.stringify(goodLinks));

      if (!dryRun) {
        try {
          await odoo.execute('account.move.line', 'write', [
            [cnLine.id],
            { sale_line_ids: [[6, 0, goodLinks]] }
          ]);
          console.log('  FIXED!');
          fixed++;
        } catch (err) {
          console.log('  ERROR: ' + err.message);
          errors++;
        }
      } else {
        console.log('  [DRY RUN - would unlink]');
        fixed++;
      }
      console.log('');
    }
  }

  console.log('=== SUMMARY ===');
  console.log('Credit note links fixed: ' + fixed);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
