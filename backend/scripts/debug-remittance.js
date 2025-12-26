const XLSX = require('xlsx');
const workbook = XLSX.readFile('/Users/nimavakil/Downloads/Payments.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

console.log('=== Invoice Detail Section (starting row 106) ===');
data.slice(106, 130).forEach((row, i) => {
  if (row && row.length > 0) {
    console.log(`Row ${106 + i}:`, row.slice(0, 6).map(c => String(c || '').substring(0, 25)));
  }
});

// Count VBE invoices
let vbeCount = 0;
data.slice(107).forEach(row => {
  if (row && row[1] && String(row[1]).includes('VBE')) {
    vbeCount++;
  }
});
console.log('\nVBE invoices found:', vbeCount);

// Show sample VBE invoices
console.log('\n=== Sample VBE Invoices ===');
let shown = 0;
data.slice(107).forEach(row => {
  if (row && row[1] && String(row[1]).includes('VBE') && shown < 15) {
    console.log(`  ${row[1]} | ${row[2]} | Amount: ${row[4]} | Net Paid: ${row[8]}`);
    shown++;
  }
});
