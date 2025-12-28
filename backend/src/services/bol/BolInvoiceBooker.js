/**
 * Bol.com Invoice Booker
 *
 * Creates vendor bills in Odoo from Bol.com invoices.
 * - Downloads PDF and Excel specification from Bol.com API
 * - Parses Excel to categorize charges by expense type
 * - Creates vendor bill with proper expense accounts and analytic accounting
 * - Attaches PDF to the vendor bill
 * - Updates MongoDB with Odoo bill ID
 */

const BolInvoice = require('../../models/BolInvoice');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// Bol.com API configuration
const BOL_API_BASE = 'https://api.bol.com/retailer';

// Token cache
let retailerAccessToken = null;
let retailerTokenExpiry = null;

// Expense account mapping by charge type
const EXPENSE_ACCOUNT_MAP = {
  // Commission and compensation
  'commissie': { code: '613100', name: 'Marketplace Commission' },
  'compensatie': { code: '613100', name: 'Marketplace Commission' },

  // Storage
  'voorraadkosten': { code: '613110', name: 'Marketplace Storage Fees' },
  'kosten onverkoopbare voorraad': { code: '613110', name: 'Marketplace Storage Fees' },

  // Shipping and fulfillment
  'verzendkosten': { code: '613120', name: 'Marketplace Shipping/Fulfillment' },
  'correctie verzendkosten': { code: '613120', name: 'Marketplace Shipping/Fulfillment' },
  'pick&pack': { code: '613120', name: 'Marketplace Shipping/Fulfillment' },
  'pick & pack': { code: '613120', name: 'Marketplace Shipping/Fulfillment' },

  // Returns
  'bijdrage aan retourzegel': { code: '613130', name: 'Marketplace Return Handling' },
  'bijdrage retourzegel': { code: '613130', name: 'Marketplace Return Handling' },
  'retourkosten': { code: '613130', name: 'Marketplace Return Handling' },
  'voorraad retourneren': { code: '613130', name: 'Marketplace Return Handling' },

  // Advertising
  'sponsored products': { code: '613200', name: 'Marketing, Advertising Expenses' },
};

// Cached Odoo IDs
let odooCache = {
  partnerId: null,
  analyticAccountId: null,
  accountIds: {},
};

/**
 * Get Bol.com API access token
 */
async function getAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Bol.com credentials not configured');
  }

  if (retailerAccessToken && retailerTokenExpiry && Date.now() < retailerTokenExpiry - 30000) {
    return retailerAccessToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://login.bol.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
  }

  const data = await response.json();
  retailerAccessToken = data.access_token;
  retailerTokenExpiry = Date.now() + (data.expires_in * 1000);

  return retailerAccessToken;
}

/**
 * Download invoice PDF from Bol.com API
 */
