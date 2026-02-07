/**
 * PdfParser - Extract invoice data from PDF using Claude AI
 *
 * Reads PDF text with pdf-parse, sends to Claude for structured extraction.
 * Optimized for European supplier invoices (German/French/Dutch).
 */

const Anthropic = require('@anthropic-ai/sdk');
const pdf = require('pdf-parse');
const fs = require('fs');

class PdfParser {
  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Parse an invoice PDF and extract structured data
   * @param {string} pdfPath - Path to PDF file
   * @param {string} supplierName - Supplier name for context
   * @returns {Object} Parsed invoice data
   */
  async parse(pdfPath, supplierName) {
    console.log(`[PdfParser] Parsing: ${pdfPath} (supplier: ${supplierName})`);

    // Read PDF
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdf(buffer);

    if (!data.text || data.text.trim().length < 20) {
      throw new Error('PDF text extraction yielded too little text — may be scanned image');
    }

    console.log(`[PdfParser] Extracted ${data.text.length} chars from ${data.numpages} page(s)`);

    // Send to Claude for structured extraction
    const extracted = await this._extractWithClaude(data.text, supplierName);

    // Calculate confidence
    extracted.confidence = this._calculateConfidence(extracted);

    return extracted;
  }

  /**
   * Extract structured invoice data using Claude
   */
  async _extractWithClaude(text, supplierName) {
    const systemPrompt = `You are an expert invoice data extractor for Smart Distribution Technologies (SDT), a German office supplies distributor.

Extract ALL information from this invoice text and return ONLY valid JSON (no markdown, no code blocks).

CONTEXT: This invoice is from supplier "${supplierName}". SDT receives invoices primarily in German, but also French, Dutch, and English.

REQUIRED JSON STRUCTURE:
{
  "invoiceNumber": "string — the invoice/Rechnung number",
  "invoiceDate": "string — date in YYYY-MM-DD format",
  "dueDate": "string or null — payment due date in YYYY-MM-DD",
  "netAmount": number — net total before VAT (Nettobetrag),
  "vatAmount": number — VAT amount (MwSt/USt),
  "vatRate": number — VAT rate as percentage (e.g. 19, not 0.19),
  "grossAmount": number — gross total including VAT (Bruttobetrag),
  "currency": "EUR",
  "poNumbers": "string — comma-separated PO/order numbers if found, or empty string",
  "vendorName": "string — supplier company name",
  "vendorVat": "string — VAT number (USt-IdNr) if found",
  "bankAccount": "string — IBAN if found",
  "lineItems": [
    {
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "lineTotal": number,
      "articleNumber": "string or null"
    }
  ],
  "paymentTerms": "string or null",
  "notes": "string — any relevant notes"
}

RULES:
- All monetary amounts MUST be numbers, not strings
- For European number format (1.234,56) → convert to 1234.56
- Dates must be YYYY-MM-DD
- Look for: Rechnungsnummer, Rechnung Nr., Invoice No., Facture N°
- Look for: Bestellnummer, PO Number, Order Reference, Commande
- Look for: Nettobetrag, Subtotal, HT, Netto
- Look for: MwSt, USt, TVA, BTW, VAT
- Look for: Bruttobetrag, Total TTC, Bruto, Total inkl. MwSt
- Return ONLY the JSON object, no additional text or explanation`;

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Extract invoice data from this document:\n\n${text.substring(0, 15000)}`,
      }],
    });

    // Parse the response
    const responseText = response.content[0]?.text || '';

    try {
      // Try to parse JSON directly
      return JSON.parse(responseText);
    } catch {
      // Try to extract JSON from the response (sometimes wrapped in backticks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error(`Failed to parse AI response as JSON: ${responseText.substring(0, 200)}`);
    }
  }

  /**
   * Calculate a confidence score (0-1) based on extracted fields
   */
  _calculateConfidence(data) {
    let score = 0;
    let total = 0;

    const checks = [
      ['invoiceNumber', d => d.invoiceNumber && d.invoiceNumber.length > 0],
      ['invoiceDate', d => d.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(d.invoiceDate)],
      ['grossAmount', d => typeof d.grossAmount === 'number' && d.grossAmount > 0],
      ['netAmount', d => typeof d.netAmount === 'number' && d.netAmount > 0],
      ['vatAmount', d => typeof d.vatAmount === 'number' && d.vatAmount >= 0],
      ['amountsConsistent', d => {
        if (typeof d.netAmount !== 'number' || typeof d.vatAmount !== 'number' || typeof d.grossAmount !== 'number') return false;
        return Math.abs((d.netAmount + d.vatAmount) - d.grossAmount) < 0.05;
      }],
      ['vendorName', d => d.vendorName && d.vendorName.length > 0],
      ['lineItems', d => Array.isArray(d.lineItems) && d.lineItems.length > 0],
    ];

    for (const [, check] of checks) {
      total++;
      if (check(data)) score++;
    }

    return Math.round((score / total) * 100) / 100;
  }
}

// Singleton
let instance = null;

async function parseInvoicePdf(pdfPath, supplierName) {
  if (!instance) instance = new PdfParser();
  return instance.parse(pdfPath, supplierName);
}

module.exports = {
  PdfParser,
  parseInvoicePdf,
};
