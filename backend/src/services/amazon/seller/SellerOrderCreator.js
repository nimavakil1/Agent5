/**
 * SellerOrderCreator - Create Odoo Sales Orders from Amazon Orders
 *
 * Handles:
 * - Finding/creating customers from shipping addresses
 * - Mapping products via SKU
 * - Creating sale.order with correct warehouse and fiscal position
 * - Auto-confirming orders
 * - Storing Odoo IDs back to MongoDB
 *
 * Based on Emipro order structure:
 * - FBA prefix: "FBA" + Amazon Order ID
 * - FBM prefix: "FBM" + Amazon Order ID
 * - 21 day payment terms
 * - Automatic validation workflow
 *
 * @module SellerOrderCreator
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerOrderImporter, COLLECTION_NAME } = require('./SellerOrderImporter');
const {
  getMarketplaceConfig,
  getWarehouseId,
  getOrderPrefix,
  SPECIAL_PRODUCTS
} = require('./SellerMarketplaceConfig');
const { euCountryConfig } = require('../EuCountryConfig');
const { skuResolver } = require('../SkuResolver');

/**
 * Payment term ID for "21 Days" in Odoo
 * Based on Emipro configuration
 */
const PAYMENT_TERM_21_DAYS = 2; // Adjust if different in your Odoo

/**
 * Amazon Seller sales team ID
 */
const AMAZON_SELLER_TEAM_ID = 11;

/**
 * SellerOrderCreator - Creates Odoo orders from Amazon seller orders
 */
class SellerOrderCreator {
  constructor() {
    this.odoo = null;
    this.importer = null;
    this.collection = null;

    // Caches
    this.warehouseCache = {};
    this.countryCache = {};
    this.productCache = {};
    this.partnerCache = {};
  }

  /**
   * Initialize the creator
   */
  async init() {
    if (this.odoo && this.collection) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    this.importer = await getSellerOrderImporter();

    const db = getDb();
    this.collection = db.collection(COLLECTION_NAME);

    // Load caches
    await this.loadCaches();
  }

  /**
   * Load caches for warehouses, countries, etc.
   */
  async loadCaches() {
    try {
      // Pre-load warehouses
      const warehouses = await this.odoo.searchRead('stock.warehouse', [], ['id', 'code', 'name']);
      for (const wh of warehouses) {
        this.warehouseCache[wh.code] = wh.id;
        this.warehouseCache[wh.id] = wh;
      }

      // Pre-load countries
      const countries = await this.odoo.searchRead('res.country', [], ['id', 'code', 'name']);
      for (const c of countries) {
        this.countryCache[c.code] = c.id;
      }

      // Load SKU resolver
      if (!skuResolver.loaded) {
        await skuResolver.load();
      }

      console.log(`[SellerOrderCreator] Caches loaded: ${warehouses.length} warehouses, ${countries.length} countries`);
    } catch (error) {
      console.error('[SellerOrderCreator] Error loading caches:', error.message);
    }
  }

