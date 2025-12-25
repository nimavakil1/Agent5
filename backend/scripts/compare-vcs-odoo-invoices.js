/**
 * Compare VCS Data with Odoo Invoices
 *
 * For orders with negative qty_to_invoice, compare:
 * - VCS data (from MongoDB)
 * - Odoo order lines
 * - Odoo invoice lines
 *
 * To ensure invoices match 100% before fixing qty_invoiced
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

let uid;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

async function run() {
  const args = process.argv.slice(2);
  const orderArg = args.find(a => a.startsWith('--order='));
  const specificOrder = orderArg ? orderArg.split('=')[1] : null;

  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // If specific order provided, just compare that one
  if (specificOrder) {
    await compareOrder(db, specificOrder);
    await mongoClient.close();
    return;
  }

  // Otherwise, get sample of orders with negative qty_to_invoice
  console.log('Finding orders with negative qty_to_invoice...\n');

  const toInvoiceOrders = await execute('sale.order', 'search_read', [
    [['invoice_status', '=', 'to invoice'], ['invoice_ids', '!=', false]]
  ], {
    fields: ['id', 'name', 'invoice_ids', 'amz_order_reference'],
    limit: 50,
    order: 'id desc'
  });

  let compared = 0;
  let matches = 0;
  let mismatches = 0;

  for (const order of toInvoiceOrders) {
    // Check if has negative qty_to_invoice lines
    const negLines = await execute('sale.order.line', 'search_count', [
      [['order_id', '=', order.id], ['qty_to_invoice', '<', 0]]
    ]);

    if (negLines > 0) {
      const result = await compareOrder(db, order.name, false);
      compared++;
      if (result.match) matches++;
      else mismatches++;

      if (compared >= 10) break; // Compare first 10
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders compared: ' + compared);
  console.log('Matches: ' + matches);
  console.log('Mismatches: ' + mismatches);

  await mongoClient.close();
}

async function compareOrder(db, orderName, verbose = true) {
  const amazonOrderId = orderName.replace(/^(FBA|FBM)/, '');

  if (verbose) {
    console.log('='.repeat(70));
    console.log('COMPARING: ' + orderName + ' (Amazon: ' + amazonOrderId + ')');
    console.log('='.repeat(70));
  }

  // 1. Get VCS data
  const vcsOrders = await db.collection('amazon_vcs_orders').find({
    orderId: { $regex: amazonOrderId }
  }).toArray();

  // Aggregate VCS items by SKU
  const vcsBySku = {};
  let vcsTotal = 0;

  for (const vcs of vcsOrders) {
    if (vcs.items) {
      for (const item of vcs.items) {
        if (!vcsBySku[item.sku]) {
          vcsBySku[item.sku] = { qty: 0, price: 0 };
        }
        vcsBySku[item.sku].qty += item.quantity || 0;
        vcsBySku[item.sku].price += item.priceExclusive || 0;
        vcsTotal += item.priceExclusive || 0;
      }
    }
  }

  if (verbose) {
    console.log('\n--- VCS DATA ---');
    console.log('VCS records: ' + vcsOrders.length);
    for (const [sku, data] of Object.entries(vcsBySku)) {
      console.log('  ' + sku + ': qty=' + data.qty + ', price=' + data.price.toFixed(2));
    }
    console.log('  VCS Total: ' + vcsTotal.toFixed(2));
  }

  // 2. Get Odoo order
  const orders = await execute('sale.order', 'search_read', [
    [['name', '=', orderName]]
  ], {
    fields: ['id', 'name', 'invoice_ids']
  });

  if (orders.length === 0) {
    console.log('Order not found in Odoo!');
    return { match: false, reason: 'Order not found' };
  }

  const order = orders[0];

  // Get order lines
  const orderLines = await execute('sale.order.line', 'search_read', [
    [['order_id', '=', order.id], ['product_id', '!=', false]]
  ], {
    fields: ['id', 'product_id', 'product_uom_qty', 'qty_invoiced', 'qty_to_invoice']
  });

  // Group by product
  const orderByProduct = {};
  for (const line of orderLines) {
    const productId = line.product_id[0];
    if (!orderByProduct[productId]) {
      orderByProduct[productId] = { name: line.product_id[1], totalQty: 0, totalInvoiced: 0, lines: [] };
    }
    orderByProduct[productId].totalQty += line.product_uom_qty;
    orderByProduct[productId].totalInvoiced += line.qty_invoiced;
    orderByProduct[productId].lines.push(line);
  }

  if (verbose) {
    console.log('\n--- ODOO ORDER LINES ---');
    for (const [prodId, data] of Object.entries(orderByProduct)) {
      console.log('  ' + data.name.substring(0, 40));
      console.log('    Order qty: ' + data.totalQty + ', Invoiced: ' + data.totalInvoiced + ' (lines: ' + data.lines.length + ')');
    }
  }

  // 3. Get Invoice data
  let invoiceTotal = 0;
  const invoiceBySku = {};

  if (order.invoice_ids.length > 0) {
    const invoices = await execute('account.move', 'search_read', [
      [['id', 'in', order.invoice_ids]]
    ], {
      fields: ['id', 'name', 'amount_untaxed']
    });

    for (const inv of invoices) {
      invoiceTotal += inv.amount_untaxed;

      const invLines = await execute('account.move.line', 'search_read', [
        [['move_id', '=', inv.id], ['display_type', '=', false], ['product_id', '!=', false]]
      ], {
        fields: ['product_id', 'quantity', 'price_subtotal']
      });

      for (const il of invLines) {
        const prodName = il.product_id[1];
        if (!invoiceBySku[prodName]) {
          invoiceBySku[prodName] = { qty: 0, price: 0 };
        }
        invoiceBySku[prodName].qty += il.quantity;
        invoiceBySku[prodName].price += il.price_subtotal;
      }
    }
  }

  if (verbose) {
    console.log('\n--- ODOO INVOICE ---');
    console.log('Invoices: ' + order.invoice_ids.length);
    for (const [name, data] of Object.entries(invoiceBySku)) {
      const unitPrice = data.qty > 0 ? (data.price / data.qty).toFixed(2) : 'N/A';
      console.log('  ' + name.substring(0, 40));
      console.log('    qty=' + data.qty + ', total=' + data.price.toFixed(2) + ' (unit=' + unitPrice + ')');
    }
    console.log('  Invoice Total: ' + invoiceTotal.toFixed(2));
  }

  // 4. Compare
  const priceDiff = Math.abs(vcsTotal - invoiceTotal);
  const match = priceDiff < 1; // Allow 1 EUR difference for rounding

  if (verbose) {
    console.log('\n--- COMPARISON ---');
    console.log('VCS Total: ' + vcsTotal.toFixed(2) + ' EUR');
    console.log('Invoice Total: ' + invoiceTotal.toFixed(2) + ' EUR');
    console.log('Difference: ' + priceDiff.toFixed(2) + ' EUR');
    console.log('MATCH: ' + (match ? 'YES' : 'NO'));
  } else {
    console.log(orderName + ': VCS=' + vcsTotal.toFixed(2) + ', Invoice=' + invoiceTotal.toFixed(2) + ', Diff=' + priceDiff.toFixed(2) + ' -> ' + (match ? 'MATCH' : 'MISMATCH'));
  }

  return { match, vcsTotal, invoiceTotal, diff: priceDiff };
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
