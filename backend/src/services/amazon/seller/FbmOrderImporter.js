/**
 * FBM Order Importer - Import FBM orders from Amazon TSV file
 *
 * REFACTORED: Now only handles TSV parsing and unified_orders storage.
 * Odoo order creation is handled by SellerOrderCreator.
 *
 * Handles:
 * - Parsing Amazon "Unshipped Orders" TSV report
 * - AI address cleaning via AddressCleanerAI
 * - Storing orders in unified_orders collection
 *
 * @module FbmOrderImporter
 */

const { getDb } = require('../../../db');
const { getAddressCleanerAI } = require('./AddressCleanerAI');
const { getUnifiedOrderService, CHANNELS, SUB_CHANNELS } = require('../../orders/UnifiedOrderService');

class FbmOrderImporter {
  constructor() {
    this.unifiedService = null;
    this.addressCleaner = null;
    this.validSkus = null; // Cache of valid product SKUs from database
  }

  async init() {
    if (this.unifiedService) return;

    // Initialize unified order service
    this.unifiedService = getUnifiedOrderService();
    await this.unifiedService.init();

    // Initialize AI address cleaner
    this.addressCleaner = getAddressCleanerAI();

    // Load valid SKUs from products collection
    await this.loadValidSkus();
  }

  /**
   * Load valid product SKUs from the products collection
   * Used to distinguish real products from promotion codes
   */
  async loadValidSkus() {
    const db = getDb();
    const products = await db.collection('products').find({}, { projection: { sku: 1 } }).toArray();
    this.validSkus = new Set(products.map(p => p.sku).filter(Boolean));
    console.log(`[FbmOrderImporter] Loaded ${this.validSkus.size} valid SKUs from products collection`);
  }

