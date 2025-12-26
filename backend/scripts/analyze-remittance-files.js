require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');

const files = [
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

const allPayments = new Map();
let totalAmount = 0;

files.forEach(file => {
  try {
    const workbook = XLSX.readFile(file);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    data.slice(3).forEach(row => {
      if (row && row[0] && row[1]) {
        const paymentNum = String(row[0]);
        const paymentDate = row[1];
        const amount = parseFloat(row[3]) || 0;

        if (!allPayments.has(paymentNum)) {
          allPayments.set(paymentNum, { paymentNum, paymentDate, amount, status: row[8] });
          if (row[8] === 'Successful' && amount > 0) {
            totalAmount += amount;
          }
        }
      }
    });
  } catch (e) {
    console.log('Error reading', path.basename(file), ':', e.message);
  }
});

console.log('=== Amazon Remittance Summary ===');
console.log('Total unique payments:', allPayments.size);
console.log('Total successful amount: EUR', totalAmount.toFixed(2));

// Group by year-month
const byMonth = {};
allPayments.forEach(p => {
  if (p.status === 'Successful' && p.amount > 0) {
    const parts = p.paymentDate.split('/');
    if (parts.length === 3) {
      const key = parts[2] + '-' + parts[1].padStart(2, '0');
      if (!byMonth[key]) byMonth[key] = { count: 0, total: 0 };
      byMonth[key].count++;
      byMonth[key].total += p.amount;
    }
  }
});

console.log('\n=== Payments by Month ===');
Object.entries(byMonth).sort().forEach(([month, data]) => {
  console.log(`${month}: ${data.count} payments, EUR ${data.total.toFixed(2)}`);
});

// Show sample payments
console.log('\n=== Sample Recent Payments ===');
const sorted = Array.from(allPayments.values())
  .filter(p => p.status === 'Successful' && p.amount > 0)
  .sort((a, b) => {
    const dateA = a.paymentDate.split('/').reverse().join('-');
    const dateB = b.paymentDate.split('/').reverse().join('-');
    return dateB.localeCompare(dateA);
  })
  .slice(0, 15);

sorted.forEach(p => {
  console.log(`${p.paymentDate.padEnd(12)} | Payment #${p.paymentNum.padEnd(12)} | EUR ${p.amount.toFixed(2).padStart(10)}`);
});
