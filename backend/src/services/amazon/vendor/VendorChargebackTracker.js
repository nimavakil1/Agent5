/**
 * VendorChargebackTracker - Track and Manage Amazon Vendor Chargebacks
 *
 * Handles chargeback tracking for Vendor Central.
 * Chargebacks are deductions Amazon makes for various reasons:
 * - Shortage claims
 * - Price discrepancies
 * - Compliance violations (labeling, packaging, etc.)
 * - CoOp/Marketing deductions
 *
 * Flow:
 * 1. Import chargebacks from uploaded report file or API
 * 2. Store in MongoDB for tracking
 * 3. Link to related POs/invoices
 * 4. Track dispute status
 *
 * @module VendorChargebackTracker
 */

const { getDb } = require('../../../db');
const { VendorClient } = require('./VendorClient');
const csv = require('csv-parser');
const { Readable } = require('stream');

/**
 * Chargeback types
 */
const CHARGEBACK_TYPES = {
  SHORTAGE: 'Shortage',
  PRICE_CLAIM: 'PriceClaim',
  COMPLIANCE: 'Compliance',
  COOP: 'CoOp',
  FREIGHT: 'Freight',
  RETURN_ALLOWANCE: 'ReturnAllowance',
  OTHER: 'Other'
};

/**
 * Dispute statuses
 */
const DISPUTE_STATUS = {
  PENDING: 'pending',         // Not yet reviewed
  ACCEPTED: 'accepted',       // Accepted the chargeback (no dispute)
  DISPUTED: 'disputed',       // Dispute submitted
  WON: 'won',                 // Dispute won
  LOST: 'lost',               // Dispute lost
  PARTIAL: 'partial'          // Partial recovery
};

/**
 * MongoDB collection name
 */
const CHARGEBACK_COLLECTION = 'vendor_chargebacks';
const PO_COLLECTION = 'vendor_purchase_orders';

class VendorChargebackTracker {
  constructor() {
    this.db = null;
    this.clients = {};
  }

  /**
   * Initialize the tracker
   */
  async init() {
    this.db = getDb();
    await this.ensureIndexes();
    return this;
  }

  /**
   * Ensure MongoDB indexes exist
   */
  async ensureIndexes() {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);
    await collection.createIndexes([
      { key: { chargebackId: 1 }, unique: true },
      { key: { invoiceNumber: 1 } },
      { key: { purchaseOrderNumber: 1 } },
      { key: { chargebackType: 1 } },
      { key: { disputeStatus: 1 } },
      { key: { chargebackDate: -1 } },
      { key: { marketplaceId: 1 } }
    ]);
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
   * Import chargebacks from CSV file content
   * @param {string} csvContent - CSV file content
   * @param {Object} options - Import options
   * @param {string} options.marketplace - Marketplace ID
   */
  async importFromCSV(csvContent, options = {}) {
    const { marketplace = 'DE' } = options;

    const results = {
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: []
    };

    const chargebacks = [];

    // Parse CSV
    const parseCSV = () => {
      return new Promise((resolve, reject) => {
        const stream = Readable.from(csvContent);
        stream
          .pipe(csv())
          .on('data', (row) => {
            try {
              const chargeback = this._mapCSVRow(row, marketplace);
              if (chargeback) {
                chargebacks.push(chargeback);
              }
            } catch (error) {
              results.errors.push({ row, error: error.message });
            }
          })
          .on('end', () => resolve())
          .on('error', reject);
      });
    };

    await parseCSV();

    // Save chargebacks
    for (const chargeback of chargebacks) {
      try {
        const saved = await this._saveChargeback(chargeback);
        if (saved.upserted) {
          results.imported++;
        } else if (saved.modified) {
          results.updated++;
        } else {
          results.skipped++;
        }
      } catch (error) {
        results.errors.push({ chargebackId: chargeback.chargebackId, error: error.message });
      }
    }

    return results;
  }

