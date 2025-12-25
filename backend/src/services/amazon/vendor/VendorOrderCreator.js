/**
 * VendorOrderCreator - Create Odoo Sale Orders from Vendor Central POs
 *
 * Creates Odoo sale.order records from Amazon Vendor Central purchase orders.
 *
 * IMPORTANT: Always checks for existing orders before creating to prevent duplicates.
 * Uses client_order_ref field to store the Amazon PO number.
 *
 * Flow:
 * 1. Check if order already exists in Odoo (by PO number)
 * 2. If exists, skip and return existing order info
 * 3. If not, create sale.order with proper customer, warehouse, products
 * 4. Update MongoDB with Odoo order reference
 *
 * @module VendorOrderCreator
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getVendorPOImporter, COLLECTION_NAME } = require('./VendorPOImporter');
const { skuResolver } = require('../SkuResolver');

/**
 * Amazon Vendor Partner IDs in Odoo (by marketplace)
 * These are the "Amazon Vendor" customers for each marketplace
 */
const AMAZON_VENDOR_PARTNERS = {
  // Will be populated from Odoo or configured here
  // Format: marketplace -> Odoo res.partner ID
  'DE': null,
  'FR': null,
  'NL': null,
  'UK': null,
  'IT': null,
  'ES': null,
  'SE': null,
  'PL': null,
};

/**
 * Marketplace to Warehouse mapping
 * For Vendor Central, we typically ship from our main warehouse
 */
const MARKETPLACE_WAREHOUSE = {
  'DE': 'be1',  // Ship from Belgium
  'FR': 'be1',
  'NL': 'be1',
  'UK': 'be1',
  'IT': 'be1',
  'ES': 'be1',
  'SE': 'be1',
  'PL': 'be1',
};

/**
 * Sales Team IDs for Vendor Central (different from Seller Central)
 */
const VENDOR_SALES_TEAMS = {
  'DE': null,  // Will need to be configured
  'FR': null,
  'NL': null,
  'UK': null,
  'IT': null,
  'ES': null,
  'SE': null,
  'PL': null,
};

class VendorOrderCreator {
  constructor(odooClient = null) {
    this.odoo = odooClient || new OdooDirectClient();
    this.db = null;
    this.importer = null;
    this.warehouseCache = {};
    this.productCache = {};
    this.partnerCache = {};
  }

  /**
   * Initialize the creator
   */
  async init() {
    this.db = getDb();
    this.importer = await getVendorPOImporter();

    // Authenticate with Odoo
    if (!this.odoo.authenticated) {
      await this.odoo.authenticate();
    }

    return this;
  }

  /**
   * Check if an order already exists in Odoo for this PO number
   *
   * @param {string} poNumber - Amazon Vendor PO number
   * @returns {object|null} Existing order or null
   */
  async findExistingOrder(poNumber) {
    // Search by client_order_ref (exact match)
    const orders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', poNumber]],
      ['id', 'name', 'state', 'amount_total', 'partner_id']
    );

    if (orders.length > 0) {
      return orders[0];
    }

