/**
 * FBM Order Importer - Import FBM orders from Amazon TSV file
 *
 * Handles:
 * - Parsing Amazon "Unshipped Orders" TSV report
 * - Creating customers with real names and addresses
 * - SKU matching using SkuResolver
 * - Creating confirmed sale orders in Odoo
 *
 * @module FbmOrderImporter
 */

const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { skuResolver } = require('../SkuResolver');
const { getDb } = require('../../../db');
const { cleanDuplicateName } = require('./SellerOrderCreator');

// Odoo constants
const PAYMENT_TERM_21_DAYS = 2;
const AMAZON_SELLER_TEAM_ID = 11;
const FBM_WAREHOUSE_ID = 1; // Belgium warehouse (CW)

/**
 * Journal configuration for FBM orders by destination country
 * FBM always ships from Belgium (CW warehouse)
 */
const FBM_JOURNALS = {
  // Specific country journals (for major markets)
  'BE': 1,   // VBE - Domestic Belgium
  'DE': 15,  // VDE - Germany
  'FR': 14,  // VFR - France
  'NL': 16,  // VNL - Netherlands
  'IT': 40,  // VIT - Italy
  'ES': 12,  // VOS - Spain (uses OSS journal)
  // Fallbacks
  'OSS': 12,     // VOS - EU cross-border OSS
  'EXPORT': 52,  // VEX - Non-EU export
  'GB': 41,      // VGB - UK (post-Brexit)
};

/**
 * OSS Fiscal Position IDs by destination country
 * These set the correct VAT rates for B2C sales
 */
const OSS_FISCAL_POSITIONS = {
  'AT': 6,   // AT*OSS | B2C Austria
  'BE': 35,  // BE*OSS | B2C Belgium
  'BG': 7,   // BG*OSS | B2C Bulgaria
  'CY': 9,   // CY*OSS | B2C Cyprus
  'CZ': 10,  // CZ*OSS | B2C Czech Republic
  'DE': 15,  // DE*OSS | B2C Germany
  'DK': 11,  // DK*OSS | B2C Denmark
  'EE': 12,  // EE*OSS | B2C Estonia
  'ES': 30,  // ES*OSS | B2C Spain
  'FI': 13,  // FI*OSS | B2C Finland
  'FR': 14,  // FR*OSS | B2C France
  'GR': 16,  // GR*OSS | B2C Greece
  'HR': 8,   // HR*OSS | B2C Croatia
  'HU': 17,  // HU*OSS | B2C Hungary
  'IE': 18,  // IE*OSS | B2C Ireland
  'IT': 19,  // IT*OSS | B2C Italy
  'LT': 21,  // LT*OSS | B2C Lithuania
  'LU': 22,  // LU*OSS | B2C Luxembourg
  'LV': 20,  // LV*OSS | B2C Latvia
  'MT': 23,  // MT*OSS | B2C Malta
  'NL': 24,  // NL*OSS | B2C Netherlands
  'PL': 25,  // PL*OSS | B2C Poland
  'PT': 26,  // PT*OSS | B2C Portugal
  'RO': 27,  // RO*OSS | B2C Romania
  'SE': 31,  // SE*OSS | B2C Sweden
  'SI': 29,  // SI*OSS | B2C Slovenia
  'SK': 28,  // SK*OSS | B2C Slovakia
};

/**
 * Intra-Community (IC) Fiscal Positions for B2B reverse charge
 * Used when is-business-order = true (buyer has VAT number)
 * These apply 0% VAT with reverse charge mechanism
 */
const IC_B2B_FISCAL_POSITIONS = {
  'BE': 4,   // BE*VAT | Régime Intra-Communautaire
  'DE': 52,  // DE*VAT | Régime Intra-Communautaire
  'FR': 37,  // FR*VAT | Régime Intra-Communautaire
  'CZ': 69,  // CZ*VAT | Régime Intra-Communautaire
  'PL': 70,  // PL*VAT | Régime Intra-Communautaire
  // Fallback - use BE*VAT for other EU B2B (applies reverse charge)
  'DEFAULT': 4
};

/**
 * EU countries for determining OSS vs Export
 */
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
];

