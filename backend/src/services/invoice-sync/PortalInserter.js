/**
 * PortalInserter - Upload invoices to SDT supplier portal (s.distri-smart.com)
 *
 * Uses Puppeteer to:
 * 1. Log in to the supplier portal
 * 2. Navigate to invoice upload section
 * 3. Select the correct supplier
 * 4. Fill in invoice details and upload PDF
 *
 * Required env vars:
 *   SDT_PORTAL_URL       (default: https://s.distri-smart.com)
 *   SDT_PORTAL_USERNAME
 *   SDT_PORTAL_PASSWORD
 *
 * NOTE: Form selectors need to be discovered via the portal UI.
 * Use scripts/discover-portal-invoice-ui.js to explore the portal interactively.
 */

const puppeteer = require('puppeteer');
const InvoiceSyncRecord = require('../../models/InvoiceSyncRecord');
const InvoiceSyncSupplier = require('../../models/InvoiceSyncSupplier');

// Portal configuration — selectors to be filled in after UI discovery
const PORTAL_CONFIG = {
  baseUrl: process.env.SDT_PORTAL_URL || 'https://s.distri-smart.com',
  loginUrl: '/login', // TODO: verify
  invoiceUploadUrl: '/invoices/upload', // TODO: verify

  // Selectors — MUST be discovered by running scripts/discover-portal-invoice-ui.js
  selectors: {
    // Login page
    usernameInput: '#username', // TODO: discover
    passwordInput: '#password', // TODO: discover
    loginButton: 'button[type="submit"]', // TODO: discover

    // Supplier selection
    supplierDropdown: '#supplier-select', // TODO: discover
    supplierSearchInput: 'input.supplier-search', // TODO: discover

    // Invoice upload form
    invoiceNumberInput: '#invoice-number', // TODO: discover
    invoiceDateInput: '#invoice-date', // TODO: discover
    amountInput: '#amount', // TODO: discover
    pdfFileInput: 'input[type="file"]', // TODO: discover
    submitButton: 'button.submit-invoice', // TODO: discover

    // Success/error confirmation
    successMessage: '.success-message', // TODO: discover
    errorMessage: '.error-message', // TODO: discover
  },
};

class PortalInserter {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  /**
   * Submit an invoice to the supplier portal
   * @param {Object} invoiceRecord - InvoiceSyncRecord document
   * @param {Object} supplierConfig - InvoiceSyncSupplier document
   */
  async submit(invoiceRecord, supplierConfig) {
    const username = process.env.SDT_PORTAL_USERNAME;
    const password = process.env.SDT_PORTAL_PASSWORD;

    if (!username || !password) {
      throw new Error('Portal credentials not configured. Set SDT_PORTAL_USERNAME and SDT_PORTAL_PASSWORD');
    }

    // Check if selectors have been configured
    if (this._hasPlaceholderSelectors()) {
      throw new Error(
        'Portal selectors not yet discovered. Run scripts/discover-portal-invoice-ui.js ' +
        'to explore the portal and update PORTAL_CONFIG.selectors in PortalInserter.js'
      );
    }

    const parsed = invoiceRecord.parsedDataJson || {};
    console.log(`[PortalInserter] Uploading invoice ${invoiceRecord.invoiceNumber} for ${supplierConfig.name}`);

    try {
      // Launch browser
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      this.page = await this.browser.newPage();

      // 1. Login
      await this._login(username, password);

      // 2. Navigate to invoice upload
      await this.page.goto(`${PORTAL_CONFIG.baseUrl}${PORTAL_CONFIG.invoiceUploadUrl}`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // 3. Select supplier
      await this._selectSupplier(supplierConfig.portalSupplierName || supplierConfig.name);

      // 4. Fill invoice form
      await this._fillInvoiceForm(invoiceRecord, parsed);

      // 5. Upload PDF
      if (invoiceRecord.pdfFilepath) {
        await this._uploadPdf(invoiceRecord.pdfFilepath);
      }

      // 6. Submit
      await this.page.click(PORTAL_CONFIG.selectors.submitButton);
      await this.page.waitForNavigation({ timeout: 15000 }).catch(() => {});

      // 7. Check for success
      const success = await this._checkSuccess();

      if (success) {
        invoiceRecord.status = 'submitted';
        invoiceRecord.addEvent('submitted_to_portal', {
          portalSupplier: supplierConfig.portalSupplierName,
        });
        await invoiceRecord.save();

        await InvoiceSyncSupplier.findByIdAndUpdate(supplierConfig._id, {
          $inc: { totalInvoicesProcessed: 1 },
        });

        return { success: true, destination: 'portal' };
      } else {
        const errorText = await this._getErrorMessage();
        throw new Error(`Portal submission failed: ${errorText}`);
      }
    } catch (error) {
      invoiceRecord.status = 'failed';
      invoiceRecord.errorMessage = error.message;
      invoiceRecord.addEvent('portal_submission_failed', { error: error.message });
      await invoiceRecord.save();
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
      }
    }
  }

