/**
 * Amazon Order Importer Service
 *
 * Imports Amazon orders (FBA and FBM) into Odoo as Sale Orders
 *
 * Flow:
 * 1. Receive order from Make.com webhook
 * 2. Resolve SKUs to Odoo product codes
 * 3. Determine journal, fiscal position, warehouse based on ship-from country
 * 4. Create Sale Order in Odoo
 * 5. For FBA: Mark as delivered (stock already shipped by Amazon)
 * 6. For FBM: Create delivery order for manual processing
 */

const { getDb } = require('../../db');
const { skuResolver } = require('./SkuResolver');
const { euCountryConfig } = require('./EuCountryConfig');

class OrderImporter {
  constructor(odooClient) {
    this.odoo = odooClient;
    this.db = null;
  }

  /**
   * Initialize the importer
   */
  async init() {
    this.db = getDb();
    // Ensure SKU resolver is loaded
    if (!skuResolver.loaded) {
      await skuResolver.load();
    }
  }

  /**
   * Import an Amazon order into Odoo
   * @param {object} amazonOrder - Order data from Amazon SP-API
   * @returns {object} { success, odooOrderId, orderId, errors }
   */
  async importOrder(amazonOrder) {
    const result = {
      success: false,
      amazonOrderId: amazonOrder.AmazonOrderId,
      odooOrderId: null,
      odooOrderName: null,
      errors: [],
      warnings: []
    };

    try {
      // Step 1: Check if order already exists in Odoo
      const existingOrder = await this.findExistingOrder(amazonOrder.AmazonOrderId);
      if (existingOrder) {
        result.success = true;
        result.odooOrderId = existingOrder.id;
        result.odooOrderName = existingOrder.name;
        result.warnings.push('Order already exists in Odoo');
        return result;
      }

      // Step 2: Determine order configuration
      const config = this.getOrderConfig(amazonOrder);

      // Step 3: Resolve products
      const orderLines = await this.resolveOrderLines(amazonOrder.OrderItems || []);
      if (orderLines.errors.length > 0) {
        result.errors.push(...orderLines.errors);
        // Continue with valid lines, warn about skipped ones
      }

      if (orderLines.lines.length === 0) {
        result.errors.push('No valid order lines found');
        return result;
      }

      // Step 4: Find or create customer
      const partnerId = await this.findOrCreateCustomer(amazonOrder, config);

      // Step 5: Find warehouse
      const warehouseId = await this.findWarehouse(config.fulfillmentType, config.shipFromCountry);

      // Step 6: Find fiscal position
      const fiscalPositionId = await this.findFiscalPosition(config.fiscalPosition);

      // Step 7: Create Sale Order
      const orderData = {
        name: this.generateOrderName(amazonOrder, config),
        partner_id: partnerId,
        client_order_ref: amazonOrder.AmazonOrderId,
        warehouse_id: warehouseId,
        fiscal_position_id: fiscalPositionId,
        date_order: amazonOrder.PurchaseDate,
        order_line: orderLines.lines.map(line => [0, 0, line]),
        // Custom fields for Amazon tracking
        x_amazon_order_id: amazonOrder.AmazonOrderId,
        x_amazon_marketplace: amazonOrder.MarketplaceId,
        x_amazon_fulfillment: config.fulfillmentType,
        x_amazon_ship_from: config.shipFromCountry,
      };

      const orderId = await this.odoo.create('sale.order', orderData);

      result.success = true;
      result.odooOrderId = orderId;
      result.odooOrderName = orderData.name;
      result.config = config;
      result.linesImported = orderLines.lines.length;
      result.linesSkipped = orderLines.errors.length;

      // Step 8: For FBA orders, auto-confirm and mark delivered
      if (config.fulfillmentType === 'FBA') {
        await this.confirmAndDeliverFba(orderId);
        result.autoConfirmed = true;
      }

      // Log to database
      await this.logImport(result, amazonOrder);

      return result;
    } catch (error) {
      result.errors.push(error.message);
      await this.logImport(result, amazonOrder, error);
      return result;
    }
  }

