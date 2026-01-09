require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function checkUnlinkedInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find all Amazon seller orders with invoice_status = "to invoice"
  console.log('Finding Amazon seller orders with invoice_status = "to invoice"...');

  const toInvoiceOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['team_id.name', 'ilike', 'Amazon']
    ],
    ['name', 'partner_id', 'amount_total', 'date_order', 'invoice_ids', 'team_id', 'client_order_ref']
  );

  console.log('Found ' + toInvoiceOrders.length + ' orders with "to invoice" status\n');

  if (toInvoiceOrders.length === 0) {
    console.log('No orders to check');
    return;
  }

  // Group by partner to reduce API calls
  const ordersByPartner = {};
  for (const order of toInvoiceOrders) {
    const partnerId = order.partner_id[0];
    if (!ordersByPartner[partnerId]) {
      ordersByPartner[partnerId] = [];
    }
    ordersByPartner[partnerId].push(order);
  }

  const partnerIds = Object.keys(ordersByPartner);
  console.log('Orders grouped under ' + partnerIds.length + ' unique partners\n');

  const potentialMatches = [];
  let checkedPartners = 0;

  for (const partnerId of partnerIds) {
    const orders = ordersByPartner[partnerId];
    checkedPartners++;
    if (checkedPartners % 20 === 0) {
      console.log('Checked ' + checkedPartners + '/' + partnerIds.length + ' partners...');
    }

    // Get ALL invoices for this partner (not cancelled)
    const allInvoices = await odoo.searchRead('account.move',
      [
        ['partner_id', '=', parseInt(partnerId)],
        ['move_type', '=', 'out_invoice'],
        ['state', '!=', 'cancel']
      ],
      ['name', 'invoice_origin', 'ref', 'amount_total', 'state', 'invoice_date']
    );

    if (allInvoices.length === 0) continue;

    // For each order, check if any invoice matches by amount (within 1 euro tolerance)
    for (const order of orders) {
      const linkedInvoiceIds = order.invoice_ids || [];
      const orderAmount = order.amount_total;

      // Find invoices that:
      // 1. Are NOT already linked to this order
      // 2. Have a similar amount (within 1 euro)
      // 3. Have an invoice_origin that contains this order name OR is empty/generic
      const matchingInvoices = allInvoices.filter(inv => {
        if (linkedInvoiceIds.includes(inv.id)) return false;

        const amountDiff = Math.abs(inv.amount_total - orderAmount);
        if (amountDiff > 1) return false;

        // Check if origin could match
        const origin = (inv.invoice_origin || '').toLowerCase();
        const orderName = order.name.toLowerCase();
        const orderRef = (order.client_order_ref || '').toLowerCase();

        // Match if:
        // - Origin contains order name
        // - Origin contains order ref (Amazon order ID)
        // - Origin is empty (could be manually created)
        if (origin.includes(orderName) ||
            (orderRef && origin.includes(orderRef)) ||
            !origin) {
          return true;
        }

        return false;
      });

      if (matchingInvoices.length > 0) {
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
          matchingInvoices: matchingInvoices.map(inv => ({
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

  console.log('\n=== RESULTS ===\n');
  console.log('Found ' + potentialMatches.length + ' orders with potential unlinked invoices:\n');

  for (const match of potentialMatches) {
    console.log('Order: ' + match.order.name + ' (ID: ' + match.order.id + ')');
    console.log('  Amazon Order ID: ' + match.order.ref);
    console.log('  Partner: ' + match.order.partner);
    console.log('  Order Amount: EUR ' + match.order.amount.toFixed(2));
    console.log('  Team: ' + match.order.team);
    console.log('  Currently linked invoices: ' + match.order.linkedInvoices);
    console.log('  Potential matching invoices:');
    for (const inv of match.matchingInvoices) {
      console.log('    - ' + inv.name + ' (ID: ' + inv.id + ')');
      console.log('      Origin: ' + (inv.origin || '(empty)'));
      console.log('      Invoice Amount: EUR ' + inv.amount.toFixed(2));
      console.log('      State: ' + inv.state);
      console.log('      Date: ' + inv.date);
    }
    console.log('');
  }

  console.log('\n=== SUMMARY ===');
  console.log('Total "to invoice" orders checked: ' + toInvoiceOrders.length);
  console.log('Orders with potential unlinked invoices: ' + potentialMatches.length);

  return potentialMatches;
}

checkUnlinkedInvoices()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
