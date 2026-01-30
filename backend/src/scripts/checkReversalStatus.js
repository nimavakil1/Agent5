#!/usr/bin/env node
require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

const REVERSED_INVOICES = [
  { invoiceId: 360101, invoiceName: 'VOS/2025/12/03508' },
  { invoiceId: 360103, invoiceName: 'VOS/2025/12/03519' },
  { invoiceId: 360248, invoiceName: 'VOS/2025/12/03607' },
  { invoiceId: 360254, invoiceName: 'VBE/2025/12/02184' },
  { invoiceId: 360255, invoiceName: 'VBE/2025/12/02181' },
  { invoiceId: 360258, invoiceName: 'VOS/2025/12/03696' },
  { invoiceId: 360261, invoiceName: 'VOS/2025/12/03757' },
  { invoiceId: 360262, invoiceName: 'VOS/2025/12/03709' },
  { invoiceId: 360264, invoiceName: 'VOS/2025/12/03708' },
];

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Checking reversal status of all 9 invoices:\n');
  console.log('='.repeat(80));

  for (const inv of REVERSED_INVOICES) {
    // Check the original invoice
    const invoices = await odoo.searchRead('account.move',
      [['id', '=', inv.invoiceId]],
      ['id', 'name', 'state', 'reversed_entry_id', 'payment_state', 'amount_total', 'amount_residual']
    );

    if (invoices.length > 0) {
      const invoice = invoices[0];
      console.log(`\n${inv.invoiceName} (ID: ${inv.invoiceId})`);
      console.log(`  State: ${invoice.state}`);
      console.log(`  Payment State: ${invoice.payment_state}`);
      console.log(`  Amount Total: ${invoice.amount_total}`);
      console.log(`  Amount Residual: ${invoice.amount_residual}`);
      console.log(`  Reversed By: ${invoice.reversed_entry_id ? invoice.reversed_entry_id[1] : '(not reversed)'}`);

      // If reversed, check the credit note
      if (invoice.reversed_entry_id) {
        const creditNotes = await odoo.searchRead('account.move',
          [['id', '=', invoice.reversed_entry_id[0]]],
          ['id', 'name', 'state', 'date', 'amount_total']
        );
        if (creditNotes.length > 0) {
          const cn = creditNotes[0];
          console.log(`  Credit Note: ${cn.name} (ID: ${cn.id})`);
          console.log(`  Credit Note Date: ${cn.date}`);
          console.log(`  Credit Note State: ${cn.state}`);
          console.log(`  Credit Note Amount: ${cn.amount_total}`);
        }
      }
    } else {
      console.log(`\n${inv.invoiceName} (ID: ${inv.invoiceId})`);
      console.log(`  NOT FOUND in Odoo!`);
    }
  }

  // Also check for any credit notes dated 2026-01-30
  console.log('\n' + '='.repeat(80));
  console.log('\nAll credit notes created on 2026-01-30:');
  const allCreditNotes = await odoo.searchRead('account.move',
    [['move_type', '=', 'out_refund'], ['date', '=', '2026-01-30']],
    ['id', 'name', 'state', 'amount_total', 'reversed_entry_id', 'ref']
  );

  for (const cn of allCreditNotes) {
    console.log(`\n${cn.name} (ID: ${cn.id})`);
    console.log(`  State: ${cn.state}`);
    console.log(`  Amount: ${cn.amount_total}`);
    console.log(`  Reverses: ${cn.reversed_entry_id ? cn.reversed_entry_id[1] : '(none)'}`);
    console.log(`  Ref: ${cn.ref || '(empty)'}`);
  }

  console.log('\n' + '='.repeat(80));
}

main().catch(console.error);
