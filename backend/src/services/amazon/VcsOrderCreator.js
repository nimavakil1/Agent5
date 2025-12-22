/**
 * VCS Order Creator
 *
 * Creates Odoo Sales Orders from Amazon VCS Tax Report data for orders that
 * don't exist in Odoo (weren't synced via Make.com).
 *
 * Key features:
 * - For B2C: Uses generic Amazon customers (e.g., "Amazon | AMZ_B2C_DE")
 * - For B2B: Creates/finds customer with VAT number, name, address
 * - Sets correct warehouse, fiscal position, journal based on ship-from country
 * - Links order lines to products via SKU matching
 */

const { getDb } = require('../../db');
const { ObjectId } = require('mongodb');
const { euCountryConfig } = require('./EuCountryConfig');
const { skuResolver } = require('./SkuResolver');

// Marketplace to Sales Team ID mapping (Odoo crm.team IDs)
const MARKETPLACE_SALES_TEAMS = {
  'DE': 17,  // Amazon DE
  'FR': 19,  // Amazon FR
  'IT': 20,  // Amazon IT
  'ES': 18,  // Amazon ES
  'NL': 21,  // Amazon NL
  'PL': 22,  // Amazon PL
  'BE': 16,  // Amazon BE
  'SE': 24,  // Amazon SE
  'GB': 25,  // Amazon UK
  'UK': 25,  // Alias for GB
};

// Generic B2C customer IDs by country (Amazon | AMZ_B2C_XX)
// Will be populated from Odoo cache
const B2C_CUSTOMER_CACHE = {};

// OSS partner IDs (for OSS orders) - from VcsOdooInvoicer
const OSS_PARTNERS = {
  'AT': 18,    // Amazon | AMZ_OSS_AT
  'BE': 3192,  // Amazon | AMZ_OSS_BE
  'BG': 3169,  // Amazon | AMZ_OSS_BG
  'CY': 21,    // Amazon | AMZ_OSS_CY
  'CZ': 3152,  // Amazon | AMZ_OSS_CZ
  'DE': 3157,  // Amazon | AMZ_OSS_DE
  'DK': 3153,  // Amazon | AMZ_OSS_DK
  'EE': 3160,  // Amazon | AMZ_OSS_EE
  'ES': 3165,  // Amazon | AMZ_OSS_ES
  'FI': 3155,  // Amazon | AMZ_OSS_FI
  'FR': 3156,  // Amazon | AMZ_OSS_FR
  'GR': 3170,  // Amazon | AMZ_OSS_GR
  'HR': 3162,  // Amazon | AMZ_OSS_HR
  'HU': 3178,  // Amazon | AMZ_OSS_HU
  'IE': 3171,  // Amazon | AMZ_OSS_IE
  'IT': 3164,  // Amazon | AMZ_OSS_IT
  'LT': 3168,  // Amazon | AMZ_OSS_LT
  'LU': 3163,  // Amazon | AMZ_OSS_LU
  'LV': 3166,  // Amazon | AMZ_OSS_LV
  'MT': 3172,  // Amazon | AMZ_OSS_MT
  'NL': 3173,  // Amazon | AMZ_OSS_NL
  'PL': 3174,  // Amazon | AMZ_OSS_PL
  'PT': 3167,  // Amazon | AMZ_OSS_PT
  'RO': 3161,  // Amazon | AMZ_OSS_RO
  'SE': 3177,  // Amazon | AMZ_OSS_SE
  'SI': 3176,  // Amazon | AMZ_OSS_SI
  'SK': 3175,  // Amazon | AMZ_OSS_SK
};

// OSS Fiscal Position IDs by country (from VcsOdooInvoicer)
const OSS_FISCAL_POSITIONS = {
  'AT': 6, 'BG': 7, 'HR': 8, 'CY': 9, 'CZ': 10, 'DK': 11, 'EE': 12, 'FI': 13,
  'FR': 14, 'DE': 15, 'GR': 16, 'HU': 17, 'IE': 18, 'IT': 19, 'LV': 20, 'LT': 21,
  'LU': 22, 'MT': 23, 'NL': 24, 'PL': 25, 'PT': 26, 'RO': 27, 'SK': 28, 'SI': 29,
  'ES': 30, 'SE': 31, 'BE': 35,
};