class FbmOrderImporter {
  constructor() {
    this.odoo = null;
    this.countryCache = {};
    this.productCache = {};
    this.partnerCache = {};
  }

  async init() {
    if (this.odoo) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    // Load countries cache
    const countries = await this.odoo.searchRead('res.country', [], ['id', 'code', 'name']);
    for (const c of countries) {
      this.countryCache[c.code] = c.id;
    }

    // Load SKU resolver
    if (!skuResolver.loaded) {
      await skuResolver.load();
    }
  }

  /**
   * Parse TSV file content
   * @param {string} content - TSV file content
   * @returns {Object} Parsed orders grouped by order ID
   */
  parseTsv(content) {
    const lines = content.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('TSV file is empty or has no data rows');
    }

    const headers = lines[0].split('\t');
    const headerIndex = {};
    headers.forEach((h, i) => headerIndex[h.trim()] = i);

    // Log headers for debugging price issues
    const priceHeaders = headers.filter(h => h.toLowerCase().includes('price') || h.toLowerCase().includes('amount'));
    console.log(`[FbmOrderImporter] Price-related headers found: ${JSON.stringify(priceHeaders)}`);
    console.log(`[FbmOrderImporter] 'item-price' column index: ${headerIndex['item-price']}`);

    // Determine which report type based on columns
    const hasRecipientName = 'recipient-name' in headerIndex;
    const hasShipAddress = 'ship-address-1' in headerIndex;

    if (!hasRecipientName || !hasShipAddress) {
      throw new Error('TSV file must be an "Unshipped Orders" report with recipient-name and ship-address columns');
    }

