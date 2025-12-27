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

// MongoDB models
const BolOrder = require('../../models/BolOrder');
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
 * IMPORTANT: As of v11, the Advertising API uses:
 * - Base URL: https://api.bol.com/advertiser/sponsored-products/campaign-management
 * - Listing endpoints use POST with /list suffix (e.g., POST /campaigns/list)
 * - Create endpoints use POST (e.g., POST /campaigns)
 * - Update endpoints use PUT (e.g., PUT /campaigns)
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

    // Build query for MongoDB
    const query = {
      orderPlacedDateTime: { $gte: new Date('2024-01-01') }
    };

    if (fulfilmentMethod) {
      query.fulfilmentMethod = fulfilmentMethod;
    }
    if (status) {
      query.status = status.toUpperCase();
    }

    // Fetch from MongoDB
    const orders = await BolOrder.find(query)
      .sort({ orderPlacedDateTime: -1 })
      .lean();

    res.json({
      success: true,
      count: orders.length,
      source: 'mongodb',
      orders: orders.map(o => ({
        orderId: o.orderId,
        orderPlacedDateTime: o.orderPlacedDateTime,
        shipmentMethod: o.shipmentMethod,
        pickupPoint: o.pickupPoint,
        orderItems: o.orderItems,
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
    // Try to get from MongoDB first
    let order = await BolOrder.findOne({ orderId: req.params.orderId }).lean();

    // If not in MongoDB, fetch from API and store
    if (!order) {
      const data = await bolRequest(`/orders/${req.params.orderId}`);

      // Store in MongoDB for future requests
      const items = (data.orderItems || []).map(item => ({
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

      order = {
        orderId: data.orderId,
        orderPlacedDateTime: data.orderPlacedDateTime,
        shipmentMethod: data.shipmentDetails?.shipmentMethod,
        pickupPoint: data.shipmentDetails?.pickupPointName,
        shipmentDetails: data.shipmentDetails,
        billingDetails: data.billingDetails,
        orderItems: items
      };

      // Save to MongoDB (fire and forget)
      BolOrder.findOneAndUpdate(
        { orderId: data.orderId },
        { ...order, syncedAt: new Date(), rawResponse: data },
        { upsert: true }
      ).catch(err => console.error('[BolAPI] Failed to cache order:', err.message));
    }

    res.json({
      success: true,
      order: {
        orderId: order.orderId,
        orderPlacedDateTime: order.orderPlacedDateTime,
        shipmentMethod: order.shipmentMethod,
        pickupPoint: order.pickupPoint,
        billingDetails: order.billingDetails,
        shipmentDetails: order.shipmentDetails,
        orderItems: order.orderItems
      }
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
        shipmentItems: s.shipmentItems
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
    const { page = 1 } = req.query;

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
 */
router.get('/invoices/:invoiceId/download', async (req, res) => {
  try {
    const token = await getRetailerAccessToken();

    // Try to get the invoice PDF directly
    const pdfResponse = await fetch(`https://api.bol.com/retailer/invoices/${req.params.invoiceId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+pdf',
        'Authorization': `Bearer ${token}`
      }
    });

    if (pdfResponse.ok) {
      // Stream the PDF response
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="bol-invoice-${req.params.invoiceId}.pdf"`);
      const buffer = await pdfResponse.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

    // PDF not available - return error with helpful message
    res.status(404).json({
      success: false,
      error: 'Invoice PDF not available via API. Please download from the Bol.com Partner Portal.',
      partnerPortalUrl: 'https://partner.bol.com/sdd/orders/invoices'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Download invoice specification (Excel)
 */
router.get('/invoices/:invoiceId/specification', async (req, res) => {
  try {
    const token = await getRetailerAccessToken();
    const { format = 'excel' } = req.query;

    let acceptHeader;
    let filename;
    let contentType;

    if (format === 'json') {
      acceptHeader = 'application/vnd.retailer.v10+json';
      filename = `bol-invoice-spec-${req.params.invoiceId}.json`;
      contentType = 'application/json';
    } else {
      // Default to Excel format
      acceptHeader = 'application/vnd.retailer.v10+openxmlformats-officedocument.spreadsheetml.sheet';
      filename = `bol-invoice-spec-${req.params.invoiceId}.xlsx`;
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    const specResponse = await fetch(`https://api.bol.com/retailer/invoices/${req.params.invoiceId}/specification`, {
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

    // Stream the Excel file
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
// ADVERTISING API ENDPOINTS
// ============================================

/**
 * Get all advertising campaigns
 * Query params: state (ENABLED, PAUSED, ARCHIVED), page, pageSize
 *
 * NOTE: In v11, listing uses POST /campaigns/list with filter body.
 * See: https://api.bol.com/advertiser/docs/redoc/sponsored-products/v11/campaign-management.html
 */
router.get('/advertising/campaigns', async (req, res) => {
  try {
    const { state, page = 1, pageSize = 50, campaignIds } = req.query;

    // Build filter body for POST /campaigns/list request (v11 style)
    const filterBody = {
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(pageSize, 10) || 50, 100) // Max 100 per page
    };

    // Add filter if campaign IDs or states provided
    if (campaignIds || state) {
      filterBody.filter = {};
      if (campaignIds) {
        filterBody.filter.campaignIds = Array.isArray(campaignIds) ? campaignIds : [campaignIds];
      }
      if (state) {
        filterBody.filter.states = Array.isArray(state) ? state : [state];
      }
    }

    // v11 uses POST /campaigns/list with filter body
    const data = await advertiserRequest('/campaigns/list', 'POST', filterBody);

    // Filter by state client-side if requested (API may not support state filter in PUT)
    let campaigns = data.campaigns || [];
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
 * NOTE: In v11, use POST /campaigns/list with campaignIds filter to get specific campaigns
 */
router.get('/advertising/campaigns/:campaignId', async (req, res) => {
  try {
    // v11 uses POST /campaigns/list with filter to get specific campaign
    const data = await advertiserRequest('/campaigns/list', 'POST', {
      filter: {
        campaignIds: [req.params.campaignId]
      },
      page: 1,
      pageSize: 1
    });

    const campaign = data.campaigns?.[0];
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
 * NOTE: In v11, use POST /ad-groups/list with filter body
 */
router.get('/advertising/campaigns/:campaignId/ad-groups', async (req, res) => {
  try {
    const { page = 1, pageSize = 50 } = req.query;

    // v11 uses POST /ad-groups/list with filter body
    const data = await advertiserRequest('/ad-groups/list', 'POST', {
      filter: {
        campaignIds: [req.params.campaignId]
      },
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(pageSize, 10) || 50, 100)
    });

    res.json({
      success: true,
      count: data.adGroups?.length || 0,
      adGroups: (data.adGroups || []).map(ag => ({
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
 * NOTE: In v11, use POST /keywords/list with filter body
 */
router.get('/advertising/ad-groups/:adGroupId/keywords', async (req, res) => {
  try {
    const { page = 1, pageSize = 50 } = req.query;

    // v11 uses POST /keywords/list with filter body
    const data = await advertiserRequest('/keywords/list', 'POST', {
      filter: {
        adGroupIds: [req.params.adGroupId]
      },
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(pageSize, 10) || 50, 100)
    });

    res.json({
      success: true,
      count: data.keywords?.length || 0,
      keywords: (data.keywords || []).map(k => ({
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
 * NOTE: In v11, uses POST /campaigns/list for listing campaigns
 */
router.get('/advertising/overview', async (req, res) => {
  try {
    // Get last 30 days performance summary
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Fetch campaigns using POST /campaigns/list
    const [campaignsData, costsData] = await Promise.all([
      // v11: Use POST /campaigns/list with filter body
      advertiserRequest('/campaigns/list', 'POST', {
        page: 1,
        pageSize: 50
      }).catch(() => ({ campaigns: [] })),
      // v11: Use POST to request performance report (endpoint TBD)
      advertiserRequest('/reports/performance', 'POST', {
        startDate,
        endDate,
        metrics: ['impressions', 'clicks', 'spend', 'orders', 'revenue']
      }).catch(() => ({ rows: [] }))
    ]);

    // Filter to only ENABLED campaigns
    const activeCampaigns = (campaignsData.campaigns || []).filter(c => c.state === 'ENABLED');

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
        totalCampaigns: campaignsData.campaigns?.length || 0,
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
 * Sync Bol orders with Odoo - link orders and check invoice status
 * Looks up orders in Odoo by client_order_ref and updates MongoDB with Odoo IDs
 */
router.post('/sync/odoo', async (req, res) => {
  try {
    const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Get all Bol orders that don't have Odoo info yet (or need refresh)
    const { refresh = false } = req.body;
    const query = refresh ? {} : { 'odoo.saleOrderId': { $exists: false } };
    const bolOrders = await BolOrder.find(query)
      .sort({ orderPlacedDateTime: -1 })
      .limit(500)
      .lean();

    if (bolOrders.length === 0) {
      return res.json({
        success: true,
        message: 'No orders to sync',
        synced: 0,
        notFound: 0
      });
    }

    let synced = 0;
    let notFound = 0;
    const errors = [];

    for (const bolOrder of bolOrders) {
      try {
        // Search for sale order in Odoo by client_order_ref (Bol order ID)
        // Emipro typically stores the Bol order ID in client_order_ref
        const saleOrders = await odoo.searchRead('sale.order', [
          ['client_order_ref', '=', bolOrder.orderId]
        ], ['id', 'name', 'invoice_ids', 'state'], { limit: 1 });

        if (saleOrders.length === 0) {
          notFound++;
          continue;
        }

        const saleOrder = saleOrders[0];
        const odooData = {
          saleOrderId: saleOrder.id,
          saleOrderName: saleOrder.name,
          linkedAt: new Date()
        };

        // Check if there are invoices
        if (saleOrder.invoice_ids && saleOrder.invoice_ids.length > 0) {
          // Get the first invoice details
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

        // Update MongoDB
        await BolOrder.updateOne(
          { orderId: bolOrder.orderId },
          { $set: { odoo: odooData } }
        );
        synced++;

      } catch (err) {
        errors.push({ orderId: bolOrder.orderId, error: err.message });
      }

      // Small delay to avoid overwhelming Odoo
      await new Promise(r => setTimeout(r, 50));
    }

    res.json({
      success: true,
      message: `Synced ${synced} orders with Odoo`,
      synced,
      notFound,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined
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

module.exports = router;
