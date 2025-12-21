/**
 * Returns Report Parser
 *
 * Parses Amazon FBA Returns reports.
 *
 * Report: Seller Central → Reports → Fulfillment → FBA Customer Returns
 */

const { parse } = require('csv-parse/sync');
const { getDb } = require('../../db');

// Return reason codes
const RETURN_REASONS = {
  'CUSTOMER_RETURN': 'Customer Return',
  'UNDELIVERABLE': 'Undeliverable',
  'DAMAGED': 'Damaged',
  'DEFECTIVE': 'Defective',
  'WRONG_ITEM': 'Wrong Item Sent',
  'ACCIDENTAL_ORDER': 'Accidental Order',
  'NO_LONGER_NEEDED': 'No Longer Needed',
  'QUALITY_UNACCEPTABLE': 'Quality Not Acceptable',
  'CARRIER_DAMAGE': 'Damaged by Carrier',
  'SWITCHEROO': 'Different Item Returned',
};

// Return dispositions
const DISPOSITIONS = {
  'SELLABLE': 'Sellable',
  'UNSELLABLE': 'Unsellable',
  'DEFECTIVE': 'Defective',
  'DAMAGED': 'Damaged',
  'CUSTOMER_DAMAGED': 'Customer Damaged',
  'CARRIER_DAMAGED': 'Carrier Damaged',
  'EXPIRED': 'Expired',
};