    const orderGroups = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < 10) continue;

      const orderId = cols[headerIndex['order-id']]?.trim();
      if (!orderId) continue;

      const sku = cols[headerIndex['sku']]?.trim();
      const resolved = this.resolveSku(sku);

      if (!orderGroups[orderId]) {
        orderGroups[orderId] = {
          orderId,
          // Buyer info
          buyerEmail: cols[headerIndex['buyer-email']]?.trim() || '',
          buyerName: cols[headerIndex['buyer-name']]?.trim() || '',
          buyerPhone: cols[headerIndex['buyer-phone-number']]?.trim() || '',
          // Shipping address
          recipientName: cols[headerIndex['recipient-name']]?.trim() || '',
          address1: cols[headerIndex['ship-address-1']]?.trim() || '',
          address2: cols[headerIndex['ship-address-2']]?.trim() || '',
          address3: cols[headerIndex['ship-address-3']]?.trim() || '',
          city: cols[headerIndex['ship-city']]?.trim() || '',
          state: cols[headerIndex['ship-state']]?.trim() || '',
          postalCode: cols[headerIndex['ship-postal-code']]?.trim() || '',
          country: cols[headerIndex['ship-country']]?.trim() || '',
          shipPhone: cols[headerIndex['ship-phone-number']]?.trim() || '',
          // Billing address
          billName: cols[headerIndex['bill-name']]?.trim() || '',
          billAddress1: cols[headerIndex['bill-address-1']]?.trim() || '',
          billAddress2: cols[headerIndex['bill-address-2']]?.trim() || '',
          billAddress3: cols[headerIndex['bill-address-3']]?.trim() || '',
          billCity: cols[headerIndex['bill-city']]?.trim() || '',
          billState: cols[headerIndex['bill-state']]?.trim() || '',
          billPostalCode: cols[headerIndex['bill-postal-code']]?.trim() || '',
          billCountry: cols[headerIndex['bill-country']]?.trim() || '',
          // Other
          purchaseDate: cols[headerIndex['purchase-date']]?.split('T')[0] || new Date().toISOString().split('T')[0],
          isBusinessOrder: cols[headerIndex['is-business-order']]?.trim() === 'true',
          buyerCompanyName: cols[headerIndex['buyer-company-name']]?.trim() || '',
          addressType: cols[headerIndex['address-type']]?.trim() || 'Residential',
          items: []
        };
      }

      // Parse price - Amazon TSV has "item-price" column
      const itemPriceStr = cols[headerIndex['item-price']]?.trim() || '0';
      const itemPrice = parseFloat(itemPriceStr.replace(/[^0-9.-]/g, '')) || 0;

      // Log price parsing for first order (debug)
      if (i === 1) {
        console.log(`[FbmOrderImporter] Price debug - column index: ${headerIndex['item-price']}, raw: "${itemPriceStr}", parsed: ${itemPrice}`);
      }

      // Parse shipping price if available
      const shippingPriceStr = cols[headerIndex['shipping-price']]?.trim() || '0';
      const shippingPrice = parseFloat(shippingPriceStr.replace(/[^0-9.-]/g, '')) || 0;

      orderGroups[orderId].items.push({
        sku: sku,
        resolvedSku: resolved.odooSku,
        quantity: parseInt(cols[headerIndex['quantity-to-ship']]?.trim() || '1'),
        productName: cols[headerIndex['product-name']]?.trim() || sku,
        itemPrice: itemPrice,
        shippingPrice: shippingPrice
      });
    }

    return orderGroups;
  }

  /**
   * Resolve Amazon SKU to Odoo SKU
   */
  resolveSku(amazonSku) {
    if (!amazonSku) return { odooSku: null };

    const original = amazonSku.trim();
    const upper = original.toUpperCase();
    let sku = original;

    // Strip FBM suffixes
    if (upper.endsWith('-FBMA')) sku = original.slice(0, -5);
    else if (upper.endsWith('-FBM')) sku = original.slice(0, -4);

    // Strip other suffixes
    const suffixes = ['-stickerless', '-stickered', '-bundle', '-new', '-refurb'];
    for (const suffix of suffixes) {
      if (sku.toLowerCase().endsWith(suffix)) {
        sku = sku.slice(0, -suffix.length);
        break;
      }
    }

    // Strip trailing "A" for 5-digit SKUs
    if (/^[0-9]{5}A$/i.test(sku)) sku = sku.slice(0, -1);

    // Pad numeric SKUs to 5 digits
    if (/^[0-9]{1,4}$/.test(sku)) sku = sku.padStart(5, '0');

    return { odooSku: sku, originalSku: original };
  }

  /**
   * Find product by SKU in Odoo
   * Returns { id, listPrice } or null if not found
   *
   * @param {string} resolvedSku - Normalized SKU
   * @param {string} originalSku - Original Amazon SKU
   * @returns {Object|null} { id, listPrice } or null
   */
  async findProduct(resolvedSku, originalSku) {
    const cacheKey = `${resolvedSku}|${originalSku}`;
    if (this.productCache[cacheKey]) return this.productCache[cacheKey];

    // Fields to fetch - include list_price for pricing fallback
    const fields = ['id', 'name', 'default_code', 'list_price'];

    // Try resolved SKU first
    let products = await this.odoo.searchRead('product.product',
      [['default_code', '=', resolvedSku]],
      fields
    );

    if (products.length > 0) {
      const result = { id: products[0].id, listPrice: products[0].list_price || 0 };
      this.productCache[cacheKey] = result;
      return result;
    }

    // Try original SKU
    products = await this.odoo.searchRead('product.product',
      [['default_code', '=', originalSku]],
      fields
    );

    if (products.length > 0) {
      const result = { id: products[0].id, listPrice: products[0].list_price || 0 };
      this.productCache[cacheKey] = result;
      return result;
    }

    // Try stripping K suffix (e.g., 9030K -> 9030)
    if (resolvedSku.endsWith('K')) {
      const strippedSku = resolvedSku.slice(0, -1);
      products = await this.odoo.searchRead('product.product',
        [['default_code', '=', strippedSku]],
        fields
      );
      if (products.length > 0) {
        const result = { id: products[0].id, listPrice: products[0].list_price || 0 };
        this.productCache[cacheKey] = result;
        return result;
      }
    }

    return null;
  }

  /**
   * Find or create customer with separate invoice and shipping addresses
   * @returns {Object} { customerId, invoiceAddressId, shippingAddressId }
   */
  async findOrCreateCustomer(order) {
    // Use buyer name or recipient name for parent customer
    const customerName = order.buyerName || order.recipientName;
    const customerCacheKey = `customer|${customerName}|${order.buyerEmail || order.postalCode}`;

    let customerId = this.partnerCache[customerCacheKey];

    if (!customerId) {
      // Search by name and email (or postal code if no email)
      const searchCriteria = order.buyerEmail
        ? [['name', '=', customerName], ['email', '=', order.buyerEmail], ['parent_id', '=', false]]
        : [['name', '=', customerName], ['zip', '=', order.postalCode], ['parent_id', '=', false]];

      const existing = await this.odoo.searchRead('res.partner', searchCriteria, ['id']);

      if (existing.length > 0) {
        customerId = existing[0].id;
      } else {
        // Create parent customer (no address - addresses are child contacts)
        const countryId = this.countryCache[order.country] || null;

        customerId = await this.odoo.create('res.partner', {
          name: customerName,
          company_type: order.isBusinessOrder ? 'company' : 'person',
          is_company: order.isBusinessOrder,
          customer_rank: 1,
          country_id: countryId,
          email: order.buyerEmail || false,
          phone: order.buyerPhone || false,
          comment: `Created from Amazon FBM order ${order.orderId}`
        });
        console.log(`[FbmOrderImporter] Created customer: ${customerName} (ID: ${customerId})`);
      }

      this.partnerCache[customerCacheKey] = customerId;
    }

    // Create/find shipping address (child contact)
    // Clean duplicate names like "LE-ROUX, LE-ROUX Armelle" for delivery addresses only
    // Handle company name: if buyer-company-name exists and is different from recipient, include it
    let street2 = order.address2 || order.address3 || false;
    const hasCompanyName = order.buyerCompanyName &&
      order.buyerCompanyName !== order.recipientName &&
      order.buyerCompanyName !== order.buyerName;

    if (hasCompanyName) {
      // Prepend company name to street2
      street2 = street2 ? `${order.buyerCompanyName}, ${street2}` : order.buyerCompanyName;
    }

    const shippingAddressId = await this.findOrCreateAddress(order, customerId, 'delivery', {
      name: cleanDuplicateName(order.recipientName),
      street: order.address1,
      street2,
      city: order.city,
      zip: order.postalCode,
      countryCode: order.country,
      phone: order.shipPhone || order.buyerPhone || false,
      email: order.buyerEmail || false  // Email for carrier notifications (GLS, etc.)
    });

    // Check if billing address is different from shipping
    const billingIsDifferent = order.billName && order.billAddress1 && (
      order.billName !== order.recipientName ||
      order.billAddress1 !== order.address1 ||
      order.billPostalCode !== order.postalCode
    );

    let invoiceAddressId;
    if (billingIsDifferent) {
      // Create separate invoice address
      invoiceAddressId = await this.findOrCreateAddress(order, customerId, 'invoice', {
        name: order.billName,
        street: order.billAddress1,
        street2: order.billAddress2 || order.billAddress3 || false,
        city: order.billCity,
        zip: order.billPostalCode,
        countryCode: order.billCountry || order.country,
        phone: order.buyerPhone || false
      });
      console.log(`[FbmOrderImporter] Order ${order.orderId} has separate billing address`);
    } else {
      // Use shipping address for invoicing too (or parent customer if no shipping details differ)
      invoiceAddressId = shippingAddressId;
    }

    return { customerId, invoiceAddressId, shippingAddressId };
  }

  /**
   * Find or create a child address contact
   * @param {Object} order - Order data
   * @param {number} parentId - Parent customer ID
   * @param {string} addressType - 'delivery' or 'invoice'
   * @param {Object} addressData - Address details
   * @returns {number} Address partner ID
   */
  async findOrCreateAddress(order, parentId, addressType, addressData) {
    const cacheKey = `${addressType}|${parentId}|${addressData.zip}|${addressData.street || addressData.city}`;

    if (this.partnerCache[cacheKey]) {
      return this.partnerCache[cacheKey];
    }

    // Build search criteria
    const searchCriteria = [
      ['parent_id', '=', parentId],
      ['type', '=', addressType]
    ];
    if (addressData.zip) searchCriteria.push(['zip', '=', addressData.zip]);
    if (addressData.city) searchCriteria.push(['city', '=', addressData.city]);

    const existing = await this.odoo.searchRead('res.partner', searchCriteria, ['id']);

    if (existing.length > 0) {
      this.partnerCache[cacheKey] = existing[0].id;
      return existing[0].id;
    }

    // Create new address contact
    const countryId = this.countryCache[addressData.countryCode] || null;

    const addressId = await this.odoo.create('res.partner', {
      parent_id: parentId,
      type: addressType,
      name: addressData.name,
      street: addressData.street || false,
      street2: addressData.street2 || false,
      city: addressData.city || false,
      zip: addressData.zip || false,
      country_id: countryId,
      phone: addressData.phone || false,
      email: addressData.email || false,  // Email for carrier notifications
      comment: `${addressType === 'delivery' ? 'Shipping' : 'Billing'} address from Amazon order ${order.orderId}`
    });

    console.log(`[FbmOrderImporter] Created ${addressType} address: ${addressData.name} (ID: ${addressId})`);
    this.partnerCache[cacheKey] = addressId;
    return addressId;
  }

  /**
   * Check if valid (non-cancelled) order exists in Odoo
   */
  async findValidOrder(amazonOrderId) {
    const fbmName = 'FBM' + amazonOrderId;

    const orders = await this.odoo.searchRead('sale.order',
      [
        '|',
        ['name', '=', fbmName],
        ['client_order_ref', '=', amazonOrderId],
        ['state', '!=', 'cancel']
      ],
      ['id', 'name', 'state', 'partner_id']
    );

    return orders.length > 0 ? orders[0] : null;
  }

  /**
   * Determine journal and fiscal position for FBM order based on destination country
   * FBM always ships from Belgium (BE)
   *
   * NOTE: This is a preliminary determination. When VCS invoice is imported later,
   * it will correct the tax rates based on Amazon's actual VAT calculation.
   *
   * @param {string} destCountry - Destination country code
   * @param {boolean} isBusinessOrder - True if Amazon flagged as B2B order
   * @returns {object} { journalId, fiscalPositionId, journalType }
   */
  determineJournalAndFiscalPosition(destCountry, isBusinessOrder = false) {
    const country = (destCountry || '').toUpperCase();

    // Non-EU destination = Export (no fiscal position needed)
    if (!EU_COUNTRIES.includes(country)) {
      return {
        journalId: FBM_JOURNALS['EXPORT'],
        fiscalPositionId: null,
        journalType: 'export'
      };
    }

    // Get country-specific journal, fallback to OSS journal for other EU countries
    const journalId = FBM_JOURNALS[country] || FBM_JOURNALS['OSS'];

    // B2B order (intra-EU) = Reverse charge (0% VAT)
    // The customer handles VAT in their country
    if (isBusinessOrder && country !== 'BE') {
      const icFiscalPosition = IC_B2B_FISCAL_POSITIONS[country] || IC_B2B_FISCAL_POSITIONS['DEFAULT'];
      return {
        journalId,
        fiscalPositionId: icFiscalPosition,
        journalType: 'b2b-ic'
      };
    }

    // B2C order = OSS fiscal position for correct VAT rates
    // Or domestic Belgium = standard VAT
    const fiscalPositionId = OSS_FISCAL_POSITIONS[country] || null;

    return {
      journalId,
      fiscalPositionId,
      journalType: country === 'BE' ? 'domestic' : 'oss'
    };
  }

  /**
   * Create sale order in Odoo with correct fiscal position and journal
   *
   * @param {Object} order - Parsed order data
   * @param {number} customerId - Parent customer ID
   * @param {number} invoiceAddressId - Invoice address ID
   * @param {number} shippingAddressId - Shipping address ID
   * @param {Array} orderLines - Order line items
   */
  async createOdooOrder(order, customerId, invoiceAddressId, shippingAddressId, orderLines) {
    // Determine journal and fiscal position based on destination country AND B2B flag
    const { journalId, fiscalPositionId, journalType } = this.determineJournalAndFiscalPosition(
      order.country,
      order.isBusinessOrder
    );

    const odooLines = orderLines.map(line => [0, 0, {
      product_id: line.product_id,
      product_uom_qty: line.quantity,
      price_unit: line.price_unit,  // Price from TSV
      name: line.name
    }]);

    const orderData = {
      partner_id: customerId,
      partner_invoice_id: invoiceAddressId,
      partner_shipping_id: shippingAddressId,
      client_order_ref: order.orderId,
      date_order: order.purchaseDate,
      warehouse_id: FBM_WAREHOUSE_ID,
      order_line: odooLines,
      payment_term_id: PAYMENT_TERM_21_DAYS,
      team_id: AMAZON_SELLER_TEAM_ID
    };

    // Set fiscal position for correct taxes (OSS rates based on destination)
    if (fiscalPositionId) {
      orderData.fiscal_position_id = fiscalPositionId;
    }

    const orderId = await this.odoo.create('sale.order', orderData);

    // Get the created order name
    const created = await this.odoo.searchRead('sale.order', [['id', '=', orderId]], ['name']);
    const createdName = created.length > 0 ? created[0].name : `SO-${orderId}`;

    console.log(`[FbmOrderImporter] Created order ${createdName} | ${order.country} → Journal type: ${journalType}, Fiscal Position: ${fiscalPositionId || 'none'}`);

    // Confirm order
    await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);

    // Sync delivery addresses to ensure they match the order
    await this.syncDeliveryAddresses(orderId);

    return { id: orderId, name: createdName };
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
      console.log(`[FbmOrderImporter] Order ${orderId} not found for delivery sync`);
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
        console.log(`[FbmOrderImporter] Updated delivery ${picking.name} address to match order ${order.name}`);
        updated++;
      }
    }

    return updated;
  }

  /**
   * Update MongoDB with data from TSV file
   * Updates both seller_orders AND unified_orders collections
   * This fills in customer names and addresses that Amazon API doesn't provide
   *
   * @param {string} amazonOrderId - Amazon Order ID
   * @param {Object} tsvOrder - Order data from TSV
   * @param {Object} odooInfo - Optional Odoo order info to update
   */
  async updateMongoWithTsvData(amazonOrderId, tsvOrder, odooInfo = null) {
    try {
      const db = getDb();

      // Update seller_orders collection (legacy)
      const sellerOrdersCollection = db.collection('seller_orders');
      const sellerOrdersUpdate = {
        // Update shipping address with TSV data
        'shippingAddress.name': tsvOrder.recipientName || null,
        'shippingAddress.addressLine1': tsvOrder.address1 || null,
        'shippingAddress.addressLine2': tsvOrder.address2 || tsvOrder.address3 || null,
        'shippingAddress.city': tsvOrder.city || null,
        'shippingAddress.postalCode': tsvOrder.postalCode || null,
        'shippingAddress.countryCode': tsvOrder.country || null,
        'shippingAddress.phone': tsvOrder.shipPhone || tsvOrder.buyerPhone || null,
        // Update buyer info
        buyerName: tsvOrder.buyerName || tsvOrder.recipientName || null,
        buyerEmail: tsvOrder.buyerEmail || null,
        // Mark as updated from TSV
        tsvImportedAt: new Date()
      };

      // Add Odoo info if provided
      if (odooInfo) {
        sellerOrdersUpdate['odoo.partnerId'] = odooInfo.partnerId || null;
        sellerOrdersUpdate['odoo.saleOrderId'] = odooInfo.saleOrderId || null;
        sellerOrdersUpdate['odoo.saleOrderName'] = odooInfo.saleOrderName || null;
        sellerOrdersUpdate['odoo.createdAt'] = new Date();
      }

      await sellerOrdersCollection.updateOne(
        { amazonOrderId },
        { $set: sellerOrdersUpdate }
      );

      // ALSO update unified_orders collection (used by countFbmOrdersPendingManualImport)
      const unifiedOrdersCollection = db.collection('unified_orders');
      const unifiedOrdersUpdate = {
        // Update shipping address with TSV data
        'shippingAddress.name': tsvOrder.recipientName || null,
        'shippingAddress.addressLine1': tsvOrder.address1 || null,
        'shippingAddress.addressLine2': tsvOrder.address2 || tsvOrder.address3 || null,
        'shippingAddress.city': tsvOrder.city || null,
        'shippingAddress.postalCode': tsvOrder.postalCode || null,
        'shippingAddress.countryCode': tsvOrder.country || null,
        'shippingAddress.phone': tsvOrder.shipPhone || tsvOrder.buyerPhone || null,
        // Update buyer info
        'buyerInfo.name': tsvOrder.buyerName || tsvOrder.recipientName || null,
        'buyerInfo.email': tsvOrder.buyerEmail || null,
        // Mark as updated from TSV
        tsvImportedAt: new Date()
      };

      // Add Odoo info if provided - using unified schema field names
      if (odooInfo) {
        unifiedOrdersUpdate['sourceIds.odooPartnerId'] = odooInfo.partnerId || null;
        unifiedOrdersUpdate['sourceIds.odooSaleOrderId'] = odooInfo.saleOrderId || null;
        unifiedOrdersUpdate['sourceIds.odooSaleOrderName'] = odooInfo.saleOrderName || null;
        unifiedOrdersUpdate['sourceIds.odooCreatedAt'] = new Date();
      }

      await unifiedOrdersCollection.updateOne(
        { 'sourceIds.amazonOrderId': amazonOrderId },
        { $set: unifiedOrdersUpdate }
      );

      console.log(`[FbmOrderImporter] Updated MongoDB (seller_orders + unified_orders) with TSV data for ${amazonOrderId}`);
    } catch (error) {
      console.error(`[FbmOrderImporter] Error updating MongoDB for ${amazonOrderId}:`, error.message);
      // Don't throw - this is a non-critical update
    }
  }

  /**
   * Import orders from TSV content
   * @param {string} tsvContent - TSV file content
   * @param {Object} options - Import options
   * @returns {Object} Import results
   */
  async importFromTsv(tsvContent, _options = {}) {
    await this.init();

    const results = {
      parsed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      orders: []
    };

    try {
      const orderGroups = this.parseTsv(tsvContent);
      const orderIds = Object.keys(orderGroups);
      results.parsed = orderIds.length;

      console.log(`[FbmOrderImporter] Parsed ${orderIds.length} orders from TSV`);

      for (const orderId of orderIds) {
        const order = orderGroups[orderId];

        try {
          // Check if valid order already exists
          const existing = await this.findValidOrder(orderId);
          if (existing) {
            // Update MongoDB with customer name from TSV AND Odoo info (for skipped orders)
            await this.updateMongoWithTsvData(orderId, order, {
              partnerId: existing.partner_id?.[0] || null,
              saleOrderId: existing.id,
              saleOrderName: existing.name
            });

            results.skipped++;
            results.orders.push({
              orderId,
              status: 'skipped',
              reason: `Exists as ${existing.name}`,
              odooName: existing.name,
              customer: order.recipientName,
              address: {
                street: order.address1,
                city: order.city,
                postalCode: order.postalCode,
                country: order.country
              }
            });
            continue;
          }

          // Find/create customer with separate invoice and shipping addresses
          const { customerId, invoiceAddressId, shippingAddressId } = await this.findOrCreateCustomer(order);

          // Resolve order lines
          const orderLines = [];
          let hasError = false;

          for (const item of order.items) {
            const product = await this.findProduct(item.resolvedSku, item.sku);
            if (!product) {
              results.errors.push({
                orderId,
                error: `Product not found: ${item.sku} -> ${item.resolvedSku}`,
                errorType: 'sku_not_found',
                sku: item.sku,
                resolvedSku: item.resolvedSku,
                customer: order.recipientName,
                address: {
                  street: order.address1,
                  city: order.city,
                  postalCode: order.postalCode,
                  country: order.country
                },
                // Include full order data for retry
                orderData: order
              });
              hasError = true;
              break;
            }

            // Calculate unit price:
            // 1. If TSV has price data, use it (item.itemPrice / quantity)
            // 2. Otherwise, fall back to Odoo product list_price
            // Note: VCS invoice import will correct prices later if needed
            let priceUnit;
            if (item.itemPrice > 0 && item.quantity > 0) {
              priceUnit = item.itemPrice / item.quantity;
            } else {
              // Use Odoo list_price as fallback
              priceUnit = product.listPrice || 0;
              if (priceUnit > 0) {
                console.log(`[FbmOrderImporter] Using Odoo list_price ${priceUnit} for ${item.sku} (TSV has no price)`);
              }
            }

            // Ensure line name is never empty (Odoo requires it)
            const lineName = item.productName || item.resolvedSku || item.sku || `Product ${product.id}`;

            orderLines.push({
              product_id: product.id,
              quantity: item.quantity,
              price_unit: priceUnit,
              name: lineName
            });
          }

          if (hasError) continue;

          // Create order with separate invoice and shipping addresses
          const created = await this.createOdooOrder(order, customerId, invoiceAddressId, shippingAddressId, orderLines);

          // Update MongoDB with customer name and Odoo info from TSV
          await this.updateMongoWithTsvData(orderId, order, {
            partnerId: customerId,
            saleOrderId: created.id,
            saleOrderName: created.name
          });

          results.created++;
          results.orders.push({
            orderId,
            status: 'created',
            odooId: created.id,
            odooName: created.name,
            customer: order.recipientName,
            address: {
              street: order.address1,
              city: order.city,
              postalCode: order.postalCode,
              country: order.country
            }
          });

        } catch (error) {
          results.errors.push({
            orderId,
            error: error.message
          });
        }
      }

    } catch (error) {
      results.errors.push({ error: error.message });
    }

    return results;
  }

  /**
   * Retry importing a single order with a corrected SKU mapping
   * @param {Object} orderData - Full order data from previous failed import
   * @param {Object} skuMappings - Map of original SKU -> correct Odoo SKU
   * @returns {Object} Import result for this single order
   */
  async retryOrderWithSku(orderData, skuMappings) {
    await this.init();

    const order = orderData;
    const orderId = order.orderId;

    // Check if valid order already exists
    const existing = await this.findValidOrder(orderId);
    if (existing) {
      return {
        success: false,
        orderId,
        status: 'skipped',
        reason: `Exists as ${existing.name}`,
        odooName: existing.name
      };
    }

    // Find/create customer
    const { customerId, invoiceAddressId, shippingAddressId } = await this.findOrCreateCustomer(order);

    // Resolve order lines with corrected SKU mappings
    const orderLines = [];

    for (const item of order.items) {
      // Check if there's a corrected SKU for this item
      const correctedSku = skuMappings[item.sku];

      let product = null;

      if (correctedSku) {
        // Use the corrected SKU to find the product
        const products = await this.odoo.searchRead('product.product',
          [['default_code', '=', correctedSku]],
          ['id', 'name', 'list_price']
        );
        if (products.length > 0) {
          product = { id: products[0].id, listPrice: products[0].list_price || 0 };
        }
      }

      // If still not found, try original resolution
      if (!product) {
        product = await this.findProduct(item.resolvedSku, item.sku);
      }

      if (!product) {
        return {
          success: false,
          orderId,
          status: 'error',
          errorType: 'sku_not_found',
          error: `Product not found: ${correctedSku || item.sku}`,
          sku: item.sku,
          correctedSku: correctedSku || null
        };
      }

      // Calculate unit price (use TSV price if available, fallback to Odoo list_price)
      let priceUnit;
      if (item.itemPrice > 0 && item.quantity > 0) {
        priceUnit = item.itemPrice / item.quantity;
      } else {
        priceUnit = product.listPrice || 0;
      }

      // Ensure line name is never empty (Odoo requires it)
      const lineName = item.productName || correctedSku || item.resolvedSku || item.sku || `Product ${product.id}`;

      orderLines.push({
        product_id: product.id,
        quantity: item.quantity,
        price_unit: priceUnit,
        name: lineName
      });
    }

    // Create order
    const created = await this.createOdooOrder(order, customerId, invoiceAddressId, shippingAddressId, orderLines);

    // Update MongoDB
    await this.updateMongoWithTsvData(orderId, order, {
      partnerId: customerId,
      saleOrderId: created.id,
      saleOrderName: created.name
    });

    return {
      success: true,
      orderId,
      status: 'created',
      odooId: created.id,
      odooName: created.name,
      customer: order.recipientName,
      address: {
        street: order.address1,
        city: order.city,
        postalCode: order.postalCode,
        country: order.country
      }
    };
  }
}

// Singleton instance
let fbmOrderImporterInstance = null;

async function getFbmOrderImporter() {
  if (!fbmOrderImporterInstance) {
    fbmOrderImporterInstance = new FbmOrderImporter();
    await fbmOrderImporterInstance.init();
  }
  return fbmOrderImporterInstance;
}

module.exports = {
  FbmOrderImporter,
  getFbmOrderImporter
};
