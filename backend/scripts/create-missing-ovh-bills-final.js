/**
 * Script to create missing OVH vendor bills in Odoo with pre-extracted data
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');
const path = require('path');

// OVH bill configuration from existing bills
const OVH_CONFIG = {
  partnerId: 21085,        // OVHcloud
  journalId: 2,            // BILL*BE/ COGS
  accountId: 494,          // 612000 IT (Server, Licenses, SAAS)
  taxId: 44,               // Tax (reverse charge - 0%)
  currencyId: 1            // EUR
};

// Pre-extracted invoice data from PDFs
const INVOICES = [
  {
    ref: 'IE1499483',
    date: '2024-02-19',
    total: 37.77,
    filename: 'Invoice_IE1499483.pdf',
    lines: [
      { description: 'the-cablebox.com - .com renewal 36 months', price: 37.77 }
    ]
  },
  {
    ref: 'IE1514750',
    date: '2024-03-09',
    total: 20.38,
    filename: 'Invoice_IE1514750.pdf',
    lines: [
      { description: 'coffretsamonnaie.fr - .fr renewal 12 months', price: 7.79 },
      { description: 'human-ivf.com - .com renewal 12 months', price: 12.59 }
    ]
  },
  {
    ref: 'IE1550302',
    date: '2024-05-09',
    total: 50.64,
    filename: 'Invoice_IE1550302.pdf',
    lines: [
      { description: 'acrobat.be - .be renewal 12 months', price: 5.19 },
      { description: 'acropaq.be - .be renewal 12 months', price: 5.19 },
      { description: 'acropaq.nl - .nl renewal 12 months', price: 5.09 },
      { description: 'bizzsoft.be - .be renewal 12 months', price: 5.19 },
      { description: 'distri.biz - .biz premium renewal 12 months', price: 18.61 },
      { description: 'kassaladewinkel.nl - .nl renewal 12 months', price: 5.09 },
      { description: 'olympia.be - .be renewal 12 months', price: 5.19 },
      { description: 'DNS Anycast distri.biz', price: 1.09 }
    ]
  },
  {
    ref: 'IE1569081',
    date: '2024-06-09',
    total: 34.16,
    filename: 'Invoice_IE1569081.pdf',
    lines: [
      { description: 'acropaq.com - .com renewal 12 months', price: 12.59 },
      { description: 'acropaq.de - .de renewal 12 months', price: 5.19 },
      { description: 'acropaq.eu - .eu renewal 12 months', price: 8.59 },
      { description: 'acropaq.fr - .fr renewal 12 months', price: 7.79 }
    ]
  },
  {
    ref: 'IE1801939',
    date: '2025-06-09',
    total: 35.06,
    filename: 'Invoice_IE1801939.pdf',
    lines: [
      { description: 'acropaq.com - .com renewal 12 months', price: 13.49 },
      { description: 'acropaq.de - .de renewal 12 months', price: 5.19 },
      { description: 'acropaq.eu - .eu renewal 12 months', price: 8.59 },
      { description: 'acropaq.fr - .fr renewal 12 months', price: 7.79 }
    ]
  },
  {
    ref: 'IE1829972',
    date: '2025-07-31',
    total: 5.80,
    filename: 'Invoice_IE1829972.pdf',
    lines: [
      { description: 'VPS Value 1-2-40 Monthly fees (vps-54d2cf99.vps.ovh.net)', price: 5.80 }
    ]
  },
  {
    ref: 'IE1851327',
    date: '2025-09-01',
    total: 5.80,
    filename: 'Invoice_IE1851327.pdf',
    lines: [
      { description: 'VPS Value 1-2-40 Monthly fees (ai.acropaq.com)', price: 5.80 }
    ]
  }
];

async function createBills() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const downloadsDir = '/Users/nimavakil/Downloads';
  const results = { created: [], errors: [] };

  for (const invoice of INVOICES) {
    console.log(`\n=== Creating: ${invoice.ref} ===`);
    console.log(`  Date: ${invoice.date}`);
    console.log(`  Total: €${invoice.total}`);
    console.log(`  Lines: ${invoice.lines.length}`);

    try {
      // Prepare invoice lines
      const invoiceLines = invoice.lines.map(line => [0, 0, {
        name: line.description,
        account_id: OVH_CONFIG.accountId,
        quantity: 1,
        price_unit: line.price,
        tax_ids: [[6, 0, [OVH_CONFIG.taxId]]]
      }]);

      // Create the vendor bill
      const billData = {
        move_type: 'in_invoice',
        partner_id: OVH_CONFIG.partnerId,
        journal_id: OVH_CONFIG.journalId,
        currency_id: OVH_CONFIG.currencyId,
        ref: invoice.ref,
        invoice_date: invoice.date,
        invoice_line_ids: invoiceLines
      };

      const billId = await odoo.create('account.move', billData);
      console.log(`  Created Bill ID: ${billId}`);

      // Attach the PDF
      const filePath = path.join(downloadsDir, invoice.filename);
      if (fs.existsSync(filePath)) {
        console.log(`  Attaching PDF: ${invoice.filename}`);
        const fileContent = fs.readFileSync(filePath);
        const base64Content = fileContent.toString('base64');

        const attachmentId = await odoo.create('ir.attachment', {
          name: invoice.filename,
          type: 'binary',
          datas: base64Content,
          res_model: 'account.move',
          res_id: billId,
          mimetype: 'application/pdf'
        });

        console.log(`  Attached! Attachment ID: ${attachmentId}`);
        results.created.push({ ref: invoice.ref, billId, attachmentId, total: invoice.total });
      } else {
        console.log(`  WARNING: PDF not found at ${filePath}`);
        results.created.push({ ref: invoice.ref, billId, attachmentId: null, total: invoice.total });
      }

    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.errors.push({ ref: invoice.ref, error: err.message });
    }
  }

  // Summary
  console.log('\n========== SUMMARY ==========');
  console.log('Created:', results.created.length);
  console.log('Errors:', results.errors.length);

  if (results.created.length > 0) {
    console.log('\nCreated Bills:');
    let totalAmount = 0;
    results.created.forEach(r => {
      console.log(`  ${r.ref} -> Bill ID: ${r.billId} | Amount: €${r.total.toFixed(2)} | Attachment: ${r.attachmentId || 'N/A'}`);
      totalAmount += r.total;
    });
    console.log(`\nTotal Amount: €${totalAmount.toFixed(2)}`);
  }

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(r => {
      console.log(`  ${r.ref}: ${r.error}`);
    });
  }
}

createBills().catch(console.error);
