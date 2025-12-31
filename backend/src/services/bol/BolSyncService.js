/**
 * Bol.com Sync Service
 *
 * Handles syncing data from Bol.com API to MongoDB with rate limiting.
 *
 * Sync modes:
 * - RECENT (30 days): Used on page load
 * - EXTENDED (6 months): Used for nightly sync
 * - HISTORICAL (from 2024-01-01): Used for initial import
 */

const BolOrder = require('../../models/BolOrder');
const BolShipment = require('../../models/BolShipment');
const BolReturn = require('../../models/BolReturn');
const BolInvoice = require('../../models/BolInvoice');

// Rate limiting configuration
const RATE_LIMIT = {
  REQUEST_DELAY_MS: 250,        // Delay between API requests
  BATCH_SIZE: 5,                // Number of detail requests per batch
  BATCH_DELAY_MS: 1000,         // Delay between batches
  PAGE_DELAY_MS: 500,           // Delay between pagination requests
  MAX_RETRIES: 3,               // Max retries on rate limit
  RETRY_DELAY_MS: 2000          // Delay before retry
};

// Sync date ranges
const SYNC_RANGES = {
  RECENT: 30,      // 30 days
  EXTENDED: 180,   // 6 months
  HISTORICAL: null // From 2024-01-01
};

// Token cache (shared with bolcom.api.js)
let retailerAccessToken = null;
let retailerTokenExpiry = null;

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get access token for Retailer API
 */
async function getAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Bol.com credentials not configured');
  }

  // Check if we have a valid cached token
  if (retailerAccessToken && retailerTokenExpiry && Date.now() < retailerTokenExpiry - 30000) {
    return retailerAccessToken;
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
    throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
  }

  const data = await response.json();
  retailerAccessToken = data.access_token;
  retailerTokenExpiry = Date.now() + (data.expires_in * 1000);

  return retailerAccessToken;
}

/**
 * Make a rate-limited request to Bol.com API
 */
