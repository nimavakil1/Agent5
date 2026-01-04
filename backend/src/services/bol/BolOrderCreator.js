/**
 * BolOrderCreator - Create Odoo Sale Orders from Bol.com Orders
 *
 * Creates Odoo sale.order records from Bol.com orders.
 *
 * Flow:
 * 1. Check if order already exists in Odoo (by client_order_ref)
 * 2. If exists, skip and return existing order info
 * 3. If not, create sale.order with customer, warehouse, products
 * 4. Auto-confirm order
 * 5. Update MongoDB with Odoo order reference
 *
 * Configuration:
 * - Order prefix: FBR (merchant) or FBB (Bol-fulfilled)
 * - Warehouse: FBR uses CW (Central Warehouse), FBB uses BOL warehouse
 * - Stock field: free_qty of Central Warehouse only
 */

const { getDb } = require('../../db');
const { CHANNELS, SUB_CHANNELS } = require('../orders/UnifiedOrderService');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { getAddressCleaner } = require('../amazon/seller/AddressCleaner');

// Collection name for unified orders
const COLLECTION_NAME = 'unified_orders';

// Warehouse IDs in Odoo
const CENTRAL_WAREHOUSE_ID = 1;  // CW - for FBR orders (we ship from our warehouse)
const BOL_WAREHOUSE_ID = 3;      // BOL - for FBB orders (Bol ships from their warehouse)

// Country code to Odoo country ID mapping
const COUNTRY_IDS = {
  'NL': 165,  // Netherlands
  'BE': 20,   // Belgium
  'DE': 57,   // Germany
  'FR': 75    // France
};

// Sales Team ID for Bol.com orders
const BOL_TEAM_ID = 10;

// Tax configuration based on fulfillment method and destination
// Key format: "{shipFrom}->{shipTo}"
// FBB ships from NL (Bol warehouse), FBR ships from BE (our warehouse)
// Journal codes: VBE (Belgium), VNL (Netherlands), VOS (OSS)
// Fiscal positions: Using (TxIn) versions since Bol prices include tax
const TAX_CONFIG = {
  'NL->NL': { taxId: 150, journalCode: 'VNL', journalId: 16, fiscalPositionId: 42 },   // FBB to NL: NL*VAT | Régime National (TxIn)
  'NL->BE': { taxId: 147, journalCode: 'VBE', journalId: 1, fiscalPositionId: 40 },    // FBB to BE: BE*OSS | B2C Belgium (TxIn)
  'BE->NL': { taxId: 153, journalCode: 'VOS', journalId: 12, fiscalPositionId: 46 },   // FBR to NL: NL*OSS | B2C Netherlands (TxIn)
  'BE->BE': { taxId: 147, journalCode: 'VBE', journalId: 1, fiscalPositionId: 41 },    // FBR to BE: BE*VAT | Régime National (TxIn)
};

class BolOrderCreator {
  constructor(odooClient = null) {
    this.odoo = odooClient || new OdooDirectClient();
    this.productCache = {};
    this.partnerCache = {};
    this.journalCache = {};
    this.shippingProductId = null;
    this.addressCleaner = null;
  }

  /**
   * Initialize the creator
   */
  async init() {
    if (!this.odoo.authenticated) {
      await this.odoo.authenticate();
    }

    // Initialize AI address cleaner
    this.addressCleaner = getAddressCleaner({ useAI: true });
    await this.addressCleaner.init();

    // Find or create shipping product
    await this.findShippingProduct();

    return this;
  }

  /**
   * Find or create the shipping charge product
   */
  async findShippingProduct() {
    const products = await this.odoo.searchRead('product.product',
      [['default_code', '=', '[SHIP BOL]']],
      ['id', 'name']
    );

    if (products.length > 0) {
      this.shippingProductId = products[0].id;
      return;
    }

    // Try alternative reference
    const altProducts = await this.odoo.searchRead('product.product',
      [['default_code', 'ilike', 'SHIP']],
      ['id', 'name', 'default_code'],
      { limit: 1 }
    );

    if (altProducts.length > 0) {
      this.shippingProductId = altProducts[0].id;
      console.log(`[BolOrderCreator] Using shipping product: ${altProducts[0].default_code}`);
    }
  }

