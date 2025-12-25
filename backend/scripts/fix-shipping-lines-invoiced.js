/**
 * Fix Shipping Lines - Mark as Invoiced
 *
 * For orders that have invoice_ids but still show "to invoice",
 * mark the shipping/discount lines as fully invoiced by setting
 * qty_invoiced = product_uom_qty
 *
 * Usage:
 *   node scripts/fix-shipping-lines-invoiced.js --dry-run    # Preview only
 *   node scripts/fix-shipping-lines-invoiced.js --limit=100  # Process first 100
 *   node scripts/fix-shipping-lines-invoiced.js              # Process all
 */

const xmlrpc = require('xmlrpc');

// Odoo connection
const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

// Amazon EPT shipping product IDs
const SHIPPING_PRODUCT_IDS = [
  16401,  // SHIP AMAZON
  16405,  // Shipping Discount
];

const commonClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/common'
});
const objectClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/object'
});

let uid = null;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  console.log('='.repeat(60));
  console.log('Fix Shipping Lines - Mark as Invoiced');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Connect to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}\n`);

  // Get orders with "to invoice" status that HAVE invoice_ids
  console.log('Fetching orders with "to invoice" status and linked invoices...');

  // First, get "to invoice" orders
  const toInvoiceOrders = await execute('sale.order', 'search_read', [
    [['invoice_status', '=', 'to invoice']]
  ], {
    fields: ['id', 'name', 'invoice_ids', 'order_line'],
    limit: limit || 0,
    order: 'id desc'
  });

  console.log(`Found ${toInvoiceOrders.length} orders with "to invoice" status`);

  // Filter to only orders that have invoices linked
  const ordersWithInvoices = toInvoiceOrders.filter(o => o.invoice_ids && o.invoice_ids.length > 0);
  console.log(`Of these, ${ordersWithInvoices.length} have invoice_ids linked\n`);

  if (ordersWithInvoices.length === 0) {
    console.log('No orders to process.');
    return;
  }

  // Statistics
  const stats = {
    ordersProcessed: 0,
    linesFixed: 0,
    errors: 0
  };

  // Process each order
  for (let i = 0; i < ordersWithInvoices.length; i++) {
    const order = ordersWithInvoices[i];

    try {
      // Get order lines that are shipping/discount lines with qty_invoiced < product_uom_qty
      const shippingLines = await execute('sale.order.line', 'search_read', [
        [
          ['order_id', '=', order.id],
          ['product_id', 'in', SHIPPING_PRODUCT_IDS],
          ['qty_invoiced', '<', 1]  // Assuming qty is always 1 for shipping
        ]
      ], {
        fields: ['id', 'name', 'product_uom_qty', 'qty_invoiced', 'product_id']
      });

      if (shippingLines.length === 0) {
        // Check for shipping by name if product_id doesn't match
        const allLines = await execute('sale.order.line', 'search_read', [
          [['order_id', '=', order.id]]
        ], {
          fields: ['id', 'name', 'product_uom_qty', 'qty_invoiced', 'product_id']
        });

        for (const line of allLines) {
          const name = (line.name || '').toLowerCase();
          const isShipping = name.includes('shipping') || name.includes('discount');
          const needsUpdate = line.qty_invoiced < line.product_uom_qty;

          if (isShipping && needsUpdate) {
            shippingLines.push(line);
          }
        }
      }

      if (shippingLines.length > 0) {
        stats.ordersProcessed++;

        for (const line of shippingLines) {
          if (!dryRun) {
            // Set qty_invoiced = product_uom_qty
            await execute('sale.order.line', 'write', [
              [line.id],
              { qty_invoiced: line.product_uom_qty }
            ]);
          }

          stats.linesFixed++;

          if (stats.linesFixed <= 20 || stats.linesFixed % 500 === 0) {
            console.log(`  [${stats.linesFixed}] ${order.name}: ${dryRun ? 'Would fix' : 'Fixed'} "${line.name.substring(0, 40)}"`);
          }
        }

        // Rate limiting
        if (!dryRun && stats.ordersProcessed % 50 === 0) {
          await sleep(100);
        }
      }

    } catch (error) {
      stats.errors++;
      console.error(`  ERROR processing ${order.name}: ${error.message}`);
    }

    // Progress update
    if ((i + 1) % 2000 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${ordersWithInvoices.length} orders ---`);
      console.log(`    Lines fixed: ${stats.linesFixed}`);
      console.log('');
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Orders with invoices checked: ${ordersWithInvoices.length}`);
  console.log(`Orders with shipping lines fixed: ${stats.ordersProcessed}`);
  console.log(`Total shipping/discount lines fixed: ${stats.linesFixed}`);
  console.log(`Errors: ${stats.errors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