async function bolRequest(endpoint, retries = RATE_LIMIT.MAX_RETRIES) {
  const token = await getAccessToken();

  const response = await fetch(`https://api.bol.com/retailer${endpoint}`, {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });

  // Handle rate limiting
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
    console.log(`[BolSync] Rate limited, waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return bolRequest(endpoint, retries - 1);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Bol.com API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Sync orders from Bol.com to MongoDB
 * @param {string} mode - 'RECENT', 'EXTENDED', or 'HISTORICAL'
 * @param {function} onProgress - Progress callback (current, total)
 */
async function syncOrders(mode = 'RECENT', onProgress = null) {
  const days = SYNC_RANGES[mode];
  const fromDate = days
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    : new Date('2024-01-01');

  console.log(`[BolSync] Syncing orders from ${fromDate.toISOString().split('T')[0]} (mode: ${mode})`);

  let allOrders = [];
  let page = 1;
  let hasMore = true;
  let reachedDateLimit = false;

  // Fetch all pages until we reach the date limit
  while (hasMore && !reachedDateLimit) {
    await sleep(RATE_LIMIT.PAGE_DELAY_MS);

    try {
      const data = await bolRequest(`/orders?page=${page}&fulfilment-method=ALL`);
      const orders = data.orders || [];

      if (orders.length === 0) {
        hasMore = false;
        break;
      }

      for (const order of orders) {
        const orderDate = new Date(order.orderPlacedDateTime);
        if (orderDate < fromDate) {
          reachedDateLimit = true;
          break;
        }
        allOrders.push(order);
      }

      console.log(`[BolSync] Fetched page ${page}, got ${orders.length} orders (total: ${allOrders.length})`);
      page++;
    } catch (error) {
      console.error(`[BolSync] Error fetching orders page ${page}:`, error.message);
      break;
    }
  }

  // For HISTORICAL mode, skip detail fetching to avoid rate limits
  const skipDetails = mode === 'HISTORICAL';

  if (!skipDetails) {
    console.log(`[BolSync] Fetching details for ${allOrders.length} orders...`);
  } else {
    console.log(`[BolSync] Storing ${allOrders.length} orders (skipping details for historical mode)...`);
  }

  // Fetch order details in batches with rate limiting
  let processed = 0;
  for (let i = 0; i < allOrders.length; i += RATE_LIMIT.BATCH_SIZE) {
    const batch = allOrders.slice(i, i + RATE_LIMIT.BATCH_SIZE);

    let results;
    if (skipDetails) {
      // For historical, just use list data
      results = batch.map(order => ({ order, details: null, success: false }));
    } else {
      const detailPromises = batch.map(async (order, idx) => {
        // Stagger requests within batch
        await sleep(idx * RATE_LIMIT.REQUEST_DELAY_MS);

        try {
          const details = await bolRequest(`/orders/${order.orderId}`);
          return { order, details, success: true };
        } catch (error) {
          console.error(`[BolSync] Error fetching order ${order.orderId}:`, error.message);
          return { order, details: null, success: false };
        }
      });

      results = await Promise.all(detailPromises);
    }

    // Upsert to MongoDB
    for (const { order, details, success } of results) {
      const orderData = success ? details : order;
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
        fulfilmentStatus: item.fulfilmentStatus || 'OPEN',
        latestDeliveryDate: item.fulfilment?.latestDeliveryDate || item.latestDeliveryDate,
        cancellationRequest: item.cancellationRequest || false
      }));

      // Calculate status
      const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
      const shippedQty = items.reduce((sum, i) => sum + i.quantityShipped, 0);
      const cancelledQty = items.reduce((sum, i) => sum + i.quantityCancelled, 0);

      let status = 'OPEN';
      if (shippedQty >= totalQty) status = 'SHIPPED';
      else if (shippedQty > 0) status = 'PARTIAL';
      else if (cancelledQty >= totalQty) status = 'CANCELLED';

      // Calculate total
      const totalAmount = items.reduce((sum, i) => sum + (i.totalPrice || i.unitPrice * i.quantity || 0), 0);

      // Determine fulfillment method from multiple sources
      // Priority: item fulfilment, shipment method (LVB = FBB), default null
      let orderFulfilmentMethod = items.find(i => i.fulfilmentMethod)?.fulfilmentMethod || null;
      if (!orderFulfilmentMethod && orderData.shipmentDetails?.shipmentMethod === 'LVB') {
        orderFulfilmentMethod = 'FBB';  // LVB = Logistics Via Bol = FBB
      }

      try {
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
            fulfilmentMethod: orderFulfilmentMethod,
            status,
            syncedAt: new Date(),
            rawResponse: success ? orderData : null
          },
          { upsert: true, new: true }
        );
      } catch (dbError) {
        console.error(`[BolSync] DB error for order ${orderData.orderId}:`, dbError.message);
      }
    }

    processed += batch.length;
    if (onProgress) onProgress(processed, allOrders.length);

    // Delay between batches
    if (i + RATE_LIMIT.BATCH_SIZE < allOrders.length) {
      await sleep(RATE_LIMIT.BATCH_DELAY_MS);
    }
  }

  console.log(`[BolSync] Orders sync complete: ${processed} orders processed`);
  return { synced: processed, fromDate: fromDate.toISOString() };
}

/**
 * Sync shipments from Bol.com to MongoDB
 */
async function syncShipments(mode = 'RECENT', onProgress = null) {
  const days = SYNC_RANGES[mode];
  const fromDate = days
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    : new Date('2024-01-01');

  console.log(`[BolSync] Syncing shipments from ${fromDate.toISOString().split('T')[0]} (mode: ${mode})`);

  let allShipments = [];
  let page = 1;
  let hasMore = true;
  let reachedDateLimit = false;

  while (hasMore && !reachedDateLimit) {
    await sleep(RATE_LIMIT.PAGE_DELAY_MS);

    try {
      const data = await bolRequest(`/shipments?page=${page}`);
      const shipments = data.shipments || [];

      if (shipments.length === 0) {
        hasMore = false;
        break;
      }

      for (const shipment of shipments) {
        const shipmentDate = new Date(shipment.shipmentDateTime);
        if (shipmentDate < fromDate) {
          reachedDateLimit = true;
          break;
        }
        allShipments.push(shipment);
      }

      console.log(`[BolSync] Fetched shipments page ${page}, got ${shipments.length} (total: ${allShipments.length})`);
      page++;
    } catch (error) {
      console.error(`[BolSync] Error fetching shipments page ${page}:`, error.message);
      break;
    }
  }

  // For HISTORICAL mode, skip detail fetching to avoid rate limits
  // List data has basic info which is sufficient for historical records
  const skipDetails = mode === 'HISTORICAL';

  if (!skipDetails) {
    console.log(`[BolSync] Fetching details for ${allShipments.length} shipments...`);
  } else {
    console.log(`[BolSync] Storing ${allShipments.length} shipments (skipping details for historical mode)...`);
  }

  // Fetch shipment details in batches (or skip for historical)
  let processed = 0;
  for (let i = 0; i < allShipments.length; i += RATE_LIMIT.BATCH_SIZE) {
    const batch = allShipments.slice(i, i + RATE_LIMIT.BATCH_SIZE);

    let results;
    if (skipDetails) {
      // For historical, just use list data
      results = batch.map(shipment => ({ shipment, details: null, success: false }));
    } else {
      const detailPromises = batch.map(async (shipment, idx) => {
        await sleep(idx * RATE_LIMIT.REQUEST_DELAY_MS);

        try {
          const details = await bolRequest(`/shipments/${shipment.shipmentId}`);
          return { shipment, details, success: true };
        } catch (error) {
          console.error(`[BolSync] Error fetching shipment ${shipment.shipmentId}:`, error.message);
          return { shipment, details: null, success: false };
        }
      });

      results = await Promise.all(detailPromises);
    }

    for (const { shipment, details, success } of results) {
      const data = success ? details : shipment;

      try {
        await BolShipment.findOneAndUpdate(
          { shipmentId: data.shipmentId },
          {
            shipmentId: data.shipmentId,
            shipmentDateTime: data.shipmentDateTime,
            shipmentReference: data.shipmentReference,
            orderId: data.order?.orderId || shipment.order?.orderId || data.shipmentItems?.[0]?.orderId,
            transport: {
              transportId: data.transport?.transportId,
              transporterCode: data.transport?.transporterCode || '',
              trackAndTrace: data.transport?.trackAndTrace || ''
            },
            shipmentItems: (data.shipmentItems || []).map(item => ({
              orderItemId: item.orderItemId,
              orderId: item.orderId,
              ean: item.product?.ean || item.ean,
              title: item.product?.title || '',
              sku: item.offer?.reference || '',
              quantity: item.quantity || 1
            })),
            syncedAt: new Date(),
            rawResponse: success ? data : null
          },
          { upsert: true, new: true }
        );
      } catch (dbError) {
        console.error(`[BolSync] DB error for shipment ${data.shipmentId}:`, dbError.message);
      }
    }

    processed += batch.length;
    if (onProgress) onProgress(processed, allShipments.length);

    if (i + RATE_LIMIT.BATCH_SIZE < allShipments.length) {
      await sleep(RATE_LIMIT.BATCH_DELAY_MS);
    }
  }

  console.log(`[BolSync] Shipments sync complete: ${processed} shipments processed`);
  return { synced: processed, fromDate: fromDate.toISOString() };
}

/**
 * Sync returns from Bol.com to MongoDB
 */
async function syncReturns(mode = 'RECENT', onProgress = null) {
  const days = SYNC_RANGES[mode];
  const fromDate = days
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    : new Date('2024-01-01');

  console.log(`[BolSync] Syncing returns from ${fromDate.toISOString().split('T')[0]} (mode: ${mode})`);

  let allReturns = [];
  let page = 1;
  let hasMore = true;
  let reachedDateLimit = false;

  while (hasMore && !reachedDateLimit) {
    await sleep(RATE_LIMIT.PAGE_DELAY_MS);

    try {
      const data = await bolRequest(`/returns?page=${page}`);
      const returns = data.returns || [];

      if (returns.length === 0) {
        hasMore = false;
        break;
      }

      for (const ret of returns) {
        const returnDate = new Date(ret.registrationDateTime);
        if (returnDate < fromDate) {
          reachedDateLimit = true;
          break;
        }
        allReturns.push(ret);
      }

      console.log(`[BolSync] Fetched returns page ${page}, got ${returns.length} (total: ${allReturns.length})`);
      page++;
    } catch (error) {
      console.error(`[BolSync] Error fetching returns page ${page}:`, error.message);
      break;
    }
  }

  // Upsert returns to MongoDB
  let processed = 0;
  for (const ret of allReturns) {
    const anyHandled = (ret.returnItems || []).some(item => item.handled === true);

    try {
      await BolReturn.findOneAndUpdate(
        { returnId: ret.returnId },
        {
          returnId: ret.returnId,
          registrationDateTime: ret.registrationDateTime,
          fulfilmentMethod: ret.fulfilmentMethod,
          handled: anyHandled,
          returnItems: (ret.returnItems || []).map(item => ({
            rmaId: item.rmaId,
            orderId: item.orderId,
            orderItemId: item.orderItemId,
            ean: item.ean || '',
            quantity: item.expectedQuantity || item.quantity || 1,
            returnReason: item.returnReason?.mainReason || '',
            returnReasonDetail: item.returnReason?.detailedReason || '',
            returnReasonComments: item.returnReason?.customerComments || '',
            handled: item.handled || false,
            handlingResult: item.handlingResult
          })),
          syncedAt: new Date(),
          rawResponse: ret
        },
        { upsert: true, new: true }
      );
      processed++;
    } catch (dbError) {
      console.error(`[BolSync] DB error for return ${ret.returnId}:`, dbError.message);
    }

    if (onProgress) onProgress(processed, allReturns.length);
  }

  console.log(`[BolSync] Returns sync complete: ${processed} returns processed`);
  return { synced: processed, fromDate: fromDate.toISOString() };
}

/**
 * Sync invoices from Bol.com to MongoDB
 * Only fetches last 30 days - older invoices are already stored and won't change
 */
async function syncInvoices(onProgress = null) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  const periodStr = `${startDate.toISOString().split('T')[0]}/${endDate.toISOString().split('T')[0]}`;
  console.log(`[BolSync] Syncing invoices for last 30 days: ${periodStr}`);

  try {
    await sleep(RATE_LIMIT.REQUEST_DELAY_MS);
    const data = await bolRequest(`/invoices?period=${encodeURIComponent(periodStr)}`);
    const invoices = data.invoiceListItems || [];

    console.log(`[BolSync] Found ${invoices.length} invoices in last 30 days`);

    let processed = 0;
    let newCount = 0;
    for (const inv of invoices) {
      const issueDate = inv.issueDate ? new Date(inv.issueDate) : null;
      const periodStart = inv.invoicePeriod?.startDate ? new Date(inv.invoicePeriod.startDate) : null;
      const periodEnd = inv.invoicePeriod?.endDate ? new Date(inv.invoicePeriod.endDate) : null;

      try {
        const existing = await BolInvoice.findOne({ invoiceId: inv.invoiceId });
        const result = await BolInvoice.findOneAndUpdate(
          { invoiceId: inv.invoiceId },
          {
            invoiceId: inv.invoiceId,
            issueDate,
            periodStartDate: periodStart,
            periodEndDate: periodEnd,
            invoiceType: inv.invoiceType,
            totalAmountExclVat: inv.legalMonetaryTotal?.taxExclusiveAmount?.amount,
            totalAmountInclVat: inv.legalMonetaryTotal?.taxInclusiveAmount?.amount,
            currency: inv.legalMonetaryTotal?.taxExclusiveAmount?.currencyID || 'EUR',
            openAmount: inv.openAmount,
            availableFormats: {
              invoice: inv.invoiceMediaTypes?.availableMediaTypes || [],
              specification: inv.specificationMediaTypes?.availableMediaTypes || []
            },
            syncedAt: new Date(),
            rawResponse: inv
          },
          { upsert: true, new: true }
        );
        processed++;
        if (!existing) newCount++;
      } catch (dbError) {
        console.error(`[BolSync] DB error for invoice ${inv.invoiceId}:`, dbError.message);
      }

      if (onProgress) onProgress(processed, invoices.length);
    }

    console.log(`[BolSync] Invoices sync complete: ${processed} processed, ${newCount} new`);
    return { synced: processed, new: newCount };
  } catch (error) {
    console.error(`[BolSync] Error syncing invoices:`, error.message);
    throw error;
  }
}

/**
 * Full historical invoice sync - use once to backfill all invoices from 2024
 * This makes multiple API calls, so use sparingly
 */
async function syncInvoicesFullHistory(onProgress = null) {
  console.log(`[BolSync] Full historical invoice sync from 2024-01-01...`);

  try {
    let allInvoices = [];
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    // Query per calendar month: 1st to 28th of each month
    // Start from January 2024
    let year = 2024;
    let month = 0; // January

    while (year < currentYear || (year === currentYear && month <= currentMonth)) {
      // Format: YYYY-MM-DD
      const startStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endStr = `${year}-${String(month + 1).padStart(2, '0')}-28`;
      const periodStr = `${startStr}/${endStr}`;

      console.log(`[BolSync] Fetching invoices for period: ${periodStr}`);

      await sleep(RATE_LIMIT.REQUEST_DELAY_MS);
      try {
        const data = await bolRequest(`/invoices?period=${encodeURIComponent(periodStr)}`);
        const invoices = data.invoiceListItems || [];
        allInvoices = allInvoices.concat(invoices);
        console.log(`[BolSync] Found ${invoices.length} invoices for period ${periodStr}`);
      } catch (e) {
        if (!e.message.includes('404')) {
          console.warn(`[BolSync] Error fetching period ${periodStr}:`, e.message);
        }
      }

      // Move to next month
      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
    }

    // Deduplicate
    const uniqueInvoices = [];
    const seenIds = new Set();
    for (const inv of allInvoices) {
      if (!seenIds.has(inv.invoiceId)) {
        seenIds.add(inv.invoiceId);
        uniqueInvoices.push(inv);
      }
    }

    console.log(`[BolSync] Total unique invoices found: ${uniqueInvoices.length}`);

    let processed = 0;
    for (const inv of uniqueInvoices) {
      const issueDate = inv.issueDate ? new Date(inv.issueDate) : null;
      const periodStart = inv.invoicePeriod?.startDate ? new Date(inv.invoicePeriod.startDate) : null;
      const periodEnd = inv.invoicePeriod?.endDate ? new Date(inv.invoicePeriod.endDate) : null;

      try {
        await BolInvoice.findOneAndUpdate(
          { invoiceId: inv.invoiceId },
          {
            invoiceId: inv.invoiceId,
            issueDate,
            periodStartDate: periodStart,
            periodEndDate: periodEnd,
            invoiceType: inv.invoiceType,
            totalAmountExclVat: inv.legalMonetaryTotal?.taxExclusiveAmount?.amount,
            totalAmountInclVat: inv.legalMonetaryTotal?.taxInclusiveAmount?.amount,
            currency: inv.legalMonetaryTotal?.taxExclusiveAmount?.currencyID || 'EUR',
            openAmount: inv.openAmount,
            availableFormats: {
              invoice: inv.invoiceMediaTypes?.availableMediaTypes || [],
              specification: inv.specificationMediaTypes?.availableMediaTypes || []
            },
            syncedAt: new Date(),
            rawResponse: inv
          },
          { upsert: true, new: true }
        );
        processed++;
      } catch (dbError) {
        console.error(`[BolSync] DB error for invoice ${inv.invoiceId}:`, dbError.message);
      }

      if (onProgress) onProgress(processed, uniqueInvoices.length);
    }

    console.log(`[BolSync] Full invoice sync complete: ${processed} invoices processed`);
    return { synced: processed };
  } catch (error) {
    console.error(`[BolSync] Error syncing invoices:`, error.message);
    throw error;
  }
}

/**
 * Run full sync for all data types
 */
async function syncAll(mode = 'RECENT') {
  console.log(`[BolSync] Starting full sync (mode: ${mode})...`);
  const startTime = Date.now();

  const results = {
    orders: await syncOrders(mode),
    shipments: await syncShipments(mode),
    returns: await syncReturns(mode),
    invoices: await syncInvoices()
  };

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[BolSync] Full sync complete in ${duration}s`);

  return {
    ...results,
    duration: `${duration}s`,
    mode
  };
}

