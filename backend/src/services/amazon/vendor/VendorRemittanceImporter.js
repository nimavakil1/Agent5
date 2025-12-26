/**
 * VendorRemittanceImporter - Import Amazon Vendor remittance data
 *
 * Parses remittance files from Amazon Vendor Central and matches
 * payments with invoices in Odoo.
 */

const XLSX = require('xlsx');
const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');

class VendorRemittanceImporter {
  constructor() {
    this.odoo = null;
  }

  async init() {
    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();
    return this;
  }

  /**
   * Parse a remittance Excel file
   * Supports both summary and detail formats
   * Amazon files often have multiple sections in one sheet
   */
  parseRemittanceFile(filePath) {
    const workbook = XLSX.readFile(filePath);
    const results = {
      payments: [],
      invoiceDetails: [],
      format: 'unknown'
    };

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      // Find ALL header rows (there may be multiple sections)
      const headerRows = [];
      data.forEach((row, index) => {
        if (row && row.length > 3) {
          const rowStr = row.map(c => String(c || '').toLowerCase()).join('|');
          if (rowStr.includes('payment number')) {
            headerRows.push({ index, headers: row.map(h => String(h || '').toLowerCase().trim()) });
          }
        }
      });

      // Process each section
      for (let i = 0; i < headerRows.length; i++) {
        const { index: headerRowIndex, headers } = headerRows[i];
        const nextHeaderIndex = headerRows[i + 1]?.index || data.length;

        // Check if this section has invoice detail
        if (headers.includes('invoice number')) {
          results.format = 'detail';
          const sectionData = data.slice(headerRowIndex, nextHeaderIndex);
          results.invoiceDetails.push(...this._parseDetailFormat(sectionData, 0, headers));
        } else if (headers.includes('payment number') && !headers.includes('invoice number')) {
          // Summary section (payment level only)
          const sectionData = data.slice(headerRowIndex, nextHeaderIndex);
          results.payments.push(...this._parseSummaryFormat(sectionData, 0, headers));
        }
      }
    }

