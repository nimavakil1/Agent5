/**
 * Check all Amazon-related invoices in Odoo (not just Claude AI created)
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function checkInvoices() {
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });

  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Find all invoices with invoice_origin starting with FBA or FBM
  const amazonInvoices = await odoo.searchRead('account.move',
    [
      '|',
      ['invoice_origin', '=like', 'FBA%'],
      ['invoice_origin', '=like', 'FBM%'],
    ],
    ['id', 'name', 'state', 'invoice_origin', 'amount_total', 'create_uid', 'create_date'],
    0, 0, 'id desc'
  );

  console.log('\nTotal Amazon invoices (FBA/FBM origin):', amazonInvoices.length);

  // Group by create_uid
  const byUser = {};
  for (const inv of amazonInvoices) {
    const userName = inv.create_uid ? inv.create_uid[1] : 'Unknown';
    if (!byUser[userName]) {
      byUser[userName] = [];
    }
    byUser[userName].push(inv);
  }

  console.log('\n=== Invoices by User ===');
  for (const [user, invs] of Object.entries(byUser)) {
    console.log(`  ${user}: ${invs.length} invoices`);
  }

  // Check for duplicates by invoice_origin
  const byOrigin = {};
  for (const inv of amazonInvoices) {
    const origin = inv.invoice_origin;
    if (!byOrigin[origin]) {
      byOrigin[origin] = [];
    }
    byOrigin[origin].push(inv);
  }

  let duplicateCount = 0;
  const duplicateDetails = [];
  for (const [origin, invs] of Object.entries(byOrigin)) {
    if (invs.length > 1) {
      duplicateCount += invs.length;
      duplicateDetails.push({ origin, invoices: invs });
    }
  }

  console.log('\n=== Duplicate Analysis ===');
  console.log('Total unique origins:', Object.keys(byOrigin).length);
  console.log('Origins with duplicates:', duplicateDetails.length);
  console.log('Total duplicate invoices:', duplicateCount);

  if (duplicateDetails.length > 0) {
    console.log('\n=== Duplicate Details ===');
    for (const { origin, invoices } of duplicateDetails.slice(0, 20)) {
      console.log(`\n${origin}:`);
      for (const inv of invoices) {
        console.log(`  ID: ${inv.id}, Name: ${inv.name}, State: ${inv.state}, Created by: ${inv.create_uid[1]}, Amount: ${inv.amount_total}`);
      }
    }
  }

  // Show recent invoices
  console.log('\n=== Recent Amazon Invoices (last 20) ===');
  for (const inv of amazonInvoices.slice(0, 20)) {
    console.log(`${inv.id} | ${inv.name} | ${inv.state} | ${inv.invoice_origin} | ${inv.create_uid[1]} | €${inv.amount_total}`);
  }
}

checkInvoices().catch(console.error);