/**
 * Get sync status (last sync times)
 */
async function getSyncStatus() {
  const [lastOrder, lastShipment, lastReturn, lastInvoice] = await Promise.all([
    BolOrder.findOne().sort({ syncedAt: -1 }).select('syncedAt'),
    BolShipment.findOne().sort({ syncedAt: -1 }).select('syncedAt'),
    BolReturn.findOne().sort({ syncedAt: -1 }).select('syncedAt'),
    BolInvoice.findOne().sort({ syncedAt: -1 }).select('syncedAt')
  ]);

  const [orderCount, shipmentCount, returnCount, invoiceCount] = await Promise.all([
    BolOrder.countDocuments(),
    BolShipment.countDocuments(),
    BolReturn.countDocuments(),
    BolInvoice.countDocuments()
  ]);

  return {
    orders: {
      count: orderCount,
      lastSyncedAt: lastOrder?.syncedAt
    },
    shipments: {
      count: shipmentCount,
      lastSyncedAt: lastShipment?.syncedAt
    },
    returns: {
      count: returnCount,
      lastSyncedAt: lastReturn?.syncedAt
    },
    invoices: {
      count: invoiceCount,
      lastSyncedAt: lastInvoice?.syncedAt
    }
  };
}

module.exports = {
  syncOrders,
  syncShipments,
  syncReturns,
  syncInvoices,
  syncInvoicesFullHistory,
  syncAll,
  getSyncStatus,
  SYNC_RANGES
};
