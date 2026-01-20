/**
 * Fix OSS invoices on wrong BE journal - move to VOS journal
 * Only fixes unpaid invoices
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Invoice IDs from the analysis (all unpaid)
const INVOICE_IDS = [
  365463, 365469, 365464, 357555, 357570, 357569, 357422,
  353985, 353984, 353835, 351921, 346372, 363187, 364843,
  364845, 364846, 364866, 364869, 364870, 364871, 344714,
  358775
];

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Fix OSS Invoices: Move from VBE to VOS Journal');
  console.log('='.repeat(100));
  console.log('Mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE'));

  // Get VOS journal ID
  const vosJournals = await odoo.searchRead('account.journal',
    [['code', '=', 'VOS']],
    ['id', 'name'],
    { limit: 1 }
  );

  if (vosJournals.length === 0) {
    console.log('ERROR: VOS journal not found!');
    process.exit(1);
  }

  const vosJournalId = vosJournals[0].id;
  console.log('VOS Journal: ' + vosJournals[0].name + ' (ID: ' + vosJournalId + ')');

  // Get invoice details
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', INVOICE_IDS]],
    ['id', 'name', 'state', 'payment_state', 'journal_id', 'amount_total'],
    { limit: 100 }
  );

  console.log('\nFound ' + invoices.length + ' invoices to process\n');

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const inv of invoices) {
    console.log('[' + (fixed + skipped + failed + 1) + '/' + invoices.length + '] ' + inv.name);

    // Verify it's not paid
    if (inv.payment_state !== 'not_paid') {
      console.log('  SKIPPED - payment state is: ' + inv.payment_state);
      skipped++;
      continue;
    }

    // Verify it's posted
    if (inv.state !== 'posted') {
      console.log('  SKIPPED - state is: ' + inv.state);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would move from ' + inv.journal_id[1] + ' to VOS');
      fixed++;
      continue;
    }

    try {
      // Reset to draft
      try {
        await odoo.execute('account.move', 'button_draft', [[inv.id]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      // Change journal to VOS
      await odoo.write('account.move', [inv.id], {
        journal_id: vosJournalId
      });

      // Re-post
      try {
        await odoo.execute('account.move', 'action_post', [[inv.id]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      // Verify
      const updated = await odoo.searchRead('account.move',
        [['id', '=', inv.id]],
        ['name', 'journal_id', 'state'],
        { limit: 1 }
      );

      if (updated.length > 0 && updated[0].journal_id[0] === vosJournalId && updated[0].state === 'posted') {
        console.log('  OK - Moved to VOS, new name: ' + updated[0].name);
        fixed++;
      } else {
        console.log('  ERROR - Verification failed');
        failed++;
      }

    } catch (err) {
      console.log('  ERROR - ' + err.message);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('Fixed: ' + fixed);
  console.log('Skipped: ' + skipped);
  console.log('Failed: ' + failed);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
