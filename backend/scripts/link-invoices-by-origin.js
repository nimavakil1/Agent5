/**
 * Link Invoices to Orders by invoice_origin
 *
 * Finds invoices where invoice_origin matches an Amazon order ID
 * and links them to the corresponding sale.order
 *
 * Usage:
 *   node scripts/link-invoices-by-origin.js --dry-run    # Preview only
 *   node scripts/link-invoices-by-origin.js --limit=100  # Process first 100
 *   node scripts/link-invoices-by-origin.js              # Process all
 */

const xmlrpc = require('xmlrpc');

// Odoo connection
const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

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
  console.log('Link Invoices to Orders by invoice_origin');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Connect to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}\n`);

  // Get orders with "to invoice" status
  console.log('Fetching orders with "to invoice" status...');
  const toInvoiceOrders = await execute('sale.order', 'search_read', [
    [['invoice_status', '=', 'to invoice']]
  ], {
    fields: ['id', 'name', 'amz_order_reference', 'client_order_ref', 'invoice_ids'],
    limit: limit || 0,
    order: 'id desc'
  });

  console.log(`Found ${toInvoiceOrders.length} orders with "to invoice" status\n`);

  // Build a map of Amazon order IDs to Odoo orders
  const amazonToOrder = new Map();
  for (const order of toInvoiceOrders) {
    // Try amz_order_reference first, then client_order_ref (stripped of FBA/FBM prefix)
    let amazonId = order.amz_order_reference;
    if (!amazonId && order.client_order_ref) {
      amazonId = order.client_order_ref.replace(/^(FBA|FBM)/, '');
    }
    if (amazonId) {
      amazonToOrder.set(amazonId, order);
    }
  }

  console.log(`Built map of ${amazonToOrder.size} Amazon order IDs\n`);

  // Get all customer invoices that have invoice_origin set
  console.log('Fetching customer invoices with invoice_origin...');
  const invoices = await execute('account.move', 'search_read', [
    [
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'state'],
    order: 'id desc'
  });

  console.log(`Found ${invoices.length} invoices with invoice_origin\n`);

  // Statistics
  const stats = {
    processed: 0,
    linked: 0,
    alreadyLinked: 0,
    noMatchingOrder: 0,
    errors: 0
  };

  const linkedSamples = [];

  // Process each invoice
  for (let i = 0; i < invoices.length; i++) {
    const invoice = invoices[i];
    const origin = invoice.invoice_origin;

    // Check if origin matches any Amazon order ID in our map
    // The origin might be the full order name (FBA171-xxx) or just the Amazon ID (171-xxx)
    let matchingOrder = null;

    // Try exact match first
    if (amazonToOrder.has(origin)) {
      matchingOrder = amazonToOrder.get(origin);
    } else {
      // Try stripping FBA/FBM prefix
      const strippedOrigin = origin.replace(/^(FBA|FBM)/, '');
      if (amazonToOrder.has(strippedOrigin)) {
        matchingOrder = amazonToOrder.get(strippedOrigin);
      }
    }

    if (!matchingOrder) {
      stats.noMatchingOrder++;
      continue;
    }

    stats.processed++;

    // Check if already linked
    if (matchingOrder.invoice_ids && matchingOrder.invoice_ids.includes(invoice.id)) {
      stats.alreadyLinked++;
      continue;
    }

    try {
      if (!dryRun) {
        // Link the invoice to the order using Many2many write command
        // Command (4, id, 0) adds an existing record to the relation
        await execute('sale.order', 'write', [
          [matchingOrder.id],
          { invoice_ids: [[4, invoice.id, 0]] }
        ]);
      }

      stats.linked++;

      if (linkedSamples.length < 20) {
        linkedSamples.push({
          order: matchingOrder.name,
          invoice: invoice.name,
          amazonId: origin
        });
      }

      if (stats.linked <= 10 || stats.linked % 500 === 0) {
        console.log(`  [${stats.linked}] ${dryRun ? 'Would link' : 'Linked'} ${invoice.name} -> ${matchingOrder.name}`);
      }

      // Rate limiting
      if (!dryRun && stats.linked % 50 === 0) {
        await sleep(100);
      }

    } catch (error) {
      stats.errors++;
      console.error(`  ERROR linking ${invoice.name}: ${error.message}`);
    }

    // Progress update
    if ((i + 1) % 5000 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${invoices.length} invoices checked ---`);
      console.log(`    Linked: ${stats.linked}, No matching order: ${stats.noMatchingOrder}`);
      console.log('');
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total invoices checked: ${invoices.length}`);
  console.log(`Invoices matching "to invoice" orders: ${stats.processed}`);
  console.log(`Successfully linked: ${stats.linked}`);
  console.log(`Already linked: ${stats.alreadyLinked}`);
  console.log(`No matching order found: ${stats.noMatchingOrder}`);
  console.log(`Errors: ${stats.errors}`);

  if (linkedSamples.length > 0) {
    console.log('\nSample links:');
    for (const sample of linkedSamples.slice(0, 10)) {
      console.log(`  ${sample.invoice} -> ${sample.order} (${sample.amazonId})`);
    }
  }

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
