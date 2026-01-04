/**
 * Bol.com Retailer & Advertising API Routes
 *
 * Integration with Bol.com marketplace for orders, offers, shipments, returns,
 * and advertising campaigns/costs.
 * Uses OAuth2 client credentials flow for authentication.
 *
 * API Documentation:
 * - Retailer: https://api.bol.com/retailer/public/Retailer-API/
 * - Advertising: https://api.bol.com/retailer/public/Advertiser-API/
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Local invoice files directory
const INVOICE_FILES_DIR = path.join(__dirname, '../../..', 'uploads/bol_invoices');

// MongoDB - using unified_orders collection
const { getDb } = require('../../db');
const { CHANNELS } = require('../../services/orders/UnifiedOrderService');
const COLLECTION_NAME = 'unified_orders';

// MongoDB models (kept for non-order data)
const BolShipment = require('../../models/BolShipment');
const BolReturn = require('../../models/BolReturn');
const BolInvoice = require('../../models/BolInvoice');

// Sync service
const BolSyncService = require('../../services/bol/BolSyncService');

// Track ongoing syncs to prevent duplicates
const ongoingSyncs = {
  orders: false,
  shipments: false,
  returns: false,
  invoices: false
};

// Token cache for Retailer API
let retailerAccessToken = null;
let retailerTokenExpiry = null;

// Token cache for Advertising API (separate credentials)
let advertiserAccessToken = null;
let advertiserTokenExpiry = null;

/**
 * Get access token for Retailer API using client credentials flow
 */
async function getRetailerAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Bol.com Retailer credentials not configured. Set BOL_CLIENT_ID and BOL_CLIENT_SECRET in .env');
  }

  // Check if we have a valid cached token (with 30 second buffer)
  if (retailerAccessToken && retailerTokenExpiry && Date.now() < retailerTokenExpiry - 30000) {
    return retailerAccessToken;
  }

  // Base64 encode credentials
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
    const error = await response.text();
    throw new Error(`Failed to get Bol.com Retailer access token: ${error}`);
  }

  const data = await response.json();
  retailerAccessToken = data.access_token;
  retailerTokenExpiry = Date.now() + (data.expires_in * 1000);

  return retailerAccessToken;
}

/**
 * Get access token for Advertising API using client credentials flow
 * Uses separate credentials (BOL_ADVERTISER_ID and BOL_ADVERTISER_SECRET)
 */
async function getAdvertiserAccessToken() {
  const advertiserId = process.env.BOL_ADVERTISER_ID;
  const advertiserSecret = process.env.BOL_ADVERTISER_SECRET;

  if (!advertiserId || !advertiserSecret) {
    throw new Error('Bol.com Advertising credentials not configured. Set BOL_ADVERTISER_ID and BOL_ADVERTISER_SECRET in .env');
  }

  // Check if we have a valid cached token (with 30 second buffer)
  if (advertiserAccessToken && advertiserTokenExpiry && Date.now() < advertiserTokenExpiry - 30000) {
    return advertiserAccessToken;
  }

  // Base64 encode credentials
  const credentials = Buffer.from(`${advertiserId}:${advertiserSecret}`).toString('base64');

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
    const error = await response.text();
    throw new Error(`Failed to get Bol.com Advertising access token: ${error}`);
  }

  const data = await response.json();
  advertiserAccessToken = data.access_token;
  advertiserTokenExpiry = Date.now() + (data.expires_in * 1000);

  return advertiserAccessToken;
}

/**
 * Make a request to Bol.com Retailer API with retry logic for rate limiting
 */
