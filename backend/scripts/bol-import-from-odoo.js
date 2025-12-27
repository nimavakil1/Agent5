/**
 * Import BOL order IDs from Odoo and fetch full details from Bol.com API
 *
 * This script:
 * 1. Extracts all BOL order IDs from Odoo (client_order_ref)
 * 2. Checks which ones are missing in MongoDB
 * 3. Fetches full details from Bol.com API with rate limiting
 *
 * Usage:
 *   node scripts/bol-import-from-odoo.js                    # Show stats only
 *   node scripts/bol-import-from-odoo.js --fetch            # Fetch missing orders
 *   node scripts/bol-import-from-odoo.js --fetch --limit=100 # Fetch max 100 orders
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const BolOrder = require('../src/models/BolOrder');

// Rate limiting: 2 seconds between requests to avoid hitting limits
const REQUEST_DELAY_MS = 2000;
const BATCH_SIZE = 100; // Fetch from Odoo in batches

let accessToken = null;
let tokenExpiry = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
    return accessToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://login.bol.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error(`Token error: ${await response.text()}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return accessToken;
}

async function fetchOrderDetails(orderId, retries = 3) {
  const token = await getAccessToken();

  const response = await fetch(`https://api.bol.com/retailer/orders/${orderId}`, {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
    console.log(`  Rate limited, waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return fetchOrderDetails(orderId, retries - 1);
  }

  if (response.status === 404) {
    return null; // Order not found
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

async function storeOrder(orderData) {
  const items = (orderData.orderItems || []).map(item => ({
    orderItemId: item.orderItemId,
    ean: item.product?.ean || item.ean || '',
    sku: item.offer?.reference || item.offerReference || '',
    title: item.product?.title || '',
    quantity: item.quantity || 1,
    quantityShipped: item.quantityShipped || 0,
    quantityCancelled: item.quantityCancelled || 0,
    unitPrice: typeof item.unitPrice === 'object' ? parseFloat(item.unitPrice?.amount || 0) : parseFloat(item.unitPrice || 0),
    totalPrice: typeof item.totalPrice === 'object' ? parseFloat(item.totalPrice?.amount || 0) : parseFloat(item.totalPrice || 0),
    commission: item.commission,
    fulfilmentMethod: item.fulfilment?.method || item.fulfilmentMethod,
    fulfilmentStatus: item.fulfilmentStatus || 'SHIPPED',
    latestDeliveryDate: item.fulfilment?.latestDeliveryDate || item.latestDeliveryDate,
    cancellationRequest: item.cancellationRequest || false
  }));

  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  const shippedQty = items.reduce((sum, i) => sum + i.quantityShipped, 0);
  const cancelledQty = items.reduce((sum, i) => sum + i.quantityCancelled, 0);

  let status = 'OPEN';
  if (shippedQty >= totalQty) status = 'SHIPPED';
  else if (shippedQty > 0) status = 'PARTIAL';
  else if (cancelledQty >= totalQty) status = 'CANCELLED';

  const totalAmount = items.reduce((sum, i) => sum + (i.totalPrice || i.unitPrice * i.quantity || 0), 0);

  await BolOrder.findOneAndUpdate(
    { orderId: orderData.orderId },
    {
      orderId: orderData.orderId,
      orderPlacedDateTime: orderData.orderPlacedDateTime,
      shipmentMethod: orderData.shipmentDetails?.shipmentMethod,
      pickupPoint: orderData.shipmentDetails?.pickupPointName,
      shipmentDetails: orderData.shipmentDetails,
      billingDetails: orderData.billingDetails,
      orderItems: items,
      totalAmount,
      itemCount: items.length,
      fulfilmentMethod: items[0]?.fulfilmentMethod || null,
      status,
      syncedAt: new Date(),
      rawResponse: orderData
    },
    { upsert: true, new: true }
  );
}

async function main() {
  const args = process.argv.slice(2);
  const doFetch = args.includes('--fetch');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const fetchLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const odoo = new OdooDirectClient();
  console.log('Connected to Odoo');

  // Step 1: Get all BOL order IDs from Odoo
  console.log('\n=== Step 1: Extracting BOL order IDs from Odoo ===');

  const totalOdooOrders = await odoo.searchCount('sale.order', [['team_id', 'in', [9, 10]]]);
  console.log(`Total BOL orders in Odoo: ${totalOdooOrders}`);

  const allOdooOrderIds = new Set();
  let offset = 0;

  while (offset < totalOdooOrders) {
    const batch = await odoo.searchRead('sale.order',
      [['team_id', 'in', [9, 10]]],
      ['client_order_ref'],
      { limit: BATCH_SIZE, offset, order: 'date_order desc' }
    );

    for (const order of batch) {
      if (order.client_order_ref) {
        allOdooOrderIds.add(order.client_order_ref);
      }
    }

    offset += BATCH_SIZE;
    if (offset % 10000 === 0) {
      console.log(`  Extracted ${offset} / ${totalOdooOrders}...`);
    }
  }

  console.log(`Unique BOL order IDs from Odoo: ${allOdooOrderIds.size}`);

  // Step 2: Check which orders we already have in MongoDB
  console.log('\n=== Step 2: Checking MongoDB for existing orders ===');

  const existingOrders = await BolOrder.find({
    orderId: { $in: [...allOdooOrderIds] }
  }).select('orderId').lean();

  const existingOrderIds = new Set(existingOrders.map(o => o.orderId));
  console.log(`Orders already in MongoDB: ${existingOrderIds.size}`);

  // Step 3: Find missing orders
  const missingOrderIds = [...allOdooOrderIds].filter(id => !existingOrderIds.has(id));
  console.log(`Missing orders (not in MongoDB): ${missingOrderIds.length}`);

  if (!doFetch) {
    console.log('\n=== Summary ===');
    console.log(`Odoo BOL orders:     ${allOdooOrderIds.size}`);
    console.log(`Already in MongoDB:  ${existingOrderIds.size}`);
    console.log(`Missing:             ${missingOrderIds.length}`);
    console.log('\nTo fetch missing orders, run with --fetch flag');
    console.log('Example: node scripts/bol-import-from-odoo.js --fetch --limit=1000');

    const estimatedTime = (missingOrderIds.length * REQUEST_DELAY_MS) / 1000 / 60;
    console.log(`\nEstimated fetch time for all: ${estimatedTime.toFixed(0)} minutes (${(estimatedTime/60).toFixed(1)} hours)`);

    process.exit(0);
  }

  // Step 4: Fetch missing orders from Bol.com API
  console.log('\n=== Step 3: Fetching missing orders from Bol.com API ===');

  const ordersToFetch = missingOrderIds.slice(0, fetchLimit);
  console.log(`Will fetch ${ordersToFetch.length} orders (limit: ${fetchLimit === Infinity ? 'none' : fetchLimit})`);

  let fetched = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < ordersToFetch.length; i++) {
    const orderId = ordersToFetch[i];
    const progress = `[${i + 1}/${ordersToFetch.length}]`;

    try {
      process.stdout.write(`${progress} Fetching ${orderId}...`);

      const orderData = await fetchOrderDetails(orderId);

      if (!orderData) {
        console.log(' NOT FOUND (404)');
        notFound++;
      } else {
        await storeOrder(orderData);
        const items = orderData.orderItems?.length || 0;
        console.log(` OK (${items} items)`);
        fetched++;
      }
    } catch (error) {
      console.log(` ERROR: ${error.message}`);
      errors++;
    }

    // Rate limiting
    if (i < ordersToFetch.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }

    // Progress update every 100 orders
    if ((i + 1) % 100 === 0) {
      console.log(`\n--- Progress: ${fetched} fetched, ${notFound} not found, ${errors} errors ---\n`);
    }
  }

  console.log('\n=== COMPLETE ===');
  console.log(`Fetched:   ${fetched}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Errors:    ${errors}`);

  const finalCount = await BolOrder.countDocuments();
  console.log(`\nTotal orders in MongoDB: ${finalCount}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
