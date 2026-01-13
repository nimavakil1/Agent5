/**
 * ItalyFbaInvoicer - Create Odoo orders and invoices for Italian FBA orders
 *
 * Since VCS is not available for Italy (VAT number issue), we need to:
 * 1. Create sale orders in Odoo for IT FBA orders
 * 2. Generate invoices with correct Italian OSS tax settings
 * 3. Post invoices so they can be provided to customers manually
 *
 * Configuration:
 * - Fiscal Position: IT*OSS | B2C Italy (ID 19)
 * - Journal: INV*IT/ Invoices (ID 40)
 * - Sales Team: Amazon IT (Marketplace) (ID 20)
 * - Warehouse: FBA Amazon.it (ID 13)
 * - Tax: IT*OSS | 22.0% via fiscal position mapping
 *
 * @module ItalyFbaInvoicer
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { CHANNELS } = require('../../orders/UnifiedOrderService');
const { transformSku } = require('../../../core/shared/SkuTransformer');
const { getOperationTracker, OPERATION_TYPES } = require('../../../core/monitoring');

// Italy-specific Odoo configuration
const IT_CONFIG = {
  fiscalPositionId: 19,    // IT*OSS | B2C Italy
  journalId: 40,           // INV*IT/ Invoices
  salesTeamId: 20,         // Amazon IT (Marketplace)
  warehouseId: 13,         // FBA Amazon.it
  countryId: 109,          // Italy
  genericCustomerName: 'Amazon Customer Italy (FBA)',
  orderPrefix: 'FBA-IT'
};

class ItalyFbaInvoicer {
  constructor() {
    this.odoo = null;
    this.db = null;
    this.genericCustomerId = null;
    this.productCache = {};
  }

  async init() {
    if (this.odoo) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();
    this.db = getDb();

    // Find or create generic Italian customer
    await this.ensureGenericCustomer();
  }

  /**
   * Find or create the generic Italian customer for FBA B2C orders
   */
  async ensureGenericCustomer() {
    // Search for existing
    const existing = await this.odoo.searchRead('res.partner',
      [['name', '=', IT_CONFIG.genericCustomerName]],
      ['id']
    );

    if (existing.length > 0) {
      this.genericCustomerId = existing[0].id;
      console.log(`[ItalyFbaInvoicer] Using existing generic customer ID: ${this.genericCustomerId}`);
      return;
    }

    // Create new generic customer
    this.genericCustomerId = await this.odoo.create('res.partner', {
      name: IT_CONFIG.genericCustomerName,
      is_company: false,
      customer_rank: 1,
      country_id: IT_CONFIG.countryId,
      property_account_position_id: IT_CONFIG.fiscalPositionId,
      comment: 'Generic customer for Amazon Italy FBA B2C orders. Created automatically.'
    });

    console.log(`[ItalyFbaInvoicer] Created generic customer ID: ${this.genericCustomerId}`);
  }

  /**
   * Get pending IT FBA orders that need Odoo orders/invoices
   * @param {Object} options - Query options
   * @returns {Array} Orders needing processing
   */
  async getPendingOrders(options = {}) {
    await this.init();

    const limit = options.limit || 50;

    const query = {
      channel: CHANNELS.AMAZON_SELLER,
      'amazonSeller.fulfillmentChannel': 'AFN',  // FBA
      'marketplace.code': 'IT',
      'sourceIds.odooSaleOrderId': null,
      'status.unified': { $in: ['shipped', 'confirmed'] },  // Only shipped/confirmed orders
      'totals.total': { $gt: 0 }  // Must have pricing data
    };

    const orders = await this.db.collection('unified_orders')
      .find(query)
      .sort({ orderDate: -1 })
      .limit(limit)
      .toArray();

    return orders;
  }

  /**
   * Get IT FBA orders that have Odoo orders but no invoice recorded in MongoDB
   * @param {Object} options - Query options
   * @returns {Array} Orders needing invoice creation
   */
  async getOrdersNeedingInvoice(options = {}) {
    await this.init();

    const limit = options.limit || 50;

    const query = {
      channel: CHANNELS.AMAZON_SELLER,
      'amazonSeller.fulfillmentChannel': 'AFN',
      'marketplace.code': 'IT',
      'sourceIds.odooSaleOrderId': { $ne: null },  // HAS Odoo order
      'odoo.invoiceId': null,  // But NO invoice recorded
      'status.unified': { $in: ['shipped', 'confirmed'] }
    };

    const orders = await this.db.collection('unified_orders')
      .find(query)
      .sort({ orderDate: -1 })
      .limit(limit)
      .toArray();

    return orders;
  }

  /**
   * Process orders that have Odoo orders but need invoices
   */
  async processOrdersNeedingInvoice(options = {}) {
    await this.init();

    const limit = options.limit || 50;
    const orders = await this.getOrdersNeedingInvoice({ limit });

    const results = {
      total: orders.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      orders: []
    };

    for (const order of orders) {
      const amazonOrderId = order.sourceIds?.amazonOrderId;
      const odooOrderId = order.sourceIds?.odooSaleOrderId;
      results.processed++;

      try {
        // Create invoice for existing Odoo order
        const invoiceResult = await this.createInvoice(odooOrderId);

        // Update MongoDB with invoice reference
        if (invoiceResult.success) {
          await this.db.collection('unified_orders').updateOne(
            { 'sourceIds.amazonOrderId': amazonOrderId },
            {
              $set: {
                'odoo.invoiceId': invoiceResult.invoiceId,
                'odoo.invoiceName': invoiceResult.invoiceName,
                'odoo.invoiceState': invoiceResult.state,
                updatedAt: new Date()
              }
            }
          );
          results.succeeded++;
        } else {
          results.failed++;
        }

        results.orders.push({
          amazonOrderId,
          odooOrderId,
          success: invoiceResult.success,
          invoice: invoiceResult
        });
      } catch (error) {
        results.failed++;
        results.orders.push({
          amazonOrderId,
          odooOrderId,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Resolve SKU to Odoo product using proper SKU transformation
   */
  async resolveProduct(sku) {
    if (!sku) return null;

    // Check cache
    if (this.productCache[sku]) {
      return this.productCache[sku];
    }

    // Transform SKU (handles amzn.gr.* returns, -FBM, -stickerless, etc.)
    const transformedSku = transformSku(sku);
    console.log(`[ItalyFbaInvoicer] Resolving SKU: ${sku} → ${transformedSku}`);

    // Try transformed SKU first
    let products = await this.odoo.searchRead('product.product',
      [['default_code', '=', transformedSku]],
      ['id', 'name', 'default_code', 'list_price']
    );

    if (products.length > 0) {
      this.productCache[sku] = products[0];
      return products[0];
    }

    // Try original SKU if different
    if (transformedSku !== sku) {
      products = await this.odoo.searchRead('product.product',
        [['default_code', '=', sku]],
        ['id', 'name', 'default_code', 'list_price']
      );

      if (products.length > 0) {
        this.productCache[sku] = products[0];
        return products[0];
      }
    }

    // Try ilike search as last resort
    products = await this.odoo.searchRead('product.product',
      [['default_code', 'ilike', transformedSku]],
      ['id', 'name', 'default_code', 'list_price'],
      { limit: 1 }
    );

    if (products.length > 0) {
      this.productCache[sku] = products[0];
      return products[0];
    }

    return null;
  }

  /**
   * Create Odoo sale order for an IT FBA order
   * @param {Object} order - Unified order from MongoDB
   * @returns {Object} Result with orderId and orderName
   */
  async createSaleOrder(order) {
    await this.init();

    const amazonOrderId = order.sourceIds?.amazonOrderId;
    if (!amazonOrderId) {
      throw new Error('Missing Amazon Order ID');
    }

    // Check if already exists in Odoo
    const existing = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', amazonOrderId]],
      ['id', 'name', 'state', 'invoice_status']
    );

    if (existing.length > 0) {
      console.log(`[ItalyFbaInvoicer] Order ${amazonOrderId} already exists in Odoo: ${existing[0].name}`);

      // If order is in draft, confirm it
      if (existing[0].state === 'draft') {
        console.log(`[ItalyFbaInvoicer] Confirming draft order ${existing[0].name}...`);
        await this.odoo.execute('sale.order', 'action_confirm', [[existing[0].id]]);
        existing[0].state = 'sale';
      }

      return {
        success: true,
        alreadyExists: true,
        orderId: existing[0].id,
        orderName: existing[0].name,
        state: existing[0].state,
        invoiceStatus: existing[0].invoice_status
      };
    }

    // Build order lines
    const orderLines = [];
    const items = order.items || [];
    const orderTotal = order.totals?.total || 0;
    const totalItemQty = items.reduce((sum, item) => sum + (item.quantity || 1), 0);

    // Check if we have item-level prices
    const hasItemPrices = items.some(item => item.unitPrice > 0 || item.lineTotal > 0);

    for (const item of items) {
      const product = await this.resolveProduct(item.sku);

      if (!product) {
        console.warn(`[ItalyFbaInvoicer] Product not found for SKU: ${item.sku}`);
        continue;
      }

      // Calculate unit price (tax-inclusive price from Amazon)
      // Amazon prices include VAT, Odoo will handle tax based on fiscal position
      let unitPrice = item.unitPrice || 0;
      if (!unitPrice && item.lineTotal > 0) {
        unitPrice = item.lineTotal / (item.quantity || 1);
      }

      // If item has no price, use order total distributed by quantity
      if ((!unitPrice || unitPrice <= 0 || isNaN(unitPrice)) && orderTotal > 0 && !hasItemPrices) {
        // Distribute order total proportionally by quantity
        // Amazon prices include VAT (22% for Italy), extract net price for Odoo
        const vatInclusivePrice = orderTotal / totalItemQty;
        unitPrice = vatInclusivePrice / 1.22;  // Extract net price (without 22% VAT)
        console.log(`[ItalyFbaInvoicer] No item prices, using order total: ${orderTotal} / ${totalItemQty} = ${vatInclusivePrice.toFixed(2)} gross, ${unitPrice.toFixed(2)} net per unit`);
      }

      // Final fallback: use Odoo product's list price
      if (!unitPrice || unitPrice <= 0 || isNaN(unitPrice)) {
        unitPrice = product.list_price || 0;
        console.log(`[ItalyFbaInvoicer] Using product list price for SKU ${item.sku}: ${unitPrice}`);
      }

      console.log(`[ItalyFbaInvoicer] Item ${item.sku}: unitPrice=${unitPrice.toFixed(2)}, qty=${item.quantity}`);

      orderLines.push([0, 0, {
        product_id: product.id,
        product_uom_qty: item.quantity || 1,
        price_unit: unitPrice,
        name: item.name || product.name
      }]);
    }

    if (orderLines.length === 0) {
      throw new Error(`No valid products found for order ${amazonOrderId}`);
    }

    // Format order date
    const orderDate = order.orderDate instanceof Date
      ? order.orderDate.toISOString().split('T')[0]
      : new Date(order.orderDate).toISOString().split('T')[0];

    // Create sale order
    const orderName = `${IT_CONFIG.orderPrefix}${amazonOrderId}`;
    const orderId = await this.odoo.create('sale.order', {
      name: orderName,
      partner_id: this.genericCustomerId,
      partner_invoice_id: this.genericCustomerId,
      partner_shipping_id: this.genericCustomerId,
      date_order: orderDate,
      client_order_ref: amazonOrderId,
      warehouse_id: IT_CONFIG.warehouseId,
      team_id: IT_CONFIG.salesTeamId,
      fiscal_position_id: IT_CONFIG.fiscalPositionId,
      order_line: orderLines,
      note: `Amazon Italy FBA Order\nAmazon Order ID: ${amazonOrderId}\nImported automatically for manual invoice provision.`
    });

    console.log(`[ItalyFbaInvoicer] Created sale order ${orderName} (ID: ${orderId})`);

    // Confirm the order
    await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);
    console.log(`[ItalyFbaInvoicer] Confirmed order ${orderName}`);

    return {
      success: true,
      orderId,
      orderName,
      itemCount: orderLines.length
    };
  }

  /**
   * Create and post invoice for a sale order
   * @param {number} saleOrderId - Odoo sale order ID
   * @returns {Object} Result with invoiceId and invoiceName
   */
  async createInvoice(saleOrderId) {
    await this.init();
    const tracker = getOperationTracker();
    const op = tracker.start(OPERATION_TYPES.INVOICE_CREATION, {
      saleOrderId,
      marketplace: 'IT',
      type: 'FBA'
    });

    try {
      // Get the sale order
      const orders = await this.odoo.searchRead('sale.order',
        [['id', '=', saleOrderId]],
        ['id', 'name', 'state', 'invoice_status', 'invoice_ids', 'date_order']
      );

      if (orders.length === 0) {
        throw new Error(`Sale order ${saleOrderId} not found`);
      }

      const saleOrder = orders[0];

      // Check if invoice already exists
      if (saleOrder.invoice_ids && saleOrder.invoice_ids.length > 0) {
        const invoices = await this.odoo.searchRead('account.move',
          [['id', 'in', saleOrder.invoice_ids]],
          ['id', 'name', 'state', 'payment_state']
        );

        if (invoices.length > 0) {
          console.log(`[ItalyFbaInvoicer] Invoice already exists for ${saleOrder.name}: ${invoices[0].name}`);
          op.skip('Invoice already exists');
          return {
            success: true,
            alreadyExists: true,
            invoiceId: invoices[0].id,
            invoiceName: invoices[0].name,
            state: invoices[0].state
          };
        }
      }

    // Check order state
    if (saleOrder.state !== 'sale') {
      throw new Error(`Order ${saleOrder.name} is not confirmed (state: ${saleOrder.state})`);
    }

    // Get order lines with product info
    const orderLines = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', saleOrderId]],
      ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'qty_delivered']
    );

    // Update qty_delivered for FBA orders (Amazon has delivered these)
    console.log(`[ItalyFbaInvoicer] Updating qty_delivered for FBA order ${saleOrder.name}...`);
    for (const line of orderLines) {
      if (line.qty_delivered < line.product_uom_qty) {
        await this.odoo.execute('sale.order.line', 'write', [[line.id], {
          qty_delivered: line.product_uom_qty
        }]);
        line.qty_delivered = line.product_uom_qty;
      }
    }

    // Build invoice lines from order lines, linking them with sale_line_ids
    const invoiceLines = [];
    for (const line of orderLines) {
      if (!line.product_id) continue;

      const qty = line.qty_delivered > 0 ? line.qty_delivered : line.product_uom_qty;

      invoiceLines.push([0, 0, {
        product_id: line.product_id[0],
        name: line.name,
        quantity: qty,
        price_unit: line.price_unit,
        tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
        sale_line_ids: [[4, line.id]], // Link to sale order line
      }]);
    }

    if (invoiceLines.length === 0) {
      throw new Error(`No invoice lines could be created for ${saleOrder.name}`);
    }

    // Create invoice directly (same approach as VcsOdooInvoicer)
    console.log(`[ItalyFbaInvoicer] Creating invoice for order ${saleOrder.name}...`);
    const invoiceId = await this.odoo.create('account.move', {
      move_type: 'out_invoice',
      partner_id: this.genericCustomerId,
      invoice_date: saleOrder.date_order,
      invoice_origin: saleOrder.name,
      journal_id: IT_CONFIG.journalId,
      fiscal_position_id: IT_CONFIG.fiscalPositionId,
      team_id: IT_CONFIG.salesTeamId,
      invoice_line_ids: invoiceLines,
      narration: `Amazon Italy FBA Order\nCreated automatically for manual invoice provision.`
    });

    if (!invoiceId) {
      throw new Error(`Failed to create invoice for ${saleOrder.name}`);
    }

    console.log(`[ItalyFbaInvoicer] Invoice created with ID ${invoiceId}, posting...`);

    // Post the invoice
    await this.odoo.execute('account.move', 'action_post', [[invoiceId]]);

    // Get invoice details
    const invoices = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['id', 'name', 'state', 'amount_total', 'amount_tax']
    );

      const invoice = invoices[0];
      const invoiceName = invoice.name === '/' ? `Draft #${invoiceId}` : invoice.name;
      console.log(`[ItalyFbaInvoicer] Created and posted invoice ${invoiceName} (ID: ${invoice.id})`);

      op.complete({ invoiceId: invoice.id, invoiceName, amountTotal: invoice.amount_total });
      return {
        success: true,
        invoiceId: invoice.id,
        invoiceName: invoiceName,
        state: invoice.state,
        amountTotal: invoice.amount_total,
        amountTax: invoice.amount_tax
      };
    } catch (error) {
      op.fail(error);
      throw error;
    }
  }

  /**
   * Process a single IT FBA order - create order and invoice
   * @param {string} amazonOrderId - Amazon Order ID
   * @returns {Object} Processing result
   */
  async processOrder(amazonOrderId) {
    await this.init();

    const result = {
      amazonOrderId,
      success: false,
      saleOrder: null,
      invoice: null,
      error: null
    };

    try {
      // Get order from MongoDB
      const order = await this.db.collection('unified_orders').findOne({
        'sourceIds.amazonOrderId': amazonOrderId
      });

      if (!order) {
        throw new Error(`Order ${amazonOrderId} not found in MongoDB`);
      }

      // Verify it's an IT FBA order
      if (order.marketplace?.code !== 'IT') {
        throw new Error(`Order ${amazonOrderId} is not an Italian order`);
      }

      if (order.amazonSeller?.fulfillmentChannel !== 'AFN') {
        throw new Error(`Order ${amazonOrderId} is not an FBA order`);
      }

      // Create sale order
      const orderResult = await this.createSaleOrder(order);
      result.saleOrder = orderResult;

      if (!orderResult.success) {
        throw new Error('Failed to create sale order');
      }

      // Update MongoDB with Odoo reference
      await this.db.collection('unified_orders').updateOne(
        { 'sourceIds.amazonOrderId': amazonOrderId },
        {
          $set: {
            'sourceIds.odooSaleOrderId': orderResult.orderId,
            'sourceIds.odooSaleOrderName': orderResult.orderName,
            'status.odoo': 'sale',
            updatedAt: new Date()
          }
        }
      );

      // Create invoice
      const invoiceResult = await this.createInvoice(orderResult.orderId);
      result.invoice = invoiceResult;

      if (!invoiceResult.success) {
        throw new Error('Failed to create invoice');
      }

      // Update MongoDB with invoice reference
      await this.db.collection('unified_orders').updateOne(
        { 'sourceIds.amazonOrderId': amazonOrderId },
        {
          $set: {
            'odoo.invoiceId': invoiceResult.invoiceId,
            'odoo.invoiceName': invoiceResult.invoiceName,
            'odoo.invoiceState': invoiceResult.state,
            updatedAt: new Date()
          }
        }
      );

      result.success = true;
      console.log(`[ItalyFbaInvoicer] Successfully processed order ${amazonOrderId}`);

    } catch (error) {
      result.error = error.message;
      console.error(`[ItalyFbaInvoicer] Error processing ${amazonOrderId}:`, error.message);
    }

    return result;
  }

  /**
   * Process all pending IT FBA orders
   * @param {Object} options - Processing options
   * @returns {Object} Batch processing results
   */
  async processPendingOrders(options = {}) {
    await this.init();

    const limit = options.limit || 20;
    const dryRun = options.dryRun || false;

    const pendingOrders = await this.getPendingOrders({ limit });

    const results = {
      total: pendingOrders.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      orders: [],
      dryRun
    };

    if (dryRun) {
      console.log(`[ItalyFbaInvoicer] DRY RUN - Would process ${pendingOrders.length} orders`);
      for (const order of pendingOrders) {
        results.orders.push({
          amazonOrderId: order.sourceIds?.amazonOrderId,
          total: order.totals?.total,
          items: order.items?.length || 0,
          status: 'would_process'
        });
      }
      return results;
    }

    console.log(`[ItalyFbaInvoicer] Processing ${pendingOrders.length} pending IT FBA orders`);

    for (const order of pendingOrders) {
      const amazonOrderId = order.sourceIds?.amazonOrderId;
      results.processed++;

      try {
        const orderResult = await this.processOrder(amazonOrderId);
        results.orders.push(orderResult);

        if (orderResult.success) {
          results.succeeded++;
        } else {
          results.failed++;
        }
      } catch (error) {
        results.failed++;
        results.orders.push({
          amazonOrderId,
          success: false,
          error: error.message
        });
      }
    }

    console.log(`[ItalyFbaInvoicer] Batch complete: ${results.succeeded} succeeded, ${results.failed} failed`);

    return results;
  }

  /**
   * Get invoice PDF URL for an order
   * @param {string} amazonOrderId - Amazon Order ID
   * @returns {Object} Invoice info with download URL
   */
  async getInvoiceForOrder(amazonOrderId) {
    await this.init();

    // Get order from MongoDB
    const order = await this.db.collection('unified_orders').findOne({
      'sourceIds.amazonOrderId': amazonOrderId
    });

    if (!order) {
      throw new Error(`Order ${amazonOrderId} not found`);
    }

    if (!order.odoo?.invoiceId) {
      throw new Error(`No invoice found for order ${amazonOrderId}`);
    }

    // Get invoice from Odoo
    const invoices = await this.odoo.searchRead('account.move',
      [['id', '=', order.odoo.invoiceId]],
      ['id', 'name', 'state', 'amount_total', 'amount_tax', 'invoice_date', 'partner_id']
    );

    if (invoices.length === 0) {
      throw new Error(`Invoice ${order.odoo.invoiceId} not found in Odoo`);
    }

    const invoice = invoices[0];

    return {
      amazonOrderId,
      invoiceId: invoice.id,
      invoiceName: invoice.name,
      state: invoice.state,
      amountTotal: invoice.amount_total,
      amountTax: invoice.amount_tax,
      invoiceDate: invoice.invoice_date,
      // URL to view/download in Odoo
      odooUrl: `${process.env.ODOO_URL}/web#id=${invoice.id}&model=account.move&view_type=form`
    };
  }

  /**
   * Get summary of IT FBA orders and invoices
   */
  async getSummary() {
    await this.init();

    const totalItFba = await this.db.collection('unified_orders').countDocuments({
      channel: CHANNELS.AMAZON_SELLER,
      'amazonSeller.fulfillmentChannel': 'AFN',
      'marketplace.code': 'IT'
    });

    const withOdooOrder = await this.db.collection('unified_orders').countDocuments({
      channel: CHANNELS.AMAZON_SELLER,
      'amazonSeller.fulfillmentChannel': 'AFN',
      'marketplace.code': 'IT',
      'sourceIds.odooSaleOrderId': { $ne: null }
    });

    const withInvoice = await this.db.collection('unified_orders').countDocuments({
      channel: CHANNELS.AMAZON_SELLER,
      'amazonSeller.fulfillmentChannel': 'AFN',
      'marketplace.code': 'IT',
      'odoo.invoiceId': { $ne: null }
    });

    const pendingWithPrice = await this.db.collection('unified_orders').countDocuments({
      channel: CHANNELS.AMAZON_SELLER,
      'amazonSeller.fulfillmentChannel': 'AFN',
      'marketplace.code': 'IT',
      'sourceIds.odooSaleOrderId': null,
      'totals.total': { $gt: 0 }
    });

    return {
      totalItFbaOrders: totalItFba,
      withOdooOrder,
      withInvoice,
      pendingWithPrice,
      pendingWithoutPrice: totalItFba - withOdooOrder - pendingWithPrice
    };
  }
}

// Singleton instance
let italyFbaInvoicerInstance = null;

function getItalyFbaInvoicer() {
  if (!italyFbaInvoicerInstance) {
    italyFbaInvoicerInstance = new ItalyFbaInvoicer();
  }
  return italyFbaInvoicerInstance;
}

module.exports = {
  ItalyFbaInvoicer,
  getItalyFbaInvoicer,
  IT_CONFIG
};
