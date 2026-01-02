const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkRecentVcsInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get the most recent 60 invoices
  const invoices = await odoo.searchRead('account.move',
    [['move_type', '=', 'out_invoice']],
    ['id', 'name', 'partner_id', 'invoice_date', 'amount_total', 'state', 'ref', 'invoice_origin'],
    60, 0, 'id desc'
  );

  console.log('=== Most Recent 60 Invoices ===\n');

  // Group by partner to see the issue
  const byPartner = {};
  for (const inv of invoices) {
    const partnerName = inv.partner_id ? inv.partner_id[1] : 'NO PARTNER';
    if (!byPartner[partnerName]) byPartner[partnerName] = [];
    byPartner[partnerName].push(inv.name);
  }

  console.log('Invoices grouped by partner:');
  for (const [partner, invNames] of Object.entries(byPartner)) {
    console.log('');
    console.log('Partner:', partner);
    console.log('Count:', invNames.length);
    console.log('Invoices:', invNames.slice(0, 5).join(', '), invNames.length > 5 ? '...' : '');
  }

  console.log('');
  console.log('=== Sample Invoice Details ===');
  for (const inv of invoices.slice(0, 20)) {
    console.log(inv.name, '| Partner:', inv.partner_id ? inv.partner_id[1] : 'NONE', '| Ref:', inv.ref || 'N/A', '| Amount:', inv.amount_total);
  }
}

checkRecentVcsInvoices().catch(console.error);
