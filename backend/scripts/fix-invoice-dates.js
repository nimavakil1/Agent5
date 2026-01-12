require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

// Parse CSV helper
function parseCSV(content) {
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = values[idx] || '');
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += char;
  }
  result.push(current.trim());
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Determine correct invoice date based on accounting period closure
function getCorrectInvoiceDate(shipmentDate) {
  if (!shipmentDate) return '2025-12-01';

  // Parse VCS date format: "12-Nov-2025 UTC" or similar
  const date = new Date(shipmentDate);
  if (isNaN(date.getTime())) return '2025-12-01';

  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed (0=Jan, 11=Dec)

  // December 2025 → 31/12/2025
  if (year === 2025 && month === 11) {
    return '2025-12-31';
  }

  // January 2026 or later → keep as is (current period)
  if (year >= 2026) {
    return date.toISOString().split('T')[0];
  }

  // November 2025 or earlier → 01/12/2025
  return '2025-12-01';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  console.log('=== FIX INVOICE DATES ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('');
  console.log('Rules:');
  console.log('  - December 2025 shipments → 31/12/2025');
  console.log('  - November 2025 and earlier → 01/12/2025');
  console.log('  - January 2026+ → actual date\n');

  // Load VCS data for shipment dates
  const vcsFiles = [
    '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b.csv',
    '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0.csv'
  ];

  const vcsShipDates = new Map();
  for (const file of vcsFiles) {
    console.log('Loading: ' + file.split('/').pop());
    const rows = parseCSV(fs.readFileSync(file, 'utf-8'));
    for (const row of rows) {
      const orderId = row['Order ID'];
      const shipDate = row['Shipment Date'];
      if (orderId && shipDate && !vcsShipDates.has(orderId)) {
        vcsShipDates.set(orderId, shipDate);
      }
    }
  }
  console.log('VCS shipment dates loaded: ' + vcsShipDates.size + '\n');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find invoices we created (have FBA/FBM in invoice_origin and dated 2026-01-11)
  console.log('Finding invoices with FBA/FBM orders dated 2026-01-11...');

  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '=', '2026-01-11'],
      '|',
      ['invoice_origin', 'like', 'FBA%'],
      ['invoice_origin', 'like', 'FBM%']
    ],
    ['id', 'name', 'ref', 'invoice_date', 'invoice_origin', 'amount_total'],
    { limit: 5000 }
  );

  console.log('Found ' + invoices.length + ' invoices to fix\n');

  // Categorize by correct date
  const byDate = {
    '2025-12-01': [],
    '2025-12-31': [],
    'current': []
  };

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const inv of invoices) {
    // Extract Amazon order ID from invoice_origin (e.g., "404-8183028-7922726" from "FBA404-8183028-7922726")
    const amazonId = inv.invoice_origin?.replace(/^FBA|^FBM/, '');
    const shipDate = vcsShipDates.get(amazonId);
    const correctDate = getCorrectInvoiceDate(shipDate);

    if (correctDate === '2025-12-01') byDate['2025-12-01'].push(inv);
    else if (correctDate === '2025-12-31') byDate['2025-12-31'].push(inv);
    else byDate['current'].push(inv);

    // Check if update needed
    if (inv.invoice_date === correctDate) {
      skipped++;
      continue;
    }

    if (updated < 20) {
      console.log(inv.name + ' (' + inv.invoice_origin + '): ' + inv.invoice_date + ' → ' + correctDate + ' (ship: ' + (shipDate || 'unknown') + ')');
    }

    if (!dryRun) {
      try {
        await sleep(50);

        // Need to reset to draft, update date, then repost
        // button_draft returns None which causes XML-RPC marshaling error, but action succeeds
        try {
          await odoo.execute('account.move', 'button_draft', [[inv.id]]);
        } catch (e) {
          // Ignore "cannot marshal None" error - the action succeeded on Odoo side
          if (!e.message.includes('cannot marshal None')) {
            throw e;
          }
        }

        await odoo.execute('account.move', 'write', [[inv.id], { invoice_date: correctDate }]);
        await odoo.execute('account.move', 'action_post', [[inv.id]]);

        updated++;
      } catch (err) {
        if (errors < 10) {
          console.log(inv.name + ': ERROR - ' + err.message);
        }
        errors++;
      }
    } else {
      updated++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Invoices to date 01/12/2025: ' + byDate['2025-12-01'].length);
  console.log('Invoices to date 31/12/2025: ' + byDate['2025-12-31'].length);
  console.log('Invoices keeping current date: ' + byDate['current'].length);
  console.log('');
  console.log('Updated: ' + updated);
  console.log('Skipped (already correct): ' + skipped);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to update dates.');
  }
}

main().catch(e => console.error(e));
