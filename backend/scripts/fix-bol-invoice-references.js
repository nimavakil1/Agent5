/**
 * Fix BOL invoice references
 *
 * Updates existing BOL invoices to include the BOL order number in:
 * - payment_reference (Payment Reference)
 * - ref (Customer Reference)
 */
require('dotenv').config();

async function main() {
  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix BOL Invoice References ===\n');

  // Find all BOL invoices (invoice_origin starts with FBB, FBR, or BOL)
  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      '|', '|',
      ['invoice_origin', 'like', 'FBB%'],
      ['invoice_origin', 'like', 'FBR%'],
      ['invoice_origin', 'like', 'BOL%']
    ],
    ['id', 'name', 'invoice_origin', 'payment_reference', 'ref'],
    { limit: 10000, order: 'id desc' }
  );

  console.log(`Found ${invoices.length} BOL invoices\n`);

  // Filter to those missing references
  const invoicesToFix = invoices.filter(inv => !inv.payment_reference || !inv.ref);
  console.log(`${invoicesToFix.length} invoices need reference fields updated\n`);

  if (invoicesToFix.length === 0) {
    console.log('All invoices already have references set!');
    process.exit(0);
  }

  let fixed = 0;
  let errors = 0;
  let noOrderRef = 0;

  for (const invoice of invoicesToFix) {
    try {
      // Get the sale order to find client_order_ref (BOL order number)
      const saleOrderName = invoice.invoice_origin;

      const [saleOrder] = await odoo.searchRead('sale.order',
        [['name', '=', saleOrderName]],
        ['id', 'name', 'client_order_ref']
      );

      if (!saleOrder || !saleOrder.client_order_ref) {
        console.log(`  - ${invoice.name}: No client_order_ref found on ${saleOrderName}`);
        noOrderRef++;
        continue;
      }

      const bolOrderNumber = saleOrder.client_order_ref;

      // Update the invoice
      await odoo.execute('account.move', 'write', [[invoice.id], {
        payment_reference: bolOrderNumber,
        ref: bolOrderNumber
      }]);

      console.log(`  + ${invoice.name} <- ${bolOrderNumber}`);
      fixed++;

    } catch (error) {
      console.error(`  ! ${invoice.name}: ${error.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`No order ref: ${noOrderRef}`);
  console.log(`Errors: ${errors}`);
  console.log(`Already OK: ${invoices.length - invoicesToFix.length}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
