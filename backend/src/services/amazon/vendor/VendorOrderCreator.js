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
const { getVendorPOImporter, COLLECTION_NAME: _COLLECTION_NAME } = require('./VendorPOImporter');
const { getVendorPartyMapping } = require('./VendorPartyMapping');
const { skuResolver } = require('../SkuResolver');
const { isTestMode } = require('./TestMode');

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
 * Warehouse for Vendor Central orders
 * All Vendor Central orders ship from Central Warehouse
 */
const VENDOR_WAREHOUSE_CODE = 'CW';  // Central Warehouse

/**
 * Invoice Journal for Vendor Central orders
 * Using Belgian journal as orders are shipped from Belgium
 */
const VENDOR_INVOICE_JOURNAL_ID = 1;  // VBE - INV*BE/ Invoices

/**
 * Sales Team IDs for Vendor Central (different from Seller Central)
 */
// Amazon Vendor sales team ID (same for all marketplaces)
const AMAZON_VENDOR_TEAM_ID = 6;

const VENDOR_SALES_TEAMS = {
  'DE': AMAZON_VENDOR_TEAM_ID,
  'FR': AMAZON_VENDOR_TEAM_ID,
  'NL': AMAZON_VENDOR_TEAM_ID,
  'UK': AMAZON_VENDOR_TEAM_ID,
  'IT': AMAZON_VENDOR_TEAM_ID,
  'ES': AMAZON_VENDOR_TEAM_ID,
  'SE': AMAZON_VENDOR_TEAM_ID,
  'PL': AMAZON_VENDOR_TEAM_ID,
  'BE': AMAZON_VENDOR_TEAM_ID,
};

