/**
 * Fix BOL invoice references
 *
 * Updates existing BOL invoices to include the correct BOL order number in:
 * - payment_reference (Payment Reference)
 * - ref (Customer Reference)
 * - x_end_user_reference (End User References - custom field)
 *
 * The BOL order number is the order name WITHOUT the FBB/FBR/BOL prefix.
 * Example: Order name "FBBA000DD78MR" → BOL order number "A000DD78MR"
 */
require('dotenv').config();

async function main() {
  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix BOL Invoice References (v2 - Strip Prefix) ===\n');

  // Find all BOL invoices (invoice_origin starts with FBB, FBR, or BOL)
  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      '|', '|',
      ['invoice_origin', 'like', 'FBB%'],
      ['invoice_origin', 'like', 'FBR%'],
      ['invoice_origin', 'like', 'BOL%']
    ],
    ['id', 'name', 'invoice_origin', 'payment_reference', 'ref', 'x_end_user_reference'],
    { limit: 10000, order: 'id desc' }
  );

  console.log(`Found ${invoices.length} BOL invoices\n`);

  if (invoices.length === 0) {
    console.log('No BOL invoices found');
    process.exit(0);
  }

  let fixed = 0;
  let errors = 0;
  let skipped = 0;

  for (const invoice of invoices) {
    try {
      // Get the sale order name from invoice_origin
      const orderName = invoice.invoice_origin;
      if (!orderName) {
        console.log(`  - ${invoice.name}: No invoice_origin`);
        skipped++;
        continue;
      }

      // Strip FBB/FBR/BOL prefix to get actual BOL order number
      const bolOrderNumber = orderName.replace(/^(FBB|FBR|BOL)/, '');

      // Check if already correct
      if (invoice.payment_reference === bolOrderNumber &&
          invoice.ref === bolOrderNumber &&
          invoice.x_end_user_reference === bolOrderNumber) {
        skipped++;
        continue;
      }

      // Update the invoice with correct BOL order number
      await odoo.execute('account.move', 'write', [[invoice.id], {
        payment_reference: bolOrderNumber,
        ref: bolOrderNumber,
        x_end_user_reference: bolOrderNumber
      }]);

      console.log(`  + ${invoice.name} <- ${bolOrderNumber} (was: ${invoice.payment_reference || 'empty'})`);
      fixed++;

    } catch (error) {
      console.error(`  ! ${invoice.name}: ${error.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`Skipped (already correct): ${skipped}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
