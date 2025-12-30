/**
 * Script to create missing OVH vendor bills in Odoo and attach PDFs
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const InvoiceParser = require('../src/services/accounting/InvoiceParser');
const fs = require('fs');
const path = require('path');

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
  taxId: 44,               // Tax (appears to be 0% or reverse charge)
  currencyId: 1            // EUR
};

async function parseAndCreateBills() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const parser = new InvoiceParser();
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

      // Parse the PDF
      console.log('  Parsing PDF...');
      const parsed = await parser.parseInvoice(filePath);

      if (!parsed || !parsed.invoice) {
        console.log('  ERROR: Could not parse invoice');
        results.errors.push({ file: filename, error: 'Parse failed' });
        continue;
      }

      console.log('  Invoice Number:', parsed.invoice.number);
      console.log('  Invoice Date:', parsed.invoice.date);
      console.log('  Total:', parsed.totals?.totalAmount);
      console.log('  Lines:', parsed.lines?.length || 0);

      // Extract invoice reference from filename
      const refMatch = filename.match(/Invoice_(IE\d+)/);
      const invoiceRef = refMatch ? refMatch[1] : parsed.invoice.number;

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
          price_unit: parsed.totals?.subtotal || parsed.totals?.totalAmount || 0,
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
        invoice_date: parsed.invoice.date || new Date().toISOString().split('T')[0],
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
        amount: parsed.totals?.totalAmount
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
