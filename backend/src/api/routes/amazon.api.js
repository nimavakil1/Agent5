/**
 * Amazon Integration API Routes
 *
 * Webhook endpoints for Make.com (or similar) to push Amazon Seller Central data.
 * This allows integration without requiring SP-API developer approval.
 *
 * Flow: Amazon → Make.com (approved SP-API app) → Agent5 webhooks
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../../db');
const { ObjectId } = require('mongodb');

// Webhook secret for validating requests from Make.com
const WEBHOOK_SECRET = process.env.AMAZON_WEBHOOK_SECRET || 'change-me-in-production';

/**
 * Middleware to validate webhook requests
 */
function validateWebhook(req, res, next) {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  // Skip validation in development or if no secret configured
  if (process.env.NODE_ENV === 'development' || WEBHOOK_SECRET === 'change-me-in-production') {
    return next();
  }

  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Validate timestamp is within 5 minutes
  const now = Date.now();
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Webhook timestamp expired' });
  }

  // Validate signature
  const payload = JSON.stringify(req.body) + timestamp;
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  next();
}

// ==================== ORDER WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/orders
 * @desc Receive new/updated orders from Make.com
 */
router.post('/webhook/orders', validateWebhook, async (req, res) => {
  try {
    const orders = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const order of orders) {
      if (!order.AmazonOrderId) {
        results.push({ error: 'Missing AmazonOrderId', order });
        continue;
      }

      const doc = {
        amazonOrderId: order.AmazonOrderId,
        sellerOrderId: order.SellerOrderId,
        purchaseDate: order.PurchaseDate ? new Date(order.PurchaseDate) : null,
        lastUpdateDate: order.LastUpdateDate ? new Date(order.LastUpdateDate) : null,
        orderStatus: order.OrderStatus,
        fulfillmentChannel: order.FulfillmentChannel,
        salesChannel: order.SalesChannel,
        shipServiceLevel: order.ShipServiceLevel,
        orderTotal: order.OrderTotal,
        numberOfItemsShipped: order.NumberOfItemsShipped,
        numberOfItemsUnshipped: order.NumberOfItemsUnshipped,
        paymentMethod: order.PaymentMethod,
        marketplaceId: order.MarketplaceId,
        buyerEmail: order.BuyerEmail,
        buyerName: order.BuyerName,
        shippingAddress: order.ShippingAddress,
        orderItems: order.OrderItems || [],
        rawData: order,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_orders').updateOne(
        { amazonOrderId: order.AmazonOrderId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ amazonOrderId: order.AmazonOrderId, status: 'saved' });
    }

    // Emit event for real-time updates
    if (req.app.get('platform')) {
      req.app.get('platform').emit('amazon:orders', { count: results.length });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon orders webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/order-items
 * @desc Receive order items details from Make.com
 * Accepts either: {amazonOrderId, items: [...]} OR {amazonOrderId, item: {...}} for single items
 */
router.post('/webhook/order-items', validateWebhook, async (req, res) => {
  try {
    const { amazonOrderId, items, ...singleItem } = req.body;

    // Check if this is a single item (all fields at root level with amazonOrderId)
    const isSingleItem = amazonOrderId && !items && Object.keys(singleItem).length > 0;

    if (!amazonOrderId) {
      return res.status(400).json({ error: 'amazonOrderId required' });
    }

    const db = getDb();

    if (isSingleItem) {
      // Single item mode - push to orderItems array
      await db.collection('amazon_orders').updateOne(
        { amazonOrderId },
        {
          $push: { orderItems: singleItem },
          $set: { updatedAt: new Date() }
        }
      );
      res.json({ success: true, amazonOrderId, mode: 'single-item' });
    } else if (items) {
      // Batch mode - replace entire orderItems array
      await db.collection('amazon_orders').updateOne(
        { amazonOrderId },
        { $set: { orderItems: items, updatedAt: new Date() } }
      );
      res.json({ success: true, amazonOrderId, itemCount: items.length });
    } else {
      return res.status(400).json({ error: 'items array or item fields required' });
    }
  } catch (error) {
    console.error('Amazon order-items webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INVENTORY WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/inventory
 * @desc Receive inventory data from Make.com
 */
router.post('/webhook/inventory', validateWebhook, async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const item of items) {
      const sku = item.sellerSku || item.sku || item.SKU;
      if (!sku) {
        results.push({ error: 'Missing SKU', item });
        continue;
      }

      const doc = {
        sellerSku: sku,
        asin: item.asin || item.ASIN,
        fnSku: item.fnSku || item.FNSKU,
        productName: item.productName || item.title,
        condition: item.condition,
        totalQuantity: item.totalQuantity ?? item.quantity ?? 0,
        inboundWorkingQuantity: item.inboundWorkingQuantity ?? 0,
        inboundShippedQuantity: item.inboundShippedQuantity ?? 0,
        inboundReceivingQuantity: item.inboundReceivingQuantity ?? 0,
        fulfillableQuantity: item.fulfillableQuantity ?? item.totalQuantity ?? 0,
        reservedQuantity: item.reservedQuantity ?? 0,
        unfulfillableQuantity: item.unfulfillableQuantity ?? 0,
        marketplaceId: item.marketplaceId,
        rawData: item,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_inventory').updateOne(
        { sellerSku: sku },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ sellerSku: sku, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon inventory webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FINANCIAL WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/settlements
 * @desc Receive settlement report data from Make.com
 */
router.post('/webhook/settlements', validateWebhook, async (req, res) => {
  try {
    const settlement = req.body;
    const db = getDb();

    if (!settlement.settlementId) {
      return res.status(400).json({ error: 'settlementId required' });
    }

    const doc = {
      settlementId: settlement.settlementId,
      settlementStartDate: settlement.settlementStartDate ? new Date(settlement.settlementStartDate) : null,
      settlementEndDate: settlement.settlementEndDate ? new Date(settlement.settlementEndDate) : null,
      depositDate: settlement.depositDate ? new Date(settlement.depositDate) : null,
      totalAmount: settlement.totalAmount,
      currency: settlement.currency,
      marketplaceId: settlement.marketplaceId,
      transactions: settlement.transactions || [],
      summary: settlement.summary || {},
      rawData: settlement,
      source: 'make.com',
      updatedAt: new Date(),
    };

    await db.collection('amazon_settlements').updateOne(
      { settlementId: settlement.settlementId },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    res.json({ success: true, settlementId: settlement.settlementId });
  } catch (error) {
    console.error('Amazon settlements webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/financial-events
 * @desc Receive financial events from Make.com
 */
router.post('/webhook/financial-events', validateWebhook, async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const event of events) {
      const doc = {
        eventType: event.eventType || event.type,
        eventDate: event.eventDate ? new Date(event.eventDate) : new Date(),
        amazonOrderId: event.amazonOrderId,
        sellerOrderId: event.sellerOrderId,
        marketplaceId: event.marketplaceId,
        amount: event.amount,
        currency: event.currency,
        description: event.description,
        rawData: event,
        source: 'make.com',
        createdAt: new Date(),
      };

      const result = await db.collection('amazon_financial_events').insertOne(doc);
      results.push({ _id: result.insertedId, eventType: doc.eventType });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon financial-events webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/fba-fees
 * @desc Receive FBA fee data from Make.com
 */
router.post('/webhook/fba-fees', validateWebhook, async (req, res) => {
  try {
    const fees = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const fee of fees) {
      const sku = fee.sellerSku || fee.sku;
      if (!sku) {
        results.push({ error: 'Missing SKU', fee });
        continue;
      }

      const doc = {
        sellerSku: sku,
        asin: fee.asin,
        feeType: fee.feeType,
        feeAmount: fee.feeAmount,
        currency: fee.currency,
        period: fee.period,
        periodStart: fee.periodStart ? new Date(fee.periodStart) : null,
        periodEnd: fee.periodEnd ? new Date(fee.periodEnd) : null,
        rawData: fee,
        source: 'make.com',
        createdAt: new Date(),
      };

      const result = await db.collection('amazon_fba_fees').insertOne(doc);
      results.push({ _id: result.insertedId, sellerSku: sku, feeType: doc.feeType });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon fba-fees webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADVERTISING WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/ads/campaigns
 * @desc Receive advertising campaign data
 */
router.post('/webhook/ads/campaigns', validateWebhook, async (req, res) => {
  try {
    const campaigns = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const campaign of campaigns) {
      const doc = {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName || campaign.name,
        campaignType: campaign.campaignType || campaign.type, // SP, SB, SD
        state: campaign.state || campaign.status,
        dailyBudget: campaign.dailyBudget || campaign.budget,
        startDate: campaign.startDate ? new Date(campaign.startDate) : null,
        endDate: campaign.endDate ? new Date(campaign.endDate) : null,
        targetingType: campaign.targetingType,
        premiumBidAdjustment: campaign.premiumBidAdjustment,
        biddingStrategy: campaign.biddingStrategy,
        rawData: campaign,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_ads_campaigns').updateOne(
        { campaignId: campaign.campaignId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ campaignId: campaign.campaignId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads campaigns webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/ads/performance
 * @desc Receive advertising performance/metrics data
 */
router.post('/webhook/ads/performance', validateWebhook, async (req, res) => {
  try {
    const metrics = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const metric of metrics) {
      const doc = {
        campaignId: metric.campaignId,
        adGroupId: metric.adGroupId,
        date: metric.date ? new Date(metric.date) : new Date(),
        impressions: metric.impressions || 0,
        clicks: metric.clicks || 0,
        cost: metric.cost || metric.spend || 0,
        sales: metric.sales || metric.attributedSales || 0,
        orders: metric.orders || metric.attributedUnitsOrdered || 0,
        acos: metric.acos || (metric.cost && metric.sales ? (metric.cost / metric.sales * 100) : 0),
        roas: metric.roas || (metric.cost && metric.sales ? (metric.sales / metric.cost) : 0),
        ctr: metric.ctr || (metric.impressions ? (metric.clicks / metric.impressions * 100) : 0),
        cpc: metric.cpc || (metric.clicks ? (metric.cost / metric.clicks) : 0),
        conversionRate: metric.conversionRate || (metric.clicks ? (metric.orders / metric.clicks * 100) : 0),
        currency: metric.currency || 'EUR',
        rawData: metric,
        source: 'make.com',
        createdAt: new Date(),
      };

      const result = await db.collection('amazon_ads_performance').insertOne(doc);
      results.push({ _id: result.insertedId, campaignId: doc.campaignId, date: doc.date });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads performance webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/ads/keywords
 * @desc Receive keyword performance data
 */
router.post('/webhook/ads/keywords', validateWebhook, async (req, res) => {
  try {
    const keywords = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const kw of keywords) {
      const doc = {
        keywordId: kw.keywordId,
        campaignId: kw.campaignId,
        adGroupId: kw.adGroupId,
        keywordText: kw.keywordText || kw.keyword,
        matchType: kw.matchType,
        state: kw.state || kw.status,
        bid: kw.bid,
        impressions: kw.impressions || 0,
        clicks: kw.clicks || 0,
        cost: kw.cost || kw.spend || 0,
        sales: kw.sales || 0,
        orders: kw.orders || 0,
        acos: kw.acos || 0,
        date: kw.date ? new Date(kw.date) : new Date(),
        rawData: kw,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_ads_keywords').updateOne(
        { keywordId: kw.keywordId, date: doc.date },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ keywordId: kw.keywordId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads keywords webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/ads/products
 * @desc Receive advertised product performance data
 */
router.post('/webhook/ads/products', validateWebhook, async (req, res) => {
  try {
    const products = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const prod of products) {
      const doc = {
        asin: prod.asin,
        sku: prod.sku,
        campaignId: prod.campaignId,
        adGroupId: prod.adGroupId,
        impressions: prod.impressions || 0,
        clicks: prod.clicks || 0,
        cost: prod.cost || prod.spend || 0,
        sales: prod.sales || 0,
        orders: prod.orders || 0,
        acos: prod.acos || 0,
        date: prod.date ? new Date(prod.date) : new Date(),
        rawData: prod,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_ads_products').updateOne(
        { asin: prod.asin, campaignId: prod.campaignId, date: doc.date },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ asin: prod.asin, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads products webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== RETURNS WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/returns
 * @desc Receive return data from Make.com
 */
router.post('/webhook/returns', validateWebhook, async (req, res) => {
  try {
    const returns = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const ret of returns) {
      const doc = {
        returnId: ret.returnId || ret.rmaId,
        amazonOrderId: ret.amazonOrderId || ret.orderId,
        sellerSku: ret.sellerSku || ret.sku,
        asin: ret.asin,
        returnRequestDate: ret.returnRequestDate ? new Date(ret.returnRequestDate) : null,
        returnReceivedDate: ret.returnReceivedDate ? new Date(ret.returnReceivedDate) : null,
        returnQuantity: ret.returnQuantity || ret.quantity || 1,
        returnReason: ret.returnReason || ret.reason,
        returnReasonCode: ret.returnReasonCode || ret.reasonCode,
        status: ret.status,
        resolution: ret.resolution,
        refundAmount: ret.refundAmount,
        currency: ret.currency,
        rawData: ret,
        source: 'make.com',
        updatedAt: new Date(),
      };

      const filter = doc.returnId
        ? { returnId: doc.returnId }
        : { amazonOrderId: doc.amazonOrderId, sellerSku: doc.sellerSku };

      await db.collection('amazon_returns').updateOne(
        filter,
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ returnId: doc.returnId, amazonOrderId: doc.amazonOrderId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon returns webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== VAT / INVOICES WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/vat-invoices
 * @desc Receive VAT invoice data from Make.com (VCS reports)
 */
router.post('/webhook/vat-invoices', validateWebhook, async (req, res) => {
  try {
    const invoices = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const invoice of invoices) {
      const doc = {
        invoiceNumber: invoice.invoiceNumber,
        amazonOrderId: invoice.amazonOrderId || invoice.orderId,
        shipmentId: invoice.shipmentId,
        invoiceDate: invoice.invoiceDate ? new Date(invoice.invoiceDate) : null,
        buyerVatNumber: invoice.buyerVatNumber,
        sellerVatNumber: invoice.sellerVatNumber,
        netAmount: invoice.netAmount,
        vatAmount: invoice.vatAmount,
        totalAmount: invoice.totalAmount,
        vatRate: invoice.vatRate,
        currency: invoice.currency,
        countryCode: invoice.countryCode,
        invoiceUrl: invoice.invoiceUrl,
        rawData: invoice,
        source: 'make.com',
        updatedAt: new Date(),
      };

      const filter = doc.invoiceNumber
        ? { invoiceNumber: doc.invoiceNumber }
        : { amazonOrderId: doc.amazonOrderId, shipmentId: doc.shipmentId };

      await db.collection('amazon_vat_invoices').updateOne(
        filter,
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ invoiceNumber: doc.invoiceNumber, amazonOrderId: doc.amazonOrderId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon vat-invoices webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORTS WEBHOOK ====================

/**
 * @route POST /api/amazon/webhook/report
 * @desc Receive any report data from Make.com
 */
router.post('/webhook/report', validateWebhook, async (req, res) => {
  try {
    const { reportType, reportId, data, metadata } = req.body;

    if (!reportType) {
      return res.status(400).json({ error: 'reportType required' });
    }

    const db = getDb();
    const doc = {
      reportType,
      reportId,
      data: data || req.body,
      metadata: metadata || {},
      source: 'make.com',
      createdAt: new Date(),
    };

    const result = await db.collection('amazon_reports').insertOne(doc);

    res.json({ success: true, _id: result.insertedId, reportType });
  } catch (error) {
    console.error('Amazon report webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== DATA ACCESS ENDPOINTS ====================

/**
 * @route GET /api/amazon/orders
 * @desc Get Amazon orders with filters
 */
router.get('/orders', async (req, res) => {
  try {
    const db = getDb();
    const { status, from, to, limit = 50, skip = 0 } = req.query;

    const filter = {};
    if (status) filter.orderStatus = status;
    if (from || to) {
      filter.purchaseDate = {};
      if (from) filter.purchaseDate.$gte = new Date(from);
      if (to) filter.purchaseDate.$lte = new Date(to);
    }

    const orders = await db.collection('amazon_orders')
      .find(filter)
      .sort({ purchaseDate: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('amazon_orders').countDocuments(filter);

    res.json({ orders, total, limit: parseInt(limit), skip: parseInt(skip) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/inventory
 * @desc Get Amazon inventory
 */
router.get('/inventory', async (req, res) => {
  try {
    const db = getDb();
    const { lowStock, limit = 100 } = req.query;

    const filter = {};
    if (lowStock === 'true') {
      filter.fulfillableQuantity = { $lte: 10 };
    }

    const inventory = await db.collection('amazon_inventory')
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ inventory, count: inventory.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/returns
 * @desc Get Amazon returns
 */
router.get('/returns', async (req, res) => {
  try {
    const db = getDb();
    const { from, to, limit = 50 } = req.query;

    const filter = {};
    if (from || to) {
      filter.returnRequestDate = {};
      if (from) filter.returnRequestDate.$gte = new Date(from);
      if (to) filter.returnRequestDate.$lte = new Date(to);
    }

    const returns = await db.collection('amazon_returns')
      .find(filter)
      .sort({ returnRequestDate: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ returns, count: returns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/financial-summary
 * @desc Get financial summary for a period
 */
router.get('/financial-summary', async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    // Aggregate orders
    const orderMatch = {};
    if (Object.keys(dateFilter).length) orderMatch.purchaseDate = dateFilter;

    const orderStats = await db.collection('amazon_orders').aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: { $toDouble: '$orderTotal.Amount' } },
          shippedOrders: {
            $sum: { $cond: [{ $eq: ['$orderStatus', 'Shipped'] }, 1, 0] }
          },
          pendingOrders: {
            $sum: { $cond: [{ $in: ['$orderStatus', ['Pending', 'Unshipped']] }, 1, 0] }
          }
        }
      }
    ]).toArray();

    // Aggregate returns
    const returnMatch = {};
    if (Object.keys(dateFilter).length) returnMatch.returnRequestDate = dateFilter;

    const returnStats = await db.collection('amazon_returns').aggregate([
      { $match: returnMatch },
      {
        $group: {
          _id: null,
          totalReturns: { $sum: 1 },
          totalRefunded: { $sum: { $toDouble: '$refundAmount' } }
        }
      }
    ]).toArray();

    // Get FBA fees
    const feeMatch = {};
    if (Object.keys(dateFilter).length) feeMatch.createdAt = dateFilter;

    const feeStats = await db.collection('amazon_fba_fees').aggregate([
      { $match: feeMatch },
      {
        $group: {
          _id: '$feeType',
          total: { $sum: { $toDouble: '$feeAmount' } }
        }
      }
    ]).toArray();

    res.json({
      period: { from, to },
      orders: orderStats[0] || { totalOrders: 0, totalRevenue: 0 },
      returns: returnStats[0] || { totalReturns: 0, totalRefunded: 0 },
      fees: feeStats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/ads/campaigns
 * @desc Get advertising campaigns
 */
router.get('/ads/campaigns', async (req, res) => {
  try {
    const db = getDb();
    const { state, type, limit = 50 } = req.query;

    const filter = {};
    if (state) filter.state = state;
    if (type) filter.campaignType = type;

    const campaigns = await db.collection('amazon_ads_campaigns')
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ campaigns, count: campaigns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/ads/performance
 * @desc Get advertising performance metrics
 */
router.get('/ads/performance', async (req, res) => {
  try {
    const db = getDb();
    const { campaignId, from, to, limit = 100 } = req.query;

    const filter = {};
    if (campaignId) filter.campaignId = campaignId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    const performance = await db.collection('amazon_ads_performance')
      .find(filter)
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ performance, count: performance.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/ads/summary
 * @desc Get advertising summary for a period
 */
router.get('/ads/summary', async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const match = {};
    if (Object.keys(dateFilter).length) match.date = dateFilter;

    const summary = await db.collection('amazon_ads_performance').aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalImpressions: { $sum: '$impressions' },
          totalClicks: { $sum: '$clicks' },
          totalCost: { $sum: '$cost' },
          totalSales: { $sum: '$sales' },
          totalOrders: { $sum: '$orders' },
        }
      }
    ]).toArray();

    const stats = summary[0] || {
      totalImpressions: 0,
      totalClicks: 0,
      totalCost: 0,
      totalSales: 0,
      totalOrders: 0,
    };

    // Calculate derived metrics
    stats.acos = stats.totalSales > 0 ? (stats.totalCost / stats.totalSales * 100).toFixed(2) : 0;
    stats.roas = stats.totalCost > 0 ? (stats.totalSales / stats.totalCost).toFixed(2) : 0;
    stats.ctr = stats.totalImpressions > 0 ? (stats.totalClicks / stats.totalImpressions * 100).toFixed(2) : 0;
    stats.cpc = stats.totalClicks > 0 ? (stats.totalCost / stats.totalClicks).toFixed(2) : 0;

    res.json({ period: { from, to }, ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/stats
 * @desc Get overall Amazon integration stats
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

    const [orders, inventory, returns, settlements, invoices, adsCampaigns, adsPerformance] = await Promise.all([
      db.collection('amazon_orders').countDocuments(),
      db.collection('amazon_inventory').countDocuments(),
      db.collection('amazon_returns').countDocuments(),
      db.collection('amazon_settlements').countDocuments(),
      db.collection('amazon_vat_invoices').countDocuments(),
      db.collection('amazon_ads_campaigns').countDocuments(),
      db.collection('amazon_ads_performance').countDocuments(),
    ]);

    // Get last sync times
    const lastOrder = await db.collection('amazon_orders').findOne({}, { sort: { updatedAt: -1 } });
    const lastInventory = await db.collection('amazon_inventory').findOne({}, { sort: { updatedAt: -1 } });
    const lastAds = await db.collection('amazon_ads_performance').findOne({}, { sort: { createdAt: -1 } });

    res.json({
      counts: { orders, inventory, returns, settlements, invoices, adsCampaigns, adsPerformance },
      lastSync: {
        orders: lastOrder?.updatedAt,
        inventory: lastInventory?.updatedAt,
        ads: lastAds?.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
