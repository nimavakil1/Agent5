/**
 * VendorPOAcknowledger - Send PO Acknowledgments to Amazon Vendor Central
 *
 * Handles the acknowledgment workflow for Vendor Central purchase orders.
 * Acknowledgments tell Amazon whether you can fulfill the order.
 *
 * Acknowledgment Codes:
 * - Accepted: Full order can be fulfilled
 * - Backordered: Items temporarily unavailable, will ship later
 * - Rejected: Cannot fulfill (out of stock, discontinued, etc.)
 *
 * @module VendorPOAcknowledger
 */

const { getDb } = require('../../../db');
const { VendorClient } = require('./VendorClient');
const { getVendorPOImporter } = require('./VendorPOImporter');

/**
 * Acknowledgment status codes
 */
const ACK_CODES = {
  ACCEPTED: 'Accepted',
  BACKORDERED: 'Backordered',
  REJECTED: 'Rejected'
};

/**
 * Party IDs for ACROPAQ vendor accounts
 */
const VENDOR_PARTY_IDS = {
  FR: process.env.AMAZON_VENDOR_PARTY_ID_FR || 'ACROPAQ',
  DE: process.env.AMAZON_VENDOR_PARTY_ID_DE || 'ACROPAQ',
  NL: process.env.AMAZON_VENDOR_PARTY_ID_NL || 'ACROPAQ',
  UK: process.env.AMAZON_VENDOR_PARTY_ID_UK || 'ACROPAQ',
  IT: process.env.AMAZON_VENDOR_PARTY_ID_IT || 'ACROPAQ',
  ES: process.env.AMAZON_VENDOR_PARTY_ID_ES || 'ACROPAQ',
  SE: process.env.AMAZON_VENDOR_PARTY_ID_SE || 'ACROPAQ',
  PL: process.env.AMAZON_VENDOR_PARTY_ID_PL || 'ACROPAQ',
};

class VendorPOAcknowledger {
  constructor() {
    this.db = null;
    this.importer = null;
    this.clients = {};
  }

  /**
   * Initialize the acknowledger
   */
  async init() {
    this.db = getDb();
    this.importer = await getVendorPOImporter();
    return this;
  }

  /**
   * Get or create VendorClient for marketplace
   */
  getClient(marketplace) {
    if (!this.clients[marketplace]) {
      this.clients[marketplace] = new VendorClient(marketplace);
    }
    return this.clients[marketplace];
  }

  /**
   * Acknowledge a single PO
   *
   * @param {string} poNumber - Purchase order number
   * @param {Object} options - Acknowledgment options
   * @param {string} options.status - Acknowledgment status (Accepted, Backordered, Rejected)
   * @param {Array} options.items - Optional item-level acknowledgments
   * @param {boolean} options.dryRun - If true, don't submit to Amazon
   * @returns {Object} Result with success status and transaction ID
   */
  async acknowledgePO(poNumber, options = {}) {
    const { status = ACK_CODES.ACCEPTED, items = null, dryRun = false } = options;

    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      status,
      transactionId: null,
      errors: [],
      warnings: []
    };

