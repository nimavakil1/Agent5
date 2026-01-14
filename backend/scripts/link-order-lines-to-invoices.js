require('dotenv').config();
const fs = require('fs');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function linkOrderLines() {
  // Load the analysis results
  const data = JSON.parse(fs.readFileSync('/tmp/order_lines_analysis.json', 'utf-8'));

  const linesToLink = data.hasMatchingInvoiceLine;
  console.log('Lines to link:', linesToLink.length);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  let linked = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails = [];

  // Process in batches
  const batchSize = 50;

  for (let i = 0; i < linesToLink.length; i += batchSize) {
    const batch = linesToLink.slice(i, i + batchSize);

    for (const item of batch) {
      try {
        // Skip if already linked
        if (item.alreadyLinked) {
          skipped++;
          continue;
        }

        // Link sale order line to invoice line
        // Use (4, id) command to add to many2many without removing existing links
        await odoo.write('sale.order.line', [item.saleOrderLineId], {
          invoice_lines: [[4, item.invoiceLineId]]
        });

        linked++;
      } catch (error) {
        errors++;
        errorDetails.push({
          saleOrderLineId: item.saleOrderLineId,
          invoiceLineId: item.invoiceLineId,
          error: error.message
        });
      }
    }

    const progress = Math.min(i + batchSize, linesToLink.length);
    const pct = Math.round((progress / linesToLink.length) * 100);
    process.stdout.write(`\rProgress: ${pct}% (${progress}/${linesToLink.length}) - Linked: ${linked}, Skipped: ${skipped}, Errors: ${errors}`);
  }

  console.log('\n\n========================================');
  console.log('LINKING COMPLETE');
  console.log('========================================\n');

  console.log('Total processed:', linesToLink.length);
  console.log('Successfully linked:', linked);
  console.log('Already linked (skipped):', skipped);
  console.log('Errors:', errors);

  if (errorDetails.length > 0) {
    console.log('\nFirst 10 errors:');
    for (const e of errorDetails.slice(0, 10)) {
      console.log('  SOL', e.saleOrderLineId, '→ Invoice Line', e.invoiceLineId);
      console.log('    Error:', e.error);
    }
  }

  // Verify a sample
  console.log('\n========================================');
  console.log('VERIFICATION (sample of 5)');
  console.log('========================================\n');

  const sampleToVerify = linesToLink.filter(l => !l.alreadyLinked).slice(0, 5);
  for (const item of sampleToVerify) {
    const sol = await odoo.searchRead('sale.order.line',
      [['id', '=', item.saleOrderLineId]],
      ['id', 'invoice_lines', 'qty_invoiced']
    );

    if (sol.length > 0) {
      console.log('SOL', item.saleOrderLineId, ':');
      console.log('  invoice_lines:', JSON.stringify(sol[0].invoice_lines));
      console.log('  qty_invoiced:', sol[0].qty_invoiced);
    }
  }

  // Save results
  fs.writeFileSync('/tmp/linking_results.json', JSON.stringify({
    totalProcessed: linesToLink.length,
    linked,
    skipped,
    errors,
    errorDetails
  }, null, 2));

  console.log('\nResults saved to /tmp/linking_results.json');
}

linkOrderLines().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