class ReturnsReportParser {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Parse Returns report CSV
   * @param {string|Buffer} csvContent
   * @returns {Array} Parsed returns
   */
  parseCSV(csvContent) {
    const firstLine = csvContent.toString().split('\n')[0];
    const delimiter = firstLine.includes('\t') ? '\t' : ',';

    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relaxColumnCount: true,
    });

    return records.map(row => this.mapRow(row));
  }

  /**
   * Map CSV row to normalized return object
   */
  mapRow(row) {
    return {
      returnDate: this.parseDate(row['return-date'] || row['Return Date'] || row['return_date']),
      orderId: row['order-id'] || row['Order ID'] || row['amazon-order-id'] || '',
      sku: row['sku'] || row['SKU'] || row['seller-sku'] || '',
      asin: row['asin'] || row['ASIN'] || '',
      fnsku: row['fnsku'] || row['FNSKU'] || '',
      productName: row['product-name'] || row['Product Name'] || row['title'] || '',
      quantity: parseInt(row['quantity'] || row['Quantity'] || 1, 10),
      fulfillmentCenterId: row['fulfillment-center-id'] || row['FC'] || '',
      detailedDisposition: row['detailed-disposition'] || row['Detailed Disposition'] || '',
      reason: row['reason'] || row['Return Reason'] || row['customer-comments'] || '',
      status: row['status'] || row['Status'] || '',
      licenseNumber: row['license-plate-number'] || row['LPN'] || '',
      customerComments: row['customer-comments'] || row['Customer Comments'] || '',
      // Financial
      reimbursed: row['reimbursed'] === 'Yes' || row['reimbursed'] === 'true',
      // Sellable status
      isSellable: (row['detailed-disposition'] || '').toLowerCase().includes('sellable'),
    };
  }

  /**
   * Parse date string
   */
  parseDate(dateStr) {
    if (!dateStr) return null;
    return new Date(dateStr);
  }

  /**
   * Group returns by order
   * @param {Array} returns
   * @returns {Map}
   */
  groupByOrder(returns) {
    const orderMap = new Map();

    for (const ret of returns) {
      if (!ret.orderId) continue;

      if (!orderMap.has(ret.orderId)) {
        orderMap.set(ret.orderId, {
          orderId: ret.orderId,
          items: [],
          totalQuantity: 0,
          sellableQuantity: 0,
          unsellableQuantity: 0,
          returnDates: [],
        });
      }

      const order = orderMap.get(ret.orderId);
      order.items.push(ret);
      order.totalQuantity += ret.quantity;
      if (ret.isSellable) {
        order.sellableQuantity += ret.quantity;
      } else {
        order.unsellableQuantity += ret.quantity;
      }
      if (ret.returnDate) {
        order.returnDates.push(ret.returnDate);
      }
    }

    // Set first and last return dates
    for (const order of orderMap.values()) {
      if (order.returnDates.length > 0) {
        order.firstReturnDate = new Date(Math.min(...order.returnDates));
        order.lastReturnDate = new Date(Math.max(...order.returnDates));
      }
    }

    return orderMap;
  }

  /**
   * Group returns by SKU
   * @param {Array} returns
   * @returns {Map}
   */
  groupBySku(returns) {
    const skuMap = new Map();

    for (const ret of returns) {
      if (!ret.sku) continue;

      if (!skuMap.has(ret.sku)) {
        skuMap.set(ret.sku, {
          sku: ret.sku,
          asin: ret.asin,
          productName: ret.productName,
          totalReturns: 0,
          sellableReturns: 0,
          unsellableReturns: 0,
          reasons: {},
        });
      }

      const skuData = skuMap.get(ret.sku);
      skuData.totalReturns += ret.quantity;
      if (ret.isSellable) {
        skuData.sellableReturns += ret.quantity;
      } else {
        skuData.unsellableReturns += ret.quantity;
      }

      // Track reasons
      const reason = ret.reason || 'Unknown';
      skuData.reasons[reason] = (skuData.reasons[reason] || 0) + ret.quantity;
    }

    return skuMap;
  }

  /**
   * Get return rate analysis
   * @param {Array} returns
   * @returns {object}
   */
  analyzeReturnRates(returns) {
    const byReason = {};
    const byDisposition = {};
    const byMonth = {};

    for (const ret of returns) {
      // By reason
      const reason = ret.reason || 'Unknown';
      byReason[reason] = (byReason[reason] || 0) + ret.quantity;

      // By disposition
      const disposition = ret.detailedDisposition || 'Unknown';
      byDisposition[disposition] = (byDisposition[disposition] || 0) + ret.quantity;

      // By month
      if (ret.returnDate) {
        const monthKey = ret.returnDate.toISOString().substring(0, 7);
        byMonth[monthKey] = (byMonth[monthKey] || 0) + ret.quantity;
      }
    }

    return {
      totalReturns: returns.reduce((sum, r) => sum + r.quantity, 0),
      uniqueOrders: new Set(returns.map(r => r.orderId)).size,
      uniqueSkus: new Set(returns.map(r => r.sku)).size,
      byReason,
      byDisposition,
      byMonth,
    };
  }

  /**
   * Process and store returns report
   * @param {string|Buffer} content
   * @param {string} filename
   * @returns {object}
   */
  async processReport(content, filename) {
    const db = getDb();

    // Parse CSV
    const returns = this.parseCSV(content);

    // Group by order and SKU
    const byOrderMap = this.groupByOrder(returns);
    const bySkuMap = this.groupBySku(returns);

    // Analyze
    const analysis = this.analyzeReturnRates(returns);

    // Get date range
    const dates = returns.map(r => r.returnDate).filter(d => d);
    const dateRange = dates.length > 0 ? {
      from: new Date(Math.min(...dates)),
      to: new Date(Math.max(...dates)),
    } : null;

    // Store report
    const doc = {
      filename,
      uploadedAt: new Date(),
      returnCount: returns.length,
      orderCount: byOrderMap.size,
      skuCount: bySkuMap.size,
      dateRange,
      analysis,
      status: 'processed',
    };

    const reportResult = await db.collection('amazon_returns_reports').insertOne(doc);

    // Store individual returns
    if (returns.length > 0) {
      const returnDocs = returns.map(ret => ({
        ...ret,
        reportId: reportResult.insertedId,
        importedAt: new Date(),
      }));

      // Upsert by orderId + sku + returnDate to avoid duplicates
      for (const retDoc of returnDocs) {
        await db.collection('amazon_returns').updateOne(
          {
            orderId: retDoc.orderId,
            sku: retDoc.sku,
            returnDate: retDoc.returnDate,
          },
          { $set: retDoc },
          { upsert: true }
        );
      }
    }

    return {
      reportId: reportResult.insertedId.toString(),
      returnCount: returns.length,
      orderCount: byOrderMap.size,
      skuCount: bySkuMap.size,
      dateRange,
      analysis,
      topReturnedSkus: Array.from(bySkuMap.values())
        .sort((a, b) => b.totalReturns - a.totalReturns)
        .slice(0, 10),
    };
  }

  /**
   * Get returns for date range
   * @param {Date} from
   * @param {Date} to
   * @returns {Array}
   */
  async getReturns(from, to) {
    const db = getDb();
    const query = {};

    if (from || to) {
      query.returnDate = {};
      if (from) query.returnDate.$gte = from;
      if (to) query.returnDate.$lte = to;
    }

    return db.collection('amazon_returns')
      .find(query)
      .sort({ returnDate: -1 })
      .toArray();
  }

  /**
   * Get returns by SKU
   * @param {string} sku
   * @returns {Array}
   */
  async getReturnsBySku(sku) {
    const db = getDb();
    return db.collection('amazon_returns')
      .find({ sku })
      .sort({ returnDate: -1 })
      .toArray();
  }

  /**
   * Get returns by order
   * @param {string} orderId
   * @returns {Array}
   */
  async getReturnsByOrder(orderId) {
    const db = getDb();
    return db.collection('amazon_returns')
      .find({ orderId })
      .toArray();
  }

  /**
   * Get return rate summary
   * @param {number} days - Look back period
   * @returns {object}
   */
  async getReturnSummary(days = 30) {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);

    const pipeline = [
      { $match: { returnDate: { $gte: since } } },
      {
        $group: {
          _id: '$sku',
          sku: { $first: '$sku' },
          productName: { $first: '$productName' },
          totalReturns: { $sum: '$quantity' },
          sellableReturns: {
            $sum: { $cond: ['$isSellable', '$quantity', 0] }
          },
        }
      },
      { $sort: { totalReturns: -1 } },
      { $limit: 50 }
    ];

    const topReturned = await db.collection('amazon_returns')
      .aggregate(pipeline)
      .toArray();

    // Get totals
    const totals = await db.collection('amazon_returns')
      .aggregate([
        { $match: { returnDate: { $gte: since } } },
        {
          $group: {
            _id: null,
            totalQuantity: { $sum: '$quantity' },
            sellableQuantity: {
              $sum: { $cond: ['$isSellable', '$quantity', 0] }
            },
            orderCount: { $addToSet: '$orderId' },
          }
        }
      ])
      .toArray();

    return {
      period: `Last ${days} days`,
      totalReturns: totals[0]?.totalQuantity || 0,
      sellableReturns: totals[0]?.sellableQuantity || 0,
      unsellableReturns: (totals[0]?.totalQuantity || 0) - (totals[0]?.sellableQuantity || 0),
      uniqueOrders: totals[0]?.orderCount?.length || 0,
      topReturnedSkus: topReturned,
    };
  }
}

module.exports = { ReturnsReportParser, RETURN_REASONS, DISPOSITIONS };
