/**
 * Analyze Invoice Mismatches
 *
 * Categorizes all orders with negative qty_to_invoice by comparing:
 * - VCS data (from MongoDB)
 * - Odoo invoice data
 *
 * Output: Categorized list of all mismatches
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
  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // Categories
  const categories = {
    'A_INVOICE_HIGHER': [],      // Invoice total > VCS total (over-invoiced)
    'B_INVOICE_LOWER': [],       // Invoice total < VCS total (under-invoiced)
    'C_TOTALS_MATCH': [],        // Totals match but qty_invoiced is wrong
    'D_NO_VCS_DATA': [],         // No VCS data found for this order
    'E_MULTIPLE_INVOICES': [],   // Order has multiple invoices
    'F_NO_INVOICE': [],          // Order has no invoice (shouldn't happen)
    'G_OTHER': []                // Other issues
  };

  // Get ALL orders with negative qty_to_invoice lines
  console.log('Finding all order lines with negative qty_to_invoice...');

  const negativeLines = await execute('sale.order.line', 'search_read', [
    [['qty_to_invoice', '<', 0]]
  ], {
    fields: ['order_id', 'product_id', 'product_uom_qty', 'qty_invoiced', 'qty_to_invoice'],
    order: 'order_id'
  });

  console.log(`Found ${negativeLines.length} lines with negative qty_to_invoice\n`);

  // Group by order
  const orderIds = [...new Set(negativeLines.map(l => l.order_id[0]))];
  console.log(`Across ${orderIds.length} unique orders\n`);

  // Get order details
  const orders = await execute('sale.order', 'search_read', [
    [['id', 'in', orderIds]]
  ], {
    fields: ['id', 'name', 'invoice_ids', 'amz_order_reference', 'amount_untaxed']
  });

  const orderMap = {};
  for (const o of orders) {
    orderMap[o.id] = o;
  }

  console.log('Analyzing each order...\n');

  let processed = 0;
  for (const orderId of orderIds) {
    const order = orderMap[orderId];
    if (!order) continue;

    processed++;
    if (processed % 100 === 0) {
      console.log(`  Processed ${processed}/${orderIds.length}...`);
    }

    const amazonOrderId = order.name.replace(/^(FBA|FBM)/, '');

    // Get VCS data
    const vcsOrders = await db.collection('amazon_vcs_orders').find({
      orderId: { $regex: amazonOrderId }
    }).toArray();

    // Calculate VCS total
    let vcsTotal = 0;
    for (const vcs of vcsOrders) {
      if (vcs.items) {
        for (const item of vcs.items) {
          vcsTotal += item.priceExclusive || 0;
        }
      }
    }

    // Get invoice data
    let invoiceTotal = 0;
    let invoiceCount = order.invoice_ids ? order.invoice_ids.length : 0;

    if (invoiceCount > 0) {
      const invoices = await execute('account.move', 'search_read', [
        [['id', 'in', order.invoice_ids]]
      ], {
        fields: ['id', 'name', 'amount_untaxed', 'state']
      });

      for (const inv of invoices) {
        invoiceTotal += inv.amount_untaxed;
      }
    }

    // Categorize
    const record = {
      orderName: order.name,
      amazonOrderId: amazonOrderId,
      invoiceCount: invoiceCount,
      vcsRecords: vcsOrders.length,
      vcsTotal: vcsTotal.toFixed(2),
      invoiceTotal: invoiceTotal.toFixed(2),
      diff: (invoiceTotal - vcsTotal).toFixed(2),
      orderTotal: order.amount_untaxed ? order.amount_untaxed.toFixed(2) : 'N/A'
    };

    if (invoiceCount === 0) {
      categories['F_NO_INVOICE'].push(record);
    } else if (vcsOrders.length === 0) {
      categories['D_NO_VCS_DATA'].push(record);
    } else if (invoiceCount > 1) {
      categories['E_MULTIPLE_INVOICES'].push(record);
    } else {
      const diff = invoiceTotal - vcsTotal;
      if (Math.abs(diff) < 1) {
        categories['C_TOTALS_MATCH'].push(record);
      } else if (diff > 0) {
        categories['A_INVOICE_HIGHER'].push(record);
      } else {
        categories['B_INVOICE_LOWER'].push(record);
      }
    }
  }

  // Output results
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS COMPLETE');
  console.log('='.repeat(80));

  console.log('\n=== CATEGORY SUMMARY ===\n');

  const categoryNames = {
    'A_INVOICE_HIGHER': 'Invoice > VCS (Over-invoiced)',
    'B_INVOICE_LOWER': 'Invoice < VCS (Under-invoiced)',
    'C_TOTALS_MATCH': 'Totals Match (qty distribution issue)',
    'D_NO_VCS_DATA': 'No VCS Data Found',
    'E_MULTIPLE_INVOICES': 'Multiple Invoices',
    'F_NO_INVOICE': 'No Invoice Linked',
    'G_OTHER': 'Other Issues'
  };

  let totalRecords = 0;
  for (const [cat, records] of Object.entries(categories)) {
    console.log(`${categoryNames[cat]}: ${records.length}`);
    totalRecords += records.length;
  }
  console.log(`\nTOTAL: ${totalRecords} orders`);

  // Detailed output per category
  for (const [cat, records] of Object.entries(categories)) {
    if (records.length === 0) continue;

    console.log('\n' + '='.repeat(80));
    console.log(`CATEGORY: ${categoryNames[cat]} (${records.length} orders)`);
    console.log('='.repeat(80));

    // Show first 10 samples
    const samples = records.slice(0, 10);
    for (const r of samples) {
      console.log(`  ${r.orderName}: VCS=${r.vcsTotal}, Invoice=${r.invoiceTotal}, Diff=${r.diff}, Invoices=${r.invoiceCount}, VCS Records=${r.vcsRecords}`);
    }
    if (records.length > 10) {
      console.log(`  ... and ${records.length - 10} more`);
    }

    // For over-invoiced, show distribution of difference amounts
    if (cat === 'A_INVOICE_HIGHER' && records.length > 0) {
      const diffs = records.map(r => parseFloat(r.diff));
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const maxDiff = Math.max(...diffs);
      const minDiff = Math.min(...diffs);
      console.log(`\n  Difference stats: Min=${minDiff.toFixed(2)}, Max=${maxDiff.toFixed(2)}, Avg=${avgDiff.toFixed(2)}`);
    }
  }

  // Save full details to file
  const fs = require('fs');
  const outputPath = '/home/ubuntu/Agent5/backend/output/invoice-mismatch-analysis.json';

  // Ensure output directory exists
  const outputDir = '/home/ubuntu/Agent5/backend/output';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(categories, null, 2));
  console.log(`\nFull details saved to: ${outputPath}`);

  await mongoClient.close();
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
