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
 * - Base URL: https://api.bol.com/advertiser (NOT /retailer/)
 * - GET endpoints replaced with PUT filter endpoints for listing data
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

  // Advertising API uses /advertiser/ base URL (NOT /retailer/)
  const response = await fetch(`https://api.bol.com/advertiser${endpoint}`, options);

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
 * Get orders
 * Query params: page, fulfilment-method (FBR/FBB), status
 */
router.get('/orders', async (req, res) => {
  try {
    const { page = 1, fulfilmentMethod, status } = req.query;

    let endpoint = `/orders?page=${page}`;
    if (fulfilmentMethod) {
      endpoint += `&fulfilment-method=${fulfilmentMethod}`;
    }
    if (status) {
      endpoint += `&status=${status}`;
    }

    const data = await bolRequest(endpoint);

    res.json({
      success: true,
      count: data.orders?.length || 0,
      orders: (data.orders || []).map(o => ({
        orderId: o.orderId,
        orderPlacedDateTime: o.orderPlacedDateTime,
        shipmentMethod: o.shipmentDetails?.shipmentMethod,
        pickupPoint: o.shipmentDetails?.pickupPointName,
        orderItems: (o.orderItems || []).map(item => ({
          orderItemId: item.orderItemId,
          ean: item.ean,
          title: item.product?.title,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          commission: item.commission,
          fulfilmentMethod: item.fulfilmentMethod,
          fulfilmentStatus: item.fulfilmentStatus,
          cancellationRequest: item.cancellationRequest
        }))
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single order details
 */
router.get('/orders/:orderId', async (req, res) => {
  try {
    const data = await bolRequest(`/orders/${req.params.orderId}`);

    res.json({
      success: true,
      order: {
        orderId: data.orderId,
        orderPlacedDateTime: data.orderPlacedDateTime,
        shipmentMethod: data.shipmentDetails?.shipmentMethod,
        pickupPoint: data.shipmentDetails?.pickupPointName,
        billingDetails: data.billingDetails,
        shipmentDetails: data.shipmentDetails,
        orderItems: (data.orderItems || []).map(item => ({
          orderItemId: item.orderItemId,
          ean: item.ean,
          title: item.product?.title,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          commission: item.commission,
          fulfilmentMethod: item.fulfilmentMethod,
          fulfilmentStatus: item.fulfilmentStatus,
          latestDeliveryDate: item.latestDeliveryDate,
          cancellationRequest: item.cancellationRequest
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get shipments
 */
router.get('/shipments', async (req, res) => {
  try {
    const { page = 1, fulfilmentMethod, orderId } = req.query;

    let endpoint = `/shipments?page=${page}`;
    if (fulfilmentMethod) {
      endpoint += `&fulfilment-method=${fulfilmentMethod}`;
    }
    if (orderId) {
      endpoint += `&order-id=${orderId}`;
    }

    const data = await bolRequest(endpoint);

    res.json({
      success: true,
      count: data.shipments?.length || 0,
      shipments: (data.shipments || []).map(s => ({
        shipmentId: s.shipmentId,
        shipmentDateTime: s.shipmentDateTime,
        shipmentReference: s.shipmentReference,
        transport: s.transport,
        orderItems: s.shipmentItems?.map(item => ({
          orderItemId: item.orderItemId,
          orderId: item.orderId
        }))
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single shipment details
 */
router.get('/shipments/:shipmentId', async (req, res) => {
  try {
    const data = await bolRequest(`/shipments/${req.params.shipmentId}`);
    res.json({ success: true, shipment: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get returns
 */
router.get('/returns', async (req, res) => {
  try {
    const { page = 1, handled, fulfilmentMethod } = req.query;

    let endpoint = `/returns?page=${page}`;
    if (handled !== undefined) {
      endpoint += `&handled=${handled}`;
    }
    if (fulfilmentMethod) {
      endpoint += `&fulfilment-method=${fulfilmentMethod}`;
    }

    const data = await bolRequest(endpoint);

    res.json({
      success: true,
      count: data.returns?.length || 0,
      returns: (data.returns || []).map(r => ({
        returnId: r.returnId,
        registrationDateTime: r.registrationDateTime,
        fulfilmentMethod: r.fulfilmentMethod,
        handled: r.handled,
        returnItems: (r.returnItems || []).map(item => ({
          rmaId: item.rmaId,
          orderId: item.orderId,
          ean: item.ean,
          title: item.title,
          quantity: item.quantity,
          returnReason: item.returnReason?.mainReason,
          returnReasonComments: item.returnReason?.customerComments,
          handlingResult: item.handlingResult
        }))
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
 * Get invoices
 */
router.get('/invoices', async (req, res) => {
  try {
    const { periodStartDate, periodEndDate } = req.query;

    let endpoint = '/invoices';
    if (periodStartDate) {
      endpoint += `?period-start-date=${periodStartDate}`;
      if (periodEndDate) {
        endpoint += `&period-end-date=${periodEndDate}`;
      }
    }

    const data = await bolRequest(endpoint);

    res.json({
      success: true,
      count: data.invoiceListItems?.length || 0,
      invoices: (data.invoiceListItems || []).map(inv => ({
        invoiceId: inv.invoiceId,
        issueDate: inv.issueDate,
        periodStartDate: inv.periodStartDate,
        periodEndDate: inv.periodEndDate,
        totalAmountExclVat: inv.invoiceTotals?.totalAmountExclVat,
        totalAmountInclVat: inv.invoiceTotals?.totalAmountInclVat
      }))
    });
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
 * NOTE: In v11, GET endpoints are replaced with PUT filter endpoints.
 * Use PUT /sponsored-products/campaigns with filter body to list campaigns.
 */
router.get('/advertising/campaigns', async (req, res) => {
  try {
    const { state, page = 1, pageSize = 50, campaignIds } = req.query;

    // Build filter body for PUT request (v11 style)
    const filterBody = {
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(pageSize, 10) || 50, 50) // Max 50 per page
    };

    // Add campaign IDs filter if provided
    if (campaignIds) {
      filterBody.campaignIds = Array.isArray(campaignIds) ? campaignIds : [campaignIds];
    }

    // v11 uses PUT with filter body to list campaigns (NOT GET)
    const data = await advertiserRequest('/sponsored-products/campaigns', 'PUT', filterBody);

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
 * NOTE: In v11, use PUT /campaigns with campaignIds filter to get specific campaigns
 */
router.get('/advertising/campaigns/:campaignId', async (req, res) => {
  try {
    // v11 uses PUT with filter to get specific campaign
    const data = await advertiserRequest('/sponsored-products/campaigns', 'PUT', {
      campaignIds: [req.params.campaignId],
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
 * NOTE: In v11, use PUT /ad-groups with filter body
 */
router.get('/advertising/campaigns/:campaignId/ad-groups', async (req, res) => {
  try {
    const { page = 1, pageSize = 50 } = req.query;

    // v11 uses PUT with filter body to list ad groups
    const data = await advertiserRequest('/sponsored-products/ad-groups', 'PUT', {
      campaignIds: [req.params.campaignId],
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(pageSize, 10) || 50, 50)
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
 * NOTE: In v11, use PUT /keywords with filter body
 */
router.get('/advertising/ad-groups/:adGroupId/keywords', async (req, res) => {
  try {
    const { page = 1, pageSize = 50 } = req.query;

    // v11 uses PUT with filter body to list keywords
    const data = await advertiserRequest('/sponsored-products/keywords', 'PUT', {
      adGroupIds: [req.params.adGroupId],
      page: parseInt(page, 10),
      pageSize: Math.min(parseInt(pageSize, 10) || 50, 50)
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
 * NOTE: In v11, uses PUT for listing campaigns and POST for reports
 */
router.get('/advertising/overview', async (req, res) => {
  try {
    // Get last 30 days performance summary
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Fetch campaigns (PUT with filter) and costs (POST report) in parallel
    const [campaignsData, costsData] = await Promise.all([
      // v11: Use PUT with filter body to list campaigns
      advertiserRequest('/sponsored-products/campaigns', 'PUT', {
        page: 1,
        pageSize: 50
      }).catch(() => ({ campaigns: [] })),
      // v11: Use POST to request performance report
      advertiserRequest('/sponsored-products/reports/performance', 'POST', {
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

module.exports = router;