    try {
      // Get PO from MongoDB
      const po = await this.importer.getPurchaseOrder(poNumber);
      if (!po) {
        result.errors.push(`PO not found: ${poNumber}`);
        return result;
      }

      // Check if already acknowledged
      // Handle unified schema (amazonVendor.acknowledgment) and legacy (acknowledgment)
      const acknowledgment = po.amazonVendor?.acknowledgment || po.acknowledgment;
      if (acknowledgment?.acknowledged) {
        result.success = true;
        result.skipped = true;
        result.skipReason = `Already acknowledged at ${acknowledgment.acknowledgedAt}`;
        result.warnings.push(result.skipReason);
        return result;
      }

      // Check PO state - handle unified and legacy
      const poState = po.amazonVendor?.purchaseOrderState || po.purchaseOrderState;
      if (poState === 'Closed') {
        result.errors.push('Cannot acknowledge a closed PO');
        return result;
      }

      // Get client for marketplace - handle unified (marketplace.code) and legacy (marketplaceId)
      const marketplaceId = po.marketplace?.code || po.marketplaceId;
      const client = this.getClient(marketplaceId);
      // Use partyId from the PO itself (Amazon's expected value), fallback to config
      const sellingParty = po.amazonVendor?.sellingParty || po.sellingParty;
      const partyId = sellingParty?.partyId || VENDOR_PARTY_IDS[marketplaceId] || 'ACROPAQ';

      // Get schedule data from PO (set by user via update-acknowledgments endpoint)
      // Handle unified schema (amazonVendor.deliveryWindow) and legacy (deliveryWindow)
      const deliveryWindow = po.amazonVendor?.deliveryWindow || po.deliveryWindow;
      const scheduleData = {
        scheduledShipDate: acknowledgment?.scheduledShipDate || deliveryWindow?.startDate,
        scheduledDeliveryDate: acknowledgment?.scheduledDeliveryDate || deliveryWindow?.endDate
      };

      // Build acknowledgment payload with line-level data
      const ackItems = items || this.buildItemAcknowledgments(po.items, status, scheduleData);

      const acknowledgment = {
        acknowledgements: [{
          purchaseOrderNumber: poNumber,
          sellingParty: {
            partyId: partyId
          },
          acknowledgementDate: new Date().toISOString(),
          items: ackItems
        }]
      };

      result.payload = acknowledgment;

      if (dryRun) {
        result.success = true;
        result.dryRun = true;
        result.warnings.push('Dry run - not submitted to Amazon');
        return result;
      }

      // Submit to Amazon
      console.log(`[VendorPOAcknowledger] Submitting acknowledgment for ${poNumber}...`);
      const response = await client.submitAcknowledgement(acknowledgment);

      // Check for transaction ID
      if (response.transactionId) {
        result.transactionId = response.transactionId;
      }

      // Update MongoDB
      await this.importer.markAcknowledged(poNumber, status);

      result.success = true;
      result.amazonResponse = response;

      console.log(`[VendorPOAcknowledger] Successfully acknowledged ${poNumber} as ${status}`);
      return result;

    } catch (error) {
      result.errors.push(error.message);
      console.error(`[VendorPOAcknowledger] Error acknowledging ${poNumber}:`, error);
      return result;
    }
  }

  /**
   * Build item-level acknowledgments from PO items
   * Supports line-level quantities: acknowledgeQty, backorderQty, productAvailability
   *
   * @param {Array} items - PO items with acknowledgment data
   * @param {string} defaultStatus - Default status if item doesn't have one
   * @param {Object} scheduleData - { scheduledShipDate, scheduledDeliveryDate }
   */
  buildItemAcknowledgments(items, defaultStatus = ACK_CODES.ACCEPTED, scheduleData = {}) {
    if (!items || items.length === 0) {
      return [];
    }

    // Default schedule dates (today + 7 days for ship, +14 for delivery)
    const defaultShipDate = scheduleData.scheduledShipDate ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const defaultDeliveryDate = scheduleData.scheduledDeliveryDate ||
      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    return items.map(item => {
      // Handle unified schema (quantity) and legacy (orderedQuantity.amount)
      const orderedQty = item.orderedQuantity?.amount || item.quantity || 0;
      const acknowledgeQty = item.acknowledgeQty ?? orderedQty; // Default to full order
      const backorderQty = item.backorderQty ?? 0;
      const productAvailability = item.productAvailability || 'accepted';
      const unitOfMeasure = item.orderedQuantity?.unitOfMeasure || 'Eaches';

      // Handle unified schema field names
      const amazonProductId = item.amazonProductIdentifier || item.asin;
      const vendorProductId = item.vendorProductIdentifier || item.ean;
      const netCost = item.netCost || (item.unitPrice ? { amount: item.unitPrice, currencyCode: 'EUR' } : null);

      // Calculate cancelled/rejected quantity
      const cancelledQty = Math.max(0, orderedQty - acknowledgeQty - backorderQty);

      // Build itemAcknowledgements array (like Emipro)
      const itemAcknowledgements = [];

      // Add accepted quantity
      if (acknowledgeQty > 0 && productAvailability === 'accepted') {
        itemAcknowledgements.push({
          acknowledgementCode: 'Accepted',
          acknowledgedQuantity: {
            amount: acknowledgeQty,
            unitOfMeasure: unitOfMeasure
          },
          scheduledShipDate: this.formatScheduleDate(defaultShipDate),
          scheduledDeliveryDate: this.formatScheduleDate(defaultDeliveryDate)
        });
      }

      // Add backordered quantity
      if (item.isBackOrderAllowed && backorderQty > 0) {
        itemAcknowledgements.push({
          acknowledgementCode: 'Backordered',
          acknowledgedQuantity: {
            amount: backorderQty,
            unitOfMeasure: unitOfMeasure
          },
          scheduledShipDate: this.formatScheduleDate(defaultShipDate),
          scheduledDeliveryDate: this.formatScheduleDate(defaultDeliveryDate)
        });
      }

      // Add rejected/cancelled quantity
      if (cancelledQty > 0) {
        // Map productAvailability to rejection reason
        let rejectionReason = 'TemporarilyUnavailable';
        if (productAvailability.includes('ObsoleteProduct')) {
          rejectionReason = 'ObsoleteProduct';
        } else if (productAvailability.includes('InvalidProductIdentifier')) {
          rejectionReason = 'InvalidProductIdentifier';
        }

        itemAcknowledgements.push({
          acknowledgementCode: 'Rejected',
          acknowledgedQuantity: {
            amount: cancelledQty,
            unitOfMeasure: unitOfMeasure
          },
          scheduledShipDate: this.formatScheduleDate(defaultShipDate),
          scheduledDeliveryDate: this.formatScheduleDate(defaultDeliveryDate),
          rejectionReason: rejectionReason
        });
      }

      // If no acknowledgements built (e.g., all zeros), default to accepting full order
      if (itemAcknowledgements.length === 0) {
        itemAcknowledgements.push({
          acknowledgementCode: defaultStatus,
          acknowledgedQuantity: {
            amount: orderedQty,
            unitOfMeasure: unitOfMeasure
          },
          scheduledShipDate: this.formatScheduleDate(defaultShipDate),
          scheduledDeliveryDate: this.formatScheduleDate(defaultDeliveryDate)
        });
      }

      return {
        itemSequenceNumber: parseInt(item.itemSequenceNumber) || 1,
        amazonProductIdentifier: amazonProductId,
        vendorProductIdentifier: vendorProductId,
        orderedQuantity: {
          amount: orderedQty,
          unitOfMeasure: unitOfMeasure
        },
        netCost: netCost ? {
          currencyCode: netCost.currencyCode || 'EUR',
          amount: String(netCost.amount)
        } : undefined,
        itemAcknowledgements: itemAcknowledgements
      };
    });
  }

  /**
   * Format date for Amazon API (ISO 8601 with time)
   */
  formatScheduleDate(date) {
    if (!date) return null;
    const d = new Date(date);
    // Format as YYYY-MM-DDTHH:MM:SSZ
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Acknowledge multiple POs
   *
   * @param {string[]} poNumbers - Array of PO numbers
   * @param {Object} options - Acknowledgment options
   * @returns {Object} Aggregate results
   */
  async acknowledgePOs(poNumbers, options = {}) {
    const results = {
      processed: 0,
      acknowledged: 0,
      skipped: 0,
      failed: 0,
      orders: []
    };

    for (const poNumber of poNumbers) {
      const result = await this.acknowledgePO(poNumber, options);
      results.processed++;
      results.orders.push(result);

      if (result.skipped) {
        results.skipped++;
      } else if (result.success) {
        results.acknowledged++;
      } else {
        results.failed++;
      }
    }

    return results;
  }

  /**
   * Acknowledge all pending POs (those not yet acknowledged)
   *
   * @param {Object} options - Options
   * @param {number} options.limit - Max POs to process
   * @param {string} options.status - Acknowledgment status
   * @returns {Object} Aggregate results
   */
  async acknowledgePendingPOs(options = {}) {
    const { limit = 50, status = ACK_CODES.ACCEPTED } = options;

    // Get pending acknowledgments
    const pendingPOs = await this.importer.getPendingAcknowledgment(limit);
    const poNumbers = pendingPOs.map(po => po.purchaseOrderNumber);

    if (poNumbers.length === 0) {
      return {
        processed: 0,
        acknowledged: 0,
        skipped: 0,
        failed: 0,
        orders: [],
        message: 'No pending POs to acknowledge'
      };
    }

    return this.acknowledgePOs(poNumbers, { ...options, status });
  }

  /**
   * Get transaction status for a submitted acknowledgment
   *
   * @param {string} transactionId - Transaction ID from submit response
   * @param {string} marketplace - Marketplace code
   * @returns {Object} Transaction status
   */
  async getTransactionStatus(transactionId, marketplace) {
    const client = this.getClient(marketplace);
    return client.getTransactionStatus(transactionId);
  }

  /**
   * Reject a PO (convenience method)
   */
  async rejectPO(poNumber, reason = null) {
    const result = await this.acknowledgePO(poNumber, { status: ACK_CODES.REJECTED });
    if (reason) {
      result.rejectionReason = reason;
    }
    return result;
  }

  /**
   * Mark PO as backordered (convenience method)
   */
  async backorderPO(poNumber, expectedDate = null) {
    const result = await this.acknowledgePO(poNumber, { status: ACK_CODES.BACKORDERED });
    if (expectedDate) {
      result.expectedShipDate = expectedDate;
    }
    return result;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the VendorPOAcknowledger instance
 */
async function getVendorPOAcknowledger() {
  if (!instance) {
    instance = new VendorPOAcknowledger();
    await instance.init();
  }
  return instance;
}

module.exports = {
  VendorPOAcknowledger,
  getVendorPOAcknowledger,
  ACK_CODES,
  VENDOR_PARTY_IDS
};
