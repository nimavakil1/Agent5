require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VBE invoices with Amazon-related fields
  const invoices = await odoo.searchRead('account.move',
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['name', 'like', 'VBE%']],
    ['name', 'partner_id', 'amount_total', 'invoice_date', 'amazon_instance_id', 'edi_state', 'edi_error_message', 'invoice_origin', 'ref'],
    {limit: 50, order: 'invoice_date desc'}
  );

  console.log('=== VBE Invoice Amazon Status ===\n');

  // Group by edi_state
  const byState = {};
  invoices.forEach(inv => {
    const state = inv.edi_state || 'no_edi';
    if (!byState[state]) byState[state] = [];
    byState[state].push(inv);
  });

  console.log('EDI State Summary:');
  Object.keys(byState).forEach(state => {
    console.log('  ' + state + ': ' + byState[state].length + ' invoices');
  });

  console.log('\n=== Sample Invoices ===');
  invoices.slice(0, 15).forEach((inv, i) => {
    const partner = inv.partner_id ? inv.partner_id[1].substring(0, 25) : '-';
    const marketplace = inv.amazon_instance_id ? inv.amazon_instance_id[1] : '-';
    console.log((i+1) + '. ' + inv.name + ' | ' + partner.padEnd(25) + ' | EDI: ' + (inv.edi_state || 'none').padEnd(10) + ' | Marketplace: ' + marketplace);
    if (inv.edi_error_message) console.log('   Error: ' + inv.edi_error_message.replace(/<[^>]*>/g, '').substring(0, 80));
  });

  // Check amazon_instance_id values
  console.log('\n=== Amazon Instance IDs ===');
  const byInstance = {};
  invoices.forEach(inv => {
    const instance = inv.amazon_instance_id ? inv.amazon_instance_id[1] : 'No Instance';
    if (!byInstance[instance]) byInstance[instance] = 0;
    byInstance[instance]++;
  });
  Object.entries(byInstance).sort((a,b) => b[1] - a[1]).forEach(([instance, count]) => {
    console.log('  ' + instance + ': ' + count);
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