  /**
   * Determine order configuration based on Amazon order data
   */
  getOrderConfig(amazonOrder) {
    const marketplaceId = amazonOrder.MarketplaceId;
    const fulfillmentChannel = amazonOrder.FulfillmentChannel; // 'AFN' (FBA) or 'MFN' (FBM)
    const fulfillmentCenter = amazonOrder.FulfillmentCenterId || null;

    // Get buyer country from shipping address
    const buyerCountry = amazonOrder.ShippingAddress?.CountryCode ||
                         amazonOrder.BuyerInfo?.BuyerCountry ||
                         euCountryConfig.getCountryFromMarketplace(marketplaceId);

    // Get buyer VAT if B2B
    const buyerVat = amazonOrder.BuyerInfo?.BuyerTaxRegistrationId ||
                     amazonOrder.BuyerInfo?.BuyerVATNumber ||
                     null;

    // Get invoice config (journal, fiscal position, ship-from)
    const invoiceConfig = euCountryConfig.getInvoiceConfig({
      marketplaceId,
      fulfillmentCenter,
      buyerCountry,
      buyerVat
    });

    return {
      ...invoiceConfig,
      fulfillmentType: fulfillmentChannel === 'AFN' ? 'FBA' : 'FBM',
      marketplaceId,
      currency: amazonOrder.OrderTotal?.CurrencyCode || 'EUR'
    };
  }

  /**
   * Resolve Amazon order items to Odoo products
   */
  async resolveOrderLines(orderItems) {
    const lines = [];
    const errors = [];

    for (const item of orderItems) {
      try {
        const amazonSku = item.SellerSKU;
        const resolved = skuResolver.resolve(amazonSku);

        if (!resolved.odooSku) {
          errors.push(`Could not resolve SKU: ${amazonSku}`);
          continue;
        }

        // Find product in Odoo
        const productId = await this.findProduct(resolved.odooSku);
        if (!productId) {
          errors.push(`Product not found in Odoo: ${resolved.odooSku} (from ${amazonSku})`);
          continue;
        }

        // Create order line
        lines.push({
          product_id: productId,
          product_uom_qty: parseInt(item.QuantityOrdered) || 1,
          price_unit: parseFloat(item.ItemPrice?.Amount) / (parseInt(item.QuantityOrdered) || 1) || 0,
          name: item.Title || resolved.odooSku,
          // Store original Amazon data
          x_amazon_sku: amazonSku,
          x_amazon_asin: item.ASIN,
          x_is_return: resolved.isReturn
        });
      } catch (error) {
        errors.push(`Error processing item ${item.SellerSKU}: ${error.message}`);
      }
    }

    return { lines, errors };
  }

  /**
   * Find existing order by Amazon Order ID
   */
  async findExistingOrder(amazonOrderId) {
    const orders = await this.odoo.search('sale.order', [
      ['client_order_ref', '=', amazonOrderId]
    ], { limit: 1 });

    if (orders.length > 0) {
      const order = await this.odoo.read('sale.order', orders[0], ['id', 'name']);
      return order;
    }
    return null;
  }

  /**
   * Find or create customer for the order
   */
  async findOrCreateCustomer(amazonOrder, config) {
    // For B2C, use generic country customer
    if (!config.isB2B) {
      const genericName = config.genericCustomer; // e.g., "Amazon | AMZ_B2C_DE"
      const existing = await this.odoo.search('res.partner', [
        ['name', '=', genericName]
      ], { limit: 1 });

      if (existing.length > 0) {
        return existing[0];
      }

      // Create generic customer if not exists
      return await this.odoo.create('res.partner', {
        name: genericName,
        company_type: 'company',
        customer_rank: 1,
        country_id: await this.getCountryId(config.buyerCountry),
        is_company: true
      });
    }

    // For B2B, create/find specific customer with VAT
    const buyerInfo = amazonOrder.BuyerInfo;
    const vatNumber = buyerInfo?.BuyerTaxRegistrationId || buyerInfo?.BuyerVATNumber;

    // Search by VAT
    if (vatNumber) {
      const byVat = await this.odoo.search('res.partner', [
        ['vat', '=', vatNumber]
      ], { limit: 1 });

      if (byVat.length > 0) {
        return byVat[0];
      }
    }

    // Create B2B customer
    const companyName = amazonOrder.ShippingAddress?.Name ||
                        amazonOrder.BuyerInfo?.BuyerName ||
                        `Amazon B2B - ${amazonOrder.AmazonOrderId}`;

    return await this.odoo.create('res.partner', {
      name: companyName,
      company_type: 'company',
      customer_rank: 1,
      vat: vatNumber,
      country_id: await this.getCountryId(config.buyerCountry),
      street: amazonOrder.ShippingAddress?.AddressLine1,
      street2: amazonOrder.ShippingAddress?.AddressLine2,
      city: amazonOrder.ShippingAddress?.City,
      zip: amazonOrder.ShippingAddress?.PostalCode,
      is_company: true
    });
  }

  /**
   * Find product by Odoo SKU (default_code)
   */
  async findProduct(odooSku) {
    const products = await this.odoo.search('product.product', [
      ['default_code', '=', odooSku]
    ], { limit: 1 });

    return products.length > 0 ? products[0] : null;
  }

