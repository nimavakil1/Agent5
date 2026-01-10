require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find draft invoices linked to sale orders
  console.log('=== DRAFT INVOICES LINKED TO ORDERS ===\n');

  const draftInvoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'draft'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'state', 'invoice_origin', 'amount_total', 'create_date', 'invoice_date'],
    { limit: 500, order: 'create_date desc' }
  );

  console.log('Total draft invoices with origin: ' + draftInvoices.length);

  // Analyze by origin pattern
  const byPattern = {};
  for (const inv of draftInvoices) {
    let pattern = 'OTHER';
    if (/^FBA/.test(inv.invoice_origin)) pattern = 'FBA';
    else if (/^FBM/.test(inv.invoice_origin)) pattern = 'FBM';
    else if (/^FBB/.test(inv.invoice_origin)) pattern = 'BOL.COM';
    else if (/^\d{3}-\d{7}-\d{7}/.test(inv.invoice_origin)) pattern = 'AMAZON_ID';
    else if (/^S\d+/.test(inv.invoice_origin)) pattern = 'MANUAL';
    
    byPattern[pattern] = (byPattern[pattern] || 0) + 1;
  }

  console.log('\nBy origin pattern:');
  Object.entries(byPattern).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => console.log('  ' + k + ': ' + v));

  // Check how many have name="/"
  const unnamed = draftInvoices.filter(inv => inv.name === '/' || inv.name === false);
  console.log('\nWith name="/" (unnamed): ' + unnamed.length);

  // Show samples
  console.log('\n=== SAMPLE DRAFT INVOICES ===\n');
  for (const inv of draftInvoices.slice(0, 10)) {
    console.log(inv.name + ' | ' + inv.invoice_origin + ' | EUR ' + (inv.amount_total || 0).toFixed(2) + ' | created: ' + (inv.create_date || '').substring(0, 10));
  }

  // Check the oldest draft invoices
  console.log('\n=== OLDEST DRAFT INVOICES ===\n');
  const oldestDrafts = await odoo.searchRead('account.move',
    [
      ['state', '=', 'draft'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'state', 'invoice_origin', 'amount_total', 'create_date'],
    { limit: 10, order: 'create_date asc' }
  );

  for (const inv of oldestDrafts) {
    console.log(inv.name + ' | ' + inv.invoice_origin + ' | EUR ' + (inv.amount_total || 0).toFixed(2) + ' | created: ' + (inv.create_date || '').substring(0, 10));
  }

  // Check total value of draft invoices
  let totalDraftValue = 0;
  for (const inv of draftInvoices) {
    totalDraftValue += inv.amount_total || 0;
  }
  console.log('\nTotal value of draft invoices (sample): EUR ' + totalDraftValue.toFixed(2));
}

main().catch(e => console.error(e));