    // Also try with VENDOR/ prefix in case that's how it was stored
    const ordersWithPrefix = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', `VENDOR/${poNumber}`]],
      ['id', 'name', 'state', 'amount_total', 'partner_id']
    );

    if (ordersWithPrefix.length > 0) {
      return ordersWithPrefix[0];
    }

    // Also check the name field for the PO number
    const ordersByName = await this.odoo.searchRead('sale.order',
      [['name', 'ilike', poNumber]],
      ['id', 'name', 'state', 'amount_total', 'partner_id'],
      { limit: 1 }
    );

    if (ordersByName.length > 0) {
      return ordersByName[0];
    }

    return null;
  }

  /**
   * Create Odoo order for a single Vendor PO
   *
   * @param {string} poNumber - Amazon Vendor PO number
   * @param {object} options - Creation options
   * @param {boolean} options.dryRun - If true, don't actually create
   * @param {boolean} options.autoConfirm - If true, confirm the order after creation
   * @returns {object} Result with success status and details
   */
  async createOrder(poNumber, options = {}) {
    const { dryRun = false, autoConfirm = false } = options;

    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      odooOrderId: null,
      odooOrderName: null,
      skipped: false,
      skipReason: null,
      errors: [],
      warnings: []
    };

    try {
      // Step 1: Get PO from MongoDB
      const po = await this.importer.getPurchaseOrder(poNumber);
      if (!po) {
        result.errors.push(`PO not found in database: ${poNumber}`);
        return result;
      }

      // Step 2: CHECK FOR EXISTING ORDER (CRITICAL - prevents duplicates)
      const existingOrder = await this.findExistingOrder(poNumber);
      if (existingOrder) {
        result.success = true;
        result.skipped = true;
        result.skipReason = `Order already exists in Odoo: ${existingOrder.name}`;
        result.odooOrderId = existingOrder.id;
        result.odooOrderName = existingOrder.name;
        result.warnings.push(result.skipReason);

        // Update MongoDB to link to existing order if not already linked
        if (!po.odoo?.saleOrderId) {
          await this.importer.linkToOdooOrder(poNumber, existingOrder.id, existingOrder.name);
        }

        return result;
      }

      // Step 3: Resolve products
      const orderLines = await this.resolveOrderLines(po.items || []);
      if (orderLines.errors.length > 0) {
        result.errors.push(...orderLines.errors);
      }

      if (orderLines.lines.length === 0) {
        result.errors.push('No valid order lines found - cannot create order');
        return result;
      }

      result.warnings.push(...orderLines.warnings);

      // Step 4: Find or create Amazon Vendor partner
      const partnerId = await this.findOrCreateVendorPartner(po.marketplaceId, po.buyingParty);

      // Step 5: Find warehouse
      const warehouseId = await this.findWarehouse(po.marketplaceId);

      // Step 6: Prepare order data
      const orderData = {
        partner_id: partnerId,
        partner_invoice_id: partnerId,
        partner_shipping_id: partnerId,
        client_order_ref: poNumber,  // CRITICAL: Store PO number for duplicate detection
        date_order: this.formatDate(po.purchaseOrderDate),
        warehouse_id: warehouseId,
        order_line: orderLines.lines.map(line => [0, 0, line]),
        // Store vendor-specific info in notes
        note: this.buildOrderNotes(po),
        // Custom fields if available
        ...(po.deliveryWindow?.endDate && {
          commitment_date: this.formatDate(po.deliveryWindow.endDate)
        })
      };

      // Add sales team if configured
      const salesTeamId = VENDOR_SALES_TEAMS[po.marketplaceId];
      if (salesTeamId) {
        orderData.team_id = salesTeamId;
      }

      if (dryRun) {
        result.success = true;
        result.dryRun = true;
        result.orderData = orderData;
        result.warnings.push('Dry run - order not created');
        return result;
      }

      // Step 7: Create the order
      const orderId = await this.odoo.create('sale.order', orderData);

      // Get the created order name
      const createdOrder = await this.odoo.read('sale.order', [orderId], ['name']);
      const orderName = createdOrder[0]?.name || `SO-${orderId}`;

      result.success = true;
      result.odooOrderId = orderId;
      result.odooOrderName = orderName;

      // Step 8: Update MongoDB with Odoo link
      await this.importer.linkToOdooOrder(poNumber, orderId, orderName);

      // Step 9: Auto-confirm if requested
      if (autoConfirm) {
        try {
          await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);
          result.confirmed = true;
        } catch (confirmError) {
          result.warnings.push(`Order created but auto-confirm failed: ${confirmError.message}`);
        }
      }

      console.log(`[VendorOrderCreator] Created Odoo order ${orderName} for PO ${poNumber}`);
      return result;

    } catch (error) {
      result.errors.push(error.message);
      console.error(`[VendorOrderCreator] Error creating order for PO ${poNumber}:`, error);
      return result;
    }
  }

  /**
   * Create orders for multiple POs
   *
   * @param {string[]} poNumbers - Array of PO numbers to process
   * @param {object} options - Creation options
   * @returns {object} Aggregate results
   */
  async createOrders(poNumbers, options = {}) {
    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      orders: []
    };

    for (const poNumber of poNumbers) {
      const result = await this.createOrder(poNumber, options);
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
   * Create orders for all pending POs (those without Odoo orders)
   *
   * @param {object} options - Creation options
   * @param {number} options.limit - Max POs to process
   * @returns {object} Aggregate results
   */
  async createPendingOrders(options = {}) {
    const { limit = 50 } = options;

    // Get POs that don't have Odoo orders yet
    const pendingPOs = await this.importer.getPendingOdooOrders(limit);
    const poNumbers = pendingPOs.map(po => po.purchaseOrderNumber);

    if (poNumbers.length === 0) {
      return {
        processed: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        orders: [],
        message: 'No pending POs to process'
      };
    }

    return this.createOrders(poNumbers, options);
  }

  /**
   * Resolve PO items to Odoo order lines
   */
  async resolveOrderLines(items) {
    const lines = [];
    const errors = [];
    const warnings = [];

    for (const item of items) {
      try {
        const sku = item.vendorProductIdentifier; // Our SKU
        const asin = item.amazonProductIdentifier;

        if (!sku && !asin) {
          errors.push(`Item ${item.itemSequenceNumber}: No SKU or ASIN`);
          continue;
        }

        // Try to resolve SKU
        let odooSku = sku;
        if (skuResolver.loaded) {
          const resolved = skuResolver.resolve(sku);
          if (resolved.odooSku) {
            odooSku = resolved.odooSku;
          }
        }

        // Find product in Odoo
        const productId = await this.findProduct(odooSku, asin);
        if (!productId) {
          errors.push(`Item ${item.itemSequenceNumber}: Product not found (SKU: ${sku}, ASIN: ${asin})`);
          continue;
        }

        // Calculate price per unit
        const quantity = item.orderedQuantity?.amount || 1;
        const netCost = parseFloat(item.netCost?.amount) || 0;
        const priceUnit = netCost > 0 ? netCost : 0;

        lines.push({
          product_id: productId,
          product_uom_qty: quantity,
          price_unit: priceUnit,
          name: `[${sku}] PO Line ${item.itemSequenceNumber}`,
        });

      } catch (error) {
        errors.push(`Item ${item.itemSequenceNumber}: ${error.message}`);
      }
    }

    return { lines, errors, warnings };
  }

  /**
   * Find product by SKU or ASIN
   */
  async findProduct(sku, asin = null) {
    // Check cache first
    const cacheKey = sku || asin;
    if (this.productCache[cacheKey]) {
      return this.productCache[cacheKey];
    }

    // Search by default_code (SKU)
    if (sku) {
      const byCode = await this.odoo.search('product.product',
        [['default_code', '=', sku]],
        { limit: 1 }
      );
      if (byCode.length > 0) {
        this.productCache[cacheKey] = byCode[0];
        return byCode[0];
      }
    }

    // Search by barcode (sometimes ASIN is stored there)
    if (asin) {
      const byBarcode = await this.odoo.search('product.product',
        [['barcode', '=', asin]],
        { limit: 1 }
      );
      if (byBarcode.length > 0) {
        this.productCache[cacheKey] = byBarcode[0];
        return byBarcode[0];
      }
    }

    return null;
  }

  /**
   * Find or create Amazon Vendor partner
   */
  async findOrCreateVendorPartner(marketplace, buyingParty = null) {
    const partnerName = `Amazon Vendor | ${marketplace}`;

    // Check cache
    if (this.partnerCache[marketplace]) {
      return this.partnerCache[marketplace];
    }

    // Search for existing partner
    const existing = await this.odoo.search('res.partner',
      [['name', '=', partnerName]],
      { limit: 1 }
    );

    if (existing.length > 0) {
      this.partnerCache[marketplace] = existing[0];
      return existing[0];
    }

    // Create new partner for Amazon Vendor
    const partnerData = {
      name: partnerName,
      company_type: 'company',
      is_company: true,
      customer_rank: 1,
      supplier_rank: 0,
      comment: `Amazon Vendor Central customer for ${marketplace} marketplace`,
    };

    // Add buying party info if available
    if (buyingParty?.partyId) {
      partnerData.ref = buyingParty.partyId;
    }

    const partnerId = await this.odoo.create('res.partner', partnerData);
    this.partnerCache[marketplace] = partnerId;

    console.log(`[VendorOrderCreator] Created Amazon Vendor partner for ${marketplace}: ID ${partnerId}`);
    return partnerId;
  }

  /**
   * Find warehouse for marketplace
   */
  async findWarehouse(marketplace) {
    const warehouseCode = MARKETPLACE_WAREHOUSE[marketplace] || 'be1';

    // Check cache
    if (this.warehouseCache[warehouseCode]) {
      return this.warehouseCache[warehouseCode];
    }

    const warehouses = await this.odoo.search('stock.warehouse',
      [['code', '=', warehouseCode]],
      { limit: 1 }
    );

    if (warehouses.length > 0) {
      this.warehouseCache[warehouseCode] = warehouses[0];
      return warehouses[0];
    }

    // Fallback to first warehouse
    const fallback = await this.odoo.search('stock.warehouse', [], { limit: 1 });
    if (fallback.length > 0) {
      this.warehouseCache[warehouseCode] = fallback[0];
      return fallback[0];
    }

    throw new Error(`No warehouse found for marketplace ${marketplace}`);
  }

  /**
   * Format date for Odoo
   */
  formatDate(date) {
    if (!date) return false;
    const d = new Date(date);
    return d.toISOString().split('T')[0];
  }

  /**
   * Build order notes from PO data
   */
  buildOrderNotes(po) {
    const lines = [
      `Amazon Vendor Central PO: ${po.purchaseOrderNumber}`,
      `Marketplace: ${po.marketplaceId}`,
      `PO Type: ${po.purchaseOrderType}`,
      `PO State: ${po.purchaseOrderState}`,
    ];

    if (po.deliveryWindow) {
      lines.push(`Delivery Window: ${this.formatDate(po.deliveryWindow.startDate)} to ${this.formatDate(po.deliveryWindow.endDate)}`);
    }

    if (po.buyingParty?.partyId) {
      lines.push(`Buying Party: ${po.buyingParty.partyId}`);
    }

    if (po.shipToParty?.partyId) {
      lines.push(`Ship To: ${po.shipToParty.partyId}`);
    }

    return lines.join('\n');
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the VendorOrderCreator instance
 */
async function getVendorOrderCreator() {
  if (!instance) {
    instance = new VendorOrderCreator();
    await instance.init();
  }
  return instance;
}

module.exports = {
  VendorOrderCreator,
  getVendorOrderCreator,
  AMAZON_VENDOR_PARTNERS,
  MARKETPLACE_WAREHOUSE,
  VENDOR_SALES_TEAMS
};