async function bolRequest(endpoint, method = 'GET', body = null, retries = 3) {
  const token = await getRetailerAccessToken();

  const options = {
    method,
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  };

  if (body) {
    options.headers['Content-Type'] = 'application/vnd.retailer.v10+json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`https://api.bol.com/retailer${endpoint}`, options);

  // Handle rate limiting with retry
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
    console.log(`Bol.com rate limited, retrying in ${retryAfter}s...`);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return bolRequest(endpoint, method, body, retries - 1);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || error.message || `Bol.com API error: ${response.status}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

/**
 * Make a request to Bol.com Advertising API (v11)
 * Uses separate credentials (BOL_ADVERTISER_ID / BOL_ADVERTISER_SECRET)
 *
 * IMPORTANT: v11 API format (Updated January 2026):
 * - Base URL: https://api.bol.com/advertiser/sponsored-products/campaign-management
 * - Listing endpoints use PUT with empty array body (e.g., PUT /campaigns with {"campaigns": []})
 * - Create endpoints use POST (e.g., POST /campaigns)
 * - Update endpoints use PUT with full object
 * - Listing returns HTTP 207 Multi-Status
 *
 * See: https://api.bol.com/advertiser/docs/redoc/sponsored-products/v11/campaign-management.html
 */
async function advertiserRequest(endpoint, method = 'GET', body = null, retries = 3) {
  const token = await getAdvertiserAccessToken();

  const options = {
    method,
    headers: {
      'Accept': 'application/vnd.advertiser.v11+json',
      'Authorization': `Bearer ${token}`
    }
  };

  if (body) {
    options.headers['Content-Type'] = 'application/vnd.advertiser.v11+json';
    options.body = JSON.stringify(body);
  }

  // Advertising API v11 full base URL (from OpenAPI spec)
  const baseUrl = 'https://api.bol.com/advertiser/sponsored-products/campaign-management';
  const response = await fetch(`${baseUrl}${endpoint}`, options);

  // Handle rate limiting with retry
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
    console.log(`Bol.com Advertising API rate limited, retrying in ${retryAfter}s...`);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return advertiserRequest(endpoint, method, body, retries - 1);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || error.message || `Bol.com Advertising API error: ${response.status}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

/**
 * Check connection status
 */
router.get('/status', async (req, res) => {
  try {
    const clientId = process.env.BOL_CLIENT_ID;
    const clientSecret = process.env.BOL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.json({
        connected: false,
        configured: false,
        error: 'Retailer API: Environment variables not set (BOL_CLIENT_ID, BOL_CLIENT_SECRET)'
      });
    }

    // Try to get a token to verify credentials
    await getRetailerAccessToken();

    res.json({
      connected: true,
      configured: true,
      clientId: clientId.slice(0, 8) + '...'
    });
  } catch (error) {
    res.json({
      connected: false,
      configured: true,
      error: error.message
    });
  }
});

/**
 * Check Advertising API connection status
 */
router.get('/advertising/status', async (req, res) => {
  try {
    const advertiserId = process.env.BOL_ADVERTISER_ID;
    const advertiserSecret = process.env.BOL_ADVERTISER_SECRET;

    if (!advertiserId || !advertiserSecret) {
      return res.json({
        connected: false,
        configured: false,
        error: 'Advertising API: Environment variables not set (BOL_ADVERTISER_ID, BOL_ADVERTISER_SECRET)'
      });
    }

    // Try to get a token to verify credentials
    await getAdvertiserAccessToken();

    res.json({
      connected: true,
      configured: true,
      advertiserId: advertiserId.slice(0, 8) + '...'
    });
  } catch (error) {
    res.json({
      connected: false,
      configured: true,
      error: error.message
    });
  }
});

/**
 * Clear token cache
 */
router.post('/clear-token', async (req, res) => {
  retailerAccessToken = null;
  retailerTokenExpiry = null;
  advertiserAccessToken = null;
  advertiserTokenExpiry = null;
  res.json({ success: true, message: 'All token caches cleared (Retailer & Advertising)' });
});

/**
 * Get orders - Sync last 30 days then read from MongoDB
 * Query params: fulfilmentMethod (FBR/FBB), status, skipSync (true to skip sync)
 */
router.get('/orders', async (req, res) => {
  try {
    const { fulfilmentMethod, status, skipSync } = req.query;

    // Sync last 30 days from Bol.com (unless skipSync=true or sync already in progress)
    if (skipSync !== 'true' && !ongoingSyncs.orders) {
      ongoingSyncs.orders = true;
      try {
        await BolSyncService.syncOrders('RECENT');
      } catch (syncError) {
        console.error('[BolAPI] Orders sync error:', syncError.message);
        // Continue with existing data from MongoDB
      } finally {
        ongoingSyncs.orders = false;
      }
    }

    // Build query for unified_orders collection
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const query = {
      channel: CHANNELS.BOL,
      orderDate: { $gte: new Date('2024-01-01') }
    };

    if (fulfilmentMethod) {
      query.subChannel = fulfilmentMethod;  // FBB or FBR
    }
    if (status) {
      query['status.source'] = status.toUpperCase();
    }

    // Fetch from MongoDB (unified_orders)
    const orders = await collection.find(query)
      .sort({ orderDate: -1 })
      .toArray();

    res.json({
      success: true,
      count: orders.length,
      source: 'mongodb',
      orders: orders.map(o => ({
        orderId: o.sourceIds?.bolOrderId,
        orderPlacedDateTime: o.orderDate,
        shipmentMethod: o.bol?.shipmentMethod,
        pickupPoint: o.bol?.pickupPoint,
        orderItems: o.items,
        odoo: o.odoo || null
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single order details - Read from MongoDB (with fallback to API)
 */
router.get('/orders/:orderId', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.BOL}:${req.params.orderId}`;

    // Try to get from unified_orders first
    let unifiedOrder = await collection.findOne({ unifiedOrderId });

    // If not in MongoDB, fetch from API and store
    if (!unifiedOrder) {
      const data = await bolRequest(`/orders/${req.params.orderId}`);

      // Transform and store in unified_orders
      const { transformBolApiOrder } = require('../../services/orders/transformers/BolOrderTransformer');
      unifiedOrder = transformBolApiOrder(data);
      unifiedOrder.rawResponse = data;
      unifiedOrder.importedAt = new Date();
      unifiedOrder.updatedAt = new Date();

      // Save to unified_orders (fire and forget)
      collection.updateOne(
        { unifiedOrderId: unifiedOrder.unifiedOrderId },
        { $set: unifiedOrder, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      ).catch(err => console.error('[BolAPI] Failed to cache order:', err.message));
    }

    // Map unified schema back to legacy API response format
    const order = {
      orderId: unifiedOrder.sourceIds?.bolOrderId,
      orderPlacedDateTime: unifiedOrder.orderDate,
      shipmentMethod: unifiedOrder.bol?.shipmentMethod,
      pickupPoint: unifiedOrder.bol?.pickupPoint,
      billingDetails: unifiedOrder.bol?.billingDetails,
      shipmentDetails: {
        firstName: unifiedOrder.shippingAddress?.name?.split(' ')[0] || '',
        surname: unifiedOrder.shippingAddress?.name?.split(' ').slice(1).join(' ') || '',
        streetName: unifiedOrder.shippingAddress?.street || '',
        city: unifiedOrder.shippingAddress?.city || '',
        zipCode: unifiedOrder.shippingAddress?.postalCode || '',
        countryCode: unifiedOrder.shippingAddress?.countryCode || ''
      },
      orderItems: unifiedOrder.items
    };

    res.json({
      success: true,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get shipments - Sync last 30 days then read from MongoDB
 * Query params: orderId, skipSync (true to skip sync)
 */
router.get('/shipments', async (req, res) => {
  try {
    const { orderId, skipSync } = req.query;

    // Sync last 30 days from Bol.com
    if (skipSync !== 'true' && !ongoingSyncs.shipments) {
      ongoingSyncs.shipments = true;
      try {
        await BolSyncService.syncShipments('RECENT');
      } catch (syncError) {
        console.error('[BolAPI] Shipments sync error:', syncError.message);
      } finally {
        ongoingSyncs.shipments = false;
      }
    }

    // Build query for MongoDB
    const query = {
      shipmentDateTime: { $gte: new Date('2024-01-01') }
    };

    if (orderId) {
      query.orderId = orderId;
    }

    // Fetch from MongoDB
    const shipments = await BolShipment.find(query)
      .sort({ shipmentDateTime: -1 })
      .lean();

    // Get ZIP codes from unified_orders
    const orderIds = [...new Set(shipments.map(s => s.orderId).filter(Boolean))];
    const unifiedOrderIds = orderIds.map(id => `${CHANNELS.BOL}:${id}`);
    const ordersDb = getDb();
    const ordersCollection = ordersDb.collection(COLLECTION_NAME);
    const orders = await ordersCollection.find(
      { unifiedOrderId: { $in: unifiedOrderIds } },
      { projection: { 'sourceIds.bolOrderId': 1, 'shippingAddress.postalCode': 1 } }
    ).toArray();
    const zipMap = {};
    for (const o of orders) {
      zipMap[o.sourceIds?.bolOrderId] = o.shippingAddress?.postalCode || '';
    }

    res.json({
      success: true,
      count: shipments.length,
      source: 'mongodb',
      shipments: shipments.map(s => ({
        shipmentId: s.shipmentId,
        shipmentDateTime: s.shipmentDateTime,
        shipmentReference: s.shipmentReference,
        orderId: s.orderId,
        transport: s.transport,
        shipmentItems: s.shipmentItems,
        zipCode: zipMap[s.orderId] || ''
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single shipment details - Read from MongoDB with fallback to API
 */
router.get('/shipments/:shipmentId', async (req, res) => {
  try {
    let shipment = await BolShipment.findOne({ shipmentId: req.params.shipmentId }).lean();

    if (!shipment) {
      const data = await bolRequest(`/shipments/${req.params.shipmentId}`);
      shipment = data;
    }

    res.json({ success: true, shipment });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get returns - Sync last 30 days then read from MongoDB
 * Query params: handled (true/false), skipSync
 */
router.get('/returns', async (req, res) => {
  try {
    const { handled, skipSync } = req.query;

    // Sync last 30 days from Bol.com
    if (skipSync !== 'true' && !ongoingSyncs.returns) {
      ongoingSyncs.returns = true;
      try {
        await BolSyncService.syncReturns('RECENT');
      } catch (syncError) {
        console.error('[BolAPI] Returns sync error:', syncError.message);
      } finally {
        ongoingSyncs.returns = false;
      }
    }

    // Build query for MongoDB
    const query = {
      registrationDateTime: { $gte: new Date('2024-01-01') }
    };

    if (handled !== undefined && handled !== '') {
      query.handled = handled === 'true';
    }

    // Fetch from MongoDB
    const returns = await BolReturn.find(query)
      .sort({ registrationDateTime: -1 })
      .lean();

    res.json({
      success: true,
      count: returns.length,
      source: 'mongodb',
      returns: returns.map(r => ({
        returnId: r.returnId,
        registrationDateTime: r.registrationDateTime,
        fulfilmentMethod: r.fulfilmentMethod,
        handled: r.handled,
        returnItems: r.returnItems
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single return details
 */
router.get('/returns/:returnId', async (req, res) => {
  try {
    const data = await bolRequest(`/returns/${req.params.returnId}`);
    res.json({ success: true, return: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Handle a return (accept/reject)
 */
router.put('/returns/:rmaId', async (req, res) => {
  try {
    const { handlingResult, quantityReturned } = req.body;

    const data = await bolRequest(`/returns/${req.params.rmaId}`, 'PUT', {
      handlingResult,
      quantityReturned
    });

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get offers (your product listings)
 */
router.get('/offers', async (req, res) => {
  try {
    const { page: _page = 1 } = req.query;

    // Note: Bol.com doesn't have a direct "list all offers" endpoint
    // You need to export offers or query by EAN
    // This endpoint requires the offers export feature
    const data = await bolRequest(`/offers/export`);

    res.json({
      success: true,
      message: 'Offer export initiated',
      processStatus: data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single offer by offer ID
 */
router.get('/offers/:offerId', async (req, res) => {
  try {
    const data = await bolRequest(`/offers/${req.params.offerId}`);

    res.json({
      success: true,
      offer: {
        offerId: data.offerId,
        ean: data.ean,
        reference: data.reference,
        onHoldByRetailer: data.onHoldByRetailer,
        unknownProductTitle: data.unknownProductTitle,
        pricing: data.pricing,
        stock: data.stock,
        fulfilment: data.fulfilment,
        store: data.store,
        condition: data.condition,
        notPublishableReasons: data.notPublishableReasons
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update offer stock
 */
router.put('/offers/:offerId/stock', async (req, res) => {
  try {
    const { amount, managedByRetailer = true } = req.body;

    const data = await bolRequest(`/offers/${req.params.offerId}/stock`, 'PUT', {
      amount,
      managedByRetailer
    });

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update offer price
 */
router.put('/offers/:offerId/price', async (req, res) => {
  try {
    const { pricing } = req.body;

    const data = await bolRequest(`/offers/${req.params.offerId}/price`, 'PUT', {
      pricing
    });

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get commissions for products
 */
router.get('/commissions', async (req, res) => {
  try {
    const { ean, condition = 'NEW', unitPrice } = req.query;

    if (!ean || !unitPrice) {
      return res.status(400).json({ error: 'ean and unitPrice are required' });
    }

    const data = await bolRequest(`/commission/${ean}?condition=${condition}&unit-price=${unitPrice}`);

    res.json({
      success: true,
      commission: {
        ean: data.ean,
        condition: data.condition,
        unitPrice: data.unitPrice,
        fixedAmount: data.fixedAmount,
        percentage: data.percentage,
        totalCost: data.totalCost,
        totalCostWithoutReduction: data.totalCostWithoutReduction,
        reductions: data.reductions
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get invoices - Sync then read from MongoDB
 * Query params: skipSync (true to skip sync)
 */
router.get('/invoices', async (req, res) => {
  try {
    const { skipSync } = req.query;

    // Sync invoices from Bol.com
    if (skipSync !== 'true' && !ongoingSyncs.invoices) {
      ongoingSyncs.invoices = true;
      try {
        await BolSyncService.syncInvoices();
      } catch (syncError) {
        console.error('[BolAPI] Invoices sync error:', syncError.message);
      } finally {
        ongoingSyncs.invoices = false;
      }
    }

    // Fetch from MongoDB
    const invoices = await BolInvoice.find({})
      .sort({ issueDate: -1 })
      .lean();

    res.json({
      success: true,
      count: invoices.length,
      source: 'mongodb',
      invoices: invoices.map(inv => ({
        invoiceId: inv.invoiceId,
        issueDate: inv.issueDate,
        periodStartDate: inv.periodStartDate,
        periodEndDate: inv.periodEndDate,
        invoiceType: inv.invoiceType,
        totalAmountExclVat: inv.totalAmountExclVat,
        totalAmountInclVat: inv.totalAmountInclVat,
        currency: inv.currency,
        openAmount: inv.openAmount,
        availableFormats: inv.availableFormats,
        odooBillId: inv.odoo?.billId,
        odooBillNumber: inv.odoo?.billNumber
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Download invoice PDF
 * First checks for local file, then falls back to Bol.com API
 */
router.get('/invoices/:invoiceId/download', async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;

    // First check for local file
    const invoice = await BolInvoice.findOne({ invoiceId });
    if (invoice?.pdfFile) {
      const localPath = path.join(INVOICE_FILES_DIR, invoice.pdfFile);
      if (fs.existsSync(localPath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="bol-invoice-${invoiceId}.pdf"`);
        return res.sendFile(localPath);
      }
    }

    // Fall back to Bol.com API
    const token = await getRetailerAccessToken();
    const pdfResponse = await fetch(`https://api.bol.com/retailer/invoices/${invoiceId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+pdf',
        'Authorization': `Bearer ${token}`
      }
    });

    if (pdfResponse.ok) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="bol-invoice-${invoiceId}.pdf"`);
      const buffer = await pdfResponse.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

    res.status(404).json({
      success: false,
      error: 'Invoice PDF not available.',
      partnerPortalUrl: 'https://partner.bol.com/sdd/orders/invoices'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Download invoice specification (Excel)
 * First checks for local file, then falls back to Bol.com API
 */
router.get('/invoices/:invoiceId/specification', async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    const { format = 'excel' } = req.query;

    // For Excel format, first check for local file
    if (format !== 'json') {
      const invoice = await BolInvoice.findOne({ invoiceId });
      if (invoice?.excelFile) {
        const localPath = path.join(INVOICE_FILES_DIR, invoice.excelFile);
        if (fs.existsSync(localPath)) {
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', `attachment; filename="bol-invoice-spec-${invoiceId}.xlsx"`);
          return res.sendFile(localPath);
        }
      }
    }

    // Fall back to Bol.com API
    const token = await getRetailerAccessToken();

    let acceptHeader;
    let filename;
    let contentType;

    if (format === 'json') {
      acceptHeader = 'application/vnd.retailer.v10+json';
      filename = `bol-invoice-spec-${invoiceId}.json`;
      contentType = 'application/json';
    } else {
      acceptHeader = 'application/vnd.retailer.v10+openxmlformats-officedocument.spreadsheetml.sheet';
      filename = `bol-invoice-spec-${invoiceId}.xlsx`;
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    const specResponse = await fetch(`https://api.bol.com/retailer/invoices/${invoiceId}/specification`, {
      headers: {
        'Accept': acceptHeader,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!specResponse.ok) {
      const errorText = await specResponse.text();
      throw new Error(`Failed to get specification: ${specResponse.status} - ${errorText}`);
    }

    if (format === 'json') {
      const data = await specResponse.json();
      return res.json({ success: true, specification: data });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const buffer = await specResponse.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get retailer information
 */
router.get('/retailer', async (req, res) => {
  try {
    const data = await bolRequest('/retailer');

    res.json({
      success: true,
      retailer: {
        retailerId: data.retailerId,
        displayName: data.displayName,
        companyName: data.companyName,
        registrationNumber: data.registrationNumber,
        vatNumber: data.vatNumber,
        email: data.contactInformation?.email,
        phone: data.contactInformation?.phone
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get performance indicators
 */
router.get('/insights/performance', async (req, res) => {
  try {
    const { name, year, week } = req.query;

    if (!name || !year || !week) {
      return res.status(400).json({ error: 'name, year, and week are required' });
    }

    const data = await bolRequest(`/insights/performance/indicator?name=${name}&year=${year}&week=${week}`);

    res.json({ success: true, performance: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Ship an order item (create shipment)
 */
router.post('/orders/:orderId/shipment', async (req, res) => {
  try {
    const { orderItemId, shipmentReference, shippingLabelId, transport } = req.body;

    if (!orderItemId) {
      return res.status(400).json({ error: 'orderItemId is required' });
    }

    const shipmentData = {
      orderItems: [{ orderItemId }]
    };

    if (shipmentReference) shipmentData.shipmentReference = shipmentReference;
    if (shippingLabelId) shipmentData.shippingLabelId = shippingLabelId;
    if (transport) shipmentData.transport = transport;

    const data = await bolRequest('/shipments', 'POST', shipmentData);

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Cancel an order item
 */
router.delete('/orders/:orderId/items/:orderItemId', async (req, res) => {
  try {
    const { reasonCode } = req.body;

    const data = await bolRequest(`/orders/cancellation`, 'PUT', {
      orderItems: [{
        orderItemId: req.params.orderItemId,
        reasonCode: reasonCode || 'OUT_OF_STOCK'
      }]
    });

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ODOO ORDER CREATION ENDPOINTS
// ============================================

/**
 * Create Odoo sale.order for a single Bol order
 * POST /api/bolcom/orders/:orderId/create-odoo
 */
router.post('/orders/:orderId/create-odoo', async (req, res) => {
  try {
    const { dryRun = false, autoConfirm = true } = req.body;
    const { getBolOrderCreator } = require('../../services/bol/BolOrderCreator');

    const creator = await getBolOrderCreator();
    const result = await creator.createOrder(req.params.orderId, { dryRun, autoConfirm });

    res.json({
      success: result.success,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create Odoo sale.orders for all pending Bol orders (without Odoo link)
 * POST /api/bolcom/orders/create-odoo-bulk
 */
router.post('/orders/create-odoo-bulk', async (req, res) => {
  try {
    const { limit = 50, dryRun = false, autoConfirm = true } = req.body;
    const { getBolOrderCreator } = require('../../services/bol/BolOrderCreator');

    const creator = await getBolOrderCreator();
    const results = await creator.createPendingOrders({ limit, dryRun, autoConfirm });

    res.json({
      success: true,
      message: `Processed ${results.processed} orders: ${results.created} created, ${results.skipped} skipped, ${results.failed} failed`,
      ...results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get orders pending Odoo creation
 * GET /api/bolcom/orders/pending-odoo
 */
router.get('/orders/pending-odoo', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    // Find orders without Odoo link (using unified schema)
    const pendingOrders = await collection.find({
      channel: CHANNELS.BOL,
      $or: [
        { 'sourceIds.odooSaleOrderId': { $exists: false } },
        { 'sourceIds.odooSaleOrderId': null }
      ]
    })
      .sort({ orderDate: -1 })
      .limit(parseInt(limit, 10))
      .project({
        'sourceIds.bolOrderId': 1,
        orderDate: 1,
        subChannel: 1,
        'totals.total': 1,
        items: 1,
        shippingAddress: 1
      })
      .toArray();

    res.json({
      success: true,
      count: pendingOrders.length,
      orders: pendingOrders.map(o => ({
        orderId: o.sourceIds?.bolOrderId,
        orderPlacedDateTime: o.orderDate,
        fulfilmentMethod: o.subChannel,
        totalAmount: o.totals?.total,
        itemCount: o.items?.length || 0,
        customerName: o.shippingAddress?.name || 'Unknown'
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// INVOICE JOURNAL UPDATE ENDPOINTS
// ============================================

/**
 * Update invoice journal for a single Bol order
 * POST /api/bolcom/orders/:orderId/update-invoice-journal
 */
router.post('/orders/:orderId/update-invoice-journal', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { getBolOrderCreator } = require('../../services/bol/BolOrderCreator');

    const creator = await getBolOrderCreator();
    const result = await creator.updateInvoiceJournal(orderId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: `Updated ${result.updated} invoice(s) to journal ${result.journalCode}`,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update invoice journals for all Bol orders
 * POST /api/bolcom/orders/update-invoice-journals-bulk
 */
router.post('/orders/update-invoice-journals-bulk', async (req, res) => {
  try {
    const { limit = 100 } = req.body;
    const { getBolOrderCreator } = require('../../services/bol/BolOrderCreator');

    const creator = await getBolOrderCreator();
    const results = await creator.updateAllInvoiceJournals({ limit });

    res.json({
      success: true,
      message: `Processed ${results.processed} orders: ${results.updated} invoices updated, ${results.noInvoice} without invoices`,
      ...results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get tax configuration info for an order
 * GET /api/bolcom/orders/:orderId/tax-config
 */
router.get('/orders/:orderId/tax-config', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { getBolOrderCreator, TAX_CONFIG } = require('../../services/bol/BolOrderCreator');

    // Use unified_orders collection
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.BOL}:${orderId}`;
    const bolOrder = await collection.findOne({ unifiedOrderId });

    if (!bolOrder) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const creator = await getBolOrderCreator();
    const fulfilmentMethod = bolOrder.subChannel || 'FBR';
    const destCountry = bolOrder.shippingAddress?.countryCode || 'NL';
    const shipFrom = fulfilmentMethod === 'FBB' ? 'NL' : 'BE';
    const taxConfig = creator.getTaxConfig(fulfilmentMethod, destCountry);

    res.json({
      success: true,
      orderId,
      fulfilmentMethod,
      route: `${shipFrom} -> ${destCountry}`,
      taxId: taxConfig.taxId,
      journalCode: taxConfig.journalCode,
      allConfigs: TAX_CONFIG
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// STOCK SYNC ENDPOINTS
// ============================================

/**
 * Trigger stock sync from Odoo to Bol.com
 * POST /api/bolcom/sync/stock
 */
router.post('/sync/stock', async (req, res) => {
  try {
    const { getBolStockSync } = require('../../services/bol/BolStockSync');
    const stockSync = await getBolStockSync();
    const result = await stockSync.syncFromOrders();

    res.json({
      success: result.success,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get stock sync status
 * GET /api/bolcom/sync/stock/status
 */
router.get('/sync/stock/status', async (req, res) => {
  try {
    const { getBolStockSync } = require('../../services/bol/BolStockSync');
    const stockSync = await getBolStockSync();
    const status = stockSync.getStatus();

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SHIPMENT SYNC ENDPOINTS
// ============================================

/**
 * Trigger shipment sync - check Odoo pickings and confirm to Bol.com
 * POST /api/bolcom/sync/shipments
 */
router.post('/sync/shipments', async (req, res) => {
  try {
    const { getBolShipmentSync } = require('../../services/bol/BolShipmentSync');
    const shipmentSync = await getBolShipmentSync();
    const result = await shipmentSync.syncAll();

    res.json({
      success: result.success,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Confirm shipment for a single order
 * POST /api/bolcom/orders/:orderId/confirm-shipment
 */
router.post('/orders/:orderId/confirm-shipment', async (req, res) => {
  try {
    const { getBolShipmentSync } = require('../../services/bol/BolShipmentSync');
    const shipmentSync = await getBolShipmentSync();
    const result = await shipmentSync.confirmSingleOrder(req.params.orderId);

    res.json({
      success: result.success,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get shipment sync status
 * GET /api/bolcom/sync/shipments/status
 */
router.get('/sync/shipments/status', async (req, res) => {
  try {
    const { getBolShipmentSync } = require('../../services/bol/BolShipmentSync');
    const shipmentSync = await getBolShipmentSync();
    const status = shipmentSync.getStatus();

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// CANCELLATION ENDPOINTS
// ============================================

/**
 * Process all pending cancellation requests
 * POST /api/bolcom/cancellations/process
 */
router.post('/cancellations/process', async (req, res) => {
  try {
    const { getBolCancellationHandler } = require('../../services/bol/BolCancellationHandler');
    const handler = await getBolCancellationHandler();
    const result = await handler.processAllCancellations();

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Check cancellation status for a single order
 * GET /api/bolcom/orders/:orderId/cancellation-status
 */
router.get('/orders/:orderId/cancellation-status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { getBolCancellationHandler } = require('../../services/bol/BolCancellationHandler');

    const handler = await getBolCancellationHandler();
    const result = await handler.checkOrder(orderId);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get cancellation handler status
 * GET /api/bolcom/cancellations/status
 */
router.get('/cancellations/status', async (req, res) => {
  try {
    const { getBolCancellationHandler } = require('../../services/bol/BolCancellationHandler');
    const handler = await getBolCancellationHandler();
    const status = handler.getStatus();

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get orders with cancellation requests
 * GET /api/bolcom/cancellations/pending
 */
router.get('/cancellations/pending', async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    // Use unified_orders collection
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const ordersWithCancellation = await collection.find({
      channel: CHANNELS.BOL,
      'items.cancellationRequest': true,
      'status.source': { $nin: ['CANCELLED', 'SHIPPED'] }
    })
      .sort({ orderDate: -1 })
      .limit(parseInt(limit, 10))
      .project({
        'sourceIds.bolOrderId': 1,
        orderDate: 1,
        subChannel: 1,
        'totals.total': 1,
        items: 1,
        odoo: 1,
        'status.source': 1
      })
      .toArray();

    res.json({
      success: true,
      count: ordersWithCancellation.length,
      orders: ordersWithCancellation.map(o => ({
        orderId: o.sourceIds?.bolOrderId,
        orderPlacedDateTime: o.orderDate,
        fulfilmentMethod: o.subChannel,
        totalAmount: o.totals?.total,
        odooOrderId: o.odoo?.saleOrderId,
        odooOrderName: o.odoo?.saleOrderName,
        status: o.status?.source,
        itemsWithCancellation: o.items?.filter(i => i.cancellationRequest)?.length || 0
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// FULFILLMENT SWAP ENDPOINTS (FBB <-> FBR)
// ============================================

/**
 * Trigger FBB/FBR fulfillment swap check
 * Swaps offers based on stock availability:
 * - FBB with no stock + local stock available → swap to FBR
 * - FBR with FBB stock available → swap to FBB
 * POST /api/bolcom/fulfillment/swap
 */
router.post('/fulfillment/swap', async (req, res) => {
  try {
    const { getBolFulfillmentSwapper } = require('../../services/bol/BolFulfillmentSwapper');
    const swapper = getBolFulfillmentSwapper();
    const result = await swapper.run();

    res.json({
      success: result.success,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get fulfillment swap status
 * GET /api/bolcom/fulfillment/status
 */
router.get('/fulfillment/status', async (req, res) => {
  try {
    const { getBolFulfillmentSwapper } = require('../../services/bol/BolFulfillmentSwapper');
    const swapper = getBolFulfillmentSwapper();
    const status = swapper.getStatus();

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// FBB INVENTORY ENDPOINTS
// ============================================

/**
 * Get FBB (Fulfillment by Bol) inventory
 * GET /api/bolcom/fbb/inventory
 */
router.get('/fbb/inventory', async (req, res) => {
  try {
    const { limit = 500, minStock } = req.query;
    const { getBolFBBInventorySync } = require('../../services/bol/BolFBBInventorySync');

    const fbbSync = await getBolFBBInventorySync();
    const inventory = await fbbSync.getInventory({
      limit: parseInt(limit, 10),
      minStock: minStock ? parseInt(minStock, 10) : null
    });

    res.json({
      success: true,
      count: inventory.length,
      inventory
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync FBB inventory from Bol.com
 * POST /api/bolcom/fbb/sync
 */
router.post('/fbb/sync', async (req, res) => {
  try {
    const { getBolFBBInventorySync } = require('../../services/bol/BolFBBInventorySync');
    const fbbSync = await getBolFBBInventorySync();
    const result = await fbbSync.sync();

    res.json({
      success: result.success,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get FBB inventory stats
 * GET /api/bolcom/fbb/stats
 */
router.get('/fbb/stats', async (req, res) => {
  try {
    const { getBolFBBInventorySync } = require('../../services/bol/BolFBBInventorySync');
    const fbbSync = await getBolFBBInventorySync();
    const stats = await fbbSync.getStats();

    res.json({
      success: true,
      ...stats
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ADVERTISING API ENDPOINTS
// ============================================

/**
 * Get all advertising campaigns
 * Query params: state (ENABLED, PAUSED, ARCHIVED), campaignIds
 *
 * NOTE: In v11, listing uses PUT /campaigns with body {"campaigns": []}.
 * Returns HTTP 207 Multi-Status.
 * See: https://api.bol.com/advertiser/docs/redoc/sponsored-products/v11/campaign-management.html
 */
router.get('/advertising/campaigns', async (req, res) => {
  try {
    const { state, campaignIds } = req.query;

    // v11 API: PUT /campaigns with {"campaigns": []} for all, or {"campaigns": ["id1"]} for specific
    // NOTE: v11 doesn't support page/pageSize in the request body - returns all matching
    const requestBody = {
      campaigns: campaignIds
        ? (Array.isArray(campaignIds) ? campaignIds : [campaignIds])
        : []
    };

    // v11 uses PUT /campaigns with campaigns array body (returns 207)
    const data = await advertiserRequest('/campaigns', 'PUT', requestBody);

    // v11 returns campaigns as object { campaignId: {...} }, convert to array
    const campaignsObj = data.campaigns || {};
    let campaigns = Array.isArray(campaignsObj)
      ? campaignsObj
      : Object.values(campaignsObj);

    // Filter by state client-side if requested
    if (state) {
      campaigns = campaigns.filter(c => c.state === state);
    }

    res.json({
      success: true,
      count: campaigns.length,
      campaigns: campaigns.map(c => ({
        campaignId: c.campaignId,
        name: c.name,
        state: c.state,
        startDate: c.startDate,
        endDate: c.endDate,
        campaignType: c.campaignType,
        targetingType: c.targetingType,
        dailyBudget: c.dailyBudget,
        totalBudget: c.totalBudget,
        targetCountries: c.targetCountries,
        targetChannels: c.targetChannels,
        acosTargetPercentage: c.acosTargetPercentage,
        constraints: c.constraints
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single campaign details
 * NOTE: In v11, use PUT /campaigns with {"campaigns": ["campaignId"]}
 */
router.get('/advertising/campaigns/:campaignId', async (req, res) => {
  try {
    // v11 uses PUT /campaigns with campaign ID in array
    const data = await advertiserRequest('/campaigns', 'PUT', {
      campaigns: [req.params.campaignId]
    });

    // Response format: { campaigns: { campaignId: {...} } }
    const campaignsObj = data.campaigns || {};
    const campaign = campaignsObj[req.params.campaignId] || Object.values(campaignsObj)[0];
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    res.json({ success: true, campaign });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get ad groups for a campaign
 * NOTE: In v11, use PUT /adgroups with {"adGroups": []}
 */
router.get('/advertising/campaigns/:campaignId/ad-groups', async (req, res) => {
  try {
    // v11 uses PUT /adgroups with adGroups array body
    // Note: endpoint is /adgroups not /ad-groups
    const data = await advertiserRequest('/adgroups', 'PUT', {
      adGroups: []  // Empty array returns all ad groups
    });

    // Filter by campaignId client-side since v11 doesn't support filter in body
    const allAdGroups = data.adGroups || {};
    const adGroupsList = Object.values(allAdGroups).filter(
      ag => ag.campaignId === req.params.campaignId
    );

    res.json({
      success: true,
      count: adGroupsList.length,
      adGroups: adGroupsList.map(ag => ({
        adGroupId: ag.adGroupId,
        campaignId: ag.campaignId,
        name: ag.name,
        state: ag.state,
        defaultBid: ag.defaultBid
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get keywords for an ad group
 * NOTE: In v11, use PUT /keywords with {"keywords": []}
 */
router.get('/advertising/ad-groups/:adGroupId/keywords', async (req, res) => {
  try {
    // v11 uses PUT /keywords with keywords array body
    const data = await advertiserRequest('/keywords', 'PUT', {
      keywords: []  // Empty array returns all keywords
    });

    // Filter by adGroupId client-side since v11 doesn't support filter in body
    const allKeywords = data.keywords || {};
    const keywordsList = Object.values(allKeywords).filter(
      k => k.adGroupId === req.params.adGroupId
    );

    res.json({
      success: true,
      count: keywordsList.length,
      keywords: keywordsList.map(k => ({
        keywordId: k.keywordId,
        adGroupId: k.adGroupId,
        keywordText: k.keywordText,
        matchType: k.matchType,
        state: k.state,
        bid: k.bid
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get campaign performance report (costs, clicks, impressions, etc.)
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 */
router.get('/advertising/reports/campaigns', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate are required (format: YYYY-MM-DD)'
      });
    }

    // Request a campaign performance report
    const data = await advertiserRequest('/sponsored-products/reports/campaigns', 'POST', {
      startDate,
      endDate,
      metrics: ['impressions', 'clicks', 'ctr', 'spend', 'orders', 'revenue', 'acos', 'roas']
    });

    res.json({
      success: true,
      report: data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get daily advertising costs summary
 * Query params: startDate, endDate
 * NOTE: Reporting API likely still uses POST for requesting reports
 */
router.get('/advertising/costs', async (req, res) => {
  try {
    const { startDate, endDate, campaignId } = req.query;

    // Default to last 30 days if no dates provided
    const end = endDate || new Date().toISOString().split('T')[0];
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Build report request body
    const reportBody = {
      startDate: start,
      endDate: end,
      metrics: ['impressions', 'clicks', 'ctr', 'spend', 'orders', 'revenue', 'acos', 'roas']
    };

    if (campaignId) {
      reportBody.campaignIds = [campaignId];
    }

    // Request performance report via POST
    const data = await advertiserRequest('/sponsored-products/reports/performance', 'POST', reportBody);

    // Calculate totals
    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    let totalOrders = 0;
    let totalRevenue = 0;

    const dailyData = (data.performance || data.dailyPerformance || data.rows || []).map(d => {
      totalSpend += d.spend || 0;
      totalClicks += d.clicks || 0;
      totalImpressions += d.impressions || 0;
      totalOrders += d.orders || 0;
      totalRevenue += d.revenue || 0;

      return {
        date: d.date,
        spend: d.spend,
        clicks: d.clicks,
        impressions: d.impressions,
        ctr: d.ctr,
        orders: d.orders,
        revenue: d.revenue,
        acos: d.acos,
        roas: d.roas
      };
    });

    res.json({
      success: true,
      period: { startDate: start, endDate: end },
      totals: {
        spend: totalSpend,
        clicks: totalClicks,
        impressions: totalImpressions,
        orders: totalOrders,
        revenue: totalRevenue,
        acos: totalRevenue > 0 ? ((totalSpend / totalRevenue) * 100).toFixed(2) + '%' : 'N/A',
        roas: totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : 'N/A'
      },
      dailyData
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get product-level advertising performance
 */
router.get('/advertising/reports/products', async (req, res) => {
  try {
    const { startDate, endDate, campaignId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate are required (format: YYYY-MM-DD)'
      });
    }

    const body = {
      startDate,
      endDate,
      metrics: ['impressions', 'clicks', 'ctr', 'spend', 'orders', 'revenue', 'acos', 'roas']
    };

    if (campaignId) {
      body.campaignId = campaignId;
    }

    const data = await advertiserRequest('/sponsored-products/reports/products', 'POST', body);

    res.json({
      success: true,
      count: data.products?.length || 0,
      products: (data.products || []).map(p => ({
        ean: p.ean,
        productTitle: p.productTitle,
        impressions: p.impressions,
        clicks: p.clicks,
        ctr: p.ctr,
        spend: p.spend,
        orders: p.orders,
        revenue: p.revenue,
        acos: p.acos,
        roas: p.roas
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get keyword-level advertising performance
 */
router.get('/advertising/reports/keywords', async (req, res) => {
  try {
    const { startDate, endDate, campaignId, adGroupId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate are required (format: YYYY-MM-DD)'
      });
    }

    const body = {
      startDate,
      endDate,
      metrics: ['impressions', 'clicks', 'ctr', 'spend', 'orders', 'revenue', 'acos', 'roas']
    };

    if (campaignId) body.campaignId = campaignId;
    if (adGroupId) body.adGroupId = adGroupId;

    const data = await advertiserRequest('/sponsored-products/reports/keywords', 'POST', body);

    res.json({
      success: true,
      count: data.keywords?.length || 0,
      keywords: (data.keywords || []).map(k => ({
        keywordText: k.keywordText,
        matchType: k.matchType,
        impressions: k.impressions,
        clicks: k.clicks,
        ctr: k.ctr,
        spend: k.spend,
        orders: k.orders,
        revenue: k.revenue,
        acos: k.acos,
        roas: k.roas
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update campaign state (pause/activate)
 */
router.put('/advertising/campaigns/:campaignId/state', async (req, res) => {
  try {
    const { state } = req.body;

    if (!['ACTIVE', 'PAUSED'].includes(state)) {
      return res.status(400).json({
        success: false,
        error: 'state must be ACTIVE or PAUSED'
      });
    }

    const data = await advertiserRequest(`/sponsored-products/campaigns/${req.params.campaignId}`, 'PUT', {
      state
    });

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update campaign budget
 */
router.put('/advertising/campaigns/:campaignId/budget', async (req, res) => {
  try {
    const { dailyBudget, totalBudget } = req.body;

    if (!dailyBudget && !totalBudget) {
      return res.status(400).json({
        success: false,
        error: 'dailyBudget or totalBudget is required'
      });
    }

    const updateData = {};
    if (dailyBudget) updateData.dailyBudget = dailyBudget;
    if (totalBudget) updateData.totalBudget = totalBudget;

    const data = await advertiserRequest(`/sponsored-products/campaigns/${req.params.campaignId}`, 'PUT', updateData);

    res.json({ success: true, processStatus: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get advertising account overview
 * NOTE: In v11, uses PUT /campaigns with {"campaigns": []}
 */
router.get('/advertising/overview', async (req, res) => {
  try {
    // Get last 30 days performance summary
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Fetch campaigns using PUT /campaigns
    const [campaignsData, costsData] = await Promise.all([
      // v11: Use PUT /campaigns with empty campaigns array
      advertiserRequest('/campaigns', 'PUT', {
        campaigns: []
      }).catch(() => ({ campaigns: {} })),
      // v11: Reporting endpoint - may not work yet (returns 404)
      advertiserRequest('/reports/performance', 'POST', {
        startDate,
        endDate,
        metrics: ['impressions', 'clicks', 'spend', 'orders', 'revenue']
      }).catch(() => ({ rows: [] }))
    ]);

    // v11 returns campaigns as object { campaignId: {...} }, convert to array
    const campaignsObj = campaignsData.campaigns || {};
    const campaignsList = Array.isArray(campaignsObj)
      ? campaignsObj
      : Object.values(campaignsObj);
    const activeCampaigns = campaignsList.filter(c => c.state === 'ENABLED');

    // Calculate totals from performance data
    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    let totalOrders = 0;
    let totalRevenue = 0;

    (costsData.performance || costsData.dailyPerformance || costsData.rows || []).forEach(d => {
      totalSpend += d.spend || 0;
      totalClicks += d.clicks || 0;
      totalImpressions += d.impressions || 0;
      totalOrders += d.orders || 0;
      totalRevenue += d.revenue || 0;
    });

    res.json({
      success: true,
      overview: {
        activeCampaigns: activeCampaigns.length,
        totalCampaigns: campaignsList.length,
        last30Days: {
          spend: totalSpend.toFixed(2),
          clicks: totalClicks,
          impressions: totalImpressions,
          orders: totalOrders,
          revenue: totalRevenue.toFixed(2),
          acos: totalRevenue > 0 ? ((totalSpend / totalRevenue) * 100).toFixed(2) + '%' : 'N/A',
          roas: totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : 'N/A',
          ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + '%' : 'N/A'
        }
      },
      campaigns: activeCampaigns.slice(0, 10).map(c => ({
        campaignId: c.campaignId,
        name: c.name,
        state: c.state,
        campaignType: c.campaignType,
        dailyBudget: c.dailyBudget,
        totalBudget: c.totalBudget
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SYNC ENDPOINTS
// ============================================

/**
 * Get sync status - shows last sync times and record counts
 */
router.get('/sync/status', async (req, res) => {
  try {
    const status = await BolSyncService.getSyncStatus();
    res.json({
      success: true,
      status,
      ongoingSyncs
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Trigger manual sync - syncs last 30 days for all data types
 */
router.post('/sync/recent', async (req, res) => {
  try {
    const results = await BolSyncService.syncAll('RECENT');
    res.json({
      success: true,
      message: 'Recent sync complete (last 30 days)',
      results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Trigger extended sync - syncs last 6 months (for nightly job)
 */
router.post('/sync/extended', async (req, res) => {
  try {
    const results = await BolSyncService.syncAll('EXTENDED');
    res.json({
      success: true,
      message: 'Extended sync complete (last 6 months)',
      results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Trigger historical import - imports all data from 2024-01-01
 * This is a one-time operation and takes a while
 */
router.post('/sync/historical', async (req, res) => {
  try {
    // Return immediately and run in background
    res.json({
      success: true,
      message: 'Historical import started. This will take several minutes. Check /sync/status for progress.'
    });

    // Run in background
    BolSyncService.syncAll('HISTORICAL')
      .then(results => {
        console.log('[BolSync] Historical import complete:', results);
      })
      .catch(error => {
        console.error('[BolSync] Historical import failed:', error);
      });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync Bol orders with Odoo - link orders by searching multiple patterns
 * Only links existing orders, never creates new ones
 */
router.post('/sync/odoo', async (req, res) => {
  try {
    const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Use unified_orders collection
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    // Get all Bol orders that don't have Odoo info yet (or need refresh)
    const { refresh = false, limit = 500 } = req.body;
    const query = {
      channel: CHANNELS.BOL
    };
    if (!refresh) {
      query.$or = [
        { 'sourceIds.odooSaleOrderId': { $exists: false } },
        { 'sourceIds.odooSaleOrderId': null }
      ];
    }
    const bolOrders = await collection.find(query)
      .sort({ orderDate: -1 })
      .limit(limit)
      .toArray();

    if (bolOrders.length === 0) {
      return res.json({
        success: true,
        message: 'No orders to sync',
        synced: 0,
        notFound: 0
      });
    }

    console.log(`[Bol Odoo Sync] Linking ${bolOrders.length} orders...`);

    let synced = 0;
    let notFound = 0;
    const notFoundList = [];
    const errors = [];

    for (const bolOrder of bolOrders) {
      try {
        // Use unified schema fields
        const orderId = bolOrder.sourceIds?.bolOrderId;
        const fulfilmentMethod = bolOrder.subChannel || 'FBR';
        const prefix = fulfilmentMethod === 'FBB' ? 'FBB' : 'FBR';

        // Try multiple search patterns to find the order
        const searchPatterns = [
          [['client_order_ref', '=', `${prefix}${orderId}`]],      // FBB123 or FBR123
          [['client_order_ref', '=', orderId]],                     // Just orderId
          [['client_order_ref', 'ilike', `%${orderId}%`]],         // Contains orderId
          [['name', 'ilike', `%${orderId}%`]]                      // Name contains orderId
        ];

        let saleOrder = null;
        for (const pattern of searchPatterns) {
          const results = await odoo.searchRead('sale.order', pattern,
            ['id', 'name', 'invoice_ids', 'state', 'client_order_ref'],
            { limit: 1 }
          );
          if (results.length > 0) {
            saleOrder = results[0];
            break;
          }
        }

        if (!saleOrder) {
          notFound++;
          if (notFoundList.length < 20) {
            notFoundList.push(orderId);
          }
          continue;
        }

        const odooData = {
          saleOrderId: saleOrder.id,
          saleOrderName: saleOrder.name,
          linkedAt: new Date()
        };

        // Check if there are invoices
        if (saleOrder.invoice_ids && saleOrder.invoice_ids.length > 0) {
          const invoices = await odoo.searchRead('account.move', [
            ['id', 'in', saleOrder.invoice_ids],
            ['move_type', '=', 'out_invoice'],
            ['state', '=', 'posted']
          ], ['id', 'name'], { limit: 1 });

          if (invoices.length > 0) {
            odooData.invoiceId = invoices[0].id;
            odooData.invoiceName = invoices[0].name;
          }
        }

        // Update unified_orders collection
        await collection.updateOne(
          { unifiedOrderId: bolOrder.unifiedOrderId },
          {
            $set: {
              odoo: odooData,
              'sourceIds.odooSaleOrderId': saleOrder.id,
              'sourceIds.odooSaleOrderName': saleOrder.name,
              updatedAt: new Date()
            }
          }
        );
        synced++;

        if (synced % 50 === 0) {
          console.log(`[Bol Odoo Sync] Linked ${synced} orders...`);
        }

      } catch (err) {
        errors.push({ orderId: bolOrder.sourceIds?.bolOrderId, error: err.message });
      }

      // Small delay to avoid overwhelming Odoo
      await new Promise(r => setTimeout(r, 30));
    }

    console.log(`[Bol Odoo Sync] Complete: ${synced} linked, ${notFound} not found`);

    res.json({
      success: true,
      message: `Linked ${synced} orders with Odoo, ${notFound} not found`,
      synced,
      notFound,
      notFoundSample: notFoundList.length > 0 ? notFoundList : undefined,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync full invoice history from 2024-01-01 (one-time backfill)
 * This fetches all historical invoices in 30-day chunks to avoid rate limits
 * Only needed once - after that, regular sync fetches last 30 days only
 */
router.post('/sync/invoices-history', async (req, res) => {
  try {
    // Return immediately and run in background
    res.json({
      success: true,
      message: 'Invoice history import started. This will take several minutes. Check /sync/status for progress.'
    });

    // Run in background
    BolSyncService.syncInvoicesFullHistory()
      .then(result => {
        console.log('[BolSync] Invoice history import complete:', result);
      })
      .catch(error => {
        console.error('[BolSync] Invoice history import failed:', error);
      });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync specific data type only
 */
router.post('/sync/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { mode = 'RECENT' } = req.body;

    let result;
    switch (type) {
      case 'orders':
        result = await BolSyncService.syncOrders(mode);
        break;
      case 'shipments':
        result = await BolSyncService.syncShipments(mode);
        break;
      case 'returns':
        result = await BolSyncService.syncReturns(mode);
        break;
      case 'invoices':
        result = await BolSyncService.syncInvoices();
        break;
      default:
        return res.status(400).json({ success: false, error: `Unknown sync type: ${type}` });
    }

    res.json({
      success: true,
      type,
      mode,
      result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Invoice booking service
const BolInvoiceBooker = require('../../services/bol/BolInvoiceBooker');

/**
 * Book a single invoice to Odoo
 * POST /api/bolcom/invoices/:invoiceId/book
 */
router.post('/invoices/:invoiceId/book', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const result = await BolInvoiceBooker.bookInvoice(invoiceId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error(`[BolComAPI] Error booking invoice ${req.params.invoiceId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Book all unbooked invoices to Odoo
 * POST /api/bolcom/invoices/book-all
 */
router.post('/invoices/book-all', async (req, res) => {
  try {
    const result = await BolInvoiceBooker.bookAllUnbooked();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[BolComAPI] Error booking all invoices:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get invoices that need to be booked to Odoo
 * GET /api/bolcom/invoices/unbooked
 */
router.get('/invoices/unbooked', async (req, res) => {
  try {
    const unbooked = await BolInvoice.find({
      'odoo.billId': { $exists: false },
      totalAmountExclVat: { $gt: 0 }
    }).sort({ issueDate: -1 });

    res.json({
      success: true,
      count: unbooked.length,
      invoices: unbooked.map(inv => ({
        invoiceId: inv.invoiceId,
        issueDate: inv.issueDate,
        invoiceType: inv.invoiceType,
        totalAmountExclVat: inv.totalAmountExclVat,
        syncError: inv.odoo?.syncError
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
