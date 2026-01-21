/**
 * Fix Cancelled Bol Invoices
 *
 * Finds all "to invoice" Bol orders that have cancelled invoices,
 * resets them to draft, and posts them with the correct date:
 * - December orders → December invoice date
 * - Otherwise → 01/01/2026
 */

require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

// Bol.com Sales Team ID
const BOL_SALES_TEAM_ID = 10; // BOL team

async function fixCancelledBolInvoices(options = {}) {
  const { dryRun = false } = options;
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`FIX CANCELLED BOL INVOICES ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  const results = {
    ordersFound: 0,
    ordersWithCancelledInvoices: 0,
    invoicesReset: 0,
    invoicesPosted: 0,
    decemberInvoices: 0,
    januaryInvoices: 0,
    errors: []
  };

  try {
    // Step 1: Find all Bol orders with invoice_status = 'to invoice' and team_id = Bol
    console.log('[1/4] Finding Bol orders with status "to invoice"...');

    const orders = await odoo.searchRead('sale.order',
      [
        ['invoice_status', '=', 'to invoice'],
        ['state', 'in', ['sale', 'done']],
        ['team_id', '=', BOL_SALES_TEAM_ID],
        '|', '|',
        ['name', 'like', 'FBB%'],
        ['name', 'like', 'FBR%'],
        ['name', 'like', 'BOL%']
      ],
      ['id', 'name', 'date_order', 'invoice_ids', 'amount_total'],
      { limit: 1000, order: 'date_order asc' }
    );

    results.ordersFound = orders.length;
    console.log(`   Found ${orders.length} orders with status "to invoice"\n`);

    if (orders.length === 0) {
      console.log('No orders to process.');
      return results;
    }

    // Step 2: Find orders that have cancelled invoices
    console.log('[2/4] Checking for cancelled invoices...\n');

    const ordersWithCancelledInvoices = [];

    for (const order of orders) {
      if (!order.invoice_ids || order.invoice_ids.length === 0) {
        continue; // No invoices linked, will be handled by normal invoicing
      }

      // Get the invoices for this order
      const invoices = await odoo.searchRead('account.move',
        [
          ['id', 'in', order.invoice_ids],
          ['state', '=', 'cancel']
        ],
        ['id', 'name', 'state', 'invoice_date', 'amount_total']
      );

      if (invoices.length > 0) {
        ordersWithCancelledInvoices.push({
          order,
          cancelledInvoices: invoices
        });
      }
    }

    results.ordersWithCancelledInvoices = ordersWithCancelledInvoices.length;
    console.log(`   Found ${ordersWithCancelledInvoices.length} orders with cancelled invoices\n`);

    if (ordersWithCancelledInvoices.length === 0) {
      console.log('No cancelled invoices to fix.');
      return results;
    }

    // Step 3: Process each order with cancelled invoices
    console.log('[3/4] Processing cancelled invoices...\n');

    for (const { order, cancelledInvoices } of ordersWithCancelledInvoices) {
      const orderDate = new Date(order.date_order);
      const orderMonth = orderDate.getMonth(); // 0-11
      const orderYear = orderDate.getFullYear();

      // Determine invoice date
      let invoiceDate;
      if (orderYear === 2025 && orderMonth === 11) { // December 2025
        // Use the order date for December invoices
        invoiceDate = order.date_order.split(' ')[0]; // Get just the date part
        results.decemberInvoices++;
      } else {
        // Use January 1, 2026 for all others
        invoiceDate = '2026-01-01';
        results.januaryInvoices++;
      }

      console.log(`   ${order.name} (${order.date_order.split(' ')[0]}) → Invoice date: ${invoiceDate}`);

      for (const invoice of cancelledInvoices) {
        try {
          if (dryRun) {
            console.log(`      [DRY RUN] Would reset ${invoice.name || 'draft'} to draft and post with date ${invoiceDate}`);
            results.invoicesReset++;
            results.invoicesPosted++;
            continue;
          }

          // Reset to draft - Odoo's button_draft returns None which causes XML-RPC marshal error
          // We catch this specific error and verify the state changed
          console.log(`      Resetting invoice ${invoice.id} to draft...`);
          try {
            await odoo.execute('account.move', 'button_draft', [[invoice.id]]);
          } catch (buttonDraftError) {
            // Check if it's the "cannot marshal None" error - button_draft succeeded but returned None
            if (buttonDraftError.message && buttonDraftError.message.includes('cannot marshal None')) {
              // This is expected, verify the invoice is now in draft
              const [verifyInvoice] = await odoo.read('account.move', [invoice.id], ['state']);
              if (verifyInvoice.state !== 'draft') {
                throw new Error(`button_draft seemed to fail - invoice still in state: ${verifyInvoice.state}`);
              }
              console.log(`      (button_draft returned None but invoice is now in draft)`);
            } else {
              // Some other error, rethrow
              throw buttonDraftError;
            }
          }
          results.invoicesReset++;

          // Update the invoice date
          await odoo.write('account.move', [invoice.id], {
            invoice_date: invoiceDate,
            date: invoiceDate
          });

          // Post the invoice
          console.log(`      Posting invoice with date ${invoiceDate}...`);
          await odoo.execute('account.move', 'action_post', [[invoice.id]]);
          results.invoicesPosted++;

          // Get the posted invoice name
          const [postedInvoice] = await odoo.read('account.move', [invoice.id], ['name']);
          console.log(`      ✓ Posted as ${postedInvoice.name}`);

        } catch (error) {
          console.error(`      ✗ Error processing invoice ${invoice.id}: ${error.message}`);
          results.errors.push({
            orderId: order.id,
            orderName: order.name,
            invoiceId: invoice.id,
            error: error.message
          });
        }
      }
    }

    // Step 4: Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`Orders found with "to invoice" status: ${results.ordersFound}`);
    console.log(`Orders with cancelled invoices: ${results.ordersWithCancelledInvoices}`);
    console.log(`Invoices reset to draft: ${results.invoicesReset}`);
    console.log(`Invoices posted: ${results.invoicesPosted}`);
    console.log(`  - December 2025 invoices: ${results.decemberInvoices}`);
    console.log(`  - January 2026 invoices: ${results.januaryInvoices}`);
    console.log(`Errors: ${results.errors.length}`);

    if (results.errors.length > 0) {
      console.log('\nErrors:');
      results.errors.forEach(e => {
        console.log(`  - ${e.orderName}: ${e.error}`);
      });
    }

    return results;

  } catch (error) {
    console.error('Fatal error:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  fixCancelledBolInvoices({ dryRun })
    .then(results => {
      console.log('\nDone!');
      process.exit(results.errors.length > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { fixCancelledBolInvoices };
