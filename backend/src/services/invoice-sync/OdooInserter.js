/**
 * OdooInserter - Create vendor bills in SDT Odoo 14
 *
 * Uses a SEPARATE Odoo connection from the main Acropaq Odoo.
 * SDT Odoo 14 at 51.89.70.33.
 *
 * Required env vars:
 *   SDT_ODOO_URL      (e.g., http://51.89.70.33:8069)
 *   SDT_ODOO_DB       (e.g., sdt)
 *   SDT_ODOO_USERNAME (e.g., admin)
 *   SDT_ODOO_PASSWORD
 */

const Odoo = require('odoo-xmlrpc');
const fs = require('fs');
const InvoiceSyncRecord = require('../../models/InvoiceSyncRecord');
const InvoiceSyncSupplier = require('../../models/InvoiceSyncSupplier');

class OdooInserter {
  constructor() {
    this.client = null;
    this.authenticated = false;
  }

  /**
   * Connect to SDT Odoo 14
   */
  async _ensureClient() {
    if (this.authenticated) return;

    const url = process.env.SDT_ODOO_URL;
    const db = process.env.SDT_ODOO_DB;
    const username = process.env.SDT_ODOO_USERNAME;
    const password = process.env.SDT_ODOO_PASSWORD;

    if (!url || !db || !username || !password) {
      throw new Error('SDT Odoo not configured. Set SDT_ODOO_URL, SDT_ODOO_DB, SDT_ODOO_USERNAME, SDT_ODOO_PASSWORD');
    }

    const parsedUrl = new URL(url);

    const config = {
      url: `${parsedUrl.protocol}//${parsedUrl.hostname}`,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 8069),
      db,
      username,
      password,
    };