  /**
   * Find warehouse for the order
   * IMPORTANT: For FBA orders, we must use the correct FBA warehouse.
   * Never fall back to Central Warehouse for FBA orders.
   */
  async findWarehouse(fulfillmentType, shipFromCountry) {
    let warehouseCode;

    if (fulfillmentType === 'FBA') {
      // FBA warehouses: de1, fr1, it1, etc.
      warehouseCode = euCountryConfig.getOdooFbaWarehouseCode(shipFromCountry);
    } else {
      // FBM: Main warehouse (be1 or similar)
      warehouseCode = 'be1'; // Default to Belgium
    }

    const warehouses = await this.odoo.search('stock.warehouse', [
      ['code', '=', warehouseCode]
    ], { limit: 1 });

    if (warehouses.length === 0) {
      if (fulfillmentType === 'FBA') {
        // FBA orders must use correct FBA warehouse - never fall back to Central Warehouse
        throw new Error(`FBA warehouse '${warehouseCode}' not found in Odoo. Please create it before processing orders from ${shipFromCountry}.`);
      }
      // For FBM, fallback to default warehouse is acceptable
      const defaultWh = await this.odoo.search('stock.warehouse', [], { limit: 1 });
      return defaultWh[0];
    }

    return warehouses[0];
  }

  /**
   * Find fiscal position by name pattern
   */
  async findFiscalPosition(fiscalPositionName) {
    // Try exact match first
    let fps = await this.odoo.search('account.fiscal.position', [
      ['name', '=', fiscalPositionName]
    ], { limit: 1 });

    if (fps.length > 0) return fps[0];

    // Try partial match
    fps = await this.odoo.search('account.fiscal.position', [
      ['name', 'ilike', fiscalPositionName.split('|')[0].trim()]
    ], { limit: 1 });

    if (fps.length > 0) return fps[0];

    // Return null if not found (Odoo will use default)
    return null;
  }

  /**
   * Get country ID from country code
   */
  async getCountryId(countryCode) {
    const countries = await this.odoo.search('res.country', [
      ['code', '=', countryCode]
    ], { limit: 1 });

    return countries.length > 0 ? countries[0] : null;
  }

  /**
   * Generate order name/reference
   */
  generateOrderName(amazonOrder, config) {
    const prefix = config.fulfillmentType === 'FBA' ? 'FBA' : 'FBM';
    return `${prefix}/${amazonOrder.AmazonOrderId}`;
  }

  /**
   * Confirm order and create delivery for FBA
   */
  async confirmAndDeliverFba(orderId) {
    // Confirm the sale order
    await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);

    // Find the delivery order
    const pickings = await this.odoo.search('stock.picking', [
      ['sale_id', '=', orderId],
      ['state', 'not in', ['done', 'cancel']]
    ]);

    // Validate all pickings (mark as delivered)
    for (const pickingId of pickings) {
      try {
        // Set quantities done = expected
        await this.odoo.execute('stock.picking', 'action_set_quantities_to_reservation', [[pickingId]]);
        // Validate
        await this.odoo.execute('stock.picking', 'button_validate', [[pickingId]]);
      } catch (error) {
        console.warn(`[OrderImporter] Could not auto-validate picking ${pickingId}:`, error.message);
      }
    }
  }

  /**
   * Log import to database
   */
  async logImport(result, amazonOrder, error = null) {
    if (!this.db) return;

    try {
      await this.db.collection('amazon_order_imports').insertOne({
        amazonOrderId: result.amazonOrderId,
        odooOrderId: result.odooOrderId,
        odooOrderName: result.odooOrderName,
        success: result.success,
        errors: result.errors,
        warnings: result.warnings,
        config: result.config,
        rawOrder: amazonOrder,
        error: error ? error.message : null,
        importedAt: new Date()
      });
    } catch (logError) {
      console.error('[OrderImporter] Failed to log import:', logError);
    }
  }

  /**
   * Bulk import orders
   * @param {object[]} orders - Array of Amazon orders
   * @returns {object} { imported, failed, results }
   */
  async importOrders(orders) {
    const results = [];
    let imported = 0;
    let failed = 0;

    for (const order of orders) {
      const result = await this.importOrder(order);
      results.push(result);

      if (result.success) {
        imported++;
      } else {
        failed++;
      }
    }

    return { imported, failed, total: orders.length, results };
  }

  /**
   * Get import statistics
   */
  async getStats(days = 30) {
    if (!this.db) return null;

    const since = new Date();
    since.setDate(since.getDate() - days);

    const stats = await this.db.collection('amazon_order_imports').aggregate([
      { $match: { importedAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          success: { $sum: { $cond: ['$success', 1, 0] } },
          failed: { $sum: { $cond: ['$success', 0, 1] } }
        }
      }
    ]).toArray();

    return stats[0] || { total: 0, success: 0, failed: 0 };
  }
}

module.exports = { OrderImporter };
