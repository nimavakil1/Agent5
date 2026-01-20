/**
 * Check for mixed-tax invoices on VBE
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VBE journal
  const vbeJournal = await odoo.searchRead('account.journal', [['code', '=', 'VBE']], ['id'], { limit: 1 });
  const vbeJournalId = vbeJournal[0].id;

  // Get all taxes
  const allTaxes = await odoo.searchRead('account.tax', [['type_tax_use', '=', 'sale']], ['id', 'name'], { limit: 500 });
  const taxMap = {};
  for (const t of allTaxes) taxMap[t.id] = t.name;

  // Get posted not-paid VBE December invoices
  const invoices = await odoo.searchRead('account.move',
    [
      ['journal_id', '=', vbeJournalId],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
      ['payment_state', '=', 'not_paid'],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31']
    ],
    ['id', 'name', 'partner_id', 'amount_total'],
    { limit: 5000 }
  );

  console.log('VBE not-paid December invoices:', invoices.length);

  // Get all lines
  const invoiceIds = invoices.map(i => i.id);
  const allLines = [];
  for (let i = 0; i < invoiceIds.length; i += 500) {
    const batchIds = invoiceIds.slice(i, i + 500);
    const batchLines = await odoo.searchRead('account.move.line',
      [['move_id', 'in', batchIds], ['display_type', '=', 'product']],
      ['id', 'move_id', 'tax_ids', 'name', 'price_subtotal'],
      { limit: 50000 }
    );
    allLines.push(...batchLines);
  }

  // Group by invoice
  const linesByInvoice = {};
  for (const line of allLines) {
    const invId = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
    if (!linesByInvoice[invId]) linesByInvoice[invId] = [];
    linesByInvoice[invId].push(line);
  }

  const mixedTaxInvoices = [];
  const pureWrongTaxInvoices = [];

  for (const inv of invoices) {
    const invLines = linesByInvoice[inv.id] || [];
    const taxPrefixes = new Set();

    for (const line of invLines) {
      if (!line.tax_ids || line.tax_ids.length === 0) continue;
      for (const taxId of line.tax_ids) {
        const taxName = taxMap[taxId] || '';
        const prefix = taxName.match(/^([A-Z]{2})/)?.[1] || 'NONE';
        taxPrefixes.add(prefix);
      }
    }

    const hasBE = taxPrefixes.has('BE');
    const hasOther = [...taxPrefixes].some(p => p !== 'BE' && p !== 'NONE');

    if (hasBE && hasOther) {
      mixedTaxInvoices.push({ inv, prefixes: [...taxPrefixes], lines: invLines });
    } else if (!hasBE && hasOther) {
      pureWrongTaxInvoices.push({ inv, prefixes: [...taxPrefixes], lines: invLines });
    }
  }

  console.log('\nMixed-tax invoices (BE* + other):', mixedTaxInvoices.length);
  console.log('Pure wrong-tax invoices (only non-BE*):', pureWrongTaxInvoices.length);

  if (mixedTaxInvoices.length > 0) {
    console.log('\n=== MIXED-TAX INVOICES (need splitting) ===');
    for (const item of mixedTaxInvoices.slice(0, 20)) {
      console.log('\n' + item.inv.name + ' - EUR ' + item.inv.amount_total);
      console.log('  Partner: ' + (item.inv.partner_id ? item.inv.partner_id[1] : 'Unknown'));
      console.log('  Tax prefixes: ' + item.prefixes.join(', '));
      console.log('  Lines:');
      for (const line of item.lines) {
        const taxes = (line.tax_ids || []).map(tid => taxMap[tid] || tid).join(', ');
        console.log('    - ' + line.name.substring(0, 40) + '... | ' + taxes + ' | EUR ' + line.price_subtotal);
      }
      console.log('  URL: https://acropaq.odoo.com/web#id=' + item.inv.id + '&model=account.move&view_type=form');
    }
  }

  if (pureWrongTaxInvoices.length > 0) {
    console.log('\n=== PURE WRONG-TAX INVOICES (can move to other journal) ===');
    for (const item of pureWrongTaxInvoices.slice(0, 10)) {
      console.log('\n' + item.inv.name + ' - EUR ' + item.inv.amount_total);
      console.log('  Partner: ' + (item.inv.partner_id ? item.inv.partner_id[1] : 'Unknown'));
      console.log('  Tax prefixes: ' + item.prefixes.join(', '));
      console.log('  URL: https://acropaq.odoo.com/web#id=' + item.inv.id + '&model=account.move&view_type=form');
    }
  }
}

main().catch(console.error);