  /**
   * Check if selectors still have placeholder values
   */
  _hasPlaceholderSelectors() {
    // If any key selectors are still the defaults, warn
    const s = PORTAL_CONFIG.selectors;
    return (
      s.usernameInput === '#username' &&
      s.invoiceNumberInput === '#invoice-number' &&
      s.pdfFileInput === 'input[type="file"]'
    );
  }

  /**
   * Log in to the portal
   */
  async _login(username, password) {
    const { selectors } = PORTAL_CONFIG;

    await this.page.goto(`${PORTAL_CONFIG.baseUrl}${PORTAL_CONFIG.loginUrl}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await this.page.type(selectors.usernameInput, username);
    await this.page.type(selectors.passwordInput, password);
    await this.page.click(selectors.loginButton);
    await this.page.waitForNavigation({ timeout: 15000 });

    this.isLoggedIn = true;
    console.log('[PortalInserter] Logged in to portal');
  }

  /**
   * Select a supplier from the portal dropdown
   */
  async _selectSupplier(supplierName) {
    const { selectors } = PORTAL_CONFIG;

    // Try typing into search input
    if (selectors.supplierSearchInput) {
      await this.page.type(selectors.supplierSearchInput, supplierName);
      await new Promise(r => setTimeout(r, 1000)); // Wait for search results
    }

    // Click on matching option (implementation depends on actual portal UI)
    // TODO: Adjust after UI discovery
    const options = await this.page.$$(`option`);
    for (const option of options) {
      const text = await option.evaluate(el => el.textContent);
      if (text && text.toLowerCase().includes(supplierName.toLowerCase())) {
        const value = await option.evaluate(el => el.value);
        await this.page.select(selectors.supplierDropdown, value);
        break;
      }
    }

    console.log(`[PortalInserter] Selected supplier: ${supplierName}`);
  }

  /**
   * Fill in the invoice upload form
   */
  async _fillInvoiceForm(invoiceRecord, parsed) {
    const { selectors } = PORTAL_CONFIG;

    const invoiceNumber = invoiceRecord.invoiceNumber || parsed.invoiceNumber || '';
    const invoiceDate = invoiceRecord.invoiceDate || parsed.invoiceDate || '';
    const amount = invoiceRecord.grossAmount || parsed.grossAmount || '';

    if (invoiceNumber && selectors.invoiceNumberInput) {
      await this.page.type(selectors.invoiceNumberInput, invoiceNumber);
    }
    if (invoiceDate && selectors.invoiceDateInput) {
      await this.page.type(selectors.invoiceDateInput, invoiceDate);
    }
    if (amount && selectors.amountInput) {
      await this.page.type(selectors.amountInput, String(amount));
    }
  }

  /**
   * Upload PDF file
   */
  async _uploadPdf(pdfPath) {
    const { selectors } = PORTAL_CONFIG;
    const fileInput = await this.page.$(selectors.pdfFileInput);
    if (fileInput) {
      await fileInput.uploadFile(pdfPath);
      console.log(`[PortalInserter] PDF uploaded: ${pdfPath}`);
    }
  }

  /**
   * Check if submission was successful
   */
  async _checkSuccess() {
    const { selectors } = PORTAL_CONFIG;
    try {
      await this.page.waitForSelector(selectors.successMessage, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get error message from page
   */
  async _getErrorMessage() {
    const { selectors } = PORTAL_CONFIG;
    try {
      const el = await this.page.$(selectors.errorMessage);
      if (el) {
        return await el.evaluate(e => e.textContent);
      }
    } catch {
      // ignore
    }
    return 'Unknown portal error';
  }
}

// Singleton
let instance = null;

async function submitToPortal(invoiceRecord, supplierConfig) {
  if (!instance) instance = new PortalInserter();
  return instance.submit(invoiceRecord, supplierConfig);
}

module.exports = {
  PortalInserter,
  submitToPortal,
  PORTAL_CONFIG,
};
