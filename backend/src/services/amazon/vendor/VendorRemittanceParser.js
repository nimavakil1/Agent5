/**
 * VendorRemittanceParser - Parse and Track Amazon Vendor Payments
 *
 * Handles payment/remittance tracking for Vendor Central.
 * Remittances show what Amazon paid and for which invoices.
 *
 * Flow:
 * 1. Import remittance data from uploaded report file
 * 2. Store in MongoDB for tracking
 * 3. Link payments to invoices
 * 4. Reconcile with Odoo payments
 *
 * @module VendorRemittanceParser
 */

const { getDb } = require('../../../db');
const csv = require('csv-parser');
const { Readable } = require('stream');

/**
 * Payment status
 */
const PAYMENT_STATUS = {
  PENDING: 'pending',       // Expected but not received
  RECEIVED: 'received',     // Payment received
  PARTIAL: 'partial',       // Partial payment
  RECONCILED: 'reconciled', // Matched with Odoo
  DISPUTED: 'disputed'      // Amount mismatch
};

/**
 * Payment types
 */
const PAYMENT_TYPES = {
  INVOICE: 'Invoice',
  CREDIT_NOTE: 'CreditNote',
  ADJUSTMENT: 'Adjustment',
  DEDUCTION: 'Deduction'
};

/**
 * MongoDB collection name
 */
const REMITTANCE_COLLECTION = 'vendor_remittances';
const PAYMENT_COLLECTION = 'vendor_payments';
const INVOICE_COLLECTION = 'vendor_invoices';

class VendorRemittanceParser {
  constructor() {
    this.db = null;
  }

