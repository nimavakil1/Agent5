/**
 * Import all Amazon Vendor remittance files
 * Usage: node scripts/import-all-remittances.js
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const XLSX = require('xlsx');
const fs = require('fs');

const FILES = [
  '/Users/nimavakil/Downloads/Payments.xlsx',
  '/Users/nimavakil/Downloads/Payments (1).xlsx',
  '/Users/nimavakil/Downloads/Payments (2).xlsx',
  '/Users/nimavakil/Downloads/Payments (3).xlsx',
  '/Users/nimavakil/Downloads/Payments (4).xlsx',
  '/Users/nimavakil/Downloads/Payments (5).xlsx',
  '/Users/nimavakil/Downloads/Payments (6).xlsx',
  '/Users/nimavakil/Downloads/Payments (7).xlsx',
  '/Users/nimavakil/Downloads/Payments (8).xlsx'
];

function normalizeInvoiceNumber(rawNum) {
  if (!rawNum || rawNum.includes('/')) return rawNum;
  const match = rawNum.match(/^(VBE)(\d{4})(\d{2})(\d+)$/);
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]}/${match[4].padStart(5, '0')}`;
  }
  return rawNum;
}

function parseRemittanceFile(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Find invoice detail section
  let invoiceHeaderIdx = -1;
  data.forEach((row, idx) => {
    if (row && row[1] && String(row[1]).toLowerCase() === 'invoice number') {
      invoiceHeaderIdx = idx;
    }
  });

  const invoices = [];
  if (invoiceHeaderIdx >= 0) {
    for (let i = invoiceHeaderIdx + 1; i < data.length; i++) {
      const row = data[i];
      if (row && row[1] && String(row[1]).startsWith('VBE')) {
        const rawNum = String(row[1]);
        invoices.push({
          raw: rawNum,
          normalized: normalizeInvoiceNumber(rawNum),
          amount: parseFloat(row[4]) || 0,
          netPaid: parseFloat(row[8]) || 0,
          date: row[2],
          paymentNumber: String(row[0] || ''),
          description: String(row[3] || '')
        });
      }
    }
  }

  return invoices;
}

async function main() {
  console.log('=== Importing All Remittance Files ===\n');

  // Collect all invoices from all files
  const allInvoices = new Map(); // Use map to dedupe

  for (const file of FILES) {
    if (!fs.existsSync(file)) {
      console.log(`Skipping: ${file} (not found)`);
      continue;
    }

    const fileName = file.split('/').pop();
    const invoices = parseRemittanceFile(file);
    console.log(`${fileName}: ${invoices.length} VBE invoices`);

    invoices.forEach(inv => {
      // Keep the entry with highest amount (in case of duplicates)
      const existing = allInvoices.get(inv.normalized);
      if (!existing || inv.amount > existing.amount) {
        allInvoices.set(inv.normalized, inv);
      }
    });
  }

  console.log(`\nTotal unique VBE invoices: ${allInvoices.size}`);

  // Connect to Odoo
  console.log('\nConnecting to Odoo...');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Match with Odoo
  console.log('Matching with Odoo invoices...\n');

  let matched = 0;
  let unmatched = 0;
  const matchedInvoices = [];
  const unmatchedInvoices = [];

  const invoiceList = Array.from(allInvoices.values());

  for (let i = 0; i < invoiceList.length; i++) {
    const inv = invoiceList[i];

    // Progress indicator
    if ((i + 1) % 100 === 0) {
      console.log(`  Progress: ${i + 1}/${invoiceList.length}`);
    }

    // Search in Odoo
    let odooInvoices = await odoo.searchRead('account.move',
      [['move_type', '=', 'out_invoice'], ['name', '=', inv.normalized]],
      ['id', 'name', 'amount_total', 'payment_state'],
      { limit: 1 }
    );

    if (odooInvoices.length === 0) {
      odooInvoices = await odoo.searchRead('account.move',
        [['move_type', '=', 'out_invoice'], ['name', 'ilike', inv.normalized]],
        ['id', 'name', 'amount_total', 'payment_state'],
        { limit: 1 }
      );
    }

    if (odooInvoices.length > 0) {
      matched++;
      matchedInvoices.push({
        amazonInvoice: inv.raw,
        odooInvoice: odooInvoices[0].name,
        odooId: odooInvoices[0].id,
        amazonAmount: inv.amount,
        odooAmount: odooInvoices[0].amount_total,
        odooPaymentState: odooInvoices[0].payment_state,
        netPaid: inv.netPaid
      });
    } else {
      unmatched++;
      unmatchedInvoices.push(inv);
    }
  }

  // Summary
  console.log('\n=== RESULTS ===');
  console.log(`Total invoices in remittance files: ${allInvoices.size}`);
  console.log(`Matched with Odoo: ${matched} (${((matched / allInvoices.size) * 100).toFixed(1)}%)`);
  console.log(`Not found in Odoo: ${unmatched}`);

  // Calculate totals
  const totalMatched = matchedInvoices.reduce((sum, inv) => sum + inv.amazonAmount, 0);
  const totalPaid = matchedInvoices.reduce((sum, inv) => sum + inv.netPaid, 0);
  console.log(`\nTotal amount matched: EUR ${totalMatched.toFixed(2)}`);
  console.log(`Total net paid: EUR ${totalPaid.toFixed(2)}`);

  // Show unmatched
  if (unmatchedInvoices.length > 0) {
    console.log(`\n=== UNMATCHED INVOICES (${unmatchedInvoices.length}) ===`);
    unmatchedInvoices.slice(0, 20).forEach(inv => {
      console.log(`  ${inv.raw} -> ${inv.normalized} | EUR ${inv.amount}`);
    });
    if (unmatchedInvoices.length > 20) {
      console.log(`  ... and ${unmatchedInvoices.length - 20} more`);
    }
  }

  // Save results to JSON for later use
  const outputPath = '/tmp/remittance-import-results.json';
  fs.writeFileSync(outputPath, JSON.stringify({
    importDate: new Date().toISOString(),
    totalFiles: FILES.length,
    totalInvoices: allInvoices.size,
    matched,
    unmatched,
    totalAmountMatched: totalMatched,
    totalNetPaid: totalPaid,
    matchedInvoices,
    unmatchedInvoices
  }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
