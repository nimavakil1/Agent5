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
const { CHANNELS } = require('../../orders/UnifiedOrderService');
const {
  getMarketplaceConfig,
  getWarehouseId,
  getOrderPrefix,
  SPECIAL_PRODUCTS
} = require('./SellerMarketplaceConfig');
const { getItemQuantity } = require('./SellerOrderSchema');
const { euCountryConfig: _euCountryConfig } = require('../EuCountryConfig');
const { skuResolver } = require('../SkuResolver');
const { getAddressCleaner: _getAddressCleaner, LEGAL_TERMS_REGEX } = require('./AddressCleaner');

/**
 * Clean duplicate names like "elodie da cunha, DA CUNHA Elodie"
 * Amazon sometimes concatenates recipient-name + buyer-name
 *
 * @param {string} name - Raw name from Amazon
 * @returns {string} Cleaned name
 */
function cleanDuplicateName(name) {
  if (!name) return name;

  // Check for comma-separated duplicate (e.g., "John Smith, SMITH John" or "LE-ROUX, LE-ROUX Armelle")
  const parts = name.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    const part1Words = parts[0].toLowerCase().split(/\s+/).sort();
    const part2Words = parts[1].toLowerCase().split(/\s+/).sort();

    // If both parts contain the same words (just reordered), use the first one
    if (part1Words.join(' ') === part2Words.join(' ')) {
      // Prefer the version that's not ALL CAPS
      if (parts[0] === parts[0].toUpperCase() && parts[1] !== parts[1].toUpperCase()) {
        return parts[1];
      }
      return parts[0];
    }

    // Check if one part is a SUBSET of the other (e.g., "LE-ROUX, LE-ROUX Armelle")
    // All words in part1 appear in part2 -> use part2 (more complete)
    const part1Set = new Set(part1Words);
    const part2Set = new Set(part2Words);

    const part1InPart2 = part1Words.every(w => part2Set.has(w));
    const part2InPart1 = part2Words.every(w => part1Set.has(w));

    if (part1InPart2 && !part2InPart1) {
      // Part1 is subset of Part2, use Part2 (more complete)
      // Prefer mixed case over ALL CAPS
      if (parts[1] === parts[1].toUpperCase() && parts[0] !== parts[0].toUpperCase()) {
        // But part2 is all caps and part1 isn't - try to build a better name
        // This shouldn't happen often, just use the longer one
      }
      return parts[1];
    }

    if (part2InPart1 && !part1InPart2) {
      // Part2 is subset of Part1, use Part1 (more complete)
      return parts[0];
    }
  }

  // Remove legal terms
  return name.replace(LEGAL_TERMS_REGEX, '').trim();
}

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
 * Journal configuration for Amazon Seller orders
 *
 * Journal selection is based on ship-from → ship-to:
 * - Domestic sales (BE→BE, DE→DE, etc.): Use country-specific journal
 * - EU cross-border B2C: Use OSS journal
 * - Export (non-EU destinations): Use Export journal
 */
const SELLER_JOURNALS = {
  // Country-specific journals (for domestic sales or FBA from that country)
  'BE': { code: 'VBE', id: 1 },   // INV*BE/ Invoices
  'NL': { code: 'VNL', id: 16 },  // INV*NL/ Invoices
  'DE': { code: 'VDE', id: 15 },  // INV*DE/ Invoices
  'FR': { code: 'VFR', id: 14 },  // INV*FR/ Invoices
  'IT': { code: 'VIT', id: 40 },  // INV*IT/ Invoices
  'PL': { code: 'VPL', id: 51 },  // INV*PL/ Invoices
  'CZ': { code: 'VCZ', id: 50 },  // INV*CZ/ Invoices
  'GB': { code: 'VGB', id: 41 },  // INV*GB/ Invoices (UK domestic FBA)
  // Special journals
  'OSS': { code: 'VOS', id: 12 }, // INV*OSS/ Invoices (EU cross-border B2C)
  'EXPORT': { code: 'VEX', id: 52 }, // INV*EX/ Export Invoices (non-EU)
};