async function downloadInvoicePdf(invoiceId) {
  const token = await getAccessToken();

  const response = await fetch(`${BOL_API_BASE}/invoices/${invoiceId}`, {
    headers: {
      'Accept': 'application/pdf',
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download invoice PDF: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download invoice specification Excel from Bol.com API
 */
async function downloadInvoiceExcel(invoiceId) {
  const token = await getAccessToken();

  const response = await fetch(`${BOL_API_BASE}/invoices/${invoiceId}/specification`, {
    headers: {
      'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download invoice Excel: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Parse Excel specification to extract charges by expense account
 * @param {Buffer} excelBuffer - Excel file buffer
 * @param {string} invoiceType - 'SALES' or 'ADVERTISING'
 * @returns {Object} charges grouped by account code
 */
function parseInvoiceExcel(excelBuffer, invoiceType) {
  const workbook = XLSX.read(excelBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert to JSON, trying to detect header row
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Find header row (contains 'Type' or 'Bedrag')
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(15, rawData.length); i++) {
    const row = rawData[i] || [];
    const rowStr = row.join(' ').toLowerCase();
    if (rowStr.includes('type') && rowStr.includes('bedrag')) {
      headerRowIdx = i;
      break;
    }
    if (rowStr.includes('product') && rowStr.includes('bedrag')) {
      headerRowIdx = i;
      break;
    }
  }

  // Get headers and data
  const headers = (rawData[headerRowIdx] || []).map(h => String(h || '').trim().replace(/\n/g, ' '));
  const data = rawData.slice(headerRowIdx + 1);

  // Find column indices
  let typeColIdx = -1;
  let amountColIdx = -1;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase();
    if (h === 'type' || h === 'product') typeColIdx = i;
    if (h.includes('bedrag') && !h.includes('incl') && !h.includes('btw') && amountColIdx === -1) {
      amountColIdx = i;
    }
  }

  // For advertising invoices, first column is product type
  if (invoiceType === 'ADVERTISING' && typeColIdx === -1) {
    typeColIdx = 0;
  }

  const chargesByAccount = {};
  let verkoopprijs = 0;

  for (const row of data) {
    if (!row || row.length === 0) continue;

    const chargeType = String(row[typeColIdx] || '').trim();
    if (!chargeType || chargeType === 'Eindtotaal' || chargeType.includes('Totaal')) continue;

    const amount = parseFloat(row[amountColIdx]) || 0;
    if (amount === 0) continue;

    // Check for Verkoopprijs (pass-through, not an expense)
    if (chargeType.toLowerCase().includes('verkoopprijs')) {
      verkoopprijs += amount;
      continue;
    }

    // Find matching expense account
    let accountCode = null;
    let accountName = null;
    const typeLower = chargeType.toLowerCase();

    for (const [keyword, account] of Object.entries(EXPENSE_ACCOUNT_MAP)) {
      if (typeLower.includes(keyword)) {
        accountCode = account.code;
        accountName = account.name;
        break;
      }
    }

    // Default to commission for unknown types
    if (!accountCode) {
      accountCode = '613100';
      accountName = 'Marketplace Commission';
    }

    if (!chargesByAccount[accountCode]) {
      chargesByAccount[accountCode] = {
        code: accountCode,
        name: accountName,
        amount: 0,
        types: {}
      };
    }

    chargesByAccount[accountCode].amount += amount;
    chargesByAccount[accountCode].types[chargeType] =
      (chargesByAccount[accountCode].types[chargeType] || 0) + amount;
  }

  return {
    charges: chargesByAccount,
    verkoopprijs,
    totalExpense: Object.values(chargesByAccount).reduce((sum, a) => sum + a.amount, 0)
  };
}

/**
 * Initialize Odoo cache (partner ID, analytic account ID, expense account IDs)
 */
async function initOdooCache(odooClient) {
  if (odooCache.partnerId) return;

  console.log('[BolInvoiceBooker] Initializing Odoo cache...');

  // Get bol.com partner
  const partners = await odooClient.searchRead('res.partner',
    [['name', 'ilike', 'bol.com']],
    ['id', 'name'],
    { limit: 1 }
  );
  if (partners.length === 0) {
    throw new Error('bol.com partner not found in Odoo');
  }
  odooCache.partnerId = partners[0].id;
  console.log(`[BolInvoiceBooker] Found bol.com partner ID: ${odooCache.partnerId}`);

  // Get BOL analytic account
  const analyticAccounts = await odooClient.searchRead('account.analytic.account',
    [['code', '=', 'BOL']],
    ['id', 'name'],
    { limit: 1 }
  );
  if (analyticAccounts.length === 0) {
    throw new Error('BOL analytic account not found in Odoo');
  }
  odooCache.analyticAccountId = analyticAccounts[0].id;
  console.log(`[BolInvoiceBooker] Found BOL analytic account ID: ${odooCache.analyticAccountId}`);

  // Get expense accounts
  const accountCodes = ['613100', '613110', '613120', '613130', '613200'];
  const accounts = await odooClient.searchRead('account.account',
    [['code', 'in', accountCodes]],
    ['id', 'code', 'name'],
    { limit: 10 }
  );
  for (const acc of accounts) {
    odooCache.accountIds[acc.code] = acc.id;
    console.log(`[BolInvoiceBooker] Found account ${acc.code} ID: ${acc.id}`);
  }
}

/**
 * Create vendor bill in Odoo
 * @param {Object} invoice - MongoDB invoice document
 * @param {Object} parsedCharges - Parsed charges from Excel
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @returns {Object} Created bill info
 */
async function createVendorBill(invoice, parsedCharges, pdfBuffer) {
  const odooClient = new OdooDirectClient();
  await odooClient.authenticate();
  await initOdooCache(odooClient);

  const invoiceDate = invoice.issueDate
    ? new Date(invoice.issueDate).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  // Build invoice lines with analytic distribution
  const invoiceLines = [];
  for (const [accountCode, data] of Object.entries(parsedCharges.charges)) {
    if (data.amount === 0) continue;

    const accountId = odooCache.accountIds[accountCode];
    if (!accountId) {
      console.warn(`[BolInvoiceBooker] Account ${accountCode} not found in Odoo, skipping`);
      continue;
    }

    // Analytic distribution format for Odoo 16+
    const analyticDistribution = {};
    analyticDistribution[odooCache.analyticAccountId.toString()] = 100;

    invoiceLines.push([0, 0, {
      name: data.name,
      account_id: accountId,
      price_unit: data.amount,
      quantity: 1,
      analytic_distribution: analyticDistribution
    }]);
  }

  if (invoiceLines.length === 0) {
    throw new Error('No valid invoice lines to create');
  }

  // Create the vendor bill
  const billData = {
    move_type: 'in_invoice',
    partner_id: odooCache.partnerId,
    invoice_date: invoiceDate,
    ref: invoice.invoiceId,
    invoice_line_ids: invoiceLines
  };

  console.log(`[BolInvoiceBooker] Creating vendor bill for ${invoice.invoiceId}...`);
  const billId = await odooClient.create('account.move', billData);
  console.log(`[BolInvoiceBooker] Created bill ID: ${billId}`);

  // Get the bill number
  const [bill] = await odooClient.read('account.move', [billId], ['name', 'amount_total']);
  console.log(`[BolInvoiceBooker] Bill number: ${bill.name}, Total: €${bill.amount_total}`);

  // Attach PDF
  if (pdfBuffer) {
    const attachmentData = {
      name: `BOL-${invoice.invoiceId}.pdf`,
      type: 'binary',
      datas: pdfBuffer.toString('base64'),
      res_model: 'account.move',
      res_id: billId,
      mimetype: 'application/pdf'
    };

    const attachmentId = await odooClient.create('ir.attachment', attachmentData);
    console.log(`[BolInvoiceBooker] Attached PDF (attachment ID: ${attachmentId})`);
  }

  return {
    billId,
    billNumber: bill.name,
    total: bill.amount_total
  };
}

/**
 * Book a single Bol.com invoice to Odoo
 * @param {string} invoiceId - Bol.com invoice ID
 * @returns {Object} Result with bill info
 */
async function bookInvoice(invoiceId) {
  console.log(`[BolInvoiceBooker] Booking invoice ${invoiceId}...`);

  // Get invoice from MongoDB
  const invoice = await BolInvoice.findOne({ invoiceId });
  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found in MongoDB`);
  }

  // Check if already booked
  if (invoice.odoo?.billId) {
    console.log(`[BolInvoiceBooker] Invoice ${invoiceId} already booked as ${invoice.odoo.billNumber}`);
    return {
      success: true,
      alreadyBooked: true,
      billId: invoice.odoo.billId,
      billNumber: invoice.odoo.billNumber
    };
  }

  try {
    // Download PDF and Excel from Bol.com API
    console.log(`[BolInvoiceBooker] Downloading PDF...`);
    const pdfBuffer = await downloadInvoicePdf(invoiceId);

    console.log(`[BolInvoiceBooker] Downloading Excel specification...`);
    const excelBuffer = await downloadInvoiceExcel(invoiceId);

    // Parse Excel to get charges
    console.log(`[BolInvoiceBooker] Parsing Excel...`);
    const parsedCharges = parseInvoiceExcel(excelBuffer, invoice.invoiceType);

    console.log(`[BolInvoiceBooker] Parsed charges:`);
    for (const [code, data] of Object.entries(parsedCharges.charges)) {
      console.log(`  ${code} ${data.name}: €${data.amount.toFixed(2)}`);
    }
    console.log(`  Total expense: €${parsedCharges.totalExpense.toFixed(2)}`);
    if (parsedCharges.verkoopprijs !== 0) {
      console.log(`  Verkoopprijs (pass-through): €${parsedCharges.verkoopprijs.toFixed(2)}`);
    }

    // Create vendor bill in Odoo
    const billResult = await createVendorBill(invoice, parsedCharges, pdfBuffer);

    // Update MongoDB
    await BolInvoice.updateOne(
      { invoiceId },
      {
        $set: {
          'odoo.billId': billResult.billId,
          'odoo.billNumber': billResult.billNumber,
          'odoo.createdAt': new Date(),
          'odoo.syncError': null
        }
      }
    );

    console.log(`[BolInvoiceBooker] ✅ Invoice ${invoiceId} booked as ${billResult.billNumber}`);

    return {
      success: true,
      invoiceId,
      billId: billResult.billId,
      billNumber: billResult.billNumber,
      total: billResult.total
    };

  } catch (error) {
    console.error(`[BolInvoiceBooker] ❌ Error booking invoice ${invoiceId}:`, error.message);

    // Save error to MongoDB
    await BolInvoice.updateOne(
      { invoiceId },
      {
        $set: {
          'odoo.syncError': error.message,
          'odoo.lastAttempt': new Date()
        }
      }
    );

    throw error;
  }
}

/**
 * Book all unbooked invoices to Odoo
 * @returns {Object} Summary of booking results
 */
async function bookAllUnbooked() {
  console.log('[BolInvoiceBooker] Finding unbooked invoices...');

  const unbookedInvoices = await BolInvoice.find({
    'odoo.billId': { $exists: false },
    totalAmountExclVat: { $gt: 0 }
  }).sort({ issueDate: -1 });

  console.log(`[BolInvoiceBooker] Found ${unbookedInvoices.length} unbooked invoices`);

  const results = {
    total: unbookedInvoices.length,
    success: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  for (const invoice of unbookedInvoices) {
    try {
      const result = await bookInvoice(invoice.invoiceId);
      if (result.alreadyBooked) {
        results.skipped++;
      } else {
        results.success++;
      }
      results.details.push(result);

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      results.failed++;
      results.details.push({
        success: false,
        invoiceId: invoice.invoiceId,
        error: error.message
      });
    }
  }

  console.log(`[BolInvoiceBooker] Booking complete: ${results.success} success, ${results.failed} failed, ${results.skipped} skipped`);

  return results;
}

module.exports = {
  bookInvoice,
  bookAllUnbooked,
  parseInvoiceExcel,
  downloadInvoicePdf,
  downloadInvoiceExcel
};
