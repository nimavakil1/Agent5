require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function findDuplicateOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Finding all Amazon Marketplace orders (paginated)...\n');

  // Paginate through all orders
  const allOrders = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    console.log('Fetching orders ' + offset + ' to ' + (offset + pageSize) + '...');

    const orders = await odoo.searchRead('sale.order',
      [
        ['team_id.name', 'ilike', 'Marketplace'],
        ['client_order_ref', '!=', false]
      ],
      ['name', 'client_order_ref', 'partner_id', 'amount_total', 'date_order', 'invoice_ids', 'invoice_status', 'state', 'team_id', 'create_date'],
      { limit: pageSize, offset: offset }
    );

    if (orders.length === 0) break;

    allOrders.push(...orders);
    offset += pageSize;

    if (orders.length < pageSize) break;
  }

  console.log('\nFound ' + allOrders.length + ' Amazon Marketplace orders\n');

  // Group by client_order_ref (Amazon Order ID)
  const ordersByRef = {};
  for (const order of allOrders) {
    const ref = order.client_order_ref;
    if (!ref) continue;

    if (!ordersByRef[ref]) {
      ordersByRef[ref] = [];
    }
    ordersByRef[ref].push(order);
  }

  // Find duplicates (more than 1 order per ref)
  const duplicates = [];
  for (const [ref, orders] of Object.entries(ordersByRef)) {
    if (orders.length > 1) {
      duplicates.push({
        amazonOrderId: ref,
        count: orders.length,
        orders: orders.map(o => ({
          id: o.id,
          name: o.name,
          amount: o.amount_total,
          state: o.state,
          invoiceStatus: o.invoice_status,
          invoiceIds: o.invoice_ids,
          team: o.team_id ? o.team_id[1] : 'N/A',
          partner: o.partner_id ? o.partner_id[1] : 'N/A',
          orderDate: o.date_order,
          createdAt: o.create_date
        }))
      });
    }
  }

  console.log('=== DUPLICATE ORDERS FOUND: ' + duplicates.length + ' ===\n');

  // Sort by creation date of first duplicate
  duplicates.sort((a, b) => {
    const dateA = a.orders[0].createdAt || '';
    const dateB = b.orders[0].createdAt || '';
    return dateA.localeCompare(dateB);
  });

  // Categorize duplicates
  const sameAmount = [];
  const differentAmount = [];

  for (const dup of duplicates) {
    const amounts = dup.orders.map(o => o.amount);
    const uniqueAmounts = [...new Set(amounts.map(a => a.toFixed(2)))];

    if (uniqueAmounts.length === 1) {
      sameAmount.push(dup);
    } else {
      differentAmount.push(dup);
    }
  }

  console.log('Duplicates with SAME amount: ' + sameAmount.length);
  console.log('Duplicates with DIFFERENT amounts: ' + differentAmount.length);
  console.log('');

  // Show duplicates with different amounts (most problematic)
  console.log('=== DUPLICATES WITH DIFFERENT AMOUNTS (most problematic) ===\n');
  for (const dup of differentAmount) {
    console.log('Amazon Order ID: ' + dup.amazonOrderId);
    console.log('  Duplicate count: ' + dup.count);
    for (const o of dup.orders) {
      const hasInvoice = o.invoiceIds && o.invoiceIds.length > 0;
      console.log('  - Odoo ID: ' + o.id + ' | Name: ' + o.name + ' | Amount: EUR ' + o.amount.toFixed(2) + ' | Status: ' + o.invoiceStatus + ' | Invoice: ' + (hasInvoice ? 'YES (' + o.invoiceIds.join(',') + ')' : 'NO') + ' | Created: ' + o.createdAt);
    }
    console.log('');
  }

  // Show duplicates with same amount
  console.log('=== DUPLICATES WITH SAME AMOUNT ===\n');
  for (const dup of sameAmount) {
    console.log('Amazon Order ID: ' + dup.amazonOrderId);
    console.log('  Duplicate count: ' + dup.count);
    for (const o of dup.orders) {
      const hasInvoice = o.invoiceIds && o.invoiceIds.length > 0;
      console.log('  - Odoo ID: ' + o.id + ' | Name: ' + o.name + ' | Amount: EUR ' + o.amount.toFixed(2) + ' | Status: ' + o.invoiceStatus + ' | Invoice: ' + (hasInvoice ? 'YES (' + o.invoiceIds.join(',') + ')' : 'NO') + ' | Created: ' + o.createdAt);
    }
    console.log('');
  }

  // Summary stats
  console.log('=== SUMMARY ===');
  console.log('Total Amazon Marketplace orders: ' + allOrders.length);
  console.log('Unique Amazon Order IDs: ' + Object.keys(ordersByRef).length);
  console.log('Amazon Order IDs with duplicates: ' + duplicates.length);
  console.log('  - Same amount: ' + sameAmount.length);
  console.log('  - Different amounts: ' + differentAmount.length);

  // Count extra orders
  let extraOrders = 0;
  for (const dup of duplicates) {
    extraOrders += dup.count - 1;
  }
  console.log('Total extra (duplicate) orders: ' + extraOrders);

  // Analyze creation date patterns
  console.log('\n=== CREATION DATE ANALYSIS ===');
  const creationDates = {};
  for (const dup of duplicates) {
    for (const o of dup.orders) {
      const date = o.createdAt ? o.createdAt.substring(0, 10) : 'Unknown';
      creationDates[date] = (creationDates[date] || 0) + 1;
    }
  }

  const sortedDates = Object.entries(creationDates).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [date, count] of sortedDates) {
    console.log('  ' + date + ': ' + count + ' duplicate entries');
  }
}

findDuplicateOrders()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
