require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const XLSX = require('xlsx');

async function test() {
  console.log('=== Testing Remittance Import ===\n');

  // Parse file
  console.log('1. Parsing remittance file...');
  const workbook = XLSX.readFile('/Users/nimavakil/Downloads/Payments.xlsx');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Find invoice detail section (row with "Invoice Number" header)
  let invoiceHeaderIdx = -1;
  data.forEach((row, idx) => {
    if (row && row[1] && String(row[1]).toLowerCase() === 'invoice number') {
      invoiceHeaderIdx = idx;
    }
  });

  console.log('   Invoice detail section starts at row:', invoiceHeaderIdx);

  // Extract VBE invoices
  const vbeInvoices = [];
  for (let i = invoiceHeaderIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (row && row[1] && String(row[1]).startsWith('VBE')) {
      const rawNum = String(row[1]);
      // Convert VBE20240200365 to VBE/2024/02/00365
      const match = rawNum.match(/^(VBE)(\d{4})(\d{2})(\d+)$/);
      const normalized = match
        ? `${match[1]}/${match[2]}/${match[3]}/${match[4].padStart(5, '0')}`
        : rawNum;
      vbeInvoices.push({
        raw: rawNum,
        normalized,
        amount: parseFloat(row[4]) || 0,
        date: row[2]
      });
    }
  }

  console.log('   Found', vbeInvoices.length, 'VBE invoices');

  // Test Odoo matching
  console.log('\n2. Testing Odoo matching...');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  let matched = 0;
  let unmatched = 0;
  const unmatchedList = [];

  for (const inv of vbeInvoices.slice(0, 30)) {
    // Search exact match first
    let invoices = await odoo.searchRead('account.move',
      [['move_type', '=', 'out_invoice'], ['name', '=', inv.normalized]],
      ['id', 'name'],
      { limit: 1 }
    );

    // Try ilike if not found
    if (invoices.length === 0) {
      invoices = await odoo.searchRead('account.move',
        [['move_type', '=', 'out_invoice'], ['name', 'ilike', inv.normalized]],
        ['id', 'name'],
        { limit: 1 }
      );
    }

    if (invoices.length > 0) {
      matched++;
      console.log(`   ✓ ${inv.raw} -> ${invoices[0].name}`);
    } else {
      unmatched++;
      unmatchedList.push(inv);
    }
  }

  console.log(`\n   Matched: ${matched}/30`);
  console.log(`   Unmatched: ${unmatched}/30`);

  if (unmatchedList.length > 0) {
    console.log('\n   Unmatched invoices:');
    unmatchedList.slice(0, 10).forEach(inv => {
      console.log(`     ${inv.raw} -> ${inv.normalized} | EUR ${inv.amount}`);
    });
  }
}

test().catch(e => console.error('Error:', e));