  /**
   * Create an Odoo order from an Amazon order
   * @param {string} amazonOrderId - Amazon Order ID
   * @param {Object} options - Creation options
   */
  async createOrder(amazonOrderId, options = {}) {
    await this.init();

    const result = {
      success: false,
      amazonOrderId,
      dryRun: options.dryRun || false,
      errors: [],
      warnings: []
    };

    try {
      // Get order from MongoDB
      const order = await this.collection.findOne({ amazonOrderId });
      if (!order) {
        result.error = 'Order not found in database';
        return result;
      }

      // Check if already has Odoo order
      if (order.odoo?.saleOrderId) {
        result.success = true;
        result.skipped = true;
        result.skipReason = 'Order already exists in Odoo';
        result.odooOrderId = order.odoo.saleOrderId;
        result.odooOrderName = order.odoo.saleOrderName;
        return result;
      }

      // Check if items are fetched
      if (!order.itemsFetched || !order.items || order.items.length === 0) {
        result.error = 'Order items not fetched yet';
        return result;
      }

      // Check order status - only create for processable orders
      const processableStatuses = ['Unshipped', 'PartiallyShipped', 'Shipped'];
      if (!processableStatuses.includes(order.orderStatus)) {
        result.error = `Order status "${order.orderStatus}" is not processable`;
        return result;
      }

      // Check if order already exists in Odoo by client_order_ref
      const existingOrder = await this.findExistingOrder(amazonOrderId);
      if (existingOrder) {
        // Update MongoDB with existing order info
        await this.importer.updateOdooInfo(amazonOrderId, {
          saleOrderId: existingOrder.id,
          saleOrderName: existingOrder.name
        });

        result.success = true;
        result.skipped = true;
        result.skipReason = 'Order already exists in Odoo (found by reference)';
        result.odooOrderId = existingOrder.id;
        result.odooOrderName = existingOrder.name;
        return result;
      }

      // Determine order configuration
      const config = this.getOrderConfig(order);

      // Find/create customer
      const partnerId = await this.findOrCreateCustomer(order, config);

      // Resolve order lines
      const orderLines = await this.resolveOrderLines(order, config);
      if (orderLines.lines.length === 0) {
        result.error = 'No valid products found for order';
        result.errors = orderLines.errors;
        return result;
      }

      if (orderLines.errors.length > 0) {
        result.warnings = orderLines.errors;
      }

      if (options.dryRun) {
        result.success = true;
        result.preview = {
          partnerId,
          warehouseId: config.warehouseId,
          orderPrefix: config.orderPrefix,
          linesCount: orderLines.lines.length,
          totalItems: order.items.length,
          errors: orderLines.errors
        };
        return result;
      }

      // Create the order in Odoo
      const createdOrder = await this.createOdooOrder(order, partnerId, config, orderLines);

      // Auto-confirm if requested
      if (options.autoConfirm !== false) {
        try {
          await this.confirmOrder(createdOrder.id);
          createdOrder.confirmed = true;
        } catch (confirmError) {
          result.warnings.push(`Order created but confirmation failed: ${confirmError.message}`);
        }
      }

      // Update MongoDB with Odoo info
      await this.importer.updateOdooInfo(amazonOrderId, {
        partnerId,
        saleOrderId: createdOrder.id,
        saleOrderName: createdOrder.name,
        createdAt: new Date()
      });

      result.success = true;
      result.odooOrderId = createdOrder.id;
      result.odooOrderName = createdOrder.name;
      result.partnerId = partnerId;
      result.linesCreated = orderLines.lines.length;
      result.confirmed = createdOrder.confirmed || false;

    } catch (error) {
      result.error = error.message;
      console.error(`[SellerOrderCreator] Error creating order ${amazonOrderId}:`, error);
    }

    return result;
  }

  /**
   * Create orders for all pending eligible orders
   * @param {Object} options - Creation options
   */
  async createPendingOrders(options = {}) {
    await this.init();

    const limit = options.limit || 50;
    const pendingOrders = await this.importer.getPendingOdooOrders(limit);

    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      orders: []
    };