// Journal IDs
const JOURNALS = {
  EXPORT: 52,  // INV*EX/ Export Invoices
  OSS: 12,     // INV*OSS/ Invoices
};

// Export fiscal position ID
const EXPORT_FISCAL_POSITION = 4;  // Export | Export

// Tax IDs for 0% exports
const EXPORT_TAX_IDS = {
  'BE*VAT | 0% EX': 13,
  'CZ*VAT | 0% EU': 193,
};

// OSS Tax IDs by country
const OSS_TAX_IDS = {
  'AT': 55,  // AT*VAT | 20%
  'BG': 72,  // BG*VAT | 20%
  'CY': 79,  // CY*VAT | 19%
  'CZ': 82,  // CZ*VAT | 21%
  'DE': 108, // DE*VAT | 19%
  'DK': 85,  // DK*VAT | 25%
  'EE': 88,  // EE*VAT | 22%
  'ES': 132, // ES*VAT | 21%
  'FI': 91,  // FI*VAT | 25.5%
  'FR': 94,  // FR*VAT | 20%
  'GR': 98,  // GR*VAT | 24%
  'HR': 105, // HR*VAT | 25%
  'HU': 101, // HU*VAT | 27%
  'IE': 112, // IE*VAT | 23%
  'IT': 115, // IT*VAT | 22%
  'LT': 122, // LT*VAT | 21%
  'LU': 125, // LU*VAT | 17%
  'LV': 119, // LV*VAT | 21%
  'MT': 128, // MT*VAT | 18%
  'NL': 141, // NL*VAT | 21%
  'PL': 144, // PL*VAT | 23%
  'PT': 147, // PT*VAT | 23%
  'RO': 150, // RO*VAT | 19%
  'SE': 159, // SE*VAT | 25%
  'SI': 153, // SI*VAT | 22%
  'SK': 156, // SK*VAT | 20%
  'BE': 21,  // BE*VAT | 21%
};

// EU countries
const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

class VcsOrderCreator {
  constructor(odooClient, options = {}) {
    this.odoo = odooClient;
    this.options = options;
    this.warehouseCache = {};
    this.countryCache = {};
    this.productCache = {};
  }

  /**
   * Create Odoo orders for selected VCS orders that don't have Odoo orders
   * @param {object} options
   * @param {string[]} options.orderIds - MongoDB IDs of VCS orders to process
   * @param {boolean} options.dryRun - If true, don't create orders
   * @returns {object} Results
   */
  async createOrders(options = {}) {
    const { orderIds = [], dryRun = false } = options;
    const db = getDb();

    const result = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      orders: [],
    };

    if (orderIds.length === 0) {
      return { ...result, message: 'No orders selected' };
    }

    // Get selected orders
    const orders = await db.collection('amazon_vcs_orders')
      .find({ _id: { $in: orderIds.map(id => new ObjectId(id)) } })
      .toArray();

    if (orders.length === 0) {
      return { ...result, message: 'No orders found for the given IDs' };
    }

    // Load caches
    await this.loadCaches();