  /**
   * Initialize the parser
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
    const remittanceCol = this.db.collection(REMITTANCE_COLLECTION);
    await remittanceCol.createIndexes([
      { key: { remittanceId: 1 }, unique: true },
      { key: { paymentDate: -1 } },
      { key: { marketplaceId: 1 } }
    ]);

    const paymentCol = this.db.collection(PAYMENT_COLLECTION);
    await paymentCol.createIndexes([
      { key: { paymentId: 1 }, unique: true },
      { key: { remittanceId: 1 } },
      { key: { invoiceNumber: 1 } },
      { key: { status: 1 } },
      { key: { paymentDate: -1 } }
    ]);
  }

  /**
   * Import remittance from CSV file content
   * @param {string} csvContent - CSV file content
   * @param {Object} options - Import options
   * @param {string} options.marketplace - Marketplace ID
   */
  async importFromCSV(csvContent, options = {}) {
    const { marketplace = 'DE' } = options;

    const results = {
      remittancesImported: 0,
      paymentsImported: 0,
      paymentsUpdated: 0,
      errors: []
    };

    const payments = [];
    let remittanceId = null;
    let paymentDate = null;
    let totalAmount = 0;

    // Parse CSV
    const parseCSV = () => {
      return new Promise((resolve, reject) => {
        const stream = Readable.from(csvContent);
        stream
          .pipe(csv())
          .on('data', (row) => {
            try {
              // Try to extract remittance ID from header rows
              if (row['Remittance ID'] || row['Payment ID'] || row['Reference']) {
                remittanceId = row['Remittance ID'] || row['Payment ID'] || row['Reference'];
              }
              if (row['Payment Date'] || row['Date']) {
                const dateStr = row['Payment Date'] || row['Date'];
                const parsed = new Date(dateStr);
                if (!isNaN(parsed.getTime())) {
                  paymentDate = parsed;
                }
              }

              const payment = this._mapCSVRow(row, marketplace);
              if (payment) {
                payments.push(payment);
                totalAmount += payment.amount.amount;
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

    // Generate remittance ID if not found
    if (!remittanceId) {
      remittanceId = `REM-${Date.now().toString(36).toUpperCase()}`;
    }

    // Save remittance header
    if (payments.length > 0) {
      await this._saveRemittance({
        remittanceId,
        marketplaceId: marketplace,
        paymentDate: paymentDate || new Date(),
        totalAmount: {
          amount: totalAmount,
          currencyCode: payments[0]?.amount?.currencyCode || 'EUR'
        },
        lineCount: payments.length
      });
      results.remittancesImported = 1;
    }

    // Save payment lines
    for (const payment of payments) {
      try {
        payment.remittanceId = remittanceId;
        const saved = await this._savePayment(payment);
        if (saved.upserted) {
          results.paymentsImported++;
        } else if (saved.modified) {
          results.paymentsUpdated++;
        }
      } catch (error) {
        results.errors.push({ paymentId: payment.paymentId, error: error.message });
      }
    }

    return results;
  }

  /**
   * Map CSV row to payment document
   */
  _mapCSVRow(row, marketplace) {
    // Common column mappings (adjust based on actual Amazon report format)
    const invoiceNumber = row['Invoice Number'] || row['Invoice'] || row['Invoice #'];
    if (!invoiceNumber) return null;

    // Parse amount
    let amount = 0;
    const amountStr = row['Amount'] || row['Payment Amount'] || row['Net Amount'] || '0';
    amount = parseFloat(amountStr.replace(/[^0-9.-]/g, '')) || 0;

    // Determine type
    let paymentType = PAYMENT_TYPES.INVOICE;
    const typeStr = (row['Type'] || row['Line Type'] || '').toLowerCase();
    if (typeStr.includes('credit')) paymentType = PAYMENT_TYPES.CREDIT_NOTE;
    else if (typeStr.includes('adjustment')) paymentType = PAYMENT_TYPES.ADJUSTMENT;
    else if (typeStr.includes('deduction')) paymentType = PAYMENT_TYPES.DEDUCTION;

    // Parse date
    let paymentDate = new Date();
    const dateStr = row['Date'] || row['Payment Date'];
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        paymentDate = parsed;
      }
    }

    return {
      paymentId: `PAY-${invoiceNumber}-${Date.now().toString(36)}`,
      marketplaceId: marketplace,
      paymentType,
      paymentDate,
      invoiceNumber,
      purchaseOrderNumber: row['PO Number'] || row['Purchase Order'] || null,
      amount: {
        amount,
        currencyCode: row['Currency'] || 'EUR'
      },
      invoiceAmount: {
        amount: parseFloat((row['Invoice Amount'] || '0').replace(/[^0-9.-]/g, '')) || 0,
        currencyCode: row['Currency'] || 'EUR'
      },
      deductions: {
        amount: parseFloat((row['Deductions'] || row['Deduction Amount'] || '0').replace(/[^0-9.-]/g, '')) || 0,
        currencyCode: row['Currency'] || 'EUR'
      },
      description: row['Description'] || row['Notes'] || '',
      status: PAYMENT_STATUS.RECEIVED,
      rawData: row
    };
  }

  /**
   * Save remittance to MongoDB
   */
  async _saveRemittance(remittance) {
    const collection = this.db.collection(REMITTANCE_COLLECTION);

    await collection.updateOne(
      { remittanceId: remittance.remittanceId },
      {
        $set: {
          ...remittance,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  /**
   * Save payment to MongoDB
   */
  async _savePayment(payment) {
    const collection = this.db.collection(PAYMENT_COLLECTION);

    const result = await collection.updateOne(
      { paymentId: payment.paymentId },
      {
        $set: {
          ...payment,
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
   * Get remittances with filters
   */
  async getRemittances(filters = {}, options = {}) {
    const collection = this.db.collection(REMITTANCE_COLLECTION);

    const query = {};
    if (filters.marketplaceId) query.marketplaceId = filters.marketplaceId;
    if (filters.dateFrom || filters.dateTo) {
      query.paymentDate = {};
      if (filters.dateFrom) query.paymentDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.paymentDate.$lte = new Date(filters.dateTo);
    }

    const cursor = collection.find(query);

    if (options.sort) {
      cursor.sort(options.sort);
    } else {
      cursor.sort({ paymentDate: -1 });
    }

    if (options.limit) cursor.limit(options.limit);
    if (options.skip) cursor.skip(options.skip);

    return cursor.toArray();
  }

  /**
   * Get remittance by ID with payment lines
   */
  async getRemittance(remittanceId) {
    const remittance = await this.db.collection(REMITTANCE_COLLECTION).findOne({ remittanceId });
    if (!remittance) return null;

    const payments = await this.db.collection(PAYMENT_COLLECTION)
      .find({ remittanceId })
      .sort({ invoiceNumber: 1 })
      .toArray();

    return {
      ...remittance,
      payments
    };
  }

  /**
   * Get payments with filters
   */
  async getPayments(filters = {}, options = {}) {
    const collection = this.db.collection(PAYMENT_COLLECTION);

    const query = {};
    if (filters.marketplaceId) query.marketplaceId = filters.marketplaceId;
    if (filters.invoiceNumber) query.invoiceNumber = filters.invoiceNumber;
    if (filters.status) query.status = filters.status;
    if (filters.remittanceId) query.remittanceId = filters.remittanceId;
    if (filters.dateFrom || filters.dateTo) {
      query.paymentDate = {};
      if (filters.dateFrom) query.paymentDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.paymentDate.$lte = new Date(filters.dateTo);
    }

    const cursor = collection.find(query);

    if (options.sort) {
      cursor.sort(options.sort);
    } else {
      cursor.sort({ paymentDate: -1 });
    }

    if (options.limit) cursor.limit(options.limit);
    if (options.skip) cursor.skip(options.skip);

    return cursor.toArray();
  }

  /**
   * Get payment statistics
   */
  async getStats(filters = {}) {
    const collection = this.db.collection(PAYMENT_COLLECTION);

    const matchStage = {};
    if (filters.marketplaceId) matchStage.marketplaceId = filters.marketplaceId;
    if (filters.dateFrom || filters.dateTo) {
      matchStage.paymentDate = {};
      if (filters.dateFrom) matchStage.paymentDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) matchStage.paymentDate.$lte = new Date(filters.dateTo);
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalPayments: { $sum: 1 },
          totalAmount: { $sum: '$amount.amount' },
          totalInvoiced: { $sum: '$invoiceAmount.amount' },
          totalDeductions: { $sum: '$deductions.amount' },
          receivedCount: {
            $sum: { $cond: [{ $eq: ['$status', PAYMENT_STATUS.RECEIVED] }, 1, 0] }
          },
          reconciledCount: {
            $sum: { $cond: [{ $eq: ['$status', PAYMENT_STATUS.RECONCILED] }, 1, 0] }
          },
          disputedCount: {
            $sum: { $cond: [{ $eq: ['$status', PAYMENT_STATUS.DISPUTED] }, 1, 0] }
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
          _id: '$paymentType',
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

    // Monthly trend
    const monthlyTrend = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            year: { $year: '$paymentDate' },
            month: { $month: '$paymentDate' }
          },
          count: { $sum: 1 },
          amount: { $sum: '$amount.amount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 12 }
    ]).toArray();

    return {
      summary: summary || {
        totalPayments: 0,
        totalAmount: 0,
        totalInvoiced: 0,
        totalDeductions: 0,
        receivedCount: 0,
        reconciledCount: 0,
        disputedCount: 0
      },
      byType: byType.map(t => ({ type: t._id, count: t.count, amount: t.amount })),
      byMarketplace: byMarketplace.map(m => ({ marketplace: m._id, count: m.count, amount: m.amount })),
      monthlyTrend: monthlyTrend.map(m => ({
        year: m._id.year,
        month: m._id.month,
        count: m.count,
        amount: m.amount
      }))
    };
  }

  /**
   * Match payments to invoices and update status
   */
  async reconcilePayments() {
    const paymentCol = this.db.collection(PAYMENT_COLLECTION);
    const invoiceCol = this.db.collection(INVOICE_COLLECTION);

    const unreconciled = await paymentCol.find({
      status: { $in: [PAYMENT_STATUS.RECEIVED, PAYMENT_STATUS.PENDING] }
    }).toArray();

    const results = {
      matched: 0,
      disputed: 0,
      notFound: 0
    };

    for (const payment of unreconciled) {
      if (!payment.invoiceNumber) continue;

      const invoice = await invoiceCol.findOne({ invoiceNumber: payment.invoiceNumber });

      if (!invoice) {
        results.notFound++;
        continue;
      }

      // Compare amounts
      const invoiceTotal = invoice.invoiceTotal?.amount || 0;
      const paidAmount = payment.amount?.amount || 0;
      const tolerance = 0.01; // 1 cent tolerance

      if (Math.abs(invoiceTotal - paidAmount) <= tolerance) {
        // Perfect match
        await paymentCol.updateOne(
          { paymentId: payment.paymentId },
          {
            $set: {
              status: PAYMENT_STATUS.RECONCILED,
              reconciledAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        results.matched++;
      } else {
        // Amount mismatch
        await paymentCol.updateOne(
          { paymentId: payment.paymentId },
          {
            $set: {
              status: PAYMENT_STATUS.DISPUTED,
              disputeReason: `Amount mismatch: Invoice ${invoiceTotal} vs Paid ${paidAmount}`,
              updatedAt: new Date()
            }
          }
        );
        results.disputed++;
      }
    }

    return results;
  }

  /**
   * Get unpaid invoices (invoices without matching payment)
   */
  async getUnpaidInvoices() {
    const invoiceCol = this.db.collection(INVOICE_COLLECTION);
    const paymentCol = this.db.collection(PAYMENT_COLLECTION);

    // Get all paid invoice numbers
    const paidInvoiceNumbers = await paymentCol.distinct('invoiceNumber', {
      status: { $in: [PAYMENT_STATUS.RECEIVED, PAYMENT_STATUS.RECONCILED] }
    });

    // Get invoices not in paid list
    const unpaidInvoices = await invoiceCol.find({
      status: 'accepted',
      invoiceNumber: { $nin: paidInvoiceNumbers }
    }).sort({ createdAt: -1 }).toArray();

    return unpaidInvoices;
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(paymentId, status, notes = null) {
    if (!Object.values(PAYMENT_STATUS).includes(status)) {
      throw new Error(`Invalid payment status: ${status}`);
    }

    const collection = this.db.collection(PAYMENT_COLLECTION);

    const update = {
      $set: {
        status,
        updatedAt: new Date()
      }
    };

    if (notes) {
      update.$set.statusNotes = notes;
    }

    if (status === PAYMENT_STATUS.RECONCILED) {
      update.$set.reconciledAt = new Date();
    }

    const result = await collection.updateOne(
      { paymentId },
      update
    );

    return result.modifiedCount > 0;
  }
}

// Singleton instance
let parserInstance = null;

async function getVendorRemittanceParser() {
  if (!parserInstance) {
    parserInstance = new VendorRemittanceParser();
    await parserInstance.init();
  }
  return parserInstance;
}

module.exports = {
  VendorRemittanceParser,
  getVendorRemittanceParser,
  PAYMENT_STATUS,
  PAYMENT_TYPES
};