    return results;
  }

  /**
   * Parse summary format (payment-level)
   */
  _parseSummaryFormat(data, headerRowIndex, headers) {
    const payments = [];
    const paymentNumIdx = headers.indexOf('payment number');
    const dateIdx = headers.indexOf('payment date');
    const amountIdx = headers.findIndex(h => h.includes('amount') && h.includes('invoice'));
    const statusIdx = headers.indexOf('payment status');

    for (let i = headerRowIndex + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[paymentNumIdx]) continue;

      payments.push({
        paymentNumber: String(row[paymentNumIdx]),
        paymentDate: this._parseDate(row[dateIdx]),
        amount: parseFloat(row[amountIdx]) || 0,
        currency: 'EUR',
        status: row[statusIdx] || 'Unknown'
      });
    }

    return payments;
  }

  /**
   * Parse detail format (invoice-level)
   */
  _parseDetailFormat(data, headerRowIndex, headers) {
    const details = [];

    // Find relevant column indices
    const invoiceNumIdx = headers.indexOf('invoice number');
    const paymentNumIdx = headers.indexOf('payment number');
    const dateIdx = headers.indexOf('invoice date');
    const invoiceAmountIdx = headers.indexOf('invoice amount');
    const netPaidIdx = headers.findIndex(h => h.includes('net amount paid'));
    const descIdx = headers.indexOf('description');

    for (let i = headerRowIndex + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[invoiceNumIdx]) continue;

      const rawInvoiceNum = String(row[invoiceNumIdx]).trim();

      // Convert VBE20240200365 to VBE/2024/02/00365 format
      const normalizedInvoiceNum = this._normalizeInvoiceNumber(rawInvoiceNum);

      // Skip non-invoice entries (chargebacks, co-op, etc.)
      const isVendorInvoice = rawInvoiceNum.startsWith('VBE');

      details.push({
        invoiceNumber: normalizedInvoiceNum,
        rawInvoiceNumber: rawInvoiceNum,
        isVendorInvoice,
        paymentNumber: paymentNumIdx >= 0 ? String(row[paymentNumIdx] || '') : null,
        invoiceDate: dateIdx >= 0 ? this._parseDate(row[dateIdx]) : null,
        invoiceAmount: invoiceAmountIdx >= 0 ? parseFloat(row[invoiceAmountIdx]) || 0 : 0,
        netAmountPaid: netPaidIdx >= 0 ? parseFloat(row[netPaidIdx]) || 0 : 0,
        description: descIdx >= 0 ? String(row[descIdx] || '') : '',
        currency: 'EUR'
      });
    }

    return details;
  }

  /**
   * Normalize invoice number from Amazon format to Odoo format
   * VBE20240200365 -> VBE/2024/02/00365
   */
  _normalizeInvoiceNumber(rawNum) {
    if (!rawNum) return rawNum;

    // Check if it's already in Odoo format
    if (rawNum.includes('/')) return rawNum;

    // Match VBE + year(4) + month(2) + sequence
    const match = rawNum.match(/^(VBE)(\d{4})(\d{2})(\d+)$/);
    if (match) {
      const [, prefix, year, month, seq] = match;
      return `${prefix}/${year}/${month}/${seq.padStart(5, '0')}`;
    }

    return rawNum;
  }

  /**
   * Parse various date formats
   */
  _parseDate(value) {
    if (!value) return null;

    // Handle Excel serial dates
    if (typeof value === 'number') {
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + value * 86400000);
      return date.toISOString().split('T')[0];
    }

    // Handle string dates (DD/MM/YYYY or MM/DD/YYYY)
    const str = String(value);
    const parts = str.split('/');
    if (parts.length === 3) {
      const [a, b, c] = parts;
      // Assume DD/MM/YYYY (European format)
      if (parseInt(a) <= 31 && parseInt(b) <= 12) {
        return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
      }
    }

    return str;
  }

  /**
   * Import remittance data and match with Odoo invoices
   */
  async importRemittance(filePath) {
    const parsed = this.parseRemittanceFile(filePath);

    // Filter to only vendor invoices
    const vendorInvoices = parsed.invoiceDetails.filter(d => d.isVendorInvoice);
    const otherEntries = parsed.invoiceDetails.filter(d => !d.isVendorInvoice);

    const results = {
      format: parsed.format,
      totalPayments: parsed.payments.length,
      totalInvoiceDetails: parsed.invoiceDetails.length,
      vendorInvoices: vendorInvoices.length,
      otherEntries: otherEntries.length,
      matched: 0,
      unmatched: 0,
      skipped: otherEntries.length,
      errors: [],
      matchedInvoices: [],
      unmatchedInvoices: []
    };

    // Match vendor invoices
    for (const detail of vendorInvoices) {
      try {
        const matchResult = await this._matchAndUpdateInvoice(detail);
        if (matchResult.matched) {
          results.matched++;
          results.matchedInvoices.push({
            amazonInvoice: detail.rawInvoiceNumber,
            odooInvoice: matchResult.odooInvoice,
            amount: detail.invoiceAmount
          });
        } else {
          results.unmatched++;
          results.unmatchedInvoices.push({
            invoiceNumber: detail.invoiceNumber,
            rawInvoiceNumber: detail.rawInvoiceNumber,
            amount: detail.invoiceAmount,
            reason: matchResult.reason
          });
        }
      } catch (error) {
        results.errors.push({
          invoiceNumber: detail.invoiceNumber,
          error: error.message
        });
      }
    }

    // Calculate totals
    results.totalAmountMatched = results.matchedInvoices.reduce((sum, inv) => sum + inv.amount, 0);
    results.totalAmountUnmatched = results.unmatchedInvoices.reduce((sum, inv) => sum + inv.amount, 0);

    // Store raw remittance data in MongoDB
    await this._storeRemittanceData(parsed, filePath);

    return results;
  }

  /**
   * Match invoice detail with Odoo and update payment status
   */
  async _matchAndUpdateInvoice(detail) {
    // Only match VBE invoices
    if (!detail.isVendorInvoice) {
      return { matched: false, reason: 'not_vendor_invoice' };
    }

    // Search for invoice in Odoo by normalized name
    let invoices = await this.odoo.searchRead('account.move',
      [
        ['move_type', '=', 'out_invoice'],
        ['name', '=', detail.invoiceNumber]
      ],
      ['id', 'name', 'amount_total', 'payment_state'],
      { limit: 1 }
    );

    // If not found, try with ilike
    if (invoices.length === 0) {
      invoices = await this.odoo.searchRead('account.move',
        [
          ['move_type', '=', 'out_invoice'],
          ['name', 'ilike', detail.invoiceNumber]
        ],
        ['id', 'name', 'amount_total', 'payment_state'],
        { limit: 1 }
      );
    }

    // If still not found, try matching by sequence number only
    if (invoices.length === 0 && detail.invoiceNumber.includes('/')) {
      const parts = detail.invoiceNumber.split('/');
      const seq = parts[parts.length - 1];
      const year = parts[1];
      const month = parts[2];

      // Search for VBE invoices in that year/month with similar sequence
      const altInvoices = await this.odoo.searchRead('account.move',
        [
          ['move_type', '=', 'out_invoice'],
          ['name', 'like', `VBE/${year}/${month}/%`]
        ],
        ['id', 'name', 'amount_total', 'payment_state'],
        { limit: 50 }
      );

      // Find by amount match if sequence doesn't match exactly
      const seqMatch = altInvoices.find(inv => inv.name.endsWith(seq));
      if (seqMatch) {
        invoices.push(seqMatch);
      }
    }

    if (invoices.length === 0) {
      return { matched: false, reason: 'not_found_in_odoo' };
    }

    const invoice = invoices[0];

    // Store the match in MongoDB
    const db = await getDb();
    await db.collection('vendor_invoice_payments').updateOne(
      { odooInvoiceId: invoice.id },
      {
        $set: {
          odooInvoiceId: invoice.id,
          odooInvoiceName: invoice.name,
          amazonPaymentNumber: detail.paymentNumber,
          invoiceDate: detail.invoiceDate,
          invoiceAmount: detail.invoiceAmount,
          netAmountPaid: detail.netAmountPaid,
          description: detail.description,
          rawInvoiceNumber: detail.rawInvoiceNumber,
          matchedAt: new Date(),
          status: detail.netAmountPaid > 0 ? 'paid' : 'processed'
        }
      },
      { upsert: true }
    );

    return { matched: true, odooInvoice: invoice.name };
  }

  /**
   * Store raw remittance data
   */
  async _storeRemittanceData(parsed, filePath) {
    const db = await getDb();
    const fileName = filePath.split('/').pop();

    await db.collection('vendor_remittance_imports').insertOne({
      fileName,
      importedAt: new Date(),
      format: parsed.format,
      paymentsCount: parsed.payments.length,
      invoiceDetailsCount: parsed.invoiceDetails.length,
      payments: parsed.payments,
      invoiceDetails: parsed.invoiceDetails
    });
  }

  /**
   * Get payment status for invoices from MongoDB
   */
  async getInvoicePaymentStatus(invoiceIds) {
    const db = await getDb();
    const payments = await db.collection('vendor_invoice_payments')
      .find({ odooInvoiceId: { $in: invoiceIds } })
      .toArray();

    const statusMap = {};
    payments.forEach(p => {
      statusMap[p.odooInvoiceId] = {
        status: p.status,
        paymentDate: p.paymentDate,
        amountPaid: p.amountPaid,
        amazonPaymentNumber: p.amazonPaymentNumber
      };
    });

    return statusMap;
  }

  /**
   * Get remittance import summary
   */
  async getImportSummary() {
    const db = await getDb();

    const imports = await db.collection('vendor_remittance_imports')
      .find()
      .sort({ importedAt: -1 })
      .limit(10)
      .toArray();

    const paymentsCount = await db.collection('vendor_invoice_payments').countDocuments();

    const totalPaid = await db.collection('vendor_invoice_payments').aggregate([
      { $group: { _id: null, total: { $sum: '$amountPaid' } } }
    ]).toArray();

    return {
      recentImports: imports,
      matchedInvoices: paymentsCount,
      totalAmountPaid: totalPaid[0]?.total || 0
    };
  }
}

module.exports = { VendorRemittanceImporter };
