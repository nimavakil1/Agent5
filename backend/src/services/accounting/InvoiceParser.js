/**
 * InvoiceParser - Extract invoice data from PDF/images using Vision LLM
 *
 * Uses Claude's vision capabilities to extract structured data from invoice documents.
 */

const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const _sharp = require('sharp');

class InvoiceParser {
  constructor(config = {}) {
    this.maxFileSizeMB = config.maxFileSizeMB || 10;
    this.maxPages = config.maxPages || 5;

    // Initialize Anthropic client
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Parse an invoice from a buffer
   * @param {Buffer} buffer - File content
   * @param {string} mimeType - MIME type (application/pdf, image/jpeg, etc.)
   * @param {string} filename - Original filename
   * @returns {Object} Extracted invoice data
   */
  async parseInvoice(buffer, mimeType, filename) {
    console.log(`[InvoiceParser] Parsing invoice: ${filename} (${mimeType})`);

    // Convert to images if PDF
    let images;
    if (mimeType === 'application/pdf') {
      images = await this._pdfToImages(buffer);
    } else if (mimeType.startsWith('image/')) {
      images = [{ base64: buffer.toString('base64'), mimeType }];
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }

    // Extract data using vision LLM
    const extractedData = await this._extractWithVisionLLM(images, filename);

    // Validate and normalize
    const normalizedData = this._normalizeInvoiceData(extractedData);

    // Calculate confidence score
    normalizedData.extractionConfidence = this._calculateConfidence(normalizedData);

    return normalizedData;
  }

  /**
   * Convert PDF to images for vision processing
   */
  async _pdfToImages(pdfBuffer) {
    const images = [];

    try {
      // Use pdf-parse to get page count
      const data = await pdf(pdfBuffer);
      const pageCount = Math.min(data.numpages || 1, this.maxPages);

      // For now, we'll use the text extraction as a fallback
      // In production, use pdf-to-img or similar for actual image conversion

      // Create a simple representation for the LLM
      images.push({
        base64: pdfBuffer.toString('base64'),
        mimeType: 'application/pdf',
        text: data.text, // Include extracted text as context
      });

      console.log(`[InvoiceParser] PDF has ${pageCount} pages, extracted ${data.text.length} chars of text`);
    } catch (error) {
      console.error('[InvoiceParser] PDF parsing error:', error.message);
      // Fallback: just use the raw PDF
      images.push({
        base64: pdfBuffer.toString('base64'),
        mimeType: 'application/pdf',
      });
    }

    return images;
  }

  /**
   * Extract invoice data using Claude's vision capabilities
   */
  async _extractWithVisionLLM(images, filename) {
    const systemPrompt = `You are an expert invoice data extractor for a Belgian e-commerce company.
Extract ALL information from this invoice and return ONLY valid JSON (no markdown, no code blocks).

REQUIRED FIELDS (extract if present):
- vendor_name: Company name on the invoice (the seller/supplier)
- vendor_vat: VAT number (look for BTW, VAT, TVA, USt-IdNr, starting with BE, NL, DE, FR, etc.)
- vendor_address: Full address
- invoice_number: Unique invoice identifier/reference
- invoice_date: Date (convert to YYYY-MM-DD format)
- due_date: Payment due date if present (YYYY-MM-DD)
- currency: ISO currency code (EUR, USD, GBP, etc.)
- po_reference: Purchase order reference if mentioned (look for PO, Order, Bestelling, Commande)

LINE ITEMS (array of objects):
- description: Item description
- quantity: Number of units
- unit_price: Price per unit (exclude VAT)
- total: Line total before VAT
- sku: Product code/SKU if present

TOTALS:
- subtotal: Total before VAT
- vat_amount: Total VAT amount
- vat_rate: VAT percentage if single rate (21, 12, 6, 0 for Belgium)
- total_amount: Grand total including VAT

ADDITIONAL (if present):
- payment_terms: Payment terms text
- bank_account: IBAN if present
- notes: Any special notes or comments

IMPORTANT:
- All monetary amounts should be numbers, not strings
- Dates must be YYYY-MM-DD format
- VAT rates are percentages (21 not 0.21)
- Return ONLY the JSON object, no additional text`;

    // Build the message content
    const content = [];

    // Add images or text context
    for (const img of images) {
      if (img.text) {
        // PDF text extraction fallback
        content.push({
          type: 'text',
          text: `Invoice text content from ${filename}:\n\n${img.text.substring(0, 10000)}`,
        });
      } else if (img.mimeType.startsWith('image/')) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: img.base64,
          },
        });
      }
    }

    content.push({
      type: 'text',
      text: `Extract invoice data from the document: ${filename}`,
    });

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content,
        }],
      });

      // Parse the JSON response
      const responseText = response.content[0].text;
      console.log('[InvoiceParser] Raw LLM response:', responseText.substring(0, 500));

      // Try to extract JSON from the response
      let jsonStr = responseText;

      // Remove markdown code blocks if present
      if (jsonStr.includes('```')) {
        const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
          jsonStr = match[1];
        }
      }

      return JSON.parse(jsonStr.trim());
    } catch (error) {
      console.error('[InvoiceParser] LLM extraction error:', error.message);
      throw new Error(`Failed to extract invoice data: ${error.message}`);
    }
  }

  /**
   * Normalize extracted data to consistent schema
   */
  _normalizeInvoiceData(data) {
    return {
      vendor: {
        name: data.vendor_name || null,
        vatNumber: this._normalizeVatNumber(data.vendor_vat),
        address: data.vendor_address || null,
      },
      invoice: {
        number: data.invoice_number || null,
        date: this._normalizeDate(data.invoice_date),
        dueDate: this._normalizeDate(data.due_date),
        currency: (data.currency || 'EUR').toUpperCase(),
        poReference: data.po_reference || null,
        paymentTerms: data.payment_terms || null,
        bankAccount: data.bank_account || null,
      },
      lines: (data.line_items || data.lines || []).map((line, _index) => ({
        description: line.description || '',
        sku: line.sku || null,
        quantity: this._parseNumber(line.quantity) || 1,
        unitPrice: this._parseNumber(line.unit_price) || 0,
        vatRate: this._parseNumber(line.vat_rate),
        lineTotal: this._parseNumber(line.total) || 0,
      })),
      totals: {
        subtotal: this._parseNumber(data.subtotal) || 0,
        vatAmount: this._parseNumber(data.vat_amount) || 0,
        vatRate: this._parseNumber(data.vat_rate),
        totalAmount: this._parseNumber(data.total_amount) || 0,
      },
      notes: data.notes || null,
      rawExtraction: data,
    };
  }

  /**
   * Normalize VAT number format
   */
  _normalizeVatNumber(vat) {
    if (!vat) return null;

    // Remove spaces and common prefixes
    let normalized = String(vat).replace(/\s+/g, '').toUpperCase();

    // Remove "BTW" prefix if present (Belgian)
    normalized = normalized.replace(/^BTW[:-]?/i, '');

    // Ensure country prefix
    if (/^\d/.test(normalized)) {
      // Assume Belgian if starts with number
      normalized = 'BE' + normalized;
    }

    return normalized;
  }

  /**
   * Normalize date to ISO format
   */
  _normalizeDate(dateStr) {
    if (!dateStr) return null;

    try {
      // Handle various date formats
      let date;

      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        // Already ISO format
        date = new Date(dateStr);
      } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
        // DD/MM/YYYY (European)
        const [day, month, year] = dateStr.split('/');
        date = new Date(`${year}-${month}-${day}`);
      } else if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
        // DD-MM-YYYY (European)
        const [day, month, year] = dateStr.split('-');
        date = new Date(`${year}-${month}-${day}`);
      } else {
        date = new Date(dateStr);
      }

      if (isNaN(date.getTime())) return null;

      return date.toISOString().split('T')[0];
    } catch {
      return null;
    }
  }

  /**
   * Parse a number from various formats
   */
  _parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;

    // Handle European number format (1.234,56)
    let numStr = String(value).trim();

    // Remove currency symbols and spaces
    numStr = numStr.replace(/[€$£\s]/g, '');

    // Handle European format: 1.234,56 -> 1234.56
    if (numStr.includes(',') && numStr.includes('.')) {
      if (numStr.lastIndexOf(',') > numStr.lastIndexOf('.')) {
        // European format
        numStr = numStr.replace(/\./g, '').replace(',', '.');
      } else {
        // US format
        numStr = numStr.replace(/,/g, '');
      }
    } else if (numStr.includes(',') && !numStr.includes('.')) {
      // Could be European decimal or US thousands
      const parts = numStr.split(',');
      if (parts.length === 2 && parts[1].length === 2) {
        // Likely European decimal
        numStr = numStr.replace(',', '.');
      } else {
        // Likely US thousands separator
        numStr = numStr.replace(/,/g, '');
      }
    }

    const result = parseFloat(numStr);
    return isNaN(result) ? null : result;
  }

  /**
   * Calculate extraction confidence score
   */
  _calculateConfidence(data) {
    let score = 0;
    let total = 0;

    // Required fields
    const requiredFields = [
      { path: 'vendor.name', weight: 15 },
      { path: 'invoice.number', weight: 15 },
      { path: 'invoice.date', weight: 10 },
      { path: 'totals.totalAmount', weight: 15 },
    ];

    // Optional but important fields
    const optionalFields = [
      { path: 'vendor.vatNumber', weight: 10 },
      { path: 'invoice.dueDate', weight: 5 },
      { path: 'invoice.currency', weight: 5 },
      { path: 'totals.subtotal', weight: 5 },
      { path: 'totals.vatAmount', weight: 5 },
      { path: 'lines.length', weight: 10, minValue: 1 },
    ];

    for (const field of [...requiredFields, ...optionalFields]) {
      total += field.weight;

      const value = this._getNestedValue(data, field.path);
      if (value !== null && value !== undefined && value !== '') {
        if (field.minValue && value < field.minValue) continue;
        score += field.weight;
      }
    }

    // Bonus for VAT/amount consistency
    if (data.totals.subtotal && data.totals.vatAmount && data.totals.totalAmount) {
      const calculatedTotal = data.totals.subtotal + data.totals.vatAmount;
      const diff = Math.abs(calculatedTotal - data.totals.totalAmount);
      if (diff < 0.1) {
        score += 5;
      }
      total += 5;
    }

    return Math.min(1, score / total);
  }

  /**
   * Get nested object value by path
   */
  _getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      if (current === null || current === undefined) return undefined;
      return current[key];
    }, obj);
  }

  /**
   * Parse a payment advice/remittance from a buffer
   * @param {Buffer} buffer - File content
   * @param {string} mimeType - MIME type
   * @param {string} filename - Original filename
   * @returns {Object} Extracted payment advice data
   */
  async parsePaymentAdvice(buffer, mimeType, filename) {
    console.log(`[InvoiceParser] Parsing payment advice: ${filename} (${mimeType})`);

    // Convert to processable format
    let content;
    if (mimeType === 'application/pdf') {
      const data = await pdf(buffer);
      content = { text: data.text };
    } else if (mimeType.startsWith('image/')) {
      content = { base64: buffer.toString('base64'), mimeType };
    } else if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) {
      // For Excel files, we'd need xlsx parsing - fallback to text extraction
      content = { text: `Excel file: ${filename}` };
    } else {
      throw new Error(`Unsupported file type for payment advice: ${mimeType}`);
    }

    // Extract using vision LLM with payment advice prompt
    const extractedData = await this._extractPaymentAdviceWithLLM(content, filename);

    // Calculate confidence
    extractedData.extractionConfidence = this._calculatePaymentAdviceConfidence(extractedData);

    return extractedData;
  }

  /**
   * Extract payment advice data using LLM
   */
  async _extractPaymentAdviceWithLLM(content, filename) {
    const systemPrompt = `You are an expert at extracting payment advice/remittance data.
Extract ALL information from this payment notification and return ONLY valid JSON (no markdown, no code blocks).

PAYMENT DETAILS:
- payer_name: Name of the company making the payment
- payer_vat: VAT number if present
- payer_bank_account: Bank account/IBAN if present
- payment_reference: Payment reference number
- payment_date: Date of payment (YYYY-MM-DD)
- total_amount: Total payment amount (number)
- currency: ISO currency code (EUR, USD, etc.)
- payment_method: wire, sepa, check, etc.

INVOICE LINES (array of objects for each invoice being paid):
- invoice_reference: Invoice number being paid
- invoice_date: Original invoice date (YYYY-MM-DD) if mentioned
- invoice_amount: Original invoice amount
- paid_amount: Amount being paid for this invoice
- discount_amount: Any discount applied
- withholding_amount: Any withholding/retention

IMPORTANT:
- All monetary amounts should be numbers, not strings
- Dates must be YYYY-MM-DD format
- Return ONLY the JSON object, no additional text
- If multiple invoices are being paid in one remittance, list each as a separate line`;

    const messageContent = [];

    if (content.text) {
      messageContent.push({
        type: 'text',
        text: `Payment advice content from ${filename}:\n\n${content.text.substring(0, 15000)}`,
      });
    } else if (content.base64 && content.mimeType.startsWith('image/')) {
      messageContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: content.mimeType,
          data: content.base64,
        },
      });
    }

    messageContent.push({
      type: 'text',
      text: 'Please extract the payment advice information and return the JSON object.',
    });

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: messageContent }],
      });

      const responseText = response.content[0].text;

      // Try to parse JSON from response
      let jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const data = JSON.parse(jsonMatch[0]);
      return this._normalizePaymentAdviceData(data);

    } catch (error) {
      console.error('[InvoiceParser] Payment advice extraction error:', error.message);
      // Return minimal structure
      return {
        payer: { name: null },
        payment: { reference: null, totalAmount: 0, currency: 'EUR' },
        lines: [],
      };
    }
  }

  /**
   * Normalize payment advice data
   */
  _normalizePaymentAdviceData(data) {
    const normalized = {
      payer: {
        name: data.payer_name || null,
        vatNumber: data.payer_vat || null,
        bankAccount: data.payer_bank_account || null,
      },
      payment: {
        reference: data.payment_reference || null,
        date: data.payment_date ? new Date(data.payment_date) : null,
        totalAmount: parseFloat(data.total_amount) || 0,
        currency: data.currency || 'EUR',
        paymentMethod: data.payment_method || null,
      },
      lines: [],
    };

    // Process invoice lines
    if (Array.isArray(data.lines || data.invoice_lines)) {
      const lines = data.lines || data.invoice_lines;
      for (const line of lines) {
        normalized.lines.push({
          invoiceReference: line.invoice_reference || line.invoiceReference || null,
          invoiceDate: line.invoice_date ? new Date(line.invoice_date) : null,
          invoiceAmount: parseFloat(line.invoice_amount || line.invoiceAmount) || 0,
          paidAmount: parseFloat(line.paid_amount || line.paidAmount) || 0,
          discountAmount: parseFloat(line.discount_amount || line.discountAmount) || 0,
          withholdingAmount: parseFloat(line.withholding_amount || line.withholdingAmount) || 0,
        });
      }
    }

    return normalized;
  }

  /**
   * Calculate confidence for payment advice extraction
   */
  _calculatePaymentAdviceConfidence(data) {
    let score = 0;
    let total = 0;

    // Check payer info (30%)
    if (data.payer?.name) { score += 15; }
    total += 15;
    if (data.payer?.vatNumber || data.payer?.bankAccount) { score += 15; }
    total += 15;

    // Check payment info (40%)
    if (data.payment?.reference) { score += 10; }
    total += 10;
    if (data.payment?.date) { score += 10; }
    total += 10;
    if (data.payment?.totalAmount > 0) { score += 20; }
    total += 20;

    // Check lines (30%)
    if (data.lines?.length > 0) {
      const hasRefs = data.lines.some(l => l.invoiceReference);
      const hasAmounts = data.lines.some(l => l.paidAmount > 0);
      if (hasRefs) { score += 15; }
      if (hasAmounts) { score += 15; }
    }
    total += 30;

    return Math.min(1, score / total);
  }
}

module.exports = InvoiceParser;