  /**
   * Get tax configuration based on fulfillment method and destination country
   * @param {string} fulfilmentMethod - FBB or FBR
   * @param {string} destCountry - Destination country code (NL or BE)
   * @returns {object} Tax configuration with taxId and journalCode
   */
  getTaxConfig(fulfilmentMethod, destCountry) {
    // Determine ship-from country based on fulfillment method
    // FBB = Fulfillment by Bol = ships from NL (Bol warehouse)
    // FBR = Fulfillment by Retailer = ships from BE (our warehouse)
    const shipFrom = fulfilmentMethod === 'FBB' ? 'NL' : 'BE';
    const shipTo = destCountry || 'NL';

    const configKey = `${shipFrom}->${shipTo}`;
    const config = TAX_CONFIG[configKey];

    if (!config) {
      console.warn(`[BolOrderCreator] No tax config for ${configKey}, defaulting to BE->NL`);
      return TAX_CONFIG['BE->NL']; // Default fallback
    }

    return config;
  }

  /**
   * Get journal ID by code pattern
   * @param {string} journalCode - Journal code (e.g., 'INV*NL')
   */
  async getJournalId(journalCode) {
    if (!journalCode) return null;

    // Check cache
    if (this.journalCache[journalCode]) {
      return this.journalCache[journalCode];
    }

    // Search for journal by code
    const journals = await this.odoo.searchRead('account.journal',
      [['code', '=', journalCode]],
      ['id', 'name', 'code'],
      { limit: 1 }
    );

    if (journals.length > 0) {
      this.journalCache[journalCode] = journals[0].id;
      return journals[0].id;
    }

    console.warn(`[BolOrderCreator] Journal not found: ${journalCode}`);
    return null;
  }

  /**
   * Check if an order already exists in Odoo
   * @param {string} orderId - Bol order ID
   * @param {string} prefix - FBR or FBB
   */
  async findExistingOrder(orderId, prefix) {
    const orderRef = `${prefix}${orderId}`;

    // Search by client_order_ref (exclude cancelled orders)
    const orders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', orderRef], ['state', '!=', 'cancel']],
      ['id', 'name', 'state', 'amount_total', 'partner_id']
    );

    if (orders.length > 0) {
      return orders[0];
    }