    for (const vcsOrder of orders) {
      result.processed++;

      try {
        // Skip if order already exists in Odoo
        const existingOrder = await this.findExistingOrder(vcsOrder.orderId);
        if (existingOrder) {
          result.skipped++;
          result.orders.push({
            orderId: vcsOrder.orderId,
            skipped: true,
            reason: `Order already exists in Odoo: ${existingOrder.name}`,
            odooOrderId: existingOrder.id,
            odooOrderName: existingOrder.name,
          });
          // Update MongoDB with the Odoo order info
          await db.collection('amazon_vcs_orders').updateOne(
            { _id: vcsOrder._id },
            { $set: { odooSaleOrderId: existingOrder.id, odooSaleOrderName: existingOrder.name } }
          );
          continue;
        }

        // Skip returns - they should be handled by credit note creation
        if (vcsOrder.transactionType === 'RETURN') {
          result.skipped++;
          result.orders.push({
            orderId: vcsOrder.orderId,
            skipped: true,
            reason: 'Returns should be handled by credit note creation',
          });
          continue;
        }

        // Determine order configuration
        const config = await this.getOrderConfig(vcsOrder);

        // Find/create customer
        const partnerId = await this.findOrCreateCustomer(vcsOrder, config);

        // Resolve order lines
        const orderLines = await this.resolveOrderLines(vcsOrder, config);
        if (orderLines.lines.length === 0 && orderLines.errors.length > 0) {
          result.errors.push({
            orderId: vcsOrder.orderId,
            error: `No valid products found: ${orderLines.errors.join(', ')}`,
          });
          continue;
        }

        if (dryRun) {
          result.orders.push({
            orderId: vcsOrder.orderId,
            dryRun: true,
            preview: {
              partner: config.isB2B ? 'B2B Customer' : config.genericCustomer,
              warehouse: config.warehouseCode,
              fiscalPosition: config.fiscalPositionName,
              shipFrom: config.shipFromCountry,
              shipTo: vcsOrder.shipToCountry,
              lines: orderLines.lines.length,
              errors: orderLines.errors,
              totalExclVat: vcsOrder.totalExclusive,
              totalTax: vcsOrder.totalTax,
            },
          });
          continue;
        }

        // Create the order
        const createdOrder = await this.createOrder(vcsOrder, partnerId, config, orderLines);
        result.created++;
        result.orders.push(createdOrder);

        // Update MongoDB with Odoo order info
        await db.collection('amazon_vcs_orders').updateOne(
          { _id: vcsOrder._id },
          {
            $set: {
              odooSaleOrderId: createdOrder.id,
              odooSaleOrderName: createdOrder.name,
              orderCreatedAt: new Date(),
            }
          }
        );

      } catch (error) {
        result.errors.push({
          orderId: vcsOrder.orderId,
          error: error.message,
        });
        console.error(`[VcsOrderCreator] Error processing ${vcsOrder.orderId}:`, error);
      }
    }