    for (const order of pendingOrders) {
      results.processed++;

      try {
        const result = await this.createOrder(order.amazonOrderId, {
          dryRun: options.dryRun,
          autoConfirm: options.autoConfirm !== false
        });

        if (result.success && !result.skipped) {
          results.created++;
        } else if (result.skipped) {
          results.skipped++;
        }

        results.orders.push({
          amazonOrderId: order.amazonOrderId,
          ...result
        });

      } catch (error) {
        results.errors.push({
          amazonOrderId: order.amazonOrderId,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Find existing order in Odoo by Amazon Order ID
   */
  async findExistingOrder(amazonOrderId) {
    // Try with both prefix variations
    const prefixes = ['FBA', 'FBM', ''];
    for (const prefix of prefixes) {
      const searchRef = prefix + amazonOrderId;
      const orders = await this.odoo.searchRead('sale.order',
        [['client_order_ref', '=', searchRef]],
        ['id', 'name', 'state']
      );
      if (orders.length > 0) return orders[0];

      // Also try by name
      const ordersByName = await this.odoo.searchRead('sale.order',
        [['name', '=', searchRef]],
        ['id', 'name', 'state']
      );
      if (ordersByName.length > 0) return ordersByName[0];
    }

    // Try just the order ID
    const orders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', amazonOrderId]],
      ['id', 'name', 'state']
    );
    return orders.length > 0 ? orders[0] : null;
  }

  /**
   * Get order configuration based on order data
   */
  getOrderConfig(order) {
    const marketplaceConfig = getMarketplaceConfig(order.marketplaceId);
    const isFBA = order.fulfillmentChannel === 'AFN';

    // Get warehouse based on fulfillment channel
    const warehouseId = getWarehouseId(order.marketplaceId, order.fulfillmentChannel);

    // Get order prefix
    const orderPrefix = getOrderPrefix(order.fulfillmentChannel);

    // Get sales team
    const salesTeamId = marketplaceConfig?.salesTeamId || AMAZON_SELLER_TEAM_ID;

    // Determine ship-from country (for fiscal position)
    let shipFromCountry = marketplaceConfig?.country || 'BE';

    // For FBA, ship-from is the FBA warehouse country
    // For FBM, ship-from is your central warehouse country (Belgium)
    if (!isFBA) {
      shipFromCountry = 'BE';
    }

    // Get ship-to country from shipping address
    const shipToCountry = order.shippingAddress?.countryCode || marketplaceConfig?.country || 'BE';

    return {
      marketplaceConfig,
      isFBA,
      warehouseId,
      orderPrefix,
      salesTeamId,
      shipFromCountry,
      shipToCountry,
      currency: marketplaceConfig?.currency || 'EUR'
    };
  }

  /**
   * Find or create customer from order data
   */
  async findOrCreateCustomer(order, config) {
    const address = order.shippingAddress;

    // For B2C, use generic Amazon customer
    if (!order.isBusinessOrder) {
      const customerName = `Amazon | AMZ_B2C_${config.shipToCountry}`;
      return await this.findOrCreateGenericCustomer(customerName, config.shipToCountry);
    }

    // For B2B, try to find/create by address
    if (address && address.name) {
      // Check cache
      const cacheKey = `${address.name}|${address.postalCode}|${address.countryCode}`;
      if (this.partnerCache[cacheKey]) {
        return this.partnerCache[cacheKey];
      }

      // Try to find existing customer by name and postal code
      const existing = await this.odoo.searchRead('res.partner',
        [
          ['name', 'ilike', address.name],
          ['zip', '=', address.postalCode]
        ],
        ['id']
      );

      if (existing.length > 0) {
        this.partnerCache[cacheKey] = existing[0].id;
        return existing[0].id;
      }

      // Create new customer
      const countryId = this.countryCache[address.countryCode] || null;
      const partnerId = await this.odoo.create('res.partner', {
        name: address.name,
        company_type: order.isBusinessOrder ? 'company' : 'person',
        is_company: order.isBusinessOrder,
        customer_rank: 1,
        street: address.addressLine1,
        street2: address.addressLine2 || null,
        city: address.city,
        zip: address.postalCode,
        country_id: countryId,
        phone: address.phone || null,
        email: order.buyerEmail || null,
        comment: `Created from Amazon order ${order.amazonOrderId}`
      });

      this.partnerCache[cacheKey] = partnerId;
      return partnerId;
    }

    // Fallback to generic customer
    const customerName = `Amazon | AMZ_B2C_${config.shipToCountry}`;
    return await this.findOrCreateGenericCustomer(customerName, config.shipToCountry);
  }

  /**
   * Find or create a generic B2C customer
   */
  async findOrCreateGenericCustomer(customerName, countryCode) {
    // Check cache
    if (this.partnerCache[customerName]) {
      return this.partnerCache[customerName];
    }

    // Search for existing
    const existing = await this.odoo.searchRead('res.partner',
      [['name', '=', customerName]],
      ['id']
    );

    if (existing.length > 0) {
      this.partnerCache[customerName] = existing[0].id;
      return existing[0].id;
    }

    // Create generic customer
    const countryId = this.countryCache[countryCode] || null;
    const partnerId = await this.odoo.create('res.partner', {
      name: customerName,
      company_type: 'company',
      is_company: true,
      customer_rank: 1,
      country_id: countryId,
      comment: 'Generic Amazon B2C customer'
    });

    this.partnerCache[customerName] = partnerId;
    return partnerId;
  }

  /**
   * Resolve order items to Odoo order lines
   */
  async resolveOrderLines(order, config) {
    const lines = [];
    const errors = [];

    for (const item of order.items) {
      try {
        const amazonSku = item.sellerSku;

        // Use SKU resolver to transform
        const resolved = skuResolver.resolve(amazonSku);
        const transformedSku = resolved.odooSku;

        // Find product in Odoo
        const productId = await this.findProduct(transformedSku, amazonSku);
        if (!productId) {
          errors.push(`Product not found: ${amazonSku} (transformed: ${transformedSku})`);
          continue;
        }

        // Calculate price (Amazon gives total, we need unit price)
        const quantity = item.quantityOrdered || 1;
        const itemPrice = parseFloat(item.itemPrice?.amount || 0);
        const priceUnit = itemPrice / quantity;

        lines.push({
          product_id: productId,
          product_uom_qty: quantity,
          price_unit: priceUnit,
          name: item.title || transformedSku
        });

      } catch (error) {
        errors.push(`Error processing SKU ${item.sellerSku}: ${error.message}`);
      }
    }

    // Add shipping line if present
    const totalShipping = order.items.reduce((sum, item) => {
      return sum + parseFloat(item.shippingPrice?.amount || 0);
    }, 0);

    if (totalShipping > 0) {
      lines.push({
        product_id: SPECIAL_PRODUCTS.SHIPPING_CHARGE.id,
        product_uom_qty: 1,
        price_unit: totalShipping,
        name: 'Amazon Shipping'
      });
    }

    // Add shipping discount if present
    const totalShippingDiscount = order.items.reduce((sum, item) => {
      return sum + parseFloat(item.shippingDiscount?.amount || 0);
    }, 0);

    if (totalShippingDiscount > 0) {
      lines.push({
        product_id: SPECIAL_PRODUCTS.SHIPMENT_DISCOUNT.id,
        product_uom_qty: 1,
        price_unit: -totalShippingDiscount,
        name: 'Shipping Discount'
      });
    }

    // Add promotion discount if present
    const totalPromoDiscount = order.items.reduce((sum, item) => {
      return sum + parseFloat(item.promotionDiscount?.amount || 0);
    }, 0);

    if (totalPromoDiscount > 0) {
      lines.push({
        product_id: SPECIAL_PRODUCTS.PROMOTION_DISCOUNT.id,
        product_uom_qty: 1,
        price_unit: -totalPromoDiscount,
        name: 'Promotion Discount'
      });
    }

    return { lines, errors };
  }

  /**
   * Find product by SKU
   */
  async findProduct(transformedSku, originalSku) {
    const cacheKey = `${transformedSku}|${originalSku}`;
    if (this.productCache[cacheKey]) {
      return this.productCache[cacheKey];
    }

    // Try transformed SKU
    let products = await this.odoo.searchRead('product.product',
      [['default_code', '=', transformedSku]],
      ['id']
    );

    if (products.length > 0) {
      this.productCache[cacheKey] = products[0].id;
      return products[0].id;
    }

    // Try original SKU
    products = await this.odoo.searchRead('product.product',
      [['default_code', '=', originalSku]],
      ['id']
    );

    if (products.length > 0) {
      this.productCache[cacheKey] = products[0].id;
      return products[0].id;
    }

    // Try stripping suffixes
    const strippedSku = transformedSku.replace(/-[A-Z]{1,2}$/i, '');
    if (strippedSku !== transformedSku) {
      products = await this.odoo.searchRead('product.product',
        [['default_code', '=', strippedSku]],
        ['id']
      );

      if (products.length > 0) {
        this.productCache[cacheKey] = products[0].id;
        return products[0].id;
      }
    }

    return null;
  }

  /**
   * Create the sale order in Odoo
   */
  async createOdooOrder(order, partnerId, config, orderLines) {
    // Generate order name
    const orderName = `${config.orderPrefix}${order.amazonOrderId}`;

    // Build order lines in Odoo format
    const odooLines = orderLines.lines.map(line => [0, 0, line]);

    // Format order date
    const orderDate = order.purchaseDate instanceof Date
      ? order.purchaseDate.toISOString().split('T')[0]
      : new Date(order.purchaseDate).toISOString().split('T')[0];

    // Create order data
    const orderData = {
      name: orderName,
      partner_id: partnerId,
      partner_invoice_id: partnerId,
      partner_shipping_id: partnerId,
      client_order_ref: order.amazonOrderId,
      date_order: orderDate,
      warehouse_id: config.warehouseId,
      order_line: odooLines,
      payment_term_id: PAYMENT_TERM_21_DAYS,
      team_id: config.salesTeamId
    };

    // Create the order
    const orderId = await this.odoo.create('sale.order', orderData);

    console.log(`[SellerOrderCreator] Created order ${orderName} (ID: ${orderId})`);

    return {
      id: orderId,
      name: orderName
    };
  }

  /**
   * Confirm a sale order
   */
  async confirmOrder(orderId) {
    await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);
    console.log(`[SellerOrderCreator] Confirmed order ${orderId}`);
  }
}

// Singleton instance
let sellerOrderCreatorInstance = null;

/**
 * Get the singleton SellerOrderCreator instance
 */
async function getSellerOrderCreator() {
  if (!sellerOrderCreatorInstance) {
    sellerOrderCreatorInstance = new SellerOrderCreator();
    await sellerOrderCreatorInstance.init();
  }
  return sellerOrderCreatorInstance;
}

module.exports = {
  SellerOrderCreator,
  getSellerOrderCreator
};
