/**
 * Bol.com Retailer API Routes
 *
 * Integration with Bol.com marketplace for orders, offers, shipments, and returns.
 * Uses OAuth2 client credentials flow for authentication.
 *
 * API Documentation: https://api.bol.com/retailer/public/Retailer-API/
 */

const express = require('express');
const router = express.Router();

// Token cache
let accessToken = null;
let tokenExpiry = null;

/**
 * Get access token using client credentials flow
 */
async function getAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Bol.com credentials not configured. Set BOL_CLIENT_ID and BOL_CLIENT_SECRET in .env');
  }

  // Check if we have a valid cached token (with 30 second buffer)
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
    return accessToken;
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
    throw new Error(`Failed to get Bol.com access token: ${error}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  return accessToken;
}

/**
 * Make a request to Bol.com Retailer API
 */
async function bolRequest(endpoint, method = 'GET', body = null) {
  const token = await getAccessToken();

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
        error: 'Environment variables not set'
      });
    }

    // Try to get a token to verify credentials
    await getAccessToken();

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
 * Clear token cache
 */
router.post('/clear-token', async (req, res) => {
  accessToken = null;
  tokenExpiry = null;
  res.json({ success: true, message: 'Token cache cleared' });
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

module.exports = router;
