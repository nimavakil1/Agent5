/**
 * Script to create missing OVH vendor bills in Odoo and attach PDFs
 * Uses Claude Vision API directly to parse the invoices
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Missing invoice files
const MISSING_INVOICES = [
  'Invoice_IE1499483.pdf',
  'Invoice_IE1514750.pdf',
  'Invoice_IE1550302.pdf',
  'Invoice_IE1569081.pdf',
  'Invoice_IE1801939.pdf',
  'Invoice_IE1829972.pdf',
  'Invoice_IE1851327.pdf'
];

// OVH bill configuration from existing bills
const OVH_CONFIG = {
  partnerId: 21085,        // OVHcloud
  journalId: 2,            // BILL*BE/ COGS
  accountId: 494,          // 612000 IT (Server, Licenses, SAAS)
  taxId: 44,               // Tax (reverse charge - 0%)
  currencyId: 1            // EUR
};

async function convertPdfToImage(pdfPath) {
  const outputPath = pdfPath.replace('.pdf', '.png');
  try {
    // Use sips to convert PDF to PNG (macOS)
    execSync(`sips -s format png "${pdfPath}" --out "${outputPath}" 2>/dev/null || convert -density 150 "${pdfPath}[0]" "${outputPath}"`);
    return outputPath;
  } catch (err) {
    // Try using pdftoppm if available
    try {
      execSync(`pdftoppm -png -f 1 -l 1 "${pdfPath}" "${pdfPath.replace('.pdf', '')}"`, { stdio: 'ignore' });
      return pdfPath.replace('.pdf', '-1.png');
    } catch (err2) {
      console.log('  Warning: Could not convert PDF to image, using PDF directly');
      return null;
    }
  }
}

async function parseInvoiceWithVision(filePath) {
  const anthropic = new Anthropic();

  // Read the PDF file and convert to base64
  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64Data
          }
        },
        {
          type: 'text',
          text: `Extract the invoice data from this OVH invoice PDF. Return ONLY valid JSON with this structure:
{
  "invoiceNumber": "IE...",
  "invoiceDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "subtotal": 0.00,
  "vatAmount": 0.00,
  "total": 0.00,
  "lines": [
    {
      "description": "Service description",
      "quantity": 1,
      "unitPrice": 0.00,
      "totalPrice": 0.00
    }
  ]
}

IMPORTANT: Return ONLY the JSON, no other text or markdown.`
        }
      ]
    }]
  });

  const jsonText = response.content[0].text.trim();
  // Remove markdown code blocks if present
  const cleanJson = jsonText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleanJson);
}

async function parseAndCreateBills() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const downloadsDir = '/Users/nimavakil/Downloads';
  const results = { created: [], errors: [] };

  for (const filename of MISSING_INVOICES) {
    const filePath = path.join(downloadsDir, filename);

    console.log(`\n=== Processing: ${filename} ===`);

    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.log(`  FILE NOT FOUND: ${filePath}`);
        results.errors.push({ file: filename, error: 'File not found' });
        continue;
      }

      // Parse the PDF with Vision
      console.log('  Parsing with Claude Vision...');
      const parsed = await parseInvoiceWithVision(filePath);

      console.log('  Invoice Number:', parsed.invoiceNumber);
      console.log('  Invoice Date:', parsed.invoiceDate);
      console.log('  Total:', parsed.total);
      console.log('  Lines:', parsed.lines?.length || 0);

      // Use invoice number from parsing or extract from filename
      const invoiceRef = parsed.invoiceNumber || filename.match(/Invoice_(IE\d+)/)?.[1];

      // Prepare invoice lines
      const invoiceLines = [];

      if (parsed.lines && parsed.lines.length > 0) {
        for (const line of parsed.lines) {
          invoiceLines.push([0, 0, {
            name: line.description || 'OVH Service',
            account_id: OVH_CONFIG.accountId,
            quantity: line.quantity || 1,
            price_unit: line.unitPrice || line.totalPrice || 0,
            tax_ids: [[6, 0, [OVH_CONFIG.taxId]]]
          }]);
        }
      } else {
        // Single line with total if no lines parsed
        invoiceLines.push([0, 0, {
          name: 'OVH Services',
          account_id: OVH_CONFIG.accountId,
          quantity: 1,
          price_unit: parsed.subtotal || parsed.total || 0,
          tax_ids: [[6, 0, [OVH_CONFIG.taxId]]]
        }]);
      }

      // Create the vendor bill
      console.log('  Creating bill in Odoo...');
      const billData = {
        move_type: 'in_invoice',
        partner_id: OVH_CONFIG.partnerId,
        journal_id: OVH_CONFIG.journalId,
        currency_id: OVH_CONFIG.currencyId,
        ref: invoiceRef,
        invoice_date: parsed.invoiceDate || new Date().toISOString().split('T')[0],
        invoice_line_ids: invoiceLines
      };

      const billId = await odoo.create('account.move', billData);
      console.log('  Created Bill ID:', billId);

      // Attach the PDF
      console.log('  Attaching PDF...');
      const fileContent = fs.readFileSync(filePath);
      const base64Content = fileContent.toString('base64');

      const attachmentId = await odoo.create('ir.attachment', {
        name: filename,
        type: 'binary',
        datas: base64Content,
        res_model: 'account.move',
        res_id: billId,
        mimetype: 'application/pdf'
      });

      console.log('  Attached! Attachment ID:', attachmentId);

      results.created.push({
        file: filename,
        ref: invoiceRef,
        billId,
        attachmentId,
        amount: parsed.total
      });

    } catch (err) {
      console.log('  ERROR:', err.message);
      results.errors.push({ file: filename, error: err.message });
    }
  }

  // Summary
  console.log('\n========== SUMMARY ==========');
  console.log('Created:', results.created.length);
  console.log('Errors:', results.errors.length);

  if (results.created.length > 0) {
    console.log('\nCreated Bills:');
    results.created.forEach(r => {
      console.log(`  ${r.ref} -> Bill ID: ${r.billId} | Amount: €${r.amount?.toFixed(2) || '?'}`);
    });
  }

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(r => {
      console.log(`  ${r.file}: ${r.error}`);
    });
  }
}

parseAndCreateBills().catch(console.error);
