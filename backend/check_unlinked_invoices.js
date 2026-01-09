require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function checkUnlinkedInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  
  // Step 1: Find all Amazon seller orders with invoice_status = "to invoice"
  console.log('Finding Amazon seller orders with invoice_status = "to invoice"...');
  
  const toInvoiceOrders = await odoo.searchRead('sale.order', 
    [
      ['invoice_status', '=', 'to invoice'],
      ['team_id.name', 'ilike', 'Amazon']
    ],
    ['name', 'partner_id', 'amount_total', 'date_order', 'invoice_ids', 'team_id', 'client_order_ref']
  );
  
  console.log(`Found ${toInvoiceOrders.length} orders with "to invoice" status`);
  
  if (toInvoiceOrders.length === 0) {
    console.log('No orders to check');
    return;
  }
  
  // Step 2: For each order, check if there's an invoice with matching reference that isn't linked
  const potentialMatches = [];
  let checked = 0;
  
  for (const order of toInvoiceOrders) {
    checked++;
    if (checked % 50 === 0) {
      console.log(`Checked ${checked}/${toInvoiceOrders.length} orders...`);
    }
    
    const partnerId = order.partner_id[0];
    const orderRef = order.client_order_ref || order.name;
    
    // Search for invoices for this partner that might match this order
    // Check by: partner_id, invoice_origin or ref containing order reference
    const invoices = await odoo.searchRead('account.move',
      [
        ['partner_id', '=', partnerId],
        ['move_type', '=', 'out_invoice'],
        ['state', '!=', 'cancel'],
        '|',
        ['invoice_origin', 'ilike', order.name],
        ['ref', 'ilike', orderRef]
      ],
      ['name', 'invoice_origin', 'ref', 'amount_total', 'state', 'invoice_date']
    );
    
    if (invoices.length > 0) {
      // Check if any of these invoices are NOT already linked to this order
      const linkedInvoiceIds = order.invoice_ids || [];
      const unlinkedInvoices = invoices.filter(inv => !linkedInvoiceIds.includes(inv.id));
      
      if (unlinkedInvoices.length > 0) {
        potentialMatches.push({
          order: {
            id: order.id,
            name: order.name,
            ref: order.client_order_ref,
            partner: order.partner_id[1],
            amount: order.amount_total,
            team: order.team_id ? order.team_id[1] : 'N/A',
            linkedInvoices: linkedInvoiceIds.length
          },
          unlinkedInvoices: unlinkedInvoices.map(inv => ({
            id: inv.id,
            name: inv.name,
            origin: inv.invoice_origin,
            ref: inv.ref,
            amount: inv.amount_total,
            state: inv.state,
            date: inv.invoice_date
          }))
        });
      }
    }
  }
  
  console.log(`\nFound ${potentialMatches.length} orders with potential unlinked invoices:\n`);
  
  for (const match of potentialMatches) {
    console.log(`Order: ${match.order.name} (ID: ${match.order.id})`);
    console.log(`  Ref: ${match.order.ref}`);
    console.log(`  Partner: ${match.order.partner}`);
    console.log(`  Amount: €${match.order.amount}`);
    console.log(`  Team: ${match.order.team}`);
    console.log(`  Currently linked invoices: ${match.order.linkedInvoices}`);
    console.log(`  Potential unlinked invoices:`);
    for (const inv of match.unlinkedInvoices) {
      console.log(`    - ${inv.name} (ID: ${inv.id})`);
      console.log(`      Origin: ${inv.origin}`);
      console.log(`      Ref: ${inv.ref}`);
      console.log(`      Amount: €${inv.amount}`);
      console.log(`      State: ${inv.state}`);
      console.log(`      Date: ${inv.date}`);
    }
    console.log('');
  }
  
  console.log('\n=== SUMMARY ===');
  console.log(`Total "to invoice" orders checked: ${toInvoiceOrders.length}`);
  console.log(`Orders with potential unlinked invoices: ${potentialMatches.length}`);
  
  return potentialMatches;
}

checkUnlinkedInvoices()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
