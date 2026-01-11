require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const SERVICE_PRODUCT_IDS = [16401, 16402, 16403, 16404];

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Analyzing duplicate orders for invoice-only fix...\n');

  // Get all FBA/FBM orders
  const orders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'state', 'invoice_ids', 'partner_id'],
    { limit: 50000, order: 'name asc' }
  );

  // Group by order name
  const ordersByName = {};
  for (const order of orders) {
    if (!ordersByName[order.name]) {
      ordersByName[order.name] = [];
    }
    ordersByName[order.name].push(order);
  }

  // Find duplicates with "to invoice" status
  const toFix = [];
  for (const [name, orderList] of Object.entries(ordersByName)) {
    if (orderList.length <= 1) continue;

    const hasToInvoice = orderList.some(o => o.invoice_status === 'to invoice');
    if (!hasToInvoice) continue;

    toFix.push({ name, orders: orderList });
  }

  console.log('Duplicate order groups with "to invoice": ' + toFix.length + '\n');

  // Analyze each case
  const cases = {
    missingInvoice: [],      // Order has no invoice at all
    overInvoiced: [],        // Net invoiced > order total
    underInvoiced: [],       // Net invoiced < order total
    amountsMatch: [],        // Amounts match, just need to mark as invoiced
    complex: []              // Other cases
  };

  let processed = 0;
  for (const group of toFix) {
    processed++;
    if (processed % 30 === 0) console.log('Processing ' + processed + '/' + toFix.length);

    // Get all invoices for this group
    const allInvoiceIds = [];
    for (const o of group.orders) {
      allInvoiceIds.push(...o.invoice_ids);
    }
    const uniqueInvoiceIds = [...new Set(allInvoiceIds)];

    // Calculate order totals
    const totalOrderAmount = group.orders.reduce((sum, o) => sum + o.amount_total, 0);

    // Get invoices
    let totalInvoiced = 0;
    let totalCredited = 0;
    if (uniqueInvoiceIds.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', uniqueInvoiceIds]],
        ['id', 'move_type', 'state', 'amount_total']
      );
      for (const inv of invoices) {
        if (inv.state === 'posted' || inv.state === 'draft') {
          if (inv.move_type === 'out_invoice') {
            totalInvoiced += inv.amount_total;
          } else if (inv.move_type === 'out_refund') {
            totalCredited += inv.amount_total;
          }
        }
      }
    }

    const netInvoiced = totalInvoiced - totalCredited;
    const diff = netInvoiced - totalOrderAmount;

    // Find orders without invoices
    const ordersWithoutInvoice = group.orders.filter(o => o.invoice_ids.length === 0);
    const ordersToInvoice = group.orders.filter(o => o.invoice_status === 'to invoice');

    // Categorize
    const caseData = {
      name: group.name,
      orderCount: group.orders.length,
      orderIds: group.orders.map(o => o.id),
      totalOrderAmount,
      netInvoiced,
      diff: diff.toFixed(2),
      ordersWithoutInvoice: ordersWithoutInvoice.length,
      ordersToInvoice: ordersToInvoice.length
    };

    if (uniqueInvoiceIds.length === 0) {
      cases.missingInvoice.push(caseData);
    } else if (Math.abs(diff) < 0.10) {
      cases.amountsMatch.push(caseData);
    } else if (diff > 0.10) {
      cases.overInvoiced.push(caseData);
    } else if (diff < -0.10) {
      cases.underInvoiced.push(caseData);
    } else {
      cases.complex.push(caseData);
    }
  }

  // Summary
  console.log('\n=== ANALYSIS SUMMARY ===\n');

  console.log('1. AMOUNTS MATCH (just mark as invoiced): ' + cases.amountsMatch.length);
  if (cases.amountsMatch.length > 0) {
    console.log('   Examples:');
    for (const c of cases.amountsMatch.slice(0, 3)) {
      console.log('   - ' + c.name + ': ' + c.orderCount + ' orders, EUR ' + c.totalOrderAmount.toFixed(2) + ' = EUR ' + c.netInvoiced.toFixed(2));
    }
  }

  console.log('\n2. MISSING INVOICE (no invoices at all): ' + cases.missingInvoice.length);
  if (cases.missingInvoice.length > 0) {
    console.log('   Examples:');
    for (const c of cases.missingInvoice.slice(0, 3)) {
      console.log('   - ' + c.name + ': ' + c.orderCount + ' orders, EUR ' + c.totalOrderAmount.toFixed(2));
    }
  }

  console.log('\n3. UNDER-INVOICED (need more invoices): ' + cases.underInvoiced.length);
  if (cases.underInvoiced.length > 0) {
    const totalUnder = cases.underInvoiced.reduce((sum, c) => sum + Math.abs(parseFloat(c.diff)), 0);
    console.log('   Total under-invoiced: EUR ' + totalUnder.toFixed(2));
    console.log('   Examples:');
    for (const c of cases.underInvoiced.slice(0, 5)) {
      console.log('   - ' + c.name + ': Order EUR ' + c.totalOrderAmount.toFixed(2) + ', Invoiced EUR ' + c.netInvoiced.toFixed(2) + ' (diff: ' + c.diff + ')');
    }
  }

  console.log('\n4. OVER-INVOICED (need credit notes): ' + cases.overInvoiced.length);
  if (cases.overInvoiced.length > 0) {
    const totalOver = cases.overInvoiced.reduce((sum, c) => sum + parseFloat(c.diff), 0);
    console.log('   Total over-invoiced: EUR ' + totalOver.toFixed(2));
    console.log('   Examples:');
    for (const c of cases.overInvoiced.slice(0, 5)) {
      console.log('   - ' + c.name + ': Order EUR ' + c.totalOrderAmount.toFixed(2) + ', Invoiced EUR ' + c.netInvoiced.toFixed(2) + ' (diff: +' + c.diff + ')');
    }
  }

  console.log('\n5. COMPLEX (other): ' + cases.complex.length);

  // Total
  const total = cases.amountsMatch.length + cases.missingInvoice.length +
                cases.underInvoiced.length + cases.overInvoiced.length + cases.complex.length;
  console.log('\n=== TOTAL: ' + total + ' duplicate order groups need attention ===');

  // Recommended fix order
  console.log('\n=== RECOMMENDED FIX ORDER ===');
  console.log('1. Fix ' + cases.amountsMatch.length + ' "amounts match" cases (just mark as invoiced)');
  console.log('2. Fix ' + cases.overInvoiced.length + ' over-invoiced cases (create credit notes)');
  console.log('3. Fix ' + cases.underInvoiced.length + ' under-invoiced cases (create invoices for missing orders)');
  console.log('4. Handle ' + cases.missingInvoice.length + ' missing invoice cases (create all invoices)');
}

main().catch(e => console.error(e));
