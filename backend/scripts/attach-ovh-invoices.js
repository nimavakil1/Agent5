/**
 * Script to attach OVH invoice PDFs to their corresponding Odoo vendor bills
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');
const path = require('path');

async function attachPDFsToBills() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Map of invoice references to Odoo bill IDs
  const odooBills = {
    'IE1922719': 358792,
    'IE1940862': 358791,
    'IE1939466': 358781,
    'IE1585931': 358802,
    'IE1588853': 358801,
    'IE1607667': 358800,
    'IE1676930': 358799,
    'IE1684299': 358798,
    'IE1740611': 358797,
    'IE1781228': 358796,
    'IE1850651': 358795,
    'IE1873456': 358794,
    'IE1899581': 358793
  };

  // Get PDF files
  const downloadsDir = '/Users/nimavakil/Downloads';
  const pdfFiles = fs.readdirSync(downloadsDir).filter(f => f.startsWith('Invoice_IE') && f.endsWith('.pdf'));

  console.log('PDF files found:', pdfFiles.length);

  const results = { matched: [], notMatched: [], attached: [], errors: [] };

  for (const pdfFile of pdfFiles) {
    // Extract invoice number from filename (e.g., 'Invoice_IE1922719 (1).pdf' -> 'IE1922719')
    const match = pdfFile.match(/Invoice_(IE\d+)/);
    if (!match) {
      results.notMatched.push({ file: pdfFile, reason: 'Could not extract invoice number' });
      continue;
    }

    const invoiceNumber = match[1];
    const billId = odooBills[invoiceNumber];

    if (!billId) {
      results.notMatched.push({ file: pdfFile, invoiceNumber, reason: 'No matching Odoo bill' });
      continue;
    }

    results.matched.push({ file: pdfFile, invoiceNumber, billId });
  }

  console.log('\n=== MATCHING RESULTS ===');
  console.log('Matched:', results.matched.length);
  console.log('Not matched:', results.notMatched.length);

  console.log('\nMatched files:');
  results.matched.forEach(m => console.log('  ', m.file, '->', 'Bill ID:', m.billId));

  console.log('\nNot matched files:');
  results.notMatched.forEach(m => console.log('  ', m.file, '|', m.reason));

  // Now attach PDFs to Odoo bills
  console.log('\n=== ATTACHING PDFs TO ODOO ===');

  // Track which bills we've already attached to (avoid duplicates from (1) files)
  const attachedBills = new Set();

  for (const match of results.matched) {
    // Skip if we already attached to this bill (e.g., avoid both IE1922719.pdf and IE1922719 (1).pdf)
    if (attachedBills.has(match.billId)) {
      console.log('  SKIP (already attached):', match.file);
      continue;
    }

    try {
      const filePath = path.join(downloadsDir, match.file);
      const fileContent = fs.readFileSync(filePath);
      const base64Content = fileContent.toString('base64');

      // Create attachment in Odoo
      const attachmentId = await odoo.create('ir.attachment', {
        name: match.file,
        type: 'binary',
        datas: base64Content,
        res_model: 'account.move',
        res_id: match.billId,
        mimetype: 'application/pdf'
      });

      attachedBills.add(match.billId);
      results.attached.push({ file: match.file, billId: match.billId, attachmentId });
      console.log('  ATTACHED:', match.file, '-> Bill ID:', match.billId, '(Attachment ID:', attachmentId + ')');

    } catch (err) {
      results.errors.push({ file: match.file, billId: match.billId, error: err.message });
      console.log('  ERROR:', match.file, '->', err.message);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('PDFs attached:', results.attached.length);
  console.log('Errors:', results.errors.length);
  console.log('Not in Odoo:', results.notMatched.length);
}

attachPDFsToBills().catch(console.error);