  /**
   * Check if a SKU exists in the products database
   */
  isValidProductSku(sku) {
    if (!sku || !this.validSkus) return false;
    return this.validSkus.has(sku);
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

    // Log quantity-related headers for debugging
    const qtyHeaders = headers.filter(h => h.toLowerCase().includes('quantity') || h.toLowerCase().includes('qty'));
    console.log(`[FbmOrderImporter] Quantity-related headers found: ${JSON.stringify(qtyHeaders)}`);

    // Determine the quantity column - Amazon uses different names in different reports
    const quantityColumn = headerIndex['quantity-to-ship'] !== undefined ? 'quantity-to-ship'
      : headerIndex['quantity-purchased'] !== undefined ? 'quantity-purchased'
      : headerIndex['quantity'] !== undefined ? 'quantity'
      : headerIndex['qty'] !== undefined ? 'qty'
      : null;
    console.log(`[FbmOrderImporter] Using quantity column: ${quantityColumn} (index: ${headerIndex[quantityColumn]})`);

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
          // Sales channel (e.g., "Amazon.de", "Amazon.fr") - for determining correct sales team
          salesChannel: cols[headerIndex['sales-channel']]?.trim() || '',
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

      // Parse quantity - use the detected column name
      const quantityRaw = quantityColumn ? cols[headerIndex[quantityColumn]]?.trim() : null;
      const quantity = parseInt(quantityRaw || '1');

      // Debug log for first item
      if (i === 1) {
        console.log(`[FbmOrderImporter] Quantity debug - column: ${quantityColumn}, raw: "${quantityRaw}", parsed: ${quantity}`);
      }

      // Check if this is a promotion/discount item
      // Promotion items appear in TSV as separate line items with price <= 0 or qty = 0
      // IMPORTANT: Check using RESOLVED SKU, not original - "18011A" resolves to "18011" (real product)
      const isPromotionItem = this.isPromotionSku(resolved.odooSku || sku, itemPrice, quantity);
      if (isPromotionItem) {
        // Mark as promotion item - will use PROMOTION_DISCOUNT product in Odoo
        console.log(`[FbmOrderImporter] Detected promotion item: SKU=${sku}, resolved=${resolved.odooSku}, price=${itemPrice}, qty=${quantity}`);
        orderGroups[orderId].items.push({
          sku: 'PROMOTION DISCOUNT',
          resolvedSku: 'PROMOTION DISCOUNT',
          quantity: 1,
          productName: `Promotion: ${sku}`,
          itemPrice: itemPrice, // Keep original (negative) price
          shippingPrice: 0,
          isPromotion: true
        });
        continue;
      }

      orderGroups[orderId].items.push({
        sku: sku,
        resolvedSku: resolved.odooSku,
        quantity: quantity,
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
   * Check if a SKU is a promotion/discount item
   *
   * IMPORTANT: First checks if SKU exists in product database - if it does, it's NOT a promotion.
   * Only applies promotion heuristics if the SKU is NOT found in the database.
   *
   * Amazon TSV files include promotion items as separate line items with:
   * - SKU that looks like a promotion code (alphanumeric, no dashes, 5-10 chars like "595771C")
   * - Price of 0 or negative (for discounts)
   * - Quantity of 0
   *
   * @param {string} sku - The SKU to check (should be resolved SKU)
   * @param {number} price - The item price
   * @param {number} quantity - The quantity
   * @returns {boolean} True if this is a promotion item
   */
  isPromotionSku(sku, price, quantity) {
    if (!sku) return true; // Skip empty SKUs

    // FIRST: Check if SKU exists in products database
    // If it's a valid product, it's NOT a promotion regardless of price/pattern
    if (this.isValidProductSku(sku)) {
      return false;
    }

    // Skip items with zero or negative price and zero quantity
    if (price <= 0 && quantity === 0) {
      return true;
    }

    // Skip items with zero quantity (likely cancelled/promotional)
    if (quantity === 0) {
      return true;
    }

    // Check if SKU looks like a promotion code:
    // - All alphanumeric (no dashes, no underscores)
    // - 5-10 characters
    // - Contains mix of letters and numbers (real SKUs are usually numeric or have dashes)
    // - Ends with a letter (many promotion codes do, like "595771C")
    const isAlphanumericOnly = /^[A-Z0-9]+$/i.test(sku);
    const hasNoDashes = !sku.includes('-') && !sku.includes('_');
    const length5to10 = sku.length >= 5 && sku.length <= 10;
    const endsWithLetter = /[A-Za-z]$/.test(sku);
    const hasLettersAndNumbers = /[A-Za-z]/.test(sku) && /[0-9]/.test(sku);

    // Pattern: alphanumeric only, 5-10 chars, ends with letter, has both letters and numbers
    // This matches patterns like "595771C", "ABC123D" but NOT "10060K-FBM" or "12345"
    if (isAlphanumericOnly && hasNoDashes && length5to10 && endsWithLetter && hasLettersAndNumbers) {
      // Additional check: if it doesn't look like a product code (which often end in K)
      // and the price is 0 or very low, it's likely a promotion
      if (price <= 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Import orders from TSV to unified_orders collection
   * Does NOT create Odoo orders - that's done by SellerOrderCreator
   *
   * @param {string} tsvContent - TSV file content
   * @param {Object} options - Import options
   * @param {string} options.fileName - Original file name for tracking
   * @returns {Object} Import results with orderIds
   */
  async importToUnifiedOrders(tsvContent, options = {}) {
    await this.init();

    const results = {
      parsed: 0,
      imported: 0,
      updated: 0,
      errors: [],
      orderIds: []
    };

    try {
      const orderGroups = this.parseTsv(tsvContent);
      const orderIds = Object.keys(orderGroups);
      results.parsed = orderIds.length;

      console.log(`[FbmOrderImporter] Parsed ${orderIds.length} orders from TSV`);

      for (const orderId of orderIds) {
        const order = orderGroups[orderId];

        try {
          // Use AddressCleanerAI to intelligently parse addresses
          let cleanedAddress = null;
          try {
            cleanedAddress = await this.addressCleaner.cleanAddress({
              recipientName: order.recipientName,
              buyerName: order.buyerName,
              buyerCompanyName: order.buyerCompanyName,
              addressLine1: order.address1,
              addressLine2: order.address2,
              addressLine3: order.address3,
              city: order.city,
              state: order.state,
              postalCode: order.postalCode,
              countryCode: order.country,
              isBusinessOrder: order.isBusinessOrder
            });

            console.log(`[FbmOrderImporter] AI parsed address for ${orderId}: company="${cleanedAddress.company}", name="${cleanedAddress.name}", isCompany=${cleanedAddress.isCompany}, confidence=${cleanedAddress.confidence}`);
          } catch (aiError) {
            console.error(`[FbmOrderImporter] AI address cleaning failed for ${orderId}:`, aiError.message);
            // Continue without AI-cleaned address
          }

          // Build unified order document
          const unifiedOrderId = `${CHANNELS.AMAZON_SELLER}:${orderId}`;

          // Check if order already exists
          const existing = await this.unifiedService.getByAmazonOrderId(orderId);

          // Transform items to unified format
          const items = order.items.map(item => ({
            sku: item.resolvedSku || item.sku,
            sellerSku: item.sku,
            asin: null,
            ean: null,
            name: item.productName,
            title: item.productName,
            quantity: item.quantity,
            quantityShipped: 0,
            unitPrice: item.quantity > 0 ? item.itemPrice / item.quantity : item.itemPrice,
            lineTotal: item.itemPrice,
            tax: 0,
            isPromotion: item.isPromotion || false
          }));

          // Calculate totals
          const subtotal = items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);

          // Build shipping address
          const shippingAddress = {
            name: order.recipientName || null,
            street: order.address1 || null,
            street2: order.address2 || order.address3 || null,
            city: order.city || null,
            state: order.state || null,
            postalCode: order.postalCode || null,
            countryCode: order.country || null,
            phone: order.shipPhone || order.buyerPhone || null
          };

          // Build billing address (if different from shipping)
          const hasBillingAddress = order.billName && order.billAddress1;
          const billingAddress = hasBillingAddress ? {
            name: order.billName || null,
            street: order.billAddress1 || null,
            street2: order.billAddress2 || order.billAddress3 || null,
            city: order.billCity || null,
            state: order.billState || null,
            postalCode: order.billPostalCode || null,
            countryCode: order.billCountry || order.country || null,
            phone: order.buyerPhone || null
          } : null;

          // Build address cleaning result
          const addressCleaningResult = cleanedAddress ? {
            company: cleanedAddress.company || null,
            name: cleanedAddress.name || null,
            street: cleanedAddress.street || null,
            street2: cleanedAddress.street2 || null,
            zip: cleanedAddress.zip || null,
            city: cleanedAddress.city || null,
            country: cleanedAddress.country || null,
            isCompany: cleanedAddress.isCompany || false,
            poNumber: cleanedAddress.poNumber || null,
            confidence: cleanedAddress.confidence || null,
            notes: cleanedAddress.notes || null,
            cleanedAt: new Date()
          } : null;

          // Extract marketplace from sales channel (e.g., "Amazon.de" -> "DE")
          const marketplaceMatch = order.salesChannel?.match(/amazon\.(\w{2})/i);
          const marketplaceCode = marketplaceMatch ? marketplaceMatch[1].toUpperCase() : 'DE';

          // Build unified order document
          const unifiedOrder = {
            unifiedOrderId,

            sourceIds: {
              amazonOrderId: orderId,
              amazonVendorPONumber: null,
              bolOrderId: null,
              odooSaleOrderId: existing?.sourceIds?.odooSaleOrderId || null,
              odooSaleOrderName: existing?.sourceIds?.odooSaleOrderName || null
            },

            channel: CHANNELS.AMAZON_SELLER,
            subChannel: SUB_CHANNELS.FBM,
            marketplace: {
              code: marketplaceCode,
              id: null,
              name: order.salesChannel || `Amazon.${marketplaceCode.toLowerCase()}`
            },

            orderDate: new Date(order.purchaseDate),
            lastUpdateDate: new Date(),
            shippingDeadline: null, // FBM - will be updated if we have ship-by date

            status: {
              unified: 'confirmed',
              source: 'Unshipped',
              odoo: existing?.status?.odoo || null
            },

            customer: {
              name: cleanedAddress?.company || cleanedAddress?.name || order.buyerName || order.recipientName || null,
              email: order.buyerEmail || null,
              odooPartnerId: existing?.customer?.odooPartnerId || null,
              odooPartnerName: existing?.customer?.odooPartnerName || null
            },

            shippingAddress,
            billingAddress,
            addressCleaningResult,

            // B2B indicators
            isBusinessOrder: order.isBusinessOrder || false,
            buyerCompanyName: order.buyerCompanyName || null,

            // TSV import tracking
            tsvImport: {
              importedAt: new Date(),
              fileName: options.fileName || null,
              salesChannel: order.salesChannel || null
            },

            totals: {
              subtotal,
              tax: 0,
              total: subtotal,
              currency: 'EUR'
            },

            items,

            // Preserve existing Odoo data
            odoo: existing?.odoo || {},

            amazonSeller: {
              fulfillmentChannel: 'MFN', // FBM = Merchant Fulfilled Network
              isPrime: false,
              isBusinessOrder: order.isBusinessOrder || false,
              isPremiumOrder: false,
              salesChannel: order.salesChannel,
              orderChannel: null,
              shipServiceLevel: null,
              shipmentServiceLevelCategory: null,
              buyerEmail: order.buyerEmail,
              buyerName: order.buyerName,
              autoImportEligible: true,
              itemsFetched: true,
              earliestShipDate: null,
              latestShipDate: null
            },
            amazonVendor: null,
            bol: null,

            createdAt: existing?.createdAt || new Date(),
            updatedAt: new Date()
          };

          // Upsert to unified_orders
          // Debug: log key fields being upserted for existing orders
          if (existing) {
            console.log(`[FbmOrderImporter] Updating existing order ${orderId}: name="${unifiedOrder.shippingAddress?.name}", street="${unifiedOrder.shippingAddress?.street}", tsvFile="${unifiedOrder.tsvImport?.fileName}"`);
          }

          const upsertResult = await this.unifiedService.upsert(unifiedOrderId, unifiedOrder);

          // Debug: verify the update actually worked
          if (existing && !upsertResult.upserted) {
            const afterUpdate = await this.unifiedService.getByAmazonOrderId(orderId);
            if (!afterUpdate?.shippingAddress?.name || !afterUpdate?.tsvImport?.fileName) {
              console.error(`[FbmOrderImporter] WARNING: Update may have failed for ${orderId}! After update: name="${afterUpdate?.shippingAddress?.name}", tsvFile="${afterUpdate?.tsvImport?.fileName}"`);
            }
          }

          if (upsertResult.upserted) {
            results.imported++;
          } else {
            results.updated++;
          }

          results.orderIds.push(orderId);

        } catch (error) {
          console.error(`[FbmOrderImporter] Error importing order ${orderId}:`, error.message);
          results.errors.push({
            orderId,
            error: error.message
          });
        }
      }

    } catch (error) {
      console.error(`[FbmOrderImporter] Error parsing TSV:`, error.message);
      results.errors.push({ error: error.message });
    }

    console.log(`[FbmOrderImporter] Import complete: ${results.imported} new, ${results.updated} updated, ${results.errors.length} errors`);

    return results;
  }

  /**
   * Get orders from unified_orders that were imported via TSV but not yet created in Odoo
   * @returns {Array} Orders pending Odoo creation
   */
  async getOrdersPendingOdooCreation() {
    await this.init();

    const db = getDb();
    const collection = db.collection('unified_orders');

    const orders = await collection.find({
      channel: CHANNELS.AMAZON_SELLER,
      subChannel: SUB_CHANNELS.FBM,
      'tsvImport.importedAt': { $ne: null },
      'sourceIds.odooSaleOrderId': null
    }).toArray();

    return orders;
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