  /**
   * Map CSV row to chargeback document
   */
  _mapCSVRow(row, marketplace) {
    // Common column mappings (adjust based on actual Amazon report format)
    const chargebackId = row['Chargeback ID'] || row['Deduction ID'] || row['Reference'];
    if (!chargebackId) return null;

    // Parse amount (handle different formats)
    let amount = 0;
    const amountStr = row['Amount'] || row['Chargeback Amount'] || row['Deduction Amount'] || '0';
    amount = Math.abs(parseFloat(amountStr.replace(/[^0-9.-]/g, '')) || 0);

    // Determine type
    let chargebackType = CHARGEBACK_TYPES.OTHER;
    const typeStr = (row['Type'] || row['Chargeback Type'] || row['Category'] || '').toLowerCase();
    if (typeStr.includes('shortage')) chargebackType = CHARGEBACK_TYPES.SHORTAGE;
    else if (typeStr.includes('price')) chargebackType = CHARGEBACK_TYPES.PRICE_CLAIM;
    else if (typeStr.includes('compliance') || typeStr.includes('violation')) chargebackType = CHARGEBACK_TYPES.COMPLIANCE;
    else if (typeStr.includes('coop') || typeStr.includes('marketing')) chargebackType = CHARGEBACK_TYPES.COOP;
    else if (typeStr.includes('freight') || typeStr.includes('shipping')) chargebackType = CHARGEBACK_TYPES.FREIGHT;
    else if (typeStr.includes('return')) chargebackType = CHARGEBACK_TYPES.RETURN_ALLOWANCE;

    // Parse date
    let chargebackDate = new Date();
    const dateStr = row['Date'] || row['Chargeback Date'] || row['Deduction Date'];
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        chargebackDate = parsed;
      }
    }

    return {
      chargebackId,
      marketplaceId: marketplace,
      chargebackType,
      chargebackDate,
      amount: {
        amount,
        currencyCode: row['Currency'] || 'EUR'
      },
      invoiceNumber: row['Invoice Number'] || row['Invoice'] || null,
      purchaseOrderNumber: row['PO Number'] || row['Purchase Order'] || null,
      asin: row['ASIN'] || null,
      vendorSku: row['Vendor SKU'] || row['SKU'] || null,
      description: row['Description'] || row['Reason'] || row['Comments'] || '',
      disputeStatus: DISPUTE_STATUS.PENDING,
      rawData: row
    };
  }

  /**
   * Save chargeback to MongoDB
   */
  async _saveChargeback(chargeback) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);

    const result = await collection.updateOne(
      { chargebackId: chargeback.chargebackId },
      {
        $set: {
          ...chargeback,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    return {
      upserted: result.upsertedCount > 0,
      modified: result.modifiedCount > 0
    };
  }

  /**
   * Get chargebacks with filters
   */
  async getChargebacks(filters = {}, options = {}) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);

    const query = {};
    if (filters.marketplaceId) query.marketplaceId = filters.marketplaceId;
    if (filters.chargebackType) query.chargebackType = filters.chargebackType;
    if (filters.disputeStatus) query.disputeStatus = filters.disputeStatus;
    if (filters.purchaseOrderNumber) query.purchaseOrderNumber = filters.purchaseOrderNumber;
    if (filters.invoiceNumber) query.invoiceNumber = filters.invoiceNumber;
    if (filters.dateFrom || filters.dateTo) {
      query.chargebackDate = {};
      if (filters.dateFrom) query.chargebackDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.chargebackDate.$lte = new Date(filters.dateTo);
    }

    const cursor = collection.find(query);

    if (options.sort) {
      cursor.sort(options.sort);
    } else {
      cursor.sort({ chargebackDate: -1 });
    }

    if (options.limit) cursor.limit(options.limit);
    if (options.skip) cursor.skip(options.skip);

    return cursor.toArray();
  }

  /**
   * Get chargeback by ID
   */
  async getChargeback(chargebackId) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);
    return collection.findOne({ chargebackId });
  }

  /**
   * Update dispute status
   */
  async updateDisputeStatus(chargebackId, status, notes = null) {
    if (!Object.values(DISPUTE_STATUS).includes(status)) {
      throw new Error(`Invalid dispute status: ${status}`);
    }

    const collection = this.db.collection(CHARGEBACK_COLLECTION);

    const update = {
      $set: {
        disputeStatus: status,
        updatedAt: new Date()
      }
    };

    if (notes) {
      update.$push = {
        disputeNotes: {
          status,
          notes,
          addedAt: new Date()
        }
      };
    }

    const result = await collection.updateOne(
      { chargebackId },
      update
    );

    return result.modifiedCount > 0;
  }

  /**
   * Add a dispute note/comment
   */
  async addDisputeNote(chargebackId, note) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);

    const result = await collection.updateOne(
      { chargebackId },
      {
        $push: {
          disputeNotes: {
            note,
            addedAt: new Date()
          }
        },
        $set: { updatedAt: new Date() }
      }
    );

    return result.modifiedCount > 0;
  }

  /**
   * Get chargeback statistics
   */
  async getStats(filters = {}) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);

    const matchStage = {};
    if (filters.marketplaceId) matchStage.marketplaceId = filters.marketplaceId;
    if (filters.dateFrom || filters.dateTo) {
      matchStage.chargebackDate = {};
      if (filters.dateFrom) matchStage.chargebackDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) matchStage.chargebackDate.$lte = new Date(filters.dateTo);
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          totalAmount: { $sum: '$amount.amount' },
          pendingCount: {
            $sum: { $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.PENDING] }, 1, 0] }
          },
          pendingAmount: {
            $sum: {
              $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.PENDING] }, '$amount.amount', 0]
            }
          },
          disputedCount: {
            $sum: { $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.DISPUTED] }, 1, 0] }
          },
          disputedAmount: {
            $sum: {
              $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.DISPUTED] }, '$amount.amount', 0]
            }
          },
          wonCount: {
            $sum: { $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.WON] }, 1, 0] }
          },
          wonAmount: {
            $sum: {
              $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.WON] }, '$amount.amount', 0]
            }
          },
          lostCount: {
            $sum: { $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.LOST] }, 1, 0] }
          },
          lostAmount: {
            $sum: {
              $cond: [{ $eq: ['$disputeStatus', DISPUTE_STATUS.LOST] }, '$amount.amount', 0]
            }
          }
        }
      }
    ];

    const [summary] = await collection.aggregate(pipeline).toArray();

    // By type breakdown
    const byType = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$chargebackType',
          count: { $sum: 1 },
          amount: { $sum: '$amount.amount' }
        }
      },
      { $sort: { amount: -1 } }
    ]).toArray();

    // By marketplace breakdown
    const byMarketplace = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$marketplaceId',
          count: { $sum: 1 },
          amount: { $sum: '$amount.amount' }
        }
      },
      { $sort: { amount: -1 } }
    ]).toArray();

    return {
      summary: summary || {
        totalCount: 0,
        totalAmount: 0,
        pendingCount: 0,
        pendingAmount: 0,
        disputedCount: 0,
        disputedAmount: 0,
        wonCount: 0,
        wonAmount: 0,
        lostCount: 0,
        lostAmount: 0
      },
      byType: byType.map(t => ({ type: t._id, count: t.count, amount: t.amount })),
      byMarketplace: byMarketplace.map(m => ({ marketplace: m._id, count: m.count, amount: m.amount }))
    };
  }

  /**
   * Link chargeback to PO
   */
  async linkToPO(chargebackId, purchaseOrderNumber) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);

    // Verify PO exists
    const po = await this.db.collection(PO_COLLECTION).findOne({ purchaseOrderNumber });
    if (!po) {
      return { success: false, error: 'Purchase order not found' };
    }

    const result = await collection.updateOne(
      { chargebackId },
      {
        $set: {
          purchaseOrderNumber,
          linkedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    return { success: result.modifiedCount > 0 };
  }

  /**
   * Manually create a chargeback entry
   */
  async createChargeback(data) {
    const chargeback = {
      chargebackId: data.chargebackId || `CB-${Date.now().toString(36).toUpperCase()}`,
      marketplaceId: data.marketplaceId || 'DE',
      chargebackType: data.chargebackType || CHARGEBACK_TYPES.OTHER,
      chargebackDate: data.chargebackDate ? new Date(data.chargebackDate) : new Date(),
      amount: {
        amount: parseFloat(data.amount) || 0,
        currencyCode: data.currencyCode || 'EUR'
      },
      invoiceNumber: data.invoiceNumber || null,
      purchaseOrderNumber: data.purchaseOrderNumber || null,
      asin: data.asin || null,
      vendorSku: data.vendorSku || null,
      description: data.description || '',
      disputeStatus: DISPUTE_STATUS.PENDING,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const collection = this.db.collection(CHARGEBACK_COLLECTION);
    await collection.insertOne(chargeback);

    return chargeback;
  }

  /**
   * Delete a chargeback
   */
  async deleteChargeback(chargebackId) {
    const collection = this.db.collection(CHARGEBACK_COLLECTION);
    const result = await collection.deleteOne({ chargebackId });
    return result.deletedCount > 0;
  }
}

// Singleton instance
let trackerInstance = null;

async function getVendorChargebackTracker() {
  if (!trackerInstance) {
    trackerInstance = new VendorChargebackTracker();
    await trackerInstance.init();
  }
  return trackerInstance;
}

module.exports = {
  VendorChargebackTracker,
  getVendorChargebackTracker,
  CHARGEBACK_TYPES,
  DISPUTE_STATUS
};