    return new Promise((resolve, reject) => {
      this.client = new Odoo(config);
      this.client.connect((err) => {
        if (err) {
          reject(new Error(`SDT Odoo authentication failed: ${err.message}`));
          return;
        }
        this.authenticated = true;
        console.log(`[OdooInserter] Connected to SDT Odoo 14 (uid: ${this.client.uid})`);
        resolve();
      });
    });
  }

  /**
   * Execute an Odoo method
   */
  async _execute(model, method, args = [], kwargs = {}) {
    await this._ensureClient();

    return new Promise((resolve, reject) => {
      this.client.execute_kw(model, method, [args, kwargs], (err, result) => {
        if (err) {
          reject(new Error(`Odoo execute error (${model}.${method}): ${err.message}`));
          return;
        }
        resolve(result);
      });
    });
  }

  async _searchRead(model, domain, fields, options = {}) {
    return this._execute(model, 'search_read', [domain], { fields, ...options });
  }

  async _create(model, values) {
    return this._execute(model, 'create', [values]);
  }

  /**
   * Submit an invoice record to SDT Odoo 14 as a vendor bill
   * @param {Object} invoiceRecord - InvoiceSyncRecord document
   * @param {Object} supplierConfig - InvoiceSyncSupplier document
   */
  async submit(invoiceRecord, supplierConfig) {
    await this._ensureClient();

    const parsed = invoiceRecord.parsedDataJson || {};
    const invoiceNum = invoiceRecord.invoiceNumber || parsed.invoiceNumber;

    console.log(`[OdooInserter] Creating vendor bill for: ${invoiceNum} (${supplierConfig.name})`);

    // 1. Check for duplicate
    const existing = await this._checkDuplicate(invoiceNum, supplierConfig.odooPartnerId);
    if (existing) {
      invoiceRecord.status = 'submitted';
      invoiceRecord.odooBillId = existing.id;
      invoiceRecord.odooBillNumber = existing.name;
      invoiceRecord.addEvent('duplicate_found', { odooId: existing.id, odooNumber: existing.name });
      await invoiceRecord.save();

      return {
        success: false,
        alreadyExists: true,
        odooBillId: existing.id,
        odooBillNumber: existing.name,
      };
    }

    // 2. Get or find partner ID
    let partnerId = supplierConfig.odooPartnerId;
    if (!partnerId) {
      partnerId = await this._findPartner(supplierConfig.name, parsed.vendorVat);
      if (partnerId) {
        // Save for future use
        await InvoiceSyncSupplier.findByIdAndUpdate(supplierConfig._id, { odooPartnerId: partnerId });
      }
    }
    if (!partnerId) {
      throw new Error(`No Odoo partner found for "${supplierConfig.name}". Set odooPartnerId manually.`);
    }

    // 3. Get expense account
    const accountCode = supplierConfig.odooExpenseAccountCode || '6770';
    const accountId = await this._getAccountByCode(accountCode);

    // 4. Get tax ID
    const taxIds = await this._getPurchaseTaxIds(parsed.vatRate);

    // 5. Build invoice lines
    const invoiceLines = this._buildLines(parsed, accountId, taxIds);

    // 6. Create vendor bill
    // Odoo 14 uses account.move with move_type = 'in_invoice'
    const billData = {
      move_type: 'in_invoice',
      partner_id: partnerId,
      ref: invoiceNum, // Vendor reference
      invoice_date: invoiceRecord.invoiceDate || parsed.invoiceDate || false,
      invoice_line_ids: invoiceLines,
      narration: `Processed by Agent5 Invoice Sync\nSupplier: ${supplierConfig.name}\nSource: Gmail scan`,
    };

    if (parsed.dueDate) {
      billData.invoice_date_due = parsed.dueDate;
    }

    try {
      const billId = await this._create('account.move', billData);
      console.log(`[OdooInserter] Vendor bill created: ID ${billId}`);

      // Read back bill number
      const bills = await this._searchRead('account.move', [['id', '=', billId]], ['name'], { limit: 1 });
      const billNumber = bills[0]?.name || `BILL/${billId}`;

      // 7. Attach PDF
      if (invoiceRecord.pdfFilepath && fs.existsSync(invoiceRecord.pdfFilepath)) {
        await this._attachPdf(billId, invoiceRecord.pdfFilepath, invoiceNum);
      }

      // 8. Update record
      invoiceRecord.status = 'submitted';
      invoiceRecord.odooBillId = billId;
      invoiceRecord.odooBillNumber = billNumber;
      invoiceRecord.addEvent('submitted_to_odoo', { billId, billNumber });
      await invoiceRecord.save();

      // Update supplier stats
      await InvoiceSyncSupplier.findByIdAndUpdate(supplierConfig._id, {
        $inc: { totalInvoicesProcessed: 1 },
      });

      return { success: true, odooBillId: billId, odooBillNumber: billNumber };
    } catch (error) {
      invoiceRecord.status = 'failed';
      invoiceRecord.errorMessage = error.message;
      invoiceRecord.addEvent('odoo_submission_failed', { error: error.message });
      await invoiceRecord.save();
      throw error;
    }
  }

  /**
   * Check for duplicate vendor bill
   */
  async _checkDuplicate(invoiceNumber, partnerId) {
    if (!invoiceNumber) return null;

    const domain = [
      ['ref', '=', invoiceNumber],
      ['move_type', '=', 'in_invoice'],
    ];
    if (partnerId) domain.push(['partner_id', '=', partnerId]);

    const existing = await this._searchRead('account.move', domain, ['id', 'name', 'state'], { limit: 1 });
    return existing.length > 0 ? existing[0] : null;
  }

  /**
   * Find partner by name or VAT
   */
  async _findPartner(name, vatNumber) {
    // Try by VAT first
    if (vatNumber) {
      const byVat = await this._searchRead('res.partner', [
        ['vat', '=ilike', vatNumber],
      ], ['id', 'name'], { limit: 1 });
      if (byVat.length > 0) return byVat[0].id;
    }

    // Try by name
    const byName = await this._searchRead('res.partner', [
      ['name', 'ilike', name],
      ['supplier_rank', '>', 0],
    ], ['id', 'name'], { limit: 1 });
    if (byName.length > 0) return byName[0].id;

    return null;
  }

  /**
   * Get account by code
   */
  async _getAccountByCode(code) {
    const accounts = await this._searchRead('account.account', [
      ['code', '=', code],
    ], ['id', 'code', 'name'], { limit: 1 });

    if (accounts.length > 0) return accounts[0].id;

    // Fallback: try starts-with
    const fallback = await this._searchRead('account.account', [
      ['code', '=like', `${code}%`],
    ], ['id', 'code', 'name'], { limit: 1 });

    if (fallback.length > 0) return fallback[0].id;

    throw new Error(`No account found with code ${code}`);
  }

  /**
   * Get purchase tax IDs for given rate
   */
  async _getPurchaseTaxIds(vatRate) {
    if (!vatRate) return [[6, 0, []]];

    const taxes = await this._searchRead('account.tax', [
      ['type_tax_use', '=', 'purchase'],
      ['amount', '=', vatRate],
      ['active', '=', true],
    ], ['id', 'name', 'amount'], { limit: 1 });

    if (taxes.length > 0) return [[6, 0, [taxes[0].id]]];
    return [[6, 0, []]];
  }

  /**
   * Build invoice lines for Odoo
   */
  _buildLines(parsed, accountId, taxIds) {
    // If we have line items from parsing, use them
    if (Array.isArray(parsed.lineItems) && parsed.lineItems.length > 0) {
      return parsed.lineItems.map(line => [0, 0, {
        name: line.description || 'Invoice line',
        quantity: line.quantity || 1,
        price_unit: line.unitPrice || 0,
        account_id: accountId,
        tax_ids: taxIds,
      }]);
    }

    // Single-line fallback
    return [[0, 0, {
      name: `Invoice ${parsed.invoiceNumber || ''}`.trim(),
      quantity: 1,
      price_unit: parsed.netAmount || parsed.grossAmount || 0,
      account_id: accountId,
      tax_ids: taxIds,
    }]];
  }

  /**
   * Attach PDF to the Odoo bill via ir.attachment
   */
  async _attachPdf(billId, pdfPath, invoiceNumber) {
    try {
      const pdfBuffer = fs.readFileSync(pdfPath);
      const base64Data = pdfBuffer.toString('base64');

      await this._create('ir.attachment', {
        name: `${invoiceNumber || 'invoice'}.pdf`,
        type: 'binary',
        datas: base64Data,
        res_model: 'account.move',
        res_id: billId,
        mimetype: 'application/pdf',
      });

      console.log(`[OdooInserter] PDF attached to bill ${billId}`);
    } catch (err) {
      console.error(`[OdooInserter] Failed to attach PDF: ${err.message}`);
      // Non-fatal — bill is already created
    }
  }
}

// Singleton
let instance = null;

async function submitToOdoo(invoiceRecord, supplierConfig) {
  if (!instance) instance = new OdooInserter();
  return instance.submit(invoiceRecord, supplierConfig);
}

module.exports = {
  OdooInserter,
  submitToOdoo,
};