/**
 * EU member countries (for determining OSS vs Export)
 */
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
];

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
      // Get order from MongoDB (unified_orders collection)
      const unifiedOrderId = `${CHANNELS.AMAZON_SELLER}:${amazonOrderId}`;
      const order = await this.collection.findOne({ unifiedOrderId });
      if (!order) {
        result.error = 'Order not found in database';
        return result;
      }

      // Check if already has Odoo order
      if (order.odoo?.saleOrderId || order.sourceIds?.odooSaleOrderId) {
        result.success = true;
        result.skipped = true;
        result.skipReason = 'Order already exists in Odoo';
        result.odooOrderId = order.odoo?.saleOrderId || order.sourceIds?.odooSaleOrderId;
        result.odooOrderName = order.odoo?.saleOrderName || order.sourceIds?.odooSaleOrderName;
        return result;
      }

      // Check if items are fetched (unified schema uses amazonSeller.itemsFetched)
      const itemsFetched = order.amazonSeller?.itemsFetched || order.itemsFetched;
      if (!itemsFetched || !order.items || order.items.length === 0) {
        result.error = 'Order items not fetched yet';
        return result;
      }

      // Check order status - only create for processable orders
      // Unified schema uses status.source for original Amazon status
      const orderStatus = order.status?.source || order.orderStatus;
      const processableStatuses = ['Unshipped', 'PartiallyShipped', 'Shipped'];
      if (!processableStatuses.includes(orderStatus)) {
        result.error = `Order status "${orderStatus}" is not processable`;
        return result;
      }

      // Check if order already exists in Odoo by client_order_ref
      const existingOrder = await this.findExistingOrder(amazonOrderId);
      if (existingOrder) {
        // Get partner name from existing order for UI display
        const partnerId = existingOrder.partner_id ? existingOrder.partner_id[0] : null;
        const partnerName = existingOrder.partner_id ? existingOrder.partner_id[1] : null;

        // Update MongoDB with existing order info including partner name
        await this.importer.updateOdooInfo(amazonOrderId, {
          partnerId,
          partnerName,  // This updates buyerName and shippingAddress.name in MongoDB
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

      // Find/create customer and shipping address (real addresses, not generic)
      const { customerId, shippingAddressId } = await this.findOrCreateCustomerAndAddress(order, config);

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
          customerId,
          shippingAddressId,
          warehouseId: config.warehouseId,
          orderPrefix: config.orderPrefix,
          linesCount: orderLines.lines.length,
          totalItems: order.items.length,
          errors: orderLines.errors
        };
        return result;
      }

      // Create the order in Odoo
      const createdOrder = await this.createOdooOrder(order, customerId, shippingAddressId, config, orderLines);

      // Auto-confirm if requested
      if (options.autoConfirm !== false) {
        try {
          await this.confirmOrder(createdOrder.id);
          createdOrder.confirmed = true;
        } catch (confirmError) {
          result.warnings.push(`Order created but confirmation failed: ${confirmError.message}`);
        }
      }

      // Update MongoDB with Odoo info including partner name for UI display
      const partnerName = await this.getPartnerName(customerId);
      await this.importer.updateOdooInfo(amazonOrderId, {
        partnerId: customerId,
        partnerName,  // This updates buyerName and shippingAddress.name in MongoDB
        shippingAddressId,
        saleOrderId: createdOrder.id,
        saleOrderName: createdOrder.name,
        createdAt: new Date()
      });

      result.success = true;
      result.odooOrderId = createdOrder.id;
      result.odooOrderName = createdOrder.name;
      result.customerId = customerId;
      result.shippingAddressId = shippingAddressId;
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
   * Find existing VALID (non-cancelled) order in Odoo by Amazon Order ID
   */
  async findExistingOrder(amazonOrderId) {
    const fields = ['id', 'name', 'state', 'partner_id'];

    // Try with both prefix variations
    const prefixes = ['FBA', 'FBM', ''];
    for (const prefix of prefixes) {
      const searchRef = prefix + amazonOrderId;
      const orders = await this.odoo.searchRead('sale.order',
        [['client_order_ref', '=', searchRef], ['state', '!=', 'cancel']],
        fields
      );
      if (orders.length > 0) return orders[0];

      // Also try by name
      const ordersByName = await this.odoo.searchRead('sale.order',
        [['name', '=', searchRef], ['state', '!=', 'cancel']],
        fields
      );
      if (ordersByName.length > 0) return ordersByName[0];
    }

    // Try just the order ID
    const orders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', amazonOrderId], ['state', '!=', 'cancel']],
      fields
    );
    return orders.length > 0 ? orders[0] : null;
  }

  /**
   * Create orders for FBA orders only (uses generic customers)
   * @param {Object} options - Creation options
   */
  async createFbaOrders(options = {}) {
    await this.init();

    const limit = options.limit || 100;

    // Get FBA orders pending Odoo creation (from unified_orders)
    const pendingOrders = await this.collection.find({
      channel: CHANNELS.AMAZON_SELLER,
      'sourceIds.odooSaleOrderId': null,
      'amazonSeller.autoImportEligible': true,
      'amazonSeller.fulfillmentChannel': 'AFN', // FBA only
      'status.source': { $in: ['Unshipped', 'Shipped', 'PartiallyShipped'] },
      'amazonSeller.itemsFetched': true
    })
      .sort({ orderDate: -1 })
      .limit(limit)
      .toArray();

    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      orders: []
    };

    console.log(`[SellerOrderCreator] Processing ${pendingOrders.length} FBA orders`);

    for (const order of pendingOrders) {
      results.processed++;
      const amazonOrderId = order.sourceIds?.amazonOrderId;

      try {
        const result = await this.createOrder(amazonOrderId, {
          dryRun: options.dryRun,
          autoConfirm: options.autoConfirm !== false
        });

        if (result.success && !result.skipped) {
          results.created++;
        } else if (result.skipped) {
          results.skipped++;
        }

        results.orders.push({
          amazonOrderId,
          ...result
        });

      } catch (error) {
        results.errors.push({
          amazonOrderId,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Get order configuration based on order data
   * Handles both legacy and unified schema field names
   */
  getOrderConfig(order) {
    // Get marketplace ID (unified: marketplace.code or amazonSeller.marketplaceId, legacy: marketplaceId)
    const marketplaceId = order.marketplace?.code || order.amazonSeller?.marketplaceId || order.marketplaceId;
    const marketplaceConfig = getMarketplaceConfig(marketplaceId);

    // Get fulfillment channel (unified: amazonSeller.fulfillmentChannel, legacy: fulfillmentChannel)
    const fulfillmentChannel = order.amazonSeller?.fulfillmentChannel || order.fulfillmentChannel;
    const isFBA = fulfillmentChannel === 'AFN';

    // Get warehouse based on fulfillment channel
    const warehouseId = getWarehouseId(marketplaceId, fulfillmentChannel);

    // Get order prefix
    const orderPrefix = getOrderPrefix(fulfillmentChannel);

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
   * Find or create customer and shipping address from order data
   * Creates real customer with actual shipping address when available,
   * falls back to generic customer if no address data.
   * Handles both legacy and unified schema field names.
   *
   * @returns {Object} { customerId, shippingAddressId }
   */
  async findOrCreateCustomerAndAddress(order, config) {
    const address = order.shippingAddress;
    const amazonOrderId = order.sourceIds?.amazonOrderId || order.amazonOrderId;

    // If no address data at all, use generic customer
    if (!address) {
      console.warn(`[SellerOrderCreator] No shipping address for ${amazonOrderId}, using generic customer`);
      const genericCustomerId = await this.findOrCreateGenericCustomer(config.shipToCountry);
      return { customerId: genericCustomerId, shippingAddressId: genericCustomerId };
    }

    // Build customer name
    // Priority: name > buyerName > location-based name > generic
    let customerName = cleanDuplicateName(address.name);

    // Try buyer name if shipping name is empty (unified: customer.name, legacy: buyerName)
    const buyerName = order.customer?.name || order.amazonSeller?.buyerName || order.buyerName;
    if (!customerName && buyerName) {
      customerName = cleanDuplicateName(buyerName);
    }

    // For B2B: use company name if available (unified: amazonSeller.isBusinessOrder)
    const isBusinessOrder = order.amazonSeller?.isBusinessOrder || order.isBusinessOrder;
    const buyerCompanyName = order.amazonSeller?.buyerCompanyName || order.buyerCompanyName;
    if (isBusinessOrder && buyerCompanyName) {
      customerName = cleanDuplicateName(buyerCompanyName);
    }

    // If still no name, create location-based customer using city/postal code
    // This is for orders where Amazon doesn't return PII (name)
    if (!customerName) {
      const city = address.city || 'Unknown';
      const postalCode = address.postalCode || '';
      const countryCode = address.countryCode || config.shipToCountry;
      customerName = `Amazon Customer (${city}${postalCode ? ' ' + postalCode : ''}, ${countryCode})`;
      console.log(`[SellerOrderCreator] Using location-based customer name for ${amazonOrderId}: ${customerName}`);
    }

    const countryId = this.countryCache[address.countryCode] || null;
    const buyerEmail = order.customer?.email || order.amazonSeller?.buyerEmail || order.buyerEmail;

    // Check cache for customer
    const customerCacheKey = `customer|${customerName}|${address.countryCode}`;
    let customerId = this.partnerCache[customerCacheKey];

    if (!customerId) {
      // Try to find existing customer by name and country
      const existingCustomer = await this.odoo.searchRead('res.partner',
        [
          ['name', '=', customerName],
          ['country_id', '=', countryId],
          ['parent_id', '=', false],  // Must be parent, not child contact
          ['customer_rank', '>', 0]
        ],
        ['id']
      );

      if (existingCustomer.length > 0) {
        customerId = existingCustomer[0].id;
      } else {
        // Create new customer
        customerId = await this.odoo.create('res.partner', {
          name: customerName,
          company_type: isBusinessOrder ? 'company' : 'person',
          is_company: isBusinessOrder,
          customer_rank: 1,
          country_id: countryId,
          email: buyerEmail || null,
          comment: `Amazon customer - created from order ${amazonOrderId}`
        });
        console.log(`[SellerOrderCreator] Created customer: ${customerName} (ID: ${customerId})`);
      }

      this.partnerCache[customerCacheKey] = customerId;
    }

    // Now create/find the shipping address as a child contact
    // Use available data for cache key (some orders may not have street address from Amazon)
    const streetKey = address.addressLine1 || address.city || 'no-street';
    const addressCacheKey = `shipping|${customerId}|${address.postalCode || 'no-zip'}|${streetKey}`;
    let shippingAddressId = this.partnerCache[addressCacheKey];

    if (!shippingAddressId) {
      // Build search criteria based on available data
      const searchCriteria = [
        ['parent_id', '=', customerId],
        ['type', '=', 'delivery']
      ];

      // Add zip to search if available
      if (address.postalCode) {
        searchCriteria.push(['zip', '=', address.postalCode]);
      }

      // Add city to search if available (as fallback when no street)
      if (address.city) {
        searchCriteria.push(['city', '=', address.city]);
      }

      // Try to find existing shipping address under this customer
      const existingAddress = await this.odoo.searchRead('res.partner',
        searchCriteria,
        ['id']
      );

      if (existingAddress.length > 0) {
        shippingAddressId = existingAddress[0].id;
      } else {
        // Create new shipping address as child contact
        // Use customerName as delivery contact name if address.name is missing
        // Clean the name to remove duplicates like "John Smith, SMITH John"
        const deliveryName = cleanDuplicateName(address.name) || customerName;
        shippingAddressId = await this.odoo.create('res.partner', {
          parent_id: customerId,
          type: 'delivery',
          name: deliveryName,
          street: address.addressLine1 || null,  // May be null if PII not available
          street2: address.addressLine2 || null,
          city: address.city || null,
          zip: address.postalCode || null,
          country_id: countryId,
          phone: address.phone || null,
          email: buyerEmail || null,  // Email for carrier notifications (GLS, etc.)
          comment: `Shipping address from Amazon order ${amazonOrderId}${!address.name ? ' (PII limited by Amazon)' : ''}`
        });
        console.log(`[SellerOrderCreator] Created shipping address: ${deliveryName} (ID: ${shippingAddressId})`);
      }

      this.partnerCache[addressCacheKey] = shippingAddressId;
    }

    return { customerId, shippingAddressId };
  }

  /**
   * Find or create a generic customer for orders without address data
   * @param {string} countryCode - Country code (DE, FR, etc.)
   */
  async findOrCreateGenericCustomer(countryCode) {
    const customerName = `Amazon | AMZ_B2C_${countryCode}`;

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
      comment: 'Generic Amazon B2C customer - used when shipping address not available'
    });

    console.log(`[SellerOrderCreator] Created generic customer: ${customerName} (ID: ${partnerId})`);
    this.partnerCache[customerName] = partnerId;
    return partnerId;
  }

  /**
   * Resolve order items to Odoo order lines
   */
  async resolveOrderLines(order, _config) {
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
        // @see SellerOrderSchema.js for field definitions
        const quantity = getItemQuantity(item);
        const itemPrice = parseFloat(item.itemPrice?.amount || 0);
        const priceUnit = itemPrice / quantity;

        // Ensure we always have a valid name (mandatory in Odoo)
        const lineName = item.title || transformedSku || amazonSku || `Product ID ${productId}`;

        lines.push({
          product_id: productId,
          product_uom_qty: quantity,
          price_unit: priceUnit,
          name: lineName
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

    // Try stripping suffixes (e.g., -DE, -NL, -FBM, -FBA, etc.)
    const strippedSku = transformedSku.replace(/-[A-Z]{1,4}$/i, '');
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
   * Get partner name from Odoo by ID
   * @param {number} partnerId - Partner ID in Odoo
   * @returns {string|null} Partner name or null
   */
  async getPartnerName(partnerId) {
    if (!partnerId) return null;

    try {
      const partners = await this.odoo.searchRead('res.partner',
        [['id', '=', partnerId]],
        ['name']
      );
      return partners.length > 0 ? partners[0].name : null;
    } catch (error) {
      console.error(`[SellerOrderCreator] Error fetching partner name for ${partnerId}:`, error.message);
      return null;
    }
  }

  /**
   * Determine the correct journal for an order based on ship-from and ship-to countries
   *
   * Logic:
   * - Export (non-EU destination): VEX
   * - Domestic (same country): Country-specific journal (VBE, VNL, VDE, etc.)
   * - EU cross-border: VOS (OSS)
   *
   * @param {object} config - Order config with shipFromCountry and shipToCountry
   * @returns {object} { journalId, journalCode, journalType }
   */
  determineJournal(config) {
    const { shipFromCountry, shipToCountry, isFBA: _isFBA } = config;

    // Check if destination is outside EU (export)
    const isExport = !EU_COUNTRIES.includes(shipToCountry);
    if (isExport) {
      const journal = SELLER_JOURNALS['EXPORT'];
      return {
        journalId: journal.id,
        journalCode: journal.code,
        journalType: 'export'
      };
    }

    // Check if domestic sale (same country)
    if (shipFromCountry === shipToCountry) {
      // Use country-specific journal
      const journal = SELLER_JOURNALS[shipFromCountry] || SELLER_JOURNALS['BE'];
      return {
        journalId: journal.id,
        journalCode: journal.code,
        journalType: 'domestic'
      };
    }

    // EU cross-border sale → OSS
    const journal = SELLER_JOURNALS['OSS'];
    return {
      journalId: journal.id,
      journalCode: journal.code,
      journalType: 'oss'
    };
  }

  /**
   * Create the sale order in Odoo
   * NOTE: Journal is NOT set here - VcsOdooInvoicer will set the correct journal
   * based on actual ship-from country from VCS report
   * Handles both legacy and unified schema field names.
   */
  async createOdooOrder(order, partnerId, shippingPartnerId, config, orderLines) {
    // Get Amazon order ID (unified: sourceIds.amazonOrderId, legacy: amazonOrderId)
    const amazonOrderId = order.sourceIds?.amazonOrderId || order.amazonOrderId;

    // Generate order name
    const orderName = `${config.orderPrefix}${amazonOrderId}`;

    // Build order lines in Odoo format
    const odooLines = orderLines.lines.map(line => [0, 0, line]);

    // Format order date (unified: orderDate, legacy: purchaseDate)
    const purchaseDate = order.orderDate || order.purchaseDate;
    const orderDate = purchaseDate instanceof Date
      ? purchaseDate.toISOString().split('T')[0]
      : new Date(purchaseDate).toISOString().split('T')[0];

    // Create order data
    // NOTE: journal_id is NOT set - VCS invoice import will set correct journal
    // NOTE: Amazon SP-API doesn't provide separate billing address, so we use
    // shipping address for both invoice and shipping. This ensures the delivery
    // address on invoices is correct for the customer.
    const orderData = {
      name: orderName,
      partner_id: partnerId,
      partner_invoice_id: shippingPartnerId,  // Use shipping address for invoice (has full address details)
      partner_shipping_id: shippingPartnerId,  // Shipping address
      client_order_ref: amazonOrderId,
      date_order: orderDate,
      warehouse_id: config.warehouseId,
      order_line: odooLines,
      payment_term_id: PAYMENT_TERM_21_DAYS,
      team_id: config.salesTeamId
    };

    // Create the order
    const orderId = await this.odoo.create('sale.order', orderData);

    console.log(`[SellerOrderCreator] Created order ${orderName} (ID: ${orderId}) - journal will be set by VCS import`);

    return {
      id: orderId,
      name: orderName
    };
  }

  /**
   * Confirm a sale order and sync delivery addresses
   */
  async confirmOrder(orderId) {
    await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);
    console.log(`[SellerOrderCreator] Confirmed order ${orderId}`);

    // Sync delivery addresses to ensure they match the order
    await this.syncDeliveryAddresses(orderId);
  }

  /**
   * Sync delivery addresses with the order's shipping address
   * This ensures stock.picking partner_id matches sale.order partner_shipping_id
   *
   * @param {number} orderId - The sale order ID
   * @returns {number} Number of deliveries updated
   */
  async syncDeliveryAddresses(orderId) {
    // Get the order with its shipping address and deliveries
    const orders = await this.odoo.searchRead('sale.order',
      [['id', '=', orderId]],
      ['id', 'name', 'partner_shipping_id', 'picking_ids']
    );

    if (orders.length === 0) {
      console.log(`[SellerOrderCreator] Order ${orderId} not found for delivery sync`);
      return 0;
    }

    const order = orders[0];
    const shippingPartnerId = order.partner_shipping_id ? order.partner_shipping_id[0] : null;

    if (!shippingPartnerId || !order.picking_ids || order.picking_ids.length === 0) {
      return 0;
    }

    // Get all deliveries for this order
    const pickings = await this.odoo.searchRead('stock.picking',
      [['id', 'in', order.picking_ids]],
      ['id', 'name', 'partner_id', 'state']
    );

    let updated = 0;
    for (const picking of pickings) {
      const currentPartnerId = picking.partner_id ? picking.partner_id[0] : null;

      // Only update if different and delivery is not done/cancelled
      if (currentPartnerId !== shippingPartnerId && !['done', 'cancel'].includes(picking.state)) {
        await this.odoo.write('stock.picking', [picking.id], {
          partner_id: shippingPartnerId
        });
        console.log(`[SellerOrderCreator] Updated delivery ${picking.name} address to match order ${order.name}`);
        updated++;
      }
    }

    return updated;
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
  getSellerOrderCreator,
  cleanDuplicateName
};
