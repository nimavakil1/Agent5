/**
 * Analyze OSS sales incorrectly placed on BE journal
 * Report only - no changes made
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Analysis: OSS Sales on BE Journal (December 2025)');
  console.log('='.repeat(100));

  // Get VBE journal ID
  const journals = await odoo.searchRead('account.journal',
    [['code', '=', 'VBE']],
    ['id', 'name'],
    { limit: 1 }
  );

  if (journals.length === 0) {
    console.log('VBE journal not found');
    process.exit(1);
  }

  const vbeJournalId = journals[0].id;
  console.log('VBE Journal ID: ' + vbeJournalId);

  // Get all taxes to identify OSS taxes
  const allTaxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale']],
    ['id', 'name'],
    { limit: 500 }
  );

  const taxNames = {};
  const ossTaxIds = [];

  for (const t of allTaxes) {
    taxNames[t.id] = t.name;
    // OSS taxes typically have country prefix but NOT BE
    const match = t.name.match(/^([A-Z]{2})\*/);
    if (match && match[1] !== 'BE') {
      ossTaxIds.push(t.id);
    }
  }

  console.log('Found ' + ossTaxIds.length + ' non-BE taxes (potential OSS indicators)');

  // Get December invoices and credit notes on VBE journal
  const invoices = await odoo.searchRead('account.move',
    [
      ['journal_id', '=', vbeJournalId],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31']
    ],
    ['id', 'name', 'move_type', 'invoice_date', 'partner_id', 'amount_total', 'payment_state', 'fiscal_position_id'],
    { limit: 5000 }
  );

  console.log('\nFound ' + invoices.length + ' posted documents on VBE journal in December 2025');

  // Get fiscal positions to identify OSS
  const fiscalPositions = await odoo.searchRead('account.fiscal.position',
    [],
    ['id', 'name'],
    { limit: 100 }
  );

  const fpNames = {};
  const ossFpIds = [];
  for (const fp of fiscalPositions) {
    fpNames[fp.id] = fp.name;
    // OSS fiscal positions typically contain "OSS" or non-BE country codes
    if (fp.name.includes('OSS') ||
        (fp.name.match(/^[A-Z]{2}\*/) && !fp.name.startsWith('BE'))) {
      ossFpIds.push(fp.id);
    }
  }

  const ossFpNamesList = ossFpIds.map(id => fpNames[id]).join(', ');
  console.log('OSS Fiscal Positions: ' + (ossFpNamesList || 'None identified'));

  // Analyze each invoice
  const wrongInvoices = [];
  const wrongCreditNotes = [];

  let checked = 0;
  for (const inv of invoices) {
    checked++;
    if (checked % 500 === 0) {
      console.log('  Checked ' + checked + ' / ' + invoices.length + '...');
    }

    // Check if fiscal position indicates OSS
    const fpId = inv.fiscal_position_id ? inv.fiscal_position_id[0] : null;
    const fpName = fpId ? fpNames[fpId] : null;
    const isOssFp = fpId && ossFpIds.includes(fpId);

    // Get invoice lines to check taxes
    const lines = await odoo.searchRead('account.move.line',
      [['move_id', '=', inv.id], ['display_type', '=', 'product']],
      ['id', 'tax_ids', 'name'],
      { limit: 50 }
    );

    // Check for non-BE taxes
    let hasNonBeTax = false;
    let nonBeTaxes = [];
    let hasOssTax = false;

    for (const line of lines) {
      if (!line.tax_ids) continue;
      for (const taxId of line.tax_ids) {
        const taxName = taxNames[taxId] || '';
        const taxMatch = taxName.match(/^([A-Z]{2})\*/);
        if (taxMatch && taxMatch[1] !== 'BE') {
          hasNonBeTax = true;
          nonBeTaxes.push(taxName);
          // Check if it's a known EU OSS country
          const country = taxMatch[1];
          const ossCountries = ['DE', 'FR', 'NL', 'IT', 'ES', 'AT', 'PL', 'CZ', 'PT', 'IE', 'SE', 'DK', 'FI', 'LU', 'GR', 'HU', 'RO', 'BG', 'SK', 'SI', 'HR', 'LT', 'LV', 'EE', 'CY', 'MT'];
          if (ossCountries.includes(country)) {
            hasOssTax = true;
          }
        }
      }
    }

    // Flag if has OSS fiscal position OR has non-BE taxes
    if (isOssFp || hasOssTax || hasNonBeTax) {
      const record = {
        id: inv.id,
        name: inv.name,
        type: inv.move_type === 'out_invoice' ? 'Invoice' : 'Credit Note',
        date: inv.invoice_date,
        partner: inv.partner_id ? inv.partner_id[1] : 'Unknown',
        amount: inv.amount_total,
        paymentState: inv.payment_state,
        fiscalPosition: fpName || 'None',
        isOssFp,
        taxes: [...new Set(nonBeTaxes)],
        url: 'https://acropaq.odoo.com/web#id=' + inv.id + '&model=account.move&view_type=form'
      };

      if (inv.move_type === 'out_invoice') {
        wrongInvoices.push(record);
      } else {
        wrongCreditNotes.push(record);
      }
    }
  }

  // Print report
  console.log('\n' + '='.repeat(100));
  console.log('REPORT: Documents on VBE that should be on VOS (OSS)');
  console.log('='.repeat(100));

  console.log('\nINVOICES WITH WRONG JOURNAL: ' + wrongInvoices.length);
  console.log('-'.repeat(100));

  let invoiceTotal = 0;
  let invoicePaid = 0;
  let invoiceNotPaid = 0;

  for (const inv of wrongInvoices) {
    invoiceTotal += inv.amount;
    if (inv.paymentState === 'not_paid') {
      invoiceNotPaid++;
    } else {
      invoicePaid++;
    }
    console.log('\n' + inv.name + ' (' + inv.type + ')');
    console.log('  Date: ' + inv.date + ' | Amount: EUR ' + inv.amount.toFixed(2) + ' | Payment: ' + inv.paymentState);
    console.log('  Partner: ' + inv.partner);
    console.log('  Fiscal Position: ' + inv.fiscalPosition + (inv.isOssFp ? ' [OSS]' : ''));
    console.log('  Wrong taxes: ' + inv.taxes.join(', '));
    console.log('  URL: ' + inv.url);
  }

  console.log('\nCREDIT NOTES WITH WRONG JOURNAL: ' + wrongCreditNotes.length);
  console.log('-'.repeat(100));

  let cnTotal = 0;
  let cnPaid = 0;
  let cnNotPaid = 0;

  for (const cn of wrongCreditNotes) {
    cnTotal += cn.amount;
    if (cn.paymentState === 'not_paid') {
      cnNotPaid++;
    } else {
      cnPaid++;
    }
    console.log('\n' + cn.name + ' (' + cn.type + ')');
    console.log('  Date: ' + cn.date + ' | Amount: EUR ' + cn.amount.toFixed(2) + ' | Payment: ' + cn.paymentState);
    console.log('  Partner: ' + cn.partner);
    console.log('  Fiscal Position: ' + cn.fiscalPosition + (cn.isOssFp ? ' [OSS]' : ''));
    console.log('  Wrong taxes: ' + cn.taxes.join(', '));
    console.log('  URL: ' + cn.url);
  }

  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('\nInvoices on VBE with non-BE taxes: ' + wrongInvoices.length);
  console.log('  - Not paid: ' + invoiceNotPaid + ' (can be fixed automatically)');
  console.log('  - Paid/Partial: ' + invoicePaid + ' (need manual fix)');
  console.log('  - Total amount: EUR ' + invoiceTotal.toFixed(2));

  console.log('\nCredit Notes on VBE with non-BE taxes: ' + wrongCreditNotes.length);
  console.log('  - Not paid: ' + cnNotPaid + ' (can be fixed automatically)');
  console.log('  - Paid/Partial: ' + cnPaid + ' (need manual fix)');
  console.log('  - Total amount: EUR ' + cnTotal.toFixed(2));

  console.log('\nTOTAL DOCUMENTS TO FIX: ' + (wrongInvoices.length + wrongCreditNotes.length));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