class VendorOrderCreator {
  constructor(odooClient = null) {
    this.odoo = odooClient || new OdooDirectClient();
    this.db = null;
    this.importer = null;
    this.partyMapping = null;
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
    this.partyMapping = await getVendorPartyMapping();

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

      // Step 4: Look up partner mappings from party IDs
      const partnerIds = await this.resolvePartnerMappings(po);
      if (partnerIds.errors.length > 0) {
        result.errors.push(...partnerIds.errors);
        return result;
      }
      result.warnings.push(...partnerIds.warnings);

      // Step 5: Find warehouse (always Central Warehouse for Vendor)
      const warehouseId = await this.findWarehouse();

      // Step 6: Prepare order data
      const orderData = {
        partner_id: partnerIds.customerId,          // Main customer (buying party)
        partner_invoice_id: partnerIds.invoiceId,   // Invoice address (billTo party)
        partner_shipping_id: partnerIds.shippingId, // Shipping address (shipTo party)
        client_order_ref: poNumber,  // CRITICAL: Store PO number for duplicate detection
        date_order: this.formatDate(po.orderDate || po.purchaseOrderDate),
        warehouse_id: warehouseId,
        journal_id: VENDOR_INVOICE_JOURNAL_ID,      // Invoice journal (VBE - Belgian)
        order_line: orderLines.lines.map(line => [0, 0, line]),
        // Store vendor-specific info in notes
        note: this.buildOrderNotes(po),
        // Custom fields if available - handle unified and legacy schema
        ...((po.amazonVendor?.deliveryWindow?.endDate || po.deliveryWindow?.endDate) && {
          commitment_date: this.formatDate(po.amazonVendor?.deliveryWindow?.endDate || po.deliveryWindow?.endDate)
        })
      };

      // Add sales team if configured - handle unified and legacy schema
      const marketplaceCode = po.marketplace?.code || po.marketplaceId;
      const salesTeamId = VENDOR_SALES_TEAMS[marketplaceCode];
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

      // TEST MODE: Return mock Odoo order without actually creating
      if (isTestMode()) {
        const mockOrderId = 900000 + Math.floor(Math.random() * 100000);
        const mockOrderName = `TEST-SO-${poNumber}`;

        result.success = true;
        result.odooOrderId = mockOrderId;
        result.odooOrderName = mockOrderName;
        result._testMode = true;
        result._mockResponse = true;
        result.warnings.push('TEST MODE: Odoo order creation mocked');

        // Update MongoDB with mock Odoo link so the flow continues
        await this.importer.linkToOdooOrder(poNumber, mockOrderId, mockOrderName);

        console.log(`[VendorOrderCreator] TEST MODE: Mock Odoo order ${mockOrderName} for PO ${poNumber}`);
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
        // Handle unified schema (ean/asin) and legacy (vendorProductIdentifier/amazonProductIdentifier)
        const sku = item.ean || item.vendorProductIdentifier; // Our SKU (EAN)
        const asin = item.asin || item.amazonProductIdentifier;

        // FIRST: Use pre-resolved odooProductId if available (from enrichment)
        // This is more reliable than re-looking up by barcode/SKU
        let productId = item.odooProductId || null;

        if (!productId) {
          // Fallback: Look up product if not pre-resolved
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
          productId = await this.findProduct(odooSku, asin);
        }

        if (!productId) {
          errors.push(`Item ${item.itemSequenceNumber}: Product not found (SKU: ${sku}, ASIN: ${asin})`);
          continue;
        }

        // Use acknowledgeQty (accepted quantity) if set, otherwise fall back to orderedQuantity
        // Handle unified schema (quantity) and legacy (orderedQuantity.amount)
        const orderedQty = item.quantity || item.orderedQuantity?.amount || 1;

        // If acknowledgeQty is explicitly set to 0 (rejected item), skip this line entirely
        if (item.acknowledgeQty === 0) {
          warnings.push(`Item ${item.itemSequenceNumber}: Skipped (acknowledgeQty = 0, rejected)`);
          continue;
        }

        // Use acknowledgeQty if set and > 0, otherwise use orderedQty
        const quantity = (item.acknowledgeQty != null && item.acknowledgeQty > 0)
          ? item.acknowledgeQty
          : orderedQty;
        // Handle unified schema (unitPrice) and legacy (netCost.amount)
        const netCost = parseFloat(item.unitPrice) || parseFloat(item.netCost?.amount) || 0;
        const priceUnit = netCost > 0 ? netCost : 0;

        lines.push({
          product_id: productId,
          product_uom_qty: quantity,
          price_unit: priceUnit,
          // Don't set name - let Odoo use default product description
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

    // Search by default_code (internal SKU)
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

    // Search by barcode (EAN - vendorProductIdentifier is typically the EAN)
    if (sku) {
      const byBarcode = await this.odoo.search('product.product',
        [['barcode', '=', sku]],
        { limit: 1 }
      );
      if (byBarcode.length > 0) {
        this.productCache[cacheKey] = byBarcode[0];
        return byBarcode[0];
      }
    }

    // Search by barcode using ASIN as fallback
    if (asin) {
      const byAsin = await this.odoo.search('product.product',
        [['barcode', '=', asin]],
        { limit: 1 }
      );
      if (byAsin.length > 0) {
        this.productCache[cacheKey] = byAsin[0];
        return byAsin[0];
      }
    }

    return null;
  }

  /**
   * Resolve partner IDs from party mapping table
   * NEVER creates new partners - fails if mapping not found
   *
   * @param {object} po - Purchase order with party info
   * @returns {object} { customerId, invoiceId, shippingId, errors, warnings }
   */
  async resolvePartnerMappings(po) {
    const result = {
      customerId: null,
      invoiceId: null,
      shippingId: null,
      errors: [],
      warnings: []
    };

    // Get party IDs from PO - handle unified and legacy schema
    const buyingPartyId = po.amazonVendor?.buyingParty?.partyId || po.buyingParty?.partyId;
    const billToPartyId = po.amazonVendor?.billToParty?.partyId || po.billToParty?.partyId;
    const shipToPartyId = po.amazonVendor?.shipToParty?.partyId || po.shipToParty?.partyId;

    // Buying party -> Main customer
    // Fallback order: buyingParty -> billToParty -> shipToParty -> default 'AMAZON_VENDOR'
    let effectiveBuyingPartyId = buyingPartyId;
    let mappingSource = 'buyingParty';

    // If no buyingParty, try alternative party IDs as fallback
    if (!effectiveBuyingPartyId && billToPartyId) {
      effectiveBuyingPartyId = billToPartyId;
      mappingSource = 'billToParty (fallback)';
    }
    if (!effectiveBuyingPartyId && shipToPartyId) {
      effectiveBuyingPartyId = shipToPartyId;
      mappingSource = 'shipToParty (fallback)';
    }

    if (effectiveBuyingPartyId) {
      const mapping = this.partyMapping.getMapping(effectiveBuyingPartyId);
      if (mapping) {
        result.customerId = mapping.odooPartnerId;
        if (mappingSource !== 'buyingParty') {
          result.warnings.push(`Using ${mappingSource} ${effectiveBuyingPartyId} as customer (no buyingParty in PO)`);
        }
      } else {
        result.errors.push(`Unmapped buying party: ${effectiveBuyingPartyId}. Please add mapping in Party Mapping settings.`);
      }
    } else {
      // No party ID at all - check for default Amazon Vendor mapping
      const defaultMapping = this.partyMapping.getMapping('AMAZON_VENDOR_DEFAULT');
      if (defaultMapping) {
        result.customerId = defaultMapping.odooPartnerId;
        result.warnings.push('Using default AMAZON_VENDOR_DEFAULT mapping (no party IDs in PO)');
      } else {
        result.errors.push('No buying party ID in PO. This may be a legacy order or data issue. Please re-sync the PO from Amazon or add AMAZON_VENDOR_DEFAULT mapping.');
      }
    }

    // BillTo party -> Invoice address
    if (billToPartyId) {
      const mapping = this.partyMapping.getMapping(billToPartyId);
      if (mapping) {
        result.invoiceId = mapping.odooPartnerId;
      } else {
        // Warning only, fall back to customer
        result.warnings.push(`Unmapped billTo party: ${billToPartyId}. Using buying party for invoice.`);
        result.invoiceId = result.customerId;
      }
    } else {
      result.invoiceId = result.customerId;
    }

    // ShipTo party -> Shipping address
    if (shipToPartyId) {
      const mapping = this.partyMapping.getMapping(shipToPartyId);
      if (mapping) {
        result.shippingId = mapping.odooPartnerId;
      } else {
        // Warning only, fall back to customer
        result.warnings.push(`Unmapped shipTo party: ${shipToPartyId}. Using buying party for shipping.`);
        result.shippingId = result.customerId;
      }
    } else {
      result.shippingId = result.customerId;
    }

    return result;
  }

  /**
   * Get VAT number for a party from mapping
   * Used for invoice submission
   */
  getPartyVatNumber(partyId) {
    const mapping = this.partyMapping.getMapping(partyId);
    return mapping?.vatNumber || null;
  }

  /**
   * Get full party info from mapping
   * Used for invoice submission
   */
  getPartyInfo(partyId) {
    return this.partyMapping.getMapping(partyId);
  }

  /**
   * Find warehouse for Vendor Central orders
   * Always uses Central Warehouse (CW)
   */
  async findWarehouse() {
    const warehouseCode = VENDOR_WAREHOUSE_CODE;

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

    // Fallback to first warehouse (should not happen)
    console.warn(`[VendorOrderCreator] Central Warehouse (CW) not found, using fallback`);
    const fallback = await this.odoo.search('stock.warehouse', [], { limit: 1 });
    if (fallback.length > 0) {
      this.warehouseCache[warehouseCode] = fallback[0];
      return fallback[0];
    }

    throw new Error('No warehouse found for Vendor Central orders');
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
   * Update an existing Odoo order with new quantities from MongoDB
   * Used when quantities are changed after initial acknowledgment
   *
   * @param {string} poNumber - Amazon Vendor PO number
   * @param {object} options - Update options
   * @returns {object} Result with success status and details
   */
  async updateOrder(poNumber, _options = {}) {
    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      odooOrderId: null,
      odooOrderName: null,
      updated: false,
      linesUpdated: 0,
      linesRemoved: 0,
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

      // Step 2: Check that Odoo order exists
      if (!po.odoo?.saleOrderId) {
        result.errors.push(`No Odoo order linked to PO ${poNumber}`);
        return result;
      }

      const odooOrderId = po.odoo.saleOrderId;
      const odooOrderName = po.odoo.saleOrderName;
      result.odooOrderId = odooOrderId;
      result.odooOrderName = odooOrderName;

      // Step 3: Get current Odoo order lines
      const existingLines = await this.odoo.searchRead('sale.order.line',
        [['order_id', '=', odooOrderId]],
        ['id', 'product_id', 'product_uom_qty', 'price_unit']
      );

      // Build a map of existing lines by product_id
      const existingLineMap = {};
      for (const line of existingLines) {
        if (line.product_id) {
          existingLineMap[line.product_id[0]] = line;
        }
      }

      // Step 4: Process each item from MongoDB
      for (const item of (po.items || [])) {
        const sku = item.ean || item.vendorProductIdentifier;
        const asin = item.asin || item.amazonProductIdentifier;

        // Get product ID (use cached if available)
        let productId = item.odooProductId || null;
        if (!productId) {
          productId = await this.findProduct(sku, asin);
        }

        if (!productId) {
          result.warnings.push(`Item ${item.itemSequenceNumber}: Product not found (SKU: ${sku})`);
          continue;
        }

        const existingLine = existingLineMap[productId];
        const newQty = item.acknowledgeQty ?? (item.quantity || item.orderedQuantity?.amount || 0);

        if (!existingLine) {
          // Line doesn't exist in Odoo - skip or add?
          if (newQty > 0) {
            result.warnings.push(`Item ${item.itemSequenceNumber}: Line not found in Odoo order (SKU: ${sku})`);
          }
          continue;
        }

        // Check if qty changed
        if (existingLine.product_uom_qty === newQty) {
          continue; // No change needed
        }

        // Get the Amazon net cost (price) - must set this when updating qty to prevent Odoo from recalculating
        const netCost = parseFloat(item.unitPrice) || parseFloat(item.netCost?.amount) || 0;
        const priceUnit = netCost > 0 ? netCost : existingLine.price_unit; // Fallback to existing price

        // Update the line (set qty to 0 for rejected items - can't delete from confirmed orders)
        if (newQty === 0) {
          await this.odoo.write('sale.order.line', [existingLine.id], {
            product_uom_qty: 0,
            price_unit: priceUnit  // Preserve price when setting qty to 0
          });
          result.linesUpdated++;
          result.warnings.push(`Item ${item.itemSequenceNumber}: Line qty set to 0`);
        } else {
          // Update the quantity AND price (Odoo recalculates price on qty change, so we must set it explicitly)
          await this.odoo.write('sale.order.line', [existingLine.id], {
            product_uom_qty: newQty,
            price_unit: priceUnit
          });
          result.linesUpdated++;
        }
      }

      // Step 5: Handle delivery pickings - update quantities directly instead of letting Odoo create returns
      if (result.linesUpdated > 0) {
        try {
          await this.syncDeliveryPickingQuantities(odooOrderId, po.items || [], existingLineMap);
          console.log(`[VendorOrderCreator] Synced delivery picking quantities for ${odooOrderName}`);
        } catch (pickingError) {
          result.warnings.push(`Could not sync delivery picking: ${pickingError.message}`);
          console.error(`[VendorOrderCreator] Error syncing delivery picking for ${odooOrderName}:`, pickingError);
        }
      }

      result.success = true;
      result.updated = result.linesUpdated > 0;

      console.log(`[VendorOrderCreator] Updated Odoo order ${odooOrderName}: ${result.linesUpdated} lines updated`);
      return result;

    } catch (error) {
      result.errors.push(error.message);
      console.error(`[VendorOrderCreator] Error updating order for PO ${poNumber}:`, error);
      return result;
    }
  }

  /**
   * Sync delivery picking quantities when SO line quantities change
   * This prevents Odoo from creating return pickings when quantities are reduced
   *
   * @param {number} odooOrderId - Odoo sale.order ID
   * @param {Array} items - PO items with acknowledgeQty
   * @param {Object} existingLineMap - Map of product_id -> SO line
   */
  async syncDeliveryPickingQuantities(odooOrderId, items, existingLineMap) {
    // Get the sale order with picking IDs
    const saleOrder = await this.odoo.searchRead('sale.order',
      [['id', '=', odooOrderId]],
      ['picking_ids']
    );

    if (!saleOrder.length || !saleOrder[0].picking_ids?.length) {
      return; // No pickings to update
    }

    const pickingIds = saleOrder[0].picking_ids;

    // Get all pickings for this order
    const pickings = await this.odoo.searchRead('stock.picking',
      [['id', 'in', pickingIds]],
      ['id', 'name', 'state', 'picking_type_id', 'move_ids_without_package']
    );

    // Separate delivery pickings from return pickings
    const deliveryPickings = [];
    const returnPickings = [];

    for (const picking of pickings) {
      const typeName = picking.picking_type_id?.[1] || '';
      if (typeName.toLowerCase().includes('return')) {
        returnPickings.push(picking);
      } else if (typeName.toLowerCase().includes('delivery') || typeName.toLowerCase().includes('out')) {
        deliveryPickings.push(picking);
      }
    }

    // Cancel any return pickings that were auto-created (only if in draft/waiting/assigned state)
    for (const returnPicking of returnPickings) {
      if (['draft', 'waiting', 'confirmed', 'assigned'].includes(returnPicking.state)) {
        try {
          await this.odoo.execute('stock.picking', 'action_cancel', [[returnPicking.id]]);
          console.log(`[VendorOrderCreator] Cancelled auto-created return picking ${returnPicking.name}`);
        } catch (cancelError) {
          console.warn(`[VendorOrderCreator] Could not cancel return ${returnPicking.name}: ${cancelError.message}`);
        }
      }
    }

    // Update delivery picking move quantities
    for (const deliveryPicking of deliveryPickings) {
      if (!['draft', 'waiting', 'confirmed', 'assigned'].includes(deliveryPicking.state)) {
        continue; // Don't modify done/cancelled pickings
      }

      const moveIds = deliveryPicking.move_ids_without_package || [];
      if (!moveIds.length) continue;

      // Get moves for this picking
      const moves = await this.odoo.searchRead('stock.move',
        [['id', 'in', moveIds]],
        ['id', 'product_id', 'product_uom_qty', 'state']
      );

      for (const move of moves) {
        if (!['draft', 'waiting', 'confirmed', 'assigned'].includes(move.state)) {
          continue; // Don't modify done/cancelled moves
        }

        const productId = move.product_id?.[0];
        if (!productId) continue;

        // Find the corresponding item to get the new quantity
        const soLine = existingLineMap[productId];
        if (!soLine) continue;

        // Find the item with this product
        let newQty = null;
        for (const item of items) {
          if (item.odooProductId === productId) {
            newQty = item.acknowledgeQty ?? (item.quantity || item.orderedQuantity?.amount || 0);
            break;
          }
        }

        if (newQty === null) continue;

        // Update move quantity if different
        if (move.product_uom_qty !== newQty) {
          await this.odoo.write('stock.move', [move.id], { product_uom_qty: newQty });
          console.log(`[VendorOrderCreator] Updated move for product ${productId}: ${move.product_uom_qty} -> ${newQty}`);

          // Re-check availability if picking is in assigned state
          if (deliveryPicking.state === 'assigned') {
            try {
              await this.odoo.execute('stock.picking', 'action_assign', [[deliveryPicking.id]]);
            } catch (assignError) {
              // Ignore - picking might already be fully assigned
            }
          }
        }
      }
    }
  }

  /**
   * Build order notes from PO data
   */
  buildOrderNotes(po) {
    // Handle unified and legacy schema for all fields
    const poNumber = po.sourceIds?.amazonVendorPONumber || po.purchaseOrderNumber;
    const marketplaceCode = po.marketplace?.code || po.marketplaceId;
    const poType = po.amazonVendor?.purchaseOrderType || po.purchaseOrderType;
    const poState = po.amazonVendor?.purchaseOrderState || po.purchaseOrderState;
    const deliveryWindow = po.amazonVendor?.deliveryWindow || po.deliveryWindow;
    const buyingPartyId = po.amazonVendor?.buyingParty?.partyId || po.buyingParty?.partyId;
    const shipToPartyId = po.amazonVendor?.shipToParty?.partyId || po.shipToParty?.partyId;

    const lines = [
      `Amazon Vendor Central PO: ${poNumber}`,
      `Marketplace: ${marketplaceCode}`,
      `PO Type: ${poType}`,
      `PO State: ${poState}`,
    ];

    if (deliveryWindow) {
      lines.push(`Delivery Window: ${this.formatDate(deliveryWindow.startDate)} to ${this.formatDate(deliveryWindow.endDate)}`);
    }

    if (buyingPartyId) {
      lines.push(`Buying Party: ${buyingPartyId}`);
    }

    if (shipToPartyId) {
      lines.push(`Ship To: ${shipToPartyId}`);
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
  VENDOR_WAREHOUSE_CODE,
  VENDOR_INVOICE_JOURNAL_ID,
  VENDOR_SALES_TEAMS
};
