#!/usr/bin/env node
/**
 * Reverse invoices with credit notes
 *
 * Creates credit notes for the 9 wrongly linked invoices to reverse them.
 * The credit notes will be dated in January 2026.
 *
 * Usage:
 *   node src/scripts/reverseWrongInvoices.js --dry-run    # Preview changes
 *   node src/scripts/reverseWrongInvoices.js --fix        # Apply fixes
 */

require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

// The 9 invoices to reverse
const INVOICES_TO_REVERSE = [
  { invoiceId: 360101, invoiceName: 'VOS/2025/12/03508', amazonOrderId: '402-1160083-6363529' },
  { invoiceId: 360103, invoiceName: 'VOS/2025/12/03519', amazonOrderId: '405-7031124-1753168' },
  { invoiceId: 360248, invoiceName: 'VOS/2025/12/03607', amazonOrderId: '303-7993887-6359566' },
  { invoiceId: 360254, invoiceName: 'VBE/2025/12/02184', amazonOrderId: '407-6214261-6623568' },
  { invoiceId: 360255, invoiceName: 'VBE/2025/12/02181', amazonOrderId: '404-3134498-6558767' },
  { invoiceId: 360258, invoiceName: 'VOS/2025/12/03696', amazonOrderId: '402-3394787-4841132' },
  { invoiceId: 360261, invoiceName: 'VOS/2025/12/03757', amazonOrderId: '408-7203120-7093146' },
  { invoiceId: 360262, invoiceName: 'VOS/2025/12/03709', amazonOrderId: '403-4696052-1501900' },
  { invoiceId: 360264, invoiceName: 'VOS/2025/12/03708', amazonOrderId: '403-4652236-2349159' },
];

// Credit note date in January 2026
const CREDIT_NOTE_DATE = '2026-01-30';

async function reverseInvoices() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fix = args.includes('--fix');

  if (!dryRun && !fix) {
    console.log('Usage:');
    console.log('  node src/scripts/reverseWrongInvoices.js --dry-run    # Preview changes');
    console.log('  node src/scripts/reverseWrongInvoices.js --fix        # Apply fixes');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Reverse Invoices with Credit Notes - ${dryRun ? 'DRY RUN' : 'APPLYING FIXES'}`);
  console.log(`Credit Note Date: ${CREDIT_NOTE_DATE}`);
  console.log(`${'='.repeat(60)}\n`);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  let reversed = 0;
  let errors = 0;

  for (const inv of INVOICES_TO_REVERSE) {
    console.log(`\nInvoice: ${inv.invoiceName} (ID: ${inv.invoiceId})`);
    console.log(`  Amazon Order: ${inv.amazonOrderId}`);

    try {
      // Get current invoice data
      const invoices = await odoo.searchRead('account.move',
        [['id', '=', inv.invoiceId]],
        ['id', 'name', 'state', 'payment_state', 'amount_total', 'reversed_entry_id']
      );

      if (invoices.length === 0) {
        console.log(`  ERROR: Invoice not found in Odoo`);
        errors++;
        continue;
      }

      const invoice = invoices[0];
      console.log(`  State: ${invoice.state}, Payment: ${invoice.payment_state}`);
      console.log(`  Amount: ${invoice.amount_total}`);

      if (invoice.reversed_entry_id) {
        console.log(`  SKIP: Already reversed (credit note: ${invoice.reversed_entry_id[1]})`);
        continue;
      }

      if (invoice.state !== 'posted') {
        console.log(`  SKIP: Invoice is not posted (state: ${invoice.state})`);
        continue;
      }

      if (fix) {
        // Create reversal (credit note) using Odoo's reverse wizard
        console.log(`  Creating credit note...`);

        // Use the account.move.reversal wizard
        const wizardId = await odoo.create('account.move.reversal', {
          move_ids: [[6, 0, [inv.invoiceId]]],
          date: CREDIT_NOTE_DATE,
          reason: `Reversal - wrong order link (Amazon: ${inv.amazonOrderId})`,
          journal_id: false,  // Use same journal as original
        });

        // Execute the reversal
        const result = await odoo.execute('account.move.reversal', 'reverse_moves', [[wizardId]]);

        // Get the created credit note
        let creditNoteId = null;
        if (result && result.res_id) {
          creditNoteId = result.res_id;
        } else if (result && result.domain) {
          // Sometimes returns a domain instead of res_id
          const creditNotes = await odoo.searchRead('account.move',
            [['reversed_entry_id', '=', inv.invoiceId]],
            ['id', 'name', 'state']
          );
          if (creditNotes.length > 0) {
            creditNoteId = creditNotes[0].id;
          }
        }

        if (creditNoteId) {
          const creditNote = await odoo.searchRead('account.move',
            [['id', '=', creditNoteId]],
            ['id', 'name', 'state']
          );
          if (creditNote.length > 0) {
            console.log(`  Credit note created: ${creditNote[0].name} (ID: ${creditNote[0].id})`);

            // Post the credit note if it's draft
            if (creditNote[0].state === 'draft') {
              console.log(`  Posting credit note...`);
              try {
                await odoo.execute('account.move', 'action_post', [[creditNote[0].id]]);
                console.log(`  Credit note posted.`);
              } catch (postErr) {
                if (!postErr.message?.includes('cannot marshal None')) {
                  throw postErr;
                }
                console.log(`  Credit note posted.`);
              }
            }
          }
        }

        console.log(`  Reversed successfully.`);
        reversed++;
      } else {
        console.log(`  [DRY RUN] Would create credit note dated ${CREDIT_NOTE_DATE}`);
        reversed++;
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Invoices ${dryRun ? 'to reverse' : 'reversed'}: ${reversed}`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log('This was a dry run. Run with --fix to apply changes.');
  } else {
    console.log('The VCS orders have already been reset to "pending".');
    console.log('You can now re-process them to create correct invoices.');
  }
}

reverseInvoices().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