    return result;
  }

  /**
   * Find existing order by Amazon Order ID
   */
  async findExistingOrder(amazonOrderId) {
    const orders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', amazonOrderId]],
      ['id', 'name', 'state']
    );

    return orders.length > 0 ? orders[0] : null;
  }

  /**
   * Determine order configuration based on VCS order data
   */
  async getOrderConfig(vcsOrder) {
    const shipFromCountry = vcsOrder.shipFromCountry || 'BE';
    const shipToCountry = vcsOrder.shipToCountry || shipFromCountry;
    const buyerVat = vcsOrder.buyerTaxRegistration || null;
    const isB2B = !!buyerVat && buyerVat.length > 5;
    const isOSS = vcsOrder.taxReportingScheme === 'VCS_EU_OSS';
    const isExport = !EU_COUNTRIES.includes(shipToCountry) ||
                     vcsOrder.taxReportingScheme === 'DEEMED_RESELLER' ||
                     vcsOrder.taxReportingScheme === 'CH_VOEC';

    // Get warehouse
    const warehouseCode = this.getWarehouseCode(shipFromCountry);
    const warehouseId = await this.findWarehouse(warehouseCode);

    // Get fiscal position
    let fiscalPositionId = null;
    let fiscalPositionName = null;

    if (isExport) {
      // Export orders use the Export fiscal position
      fiscalPositionId = EXPORT_FISCAL_POSITION;
      fiscalPositionName = 'Export | Export';
    } else if (isOSS && OSS_FISCAL_POSITIONS[shipToCountry]) {
      fiscalPositionId = OSS_FISCAL_POSITIONS[shipToCountry];
      fiscalPositionName = `${shipToCountry}*OSS | B2C ${euCountryConfig.getCountryName(shipToCountry)}`;
    }

    // Determine tax ID based on tax scheme
    let taxId = null;
    if (isExport) {
      // Use 0% export tax
      taxId = EXPORT_TAX_IDS['BE*VAT | 0% EX'];
    } else if (isOSS && OSS_TAX_IDS[shipToCountry]) {
      // Use the OSS tax for the destination country
      taxId = OSS_TAX_IDS[shipToCountry];
    }

    // Determine journal
    let journalId = null;
    if (isExport) {
      journalId = JOURNALS.EXPORT;
    } else if (isOSS) {
      journalId = JOURNALS.OSS;
    }

    // Get generic customer name for B2C
    const genericCustomer = isOSS
      ? `Amazon | AMZ_OSS_${shipToCountry}`
      : `Amazon | AMZ_B2C_${shipToCountry}`;

    // Get sales team
    const marketplace = vcsOrder.marketplaceId || shipToCountry;
    const teamId = MARKETPLACE_SALES_TEAMS[marketplace] || null;

    console.log(`[VcsOrderCreator] Order config for ${vcsOrder.orderId}: scheme=${vcsOrder.taxReportingScheme}, isExport=${isExport}, isOSS=${isOSS}, taxId=${taxId}, journalId=${journalId}, fiscalPositionId=${fiscalPositionId}`);

    return {
      shipFromCountry,
      shipToCountry,
      buyerVat,
      isB2B,
      isOSS,
      isExport,
      warehouseCode,
      warehouseId,
      fiscalPositionId,
      fiscalPositionName,
      genericCustomer,
      teamId,
      taxId,
      journalId,
      taxReportingScheme: vcsOrder.taxReportingScheme,
    };
  }

  /**
   * Get warehouse code for a country
   */
  getWarehouseCode(countryCode) {
    // FBA warehouses are named: de1, fr1, it1, etc.
    return `${countryCode.toLowerCase()}1`;
  }

  /**
   * Find warehouse by code
   */
  async findWarehouse(warehouseCode) {
    if (this.warehouseCache[warehouseCode]) {
      return this.warehouseCache[warehouseCode];
    }

    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['code', '=', warehouseCode]],
      ['id', 'name']
    );

    if (warehouses.length > 0) {
      this.warehouseCache[warehouseCode] = warehouses[0].id;
      return warehouses[0].id;
    }

    // Fallback to first warehouse
    const defaultWh = await this.odoo.searchRead('stock.warehouse', [], ['id', 'name'], 0, 1);
    if (defaultWh.length > 0) {
      this.warehouseCache[warehouseCode] = defaultWh[0].id;
      return defaultWh[0].id;
    }

    return null;
  }

  /**
   * Find or create customer for the order
   */
  async findOrCreateCustomer(vcsOrder, config) {
    // For B2B, find/create customer with VAT
    if (config.isB2B) {
      return await this.findOrCreateB2BCustomer(vcsOrder, config);
    }

    // For B2C OSS, use OSS partners
    if (config.isOSS && OSS_PARTNERS[config.shipToCountry]) {
      return OSS_PARTNERS[config.shipToCountry];
    }

    // For B2C, use generic customer
    return await this.findOrCreateGenericCustomer(config.genericCustomer, config.shipToCountry);
  }

  /**
   * Find or create a B2B customer with VAT number
   */
  async findOrCreateB2BCustomer(vcsOrder, config) {
    const vatNumber = config.buyerVat;

    // Search by VAT number first
    if (vatNumber) {
      const byVat = await this.odoo.searchRead('res.partner',
        [['vat', '=', vatNumber]],
        ['id', 'name']
      );

      if (byVat.length > 0) {
        console.log(`[VcsOrderCreator] Found existing B2B customer by VAT ${vatNumber}: ${byVat[0].name}`);
        return byVat[0].id;
      }
    }

    // Get country ID
    const countryId = await this.getCountryId(config.shipToCountry);

    // Create new B2B customer
    const customerName = vcsOrder.buyerName ||
                         vcsOrder.buyerCompany ||
                         `Amazon B2B - ${vcsOrder.orderId}`;

    console.log(`[VcsOrderCreator] Creating B2B customer: ${customerName}`);

    const partnerId = await this.odoo.create('res.partner', {
      name: customerName,
      company_type: 'company',
      is_company: true,
      customer_rank: 1,
      vat: vatNumber,
      country_id: countryId,
      street: vcsOrder.buyerAddress?.street || null,
      street2: vcsOrder.buyerAddress?.street2 || null,
      city: vcsOrder.buyerAddress?.city || null,
      zip: vcsOrder.buyerAddress?.postalCode || null,
      comment: `Created from Amazon VCS order ${vcsOrder.orderId}`,
    });

    return partnerId;
  }

  /**
   * Find or create a generic B2C customer
   */
  async findOrCreateGenericCustomer(customerName, countryCode) {
    // Check cache
    if (B2C_CUSTOMER_CACHE[customerName]) {
      return B2C_CUSTOMER_CACHE[customerName];
    }

    // Search for existing customer
    const existing = await this.odoo.searchRead('res.partner',
      [['name', '=', customerName]],
      ['id']
    );

    if (existing.length > 0) {
      B2C_CUSTOMER_CACHE[customerName] = existing[0].id;
      return existing[0].id;
    }

    // Get country ID
    const countryId = await this.getCountryId(countryCode);

    // Create generic customer
    console.log(`[VcsOrderCreator] Creating generic customer: ${customerName}`);

    const partnerId = await this.odoo.create('res.partner', {
      name: customerName,
      company_type: 'company',
      is_company: true,
      customer_rank: 1,
      country_id: countryId,
      comment: 'Generic Amazon B2C customer for VCS orders',
    });

    B2C_CUSTOMER_CACHE[customerName] = partnerId;
    return partnerId;
  }

  /**
   * Get country ID from country code
   */
  async getCountryId(countryCode) {
    if (this.countryCache[countryCode]) {
      return this.countryCache[countryCode];
    }

    const countries = await this.odoo.searchRead('res.country',
      [['code', '=', countryCode]],
      ['id']
    );

    if (countries.length > 0) {
      this.countryCache[countryCode] = countries[0].id;
      return countries[0].id;
    }

    return null;
  }

  /**
   * Resolve VCS order items to Odoo order lines
   * @param {object} vcsOrder - The VCS order
   * @param {object} config - The order configuration with taxId
   */
  async resolveOrderLines(vcsOrder, config) {
    const lines = [];
    const errors = [];

    if (!vcsOrder.items || vcsOrder.items.length === 0) {
      errors.push('No items in order');
      return { lines, errors };
    }

    // Ensure skuResolver is loaded
    if (!skuResolver.loaded) {
      await skuResolver.load();
    }

    for (const item of vcsOrder.items) {
      try {
        const amazonSku = item.sku;

        // Use SkuResolver to transform the SKU
        const resolved = skuResolver.resolve(amazonSku);
        const transformedSku = resolved.odooSku;

        console.log(`[VcsOrderCreator] SKU: ${amazonSku} -> ${transformedSku} (${resolved.matchType})`);

        // Find product in Odoo
        const productId = await this.findProduct(transformedSku, amazonSku);
        if (!productId) {
          errors.push(`Product not found: ${amazonSku} (transformed: ${transformedSku})`);
          continue;
        }

        // Calculate unit price (VCS gives total price exclusive of VAT)
        const quantity = Math.abs(item.quantity) || 1;
        const priceUnit = (Math.abs(item.priceExclusive) || 0) / quantity;

        const lineData = {
          product_id: productId,
          product_uom_qty: quantity,
          price_unit: priceUnit,
          name: item.productName || transformedSku,
        };

        // Add tax_id if we have one - format: [[6, 0, [taxId]]] replaces existing taxes
        if (config.taxId) {
          lineData.tax_id = [[6, 0, [config.taxId]]];
        }

        lines.push(lineData);

      } catch (error) {
        errors.push(`Error processing SKU ${item.sku}: ${error.message}`);
      }
    }

    // Add shipping line if there's shipping cost
    if (vcsOrder.totalShipping && vcsOrder.totalShipping > 0) {
      const shippingProductId = await this.findShippingProduct();
      if (shippingProductId) {
        const shippingLine = {
          product_id: shippingProductId,
          product_uom_qty: 1,
          price_unit: vcsOrder.totalShipping,
          name: 'Shipping',
        };
        if (config.taxId) {
          shippingLine.tax_id = [[6, 0, [config.taxId]]];
        }
        lines.push(shippingLine);
      }
    }

    // Add shipping discount if there's a promo
    if (vcsOrder.totalShippingPromo && vcsOrder.totalShippingPromo !== 0) {
      const shippingDiscountProductId = await this.findShippingDiscountProduct();
      if (shippingDiscountProductId) {
        const discountLine = {
          product_id: shippingDiscountProductId,
          product_uom_qty: 1,
          price_unit: -Math.abs(vcsOrder.totalShippingPromo),
          name: 'Shipping Discount',
        };
        if (config.taxId) {
          discountLine.tax_id = [[6, 0, [config.taxId]]];
        }
        lines.push(discountLine);
      }
    }

    return { lines, errors };
  }

  /**
   * Find product by SKU
   */
  async findProduct(transformedSku, originalSku) {
    // Check cache
    const cacheKey = `${transformedSku}|${originalSku}`;
    if (this.productCache[cacheKey]) {
      return this.productCache[cacheKey];
    }

    // Try transformed SKU first
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

    // Try partial match with ilike
    products = await this.odoo.searchRead('product.product',
      [['default_code', 'ilike', transformedSku]],
      ['id', 'default_code'],
      0, 5
    );

    if (products.length > 0) {
      // Return exact match if found, otherwise first result
      const exactMatch = products.find(p => p.default_code === transformedSku);
      const productId = exactMatch ? exactMatch.id : products[0].id;
      this.productCache[cacheKey] = productId;
      return productId;
    }

    return null;
  }

  /**
   * Find shipping product
   */
  async findShippingProduct() {
    if (this.productCache['_shipping']) {
      return this.productCache['_shipping'];
    }

    // Search for shipping product by name patterns
    const patterns = ['SHIP AMAZON', 'Amazon Shipping', 'Shipping'];
    for (const pattern of patterns) {
      const products = await this.odoo.searchRead('product.product',
        [['name', 'ilike', pattern]],
        ['id']
      );
      if (products.length > 0) {
        this.productCache['_shipping'] = products[0].id;
        return products[0].id;
      }
    }

    // Try product ID 16401 (known SHIP AMAZON product)
    try {
      const product = await this.odoo.searchRead('product.product',
        [['id', '=', 16401]],
        ['id']
      );
      if (product.length > 0) {
        this.productCache['_shipping'] = 16401;
        return 16401;
      }
    } catch (e) {
      // Product doesn't exist
    }

    return null;
  }

  /**
   * Find shipping discount product
   */
  async findShippingDiscountProduct() {
    if (this.productCache['_shipping_discount']) {
      return this.productCache['_shipping_discount'];
    }

    // Search for shipping discount product
    const patterns = ['Shipment Discount', 'Shipping Discount'];
    for (const pattern of patterns) {
      const products = await this.odoo.searchRead('product.product',
        [['name', 'ilike', pattern]],
        ['id']
      );
      if (products.length > 0) {
        this.productCache['_shipping_discount'] = products[0].id;
        return products[0].id;
      }
    }

    // Try product ID 16405 (known shipping discount product)
    try {
      const product = await this.odoo.searchRead('product.product',
        [['id', '=', 16405]],
        ['id']
      );
      if (product.length > 0) {
        this.productCache['_shipping_discount'] = 16405;
        return 16405;
      }
    } catch (e) {
      // Product doesn't exist
    }

    return null;
  }

  /**
   * Create the Sale Order in Odoo
   */
  async createOrder(vcsOrder, partnerId, config, orderLines) {
    console.log(`[VcsOrderCreator] Creating order for ${vcsOrder.orderId}...`);

    // Determine fulfillment type from VCS data
    // If ship-from is FBA warehouse, it's FBA
    const isFBA = vcsOrder.fulfillmentCenter ||
                  vcsOrder.shipFromCountry !== 'BE' ||
                  vcsOrder.taxReportingScheme === 'VCS_EU_OSS';

    // Generate order name
    const orderPrefix = isFBA ? 'FBA' : 'FBM';
    const orderName = `${orderPrefix}${vcsOrder.orderId}`;

    // Build order lines in Odoo format
    const odooLines = orderLines.lines.map(line => [0, 0, line]);

    // Create the order
    const orderData = {
      name: orderName,
      partner_id: partnerId,
      partner_invoice_id: partnerId,  // Invoice address (required by Odoo)
      partner_shipping_id: partnerId, // Shipping address
      client_order_ref: vcsOrder.orderId,
      date_order: this.formatDate(vcsOrder.orderDate || vcsOrder.shipmentDate),
      warehouse_id: config.warehouseId,
      order_line: odooLines,
    };

    // Add fiscal position if set
    if (config.fiscalPositionId) {
      orderData.fiscal_position_id = config.fiscalPositionId;
    }

    // Add sales team if set
    if (config.teamId) {
      orderData.team_id = config.teamId;
    }

    // Create the order
    const orderId = await this.odoo.create('sale.order', orderData);

    console.log(`[VcsOrderCreator] Created order ${orderName} (ID: ${orderId})`);

    // VCS orders are already shipped - always confirm and deliver
    // This is necessary to update stock levels in Odoo
    const deliveryResult = await this.confirmAndDeliver(orderId, vcsOrder);

    return {
      id: orderId,
      name: orderName,
      orderId: vcsOrder.orderId,
      partnerId,
      warehouseId: config.warehouseId,
      isFBA,
      linesCreated: orderLines.lines.length,
      lineErrors: orderLines.errors,
      deliveryValidated: deliveryResult.success,
      deliveryError: deliveryResult.error,
    };
  }

  /**
   * Confirm order and create/validate delivery
   * VCS orders are already shipped so we need to update stock levels
   * @param {number} orderId - Odoo sale.order ID
   * @param {object} vcsOrder - The VCS order data for shipment date
   * @returns {object} Result with success boolean and optional error
   */
  async confirmAndDeliver(orderId, vcsOrder) {
    const result = { success: false, error: null, pickingsValidated: 0 };

    try {
      // Confirm the sale order
      await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);
      console.log(`[VcsOrderCreator] Confirmed order ${orderId}`);

      // Find all delivery orders for this sale
      const pickings = await this.odoo.searchRead('stock.picking',
        [['sale_id', '=', orderId], ['state', 'not in', ['done', 'cancel']]],
        ['id', 'name', 'state', 'move_ids_without_package']
      );

      if (pickings.length === 0) {
        console.warn(`[VcsOrderCreator] No pickings found for order ${orderId}`);
        result.error = 'No delivery orders found';
        return result;
      }

      console.log(`[VcsOrderCreator] Found ${pickings.length} picking(s) for order ${orderId}`);

      // Validate all pickings (mark as delivered)
      for (const picking of pickings) {
        try {
          // Set quantities to what was reserved
          await this.odoo.execute('stock.picking', 'action_set_quantities_to_reservation', [[picking.id]]);
          console.log(`[VcsOrderCreator] Set quantities for picking ${picking.id} (${picking.name})`);

          // Validate the picking
          try {
            await this.odoo.execute('stock.picking', 'button_validate', [[picking.id]]);
            console.log(`[VcsOrderCreator] Validated picking ${picking.id} (${picking.name})`);
            result.pickingsValidated++;
          } catch (validateError) {
            // Some pickings might require a backorder wizard - try to process it
            if (validateError.message && validateError.message.includes('ir.actions.act_window')) {
              // This means Odoo wants to show a wizard, try action_done instead
              await this.odoo.execute('stock.picking', 'action_done', [[picking.id]]);
              console.log(`[VcsOrderCreator] Force-validated picking ${picking.id} with action_done`);
              result.pickingsValidated++;
            } else {
              throw validateError;
            }
          }

        } catch (pickingError) {
          console.error(`[VcsOrderCreator] Failed to validate picking ${picking.id}:`, pickingError.message);
          result.error = `Picking ${picking.id}: ${pickingError.message}`;
        }
      }

      result.success = result.pickingsValidated > 0;

    } catch (error) {
      console.error(`[VcsOrderCreator] Could not confirm/deliver order ${orderId}:`, error.message);
      result.error = error.message;
    }

    return result;
  }

  /**
   * Format date for Odoo
   */
  formatDate(date) {
    if (!date) return new Date().toISOString().split('T')[0];
    const d = new Date(date);
    return d.toISOString().split('T')[0];
  }

  /**
   * Load caches for warehouses, countries, etc.
   */
  async loadCaches() {
    // Pre-load common warehouses
    const warehouses = await this.odoo.searchRead('stock.warehouse', [], ['id', 'code']);
    for (const wh of warehouses) {
      this.warehouseCache[wh.code] = wh.id;
    }

    // Pre-load countries
    const countries = await this.odoo.searchRead('res.country',
      [['code', 'in', EU_COUNTRIES.concat(['GB', 'CH'])]],
      ['id', 'code']
    );
    for (const c of countries) {
      this.countryCache[c.code] = c.id;
    }

    // Pre-load generic B2C customers
    const b2cCustomers = await this.odoo.searchRead('res.partner',
      [['name', 'ilike', 'Amazon | AMZ_']],
      ['id', 'name']
    );
    for (const c of b2cCustomers) {
      B2C_CUSTOMER_CACHE[c.name] = c.id;
    }

    console.log(`[VcsOrderCreator] Caches loaded: ${warehouses.length} warehouses, ${countries.length} countries, ${b2cCustomers.length} Amazon customers`);
  }
}

module.exports = { VcsOrderCreator };