    // Also try without prefix (exclude cancelled orders)
    const ordersNoPrefix = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', orderId], ['state', '!=', 'cancel']],
      ['id', 'name', 'state', 'amount_total', 'partner_id']
    );

    if (ordersNoPrefix.length > 0) {
      return ordersNoPrefix[0];
    }

    return null;
  }

  /**
   * Find or create customer from shipping details with AI address cleaning
   * @param {object} shipmentDetails - Bol order shipping details
   */
  async findOrCreatePartner(shipmentDetails) {
    if (!shipmentDetails) {
      throw new Error('No shipping details provided');
    }

    const firstName = shipmentDetails.firstName || '';
    const surname = shipmentDetails.surname || '';
    const rawName = `${firstName} ${surname}`.trim();
    const zipCode = shipmentDetails.zipCode || '';
    const countryCode = shipmentDetails.countryCode || 'NL';

    if (!rawName) {
      throw new Error('No customer name in shipping details');
    }

    // Build raw street address
    let rawStreet = shipmentDetails.streetName || '';
    if (shipmentDetails.houseNumber) {
      rawStreet += ' ' + shipmentDetails.houseNumber;
    }
    if (shipmentDetails.houseNumberExtension) {
      rawStreet += shipmentDetails.houseNumberExtension;
    }

    // Clean address with AI
    let cleanedAddress;
    try {
      cleanedAddress = await this.addressCleaner.cleanAddress({
        recipientName: rawName,
        addressLine1: rawStreet.trim(),
        addressLine2: shipmentDetails.extraAddressInformation || '',
        city: shipmentDetails.city || '',
        postalCode: zipCode,
        countryCode: countryCode
      });
    } catch (err) {
      console.warn(`[BolOrderCreator] AI cleaning failed, using raw data: ${err.message}`);
      cleanedAddress = {
        name: rawName,
        company: null,
        street: rawStreet.trim(),
        street2: null,
        city: shipmentDetails.city || '',
        zip: zipCode,
        country: countryCode
      };
    }

    // Build display name: company first, then personal name
    const displayName = cleanedAddress.company
      ? (cleanedAddress.name ? `${cleanedAddress.company}, ${cleanedAddress.name}` : cleanedAddress.company)
      : (cleanedAddress.name || rawName);

    // Check cache first
    const cacheKey = `${displayName}|${zipCode}`;
    if (this.partnerCache[cacheKey]) {
      return this.partnerCache[cacheKey];
    }

    // Search by cleaned name + postal code
    const existing = await this.odoo.searchRead('res.partner', [
      ['name', '=', displayName],
      ['zip', '=', zipCode]
    ], ['id', 'name']);

    if (existing.length > 0) {
      this.partnerCache[cacheKey] = existing[0].id;
      return existing[0].id;
    }

    // Also try raw name (in case partner was created before)
    if (displayName !== rawName) {
      const existingRaw = await this.odoo.searchRead('res.partner', [
        ['name', '=', rawName],
        ['zip', '=', zipCode]
      ], ['id', 'name']);

      if (existingRaw.length > 0) {
        // Update existing partner with cleaned address
        const partnerId = existingRaw[0].id;
        await this.odoo.write('res.partner', [partnerId], {
          name: displayName,
          street: cleanedAddress.street || false,
          street2: cleanedAddress.street2 || false,
          city: cleanedAddress.city || false,
          zip: cleanedAddress.zip || false
        });
        console.log(`[BolOrderCreator] Updated partner ${partnerId} with cleaned address: ${displayName}`);
        this.partnerCache[cacheKey] = partnerId;
        return partnerId;
      }
    }

    // Get country ID
    const countryId = COUNTRY_IDS[countryCode] || COUNTRY_IDS['NL'];

    // Create new partner with cleaned address
    const partnerId = await this.odoo.create('res.partner', {
      name: displayName,
      street: cleanedAddress.street || rawStreet.trim(),
      street2: cleanedAddress.street2 || false,
      zip: cleanedAddress.zip || zipCode,
      city: cleanedAddress.city || shipmentDetails.city || '',
      country_id: countryId,
      email: shipmentDetails.email || '',
      phone: shipmentDetails.deliveryPhoneNumber || '',
      customer_rank: 1,
      type: 'contact'
    });

    this.partnerCache[cacheKey] = partnerId;
    console.log(`[BolOrderCreator] Created partner ${partnerId}: ${displayName}`);

    return partnerId;
  }

  /**
   * Find product by EAN (barcode)
   * @param {string} ean - Product EAN
   */
  async findProduct(ean) {
    if (!ean) return null;

    // Check cache
    if (this.productCache[ean]) {
      return this.productCache[ean];
    }

    // Search by barcode
    const products = await this.odoo.searchRead('product.product',
      [['barcode', '=', ean]],
      ['id', 'name', 'default_code'],
      { limit: 1 }
    );

    if (products.length > 0) {
      this.productCache[ean] = products[0].id;
      return products[0].id;
    }

    return null;
  }

  /**
   * Create Odoo order for a single Bol order
   * @param {string} orderId - Bol order ID
   * @param {object} options - Creation options
   */
  async createOrder(orderId, options = {}) {
    const { dryRun = false, autoConfirm = true } = options;

    const result = {
      success: false,
      bolOrderId: orderId,
      odooOrderId: null,
      odooOrderName: null,
      skipped: false,
      skipReason: null,
      errors: [],
      warnings: []
    };

    try {
      // Step 1: Get order from unified_orders collection
      const db = getDb();
      const collection = db.collection(COLLECTION_NAME);
      const unifiedOrderId = `${CHANNELS.BOL}:${orderId}`;

      const bolOrder = await collection.findOne({ unifiedOrderId });
      if (!bolOrder) {
        result.errors.push(`Order not found in database: ${orderId}`);
        return result;
      }

      // Extract Bol-specific data
      const bolData = bolOrder.bol || {};

      // Step 2: Determine prefix based on fulfillment method
      // Use unified schema: bolOrder.bol.fulfilmentMethod or subChannel
      let fulfilmentMethod = bolData.fulfilmentMethod ||
        bolOrder.subChannel ||
        bolOrder.items?.[0]?.fulfilmentMethod;

      // If still not determined, check shipment method (LVB = Logistics Via Bol = FBB)
      if (!fulfilmentMethod && bolData.shipmentMethod === 'LVB') {
        fulfilmentMethod = 'FBB';
      }

      // Check if any order item indicates FBB
      if (!fulfilmentMethod && bolOrder.items?.length > 0) {
        const hasFBB = bolOrder.items.some(item =>
          item.fulfilmentMethod === 'FBB'
        );
        if (hasFBB) fulfilmentMethod = 'FBB';
      }

      // Default to FBR only as last resort, but log a warning
      if (!fulfilmentMethod) {
        console.warn(`[BolOrderCreator] No fulfilmentMethod found for order ${orderId}, defaulting to FBR`);
        fulfilmentMethod = 'FBR';
      }

      const prefix = fulfilmentMethod === 'FBB' ? 'FBB' : 'FBR';
      const orderRef = `${prefix}${orderId}`;

      // Step 3: Check for existing order
      const existingOrder = await this.findExistingOrder(orderId, prefix);
      if (existingOrder) {
        result.success = true;
        result.skipped = true;
        result.skipReason = `Order already exists in Odoo: ${existingOrder.name}`;
        result.odooOrderId = existingOrder.id;
        result.odooOrderName = existingOrder.name;

        // Update unified_orders if not linked
        if (!bolOrder.sourceIds?.odooSaleOrderId) {
          // Use full odoo object to avoid "Cannot create field in element {odoo: null}" error
          const odooData = {
            ...(bolOrder.odoo || {}),
            saleOrderId: existingOrder.id,
            saleOrderName: existingOrder.name,
            syncedAt: new Date()
          };
          await collection.updateOne(
            { unifiedOrderId },
            {
              $set: {
                'sourceIds.odooSaleOrderId': existingOrder.id,
                'sourceIds.odooSaleOrderName': existingOrder.name,
                odoo: odooData,
                updatedAt: new Date()
              }
            }
          );
        }

        return result;
      }

      // Step 4: Find or create customer
      // Map unified schema to shipmentDetails format expected by findOrCreatePartner
      const shipmentDetails = this.buildShipmentDetails(bolOrder);
      const partnerId = await this.findOrCreatePartner(shipmentDetails);

      // Step 5: Get tax configuration based on fulfillment and destination
      const destCountry = bolOrder.shippingAddress?.countryCode || 'NL';
      const taxConfig = this.getTaxConfig(fulfilmentMethod, destCountry);
      const shipFrom = fulfilmentMethod === 'FBB' ? 'NL' : 'BE';
      console.log(`[BolOrderCreator] Tax config for ${prefix} ${shipFrom}->${destCountry}: Tax ID ${taxConfig.taxId}, Journal ${taxConfig.journalCode}`);

      // Step 6: Build order lines with tax-included tax
      // Use unified schema items array
      const orderLines = [];
      for (const item of (bolOrder.items || [])) {
        const productId = await this.findProduct(item.ean);

        if (!productId) {
          result.warnings.push(`Product not found for EAN ${item.ean}: ${item.name}`);
          continue;
        }

        const unitPrice = item.unitPrice || (item.lineTotal / (item.quantity || 1)) || 0;

        orderLines.push([0, 0, {
          product_id: productId,
          product_uom_qty: item.quantity || 1,
          price_unit: unitPrice,
          name: item.name || `[${item.ean}]`,
          tax_id: [[6, 0, [taxConfig.taxId]]]  // Set tax-included tax
        }]);
      }

      if (orderLines.length === 0) {
        result.errors.push('No valid order lines could be created');
        return result;
      }

      // Step 7: Get journal ID for the order (use hardcoded ID or lookup by code)
      const journalId = taxConfig.journalId || await this.getJournalId(taxConfig.journalCode);

      // Step 8: Prepare order data
      // Use unified schema orderDate field
      const orderDate = bolOrder.orderDate
        ? new Date(bolOrder.orderDate).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      // Use BOL warehouse for FBB orders, Central Warehouse for FBR orders
      const warehouseId = fulfilmentMethod === 'FBB' ? BOL_WAREHOUSE_ID : CENTRAL_WAREHOUSE_ID;
      console.log(`[BolOrderCreator] Using warehouse: ${fulfilmentMethod === 'FBB' ? 'BOL' : 'CW'} (ID: ${warehouseId})`);

      const orderData = {
        name: orderRef,                   // Set order name to Bol reference (e.g., FBBA000DD78MR)
        partner_id: partnerId,
        partner_invoice_id: partnerId,   // Required: Invoice address
        partner_shipping_id: partnerId,  // Required: Delivery address
        client_order_ref: orderRef,
        date_order: orderDate,
        warehouse_id: warehouseId,
        team_id: BOL_TEAM_ID,            // Sales Team: BOL
        order_line: orderLines,
        note: this.buildOrderNotes(bolOrder, bolData, prefix, taxConfig)
      };

      // Set fiscal position for correct tax mapping
      if (taxConfig.fiscalPositionId) {
        orderData.fiscal_position_id = taxConfig.fiscalPositionId;
        console.log(`[BolOrderCreator] Setting fiscal_position_id=${taxConfig.fiscalPositionId}`);
      }

      // Set journal_id on sales order (inherits to invoice)
      if (journalId) {
        orderData.journal_id = journalId;
        console.log(`[BolOrderCreator] Setting journal_id=${journalId} (${taxConfig.journalCode})`);
      }

      if (dryRun) {
        result.success = true;
        result.dryRun = true;
        result.orderData = orderData;
        result.warnings.push('Dry run - order not created');
        return result;
      }

      // Step 9: Create the order
      const saleOrderId = await this.odoo.create('sale.order', orderData);

      // Get created order name
      const createdOrder = await this.odoo.read('sale.order', [saleOrderId], ['name', 'journal_id']);
      const orderName = createdOrder[0]?.name || `SO-${saleOrderId}`;

      result.success = true;
      result.odooOrderId = saleOrderId;
      result.odooOrderName = orderName;
      result.taxConfig = { taxId: taxConfig.taxId, journal: taxConfig.journalCode, fiscalPositionId: taxConfig.fiscalPositionId };
      result.journalId = createdOrder[0]?.journal_id?.[0] || journalId;

      // Step 10: Update unified_orders with Odoo link
      // Use full odoo object to avoid "Cannot create field in element {odoo: null}" error
      const odooData = {
        ...(bolOrder.odoo || {}),
        saleOrderId,
        saleOrderName: orderName,
        linkedAt: new Date(),
        syncedAt: new Date(),
        syncError: ''
      };
      await collection.updateOne(
        { unifiedOrderId },
        {
          $set: {
            'sourceIds.odooSaleOrderId': saleOrderId,
            'sourceIds.odooSaleOrderName': orderName,
            odoo: odooData,
            updatedAt: new Date()
          }
        }
      );

      // Step 11: Auto-confirm order
      if (autoConfirm) {
        try {
          await this.odoo.execute('sale.order', 'action_confirm', [[saleOrderId]]);
          result.confirmed = true;

          // Sync delivery addresses to ensure they match the order
          await this.syncDeliveryAddresses(saleOrderId);
        } catch (confirmError) {
          result.warnings.push(`Order created but auto-confirm failed: ${confirmError.message}`);
        }
      }

      console.log(`[BolOrderCreator] Created Odoo order ${orderName} for Bol order ${orderId}`);
      return result;

    } catch (error) {
      result.errors.push(error.message);

      // Update unified_orders with error
      // Use full odoo object to avoid "Cannot create field in element {odoo: null}" error
      try {
        const db = getDb();
        const collection = db.collection(COLLECTION_NAME);
        const unifiedOrderId = `${CHANNELS.BOL}:${orderId}`;
        // Fetch current order to preserve existing odoo data
        const currentOrder = await collection.findOne({ unifiedOrderId });
        const odooData = {
          ...(currentOrder?.odoo || {}),
          syncError: error.message
        };
        await collection.updateOne(
          { unifiedOrderId },
          { $set: { odoo: odooData, updatedAt: new Date() } }
        );
      } catch (dbError) {
        console.error(`[BolOrderCreator] Failed to update error in DB:`, dbError.message);
      }

      console.error(`[BolOrderCreator] Error creating order for ${orderId}:`, error);
      return result;
    }
  }

  /**
   * Create orders for multiple Bol orders
   * @param {string[]} orderIds - Array of Bol order IDs
   * @param {object} options - Creation options
   */
  async createOrders(orderIds, options = {}) {
    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      orders: []
    };

    for (const orderId of orderIds) {
      const result = await this.createOrder(orderId, options);
      results.processed++;
      results.orders.push(result);

      if (result.skipped) {
        results.skipped++;
      } else if (result.success) {
        results.created++;
      } else {
        results.failed++;
      }
    }

    return results;
  }

  /**
   * Create orders for pending Bol orders (without Odoo orders)
   * Only processes orders from the last X days to avoid creating historical orders
   * @param {object} options - Creation options { limit, maxAgeDays }
   */
  async createPendingOrders(options = {}) {
    const { limit = 50, maxAgeDays = 7 } = options;

    // Only process orders from the last X days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    // Find recent orders without Odoo link from unified_orders
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const pendingOrders = await collection.find({
      channel: CHANNELS.BOL,
      $or: [
        { 'sourceIds.odooSaleOrderId': { $exists: false } },
        { 'sourceIds.odooSaleOrderId': null }
      ],
      orderDate: { $gte: cutoffDate }
    })
      .sort({ orderDate: -1 })
      .limit(limit)
      .project({ 'sourceIds.bolOrderId': 1, orderDate: 1 })
      .toArray();

    if (pendingOrders.length === 0) {
      return {
        processed: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        orders: [],
        message: `No pending orders from the last ${maxAgeDays} days`
      };
    }

    const orderIds = pendingOrders.map(o => o.sourceIds?.bolOrderId).filter(Boolean);
    console.log(`[BolOrderCreator] Processing ${orderIds.length} pending orders from last ${maxAgeDays} days...`);
    return this.createOrders(orderIds, options);
  }

  /**
   * Update invoice journal for a Bol order
   * Call this after invoices are created to set the correct journal
   * @param {string} orderId - Bol order ID
   */
  async updateInvoiceJournal(orderId) {
    // Get order from unified_orders
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.BOL}:${orderId}`;

    const bolOrder = await collection.findOne({ unifiedOrderId });
    if (!bolOrder?.odoo?.saleOrderId) {
      return { success: false, error: 'Order not linked to Odoo' };
    }

    // Get fulfillment and destination from unified schema
    const bolData = bolOrder.bol || {};
    const fulfilmentMethod = bolData.fulfilmentMethod || bolOrder.subChannel || 'FBR';
    const destCountry = bolOrder.shippingAddress?.countryCode || 'NL';
    const taxConfig = this.getTaxConfig(fulfilmentMethod, destCountry);

    // Get journal ID
    const journalId = await this.getJournalId(taxConfig.journalCode);
    if (!journalId) {
      return { success: false, error: `Journal not found: ${taxConfig.journalCode}` };
    }

    // Find invoices for this sale order
    const invoices = await this.odoo.searchRead('account.move',
      [
        ['invoice_origin', 'ilike', bolOrder.odoo.saleOrderName],
        ['move_type', '=', 'out_invoice']
      ],
      ['id', 'name', 'journal_id', 'state']
    );

    if (invoices.length === 0) {
      return { success: false, error: 'No invoices found for this order' };
    }

    let updated = 0;
    const errors = [];

    for (const invoice of invoices) {
      if (invoice.journal_id[0] === journalId) {
        continue; // Already correct
      }

      if (invoice.state === 'posted') {
        errors.push(`Invoice ${invoice.name} is already posted, cannot change journal`);
        continue;
      }

      try {
        await this.odoo.write('account.move', [invoice.id], { journal_id: journalId });
        updated++;
        console.log(`[BolOrderCreator] Updated journal for invoice ${invoice.name} to ${taxConfig.journalCode}`);
      } catch (e) {
        errors.push(`Failed to update ${invoice.name}: ${e.message}`);
      }
    }

    return {
      success: true,
      updated,
      total: invoices.length,
      errors,
      journalCode: taxConfig.journalCode
    };
  }

  /**
   * Update invoice journals for all Bol orders with invoices
   * @param {object} options - Options { limit: number }
   */
  async updateAllInvoiceJournals(options = {}) {
    const { limit = 100 } = options;

    // Find Bol orders with Odoo links from unified_orders
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const orders = await collection.find({
      channel: CHANNELS.BOL,
      'sourceIds.odooSaleOrderId': { $exists: true, $ne: null }
    })
      .sort({ orderDate: -1 })
      .limit(limit)
      .project({ 'sourceIds.bolOrderId': 1 })
      .toArray();

    const results = {
      processed: 0,
      updated: 0,
      noInvoice: 0,
      errors: []
    };

    for (const order of orders) {
      const orderId = order.sourceIds?.bolOrderId;
      if (!orderId) continue;

      const result = await this.updateInvoiceJournal(orderId);
      results.processed++;

      if (result.success && result.updated > 0) {
        results.updated += result.updated;
      } else if (result.error === 'No invoices found for this order') {
        results.noInvoice++;
      } else if (!result.success) {
        results.errors.push({ orderId: order.orderId, error: result.error });
      }
    }

    console.log(`[BolOrderCreator] Invoice journal update: ${results.updated} updated, ${results.noInvoice} without invoices`);
    return results;
  }

  /**
   * Build shipmentDetails object from unified order schema
   * Converts unified shippingAddress to the format expected by findOrCreatePartner
   * @param {object} bolOrder - Unified order document
   * @returns {object} shipmentDetails in legacy format
   */
  buildShipmentDetails(bolOrder) {
    const addr = bolOrder.shippingAddress || {};
    const bolData = bolOrder.bol || {};

    // Parse name into first/last if not already split
    let firstName = '';
    let surname = '';
    const fullName = addr.name || '';

    if (fullName.includes(' ')) {
      const parts = fullName.split(' ');
      firstName = parts[0];
      surname = parts.slice(1).join(' ');
    } else {
      surname = fullName;
    }

    // Parse street into streetName and houseNumber
    let streetName = addr.street || '';
    let houseNumber = '';
    let houseNumberExtension = '';

    // Try to extract house number from street
    const streetMatch = streetName.match(/^(.+?)\s+(\d+)\s*(.*)$/);
    if (streetMatch) {
      streetName = streetMatch[1];
      houseNumber = streetMatch[2];
      houseNumberExtension = streetMatch[3] || '';
    }

    return {
      firstName,
      surname,
      streetName,
      houseNumber,
      houseNumberExtension,
      extraAddressInformation: addr.street2 || '',
      city: addr.city || '',
      zipCode: addr.postalCode || '',
      countryCode: addr.countryCode || 'NL',
      email: bolData.email || bolOrder.customer?.email || '',
      deliveryPhoneNumber: bolData.phone || ''
    };
  }

  /**
   * Build order notes
   * @param {object} bolOrder - Unified order document
   * @param {object} bolData - Bol-specific data from bolOrder.bol
   * @param {string} prefix - FBB or FBR
   * @param {object} taxConfig - Tax configuration
   */
  buildOrderNotes(bolOrder, bolData, prefix, taxConfig = null) {
    const shipFrom = prefix === 'FBB' ? 'NL' : 'BE';
    const shipTo = bolOrder.shippingAddress?.countryCode || 'NL';

    // Use unified orderId or source ID
    const orderId = bolOrder.sourceIds?.bolOrderId || bolOrder.unifiedOrderId?.split(':')[1] || 'Unknown';

    const lines = [
      `Bol.com Order: ${orderId}`,
      `Fulfillment: ${prefix === 'FBB' ? 'Fulfillment by Bol (NL)' : 'Fulfillment by Retailer (BE)'}`,
      `Route: ${shipFrom} → ${shipTo}`,
      `Order Date: ${bolOrder.orderDate ? new Date(bolOrder.orderDate).toLocaleDateString() : 'Unknown'}`
    ];

    if (taxConfig) {
      lines.push(`Tax: ID ${taxConfig.taxId} | Journal: ${taxConfig.journalCode}`);
    }

    // Get email from bolData or unified customer
    const email = bolData?.email || bolOrder.customer?.email;
    if (email) {
      lines.push(`Customer Email: ${email}`);
    }

    return lines.join('\n');
  }

  /**
   * Link pending Bol orders to existing Odoo orders (no creation)
   * Searches by multiple patterns to find existing orders
   * @param {object} options - Options { limit: number, batchSize: number }
   */
  async linkPendingOrders(options = {}) {
    const { limit = 500, batchSize = 50 } = options;

    // Find orders without Odoo link from unified_orders
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const pendingOrders = await collection.find({
      channel: CHANNELS.BOL,
      $or: [
        { 'sourceIds.odooSaleOrderId': { $exists: false } },
        { 'sourceIds.odooSaleOrderId': null }
      ]
    })
      .sort({ orderDate: -1 })
      .limit(limit)
      .project({ 'sourceIds.bolOrderId': 1, subChannel: 1, 'bol.fulfilmentMethod': 1 })
      .toArray();

    if (pendingOrders.length === 0) {
      return {
        processed: 0,
        linked: 0,
        notFound: 0,
        notFoundOrders: [],
        message: 'No pending orders to link'
      };
    }

    console.log(`[BolOrderCreator] Linking ${pendingOrders.length} pending orders to Odoo...`);

    const results = {
      processed: 0,
      linked: 0,
      notFound: 0,
      notFoundOrders: []
    };

    // Process in batches to avoid timeout
    for (let i = 0; i < pendingOrders.length; i += batchSize) {
      const batch = pendingOrders.slice(i, i + batchSize);

      for (const order of batch) {
        results.processed++;
        const orderId = order.sourceIds?.bolOrderId;
        if (!orderId) continue;

        const fulfilmentMethod = order.bol?.fulfilmentMethod || order.subChannel || 'FBR';
        const prefix = fulfilmentMethod === 'FBB' ? 'FBB' : 'FBR';
        const unifiedOrderId = `${CHANNELS.BOL}:${orderId}`;

        // Try multiple search patterns
        const searchPatterns = [
          ['client_order_ref', '=', `${prefix}${orderId}`],        // FBB123 or FBR123
          ['client_order_ref', '=', orderId],                       // Just 123
          ['client_order_ref', 'ilike', `%${orderId}%`],           // Contains orderId
          ['name', 'ilike', `%${orderId}%`]                        // Order name contains orderId
        ];

        let foundOrder = null;
        for (const pattern of searchPatterns) {
          const orders = await this.odoo.searchRead('sale.order',
            [pattern],
            ['id', 'name', 'state', 'client_order_ref']
          );
          if (orders.length > 0) {
            foundOrder = orders[0];
            break;
          }
        }

        if (foundOrder) {
          // Link to unified_orders
          // Use full odoo object to avoid "Cannot create field in element {odoo: null}" error
          const odooData = {
            ...(order.odoo || {}),
            saleOrderId: foundOrder.id,
            saleOrderName: foundOrder.name,
            linkedAt: new Date(),
            syncedAt: new Date()
          };
          await collection.updateOne(
            { unifiedOrderId },
            {
              $set: {
                'sourceIds.odooSaleOrderId': foundOrder.id,
                'sourceIds.odooSaleOrderName': foundOrder.name,
                odoo: odooData,
                updatedAt: new Date()
              }
            }
          );
          results.linked++;

          if (results.linked % 50 === 0) {
            console.log(`[BolOrderCreator] Linked ${results.linked} orders...`);
          }
        } else {
          results.notFound++;
          results.notFoundOrders.push(orderId);
        }
      }
    }

    console.log(`[BolOrderCreator] Link complete: ${results.linked} linked, ${results.notFound} not found in Odoo`);
    return results;
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
      console.log(`[BolOrderCreator] Order ${orderId} not found for delivery sync`);
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
        console.log(`[BolOrderCreator] Updated delivery ${picking.name} address to match order ${order.name}`);
        updated++;
      }
    }

    return updated;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolOrderCreator instance
 */
async function getBolOrderCreator() {
  if (!instance) {
    instance = new BolOrderCreator();
    await instance.init();
  }
  return instance;
}

module.exports = {
  BolOrderCreator,
  getBolOrderCreator,
  CENTRAL_WAREHOUSE_ID,
  BOL_WAREHOUSE_ID,
  COUNTRY_IDS,
  TAX_CONFIG
};
