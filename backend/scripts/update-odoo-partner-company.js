#!/usr/bin/env node
/**
 * Update Odoo Partner with Company Name
 *
 * Updates an Odoo partner to link them to a company based on
 * enriched SP-API data.
 *
 * Usage:
 *   node scripts/update-odoo-partner-company.js 303-2842054-9726706
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/services/odoo/OdooDirectClient');

const amazonOrderId = process.argv[2];

if (!amazonOrderId) {
  console.error('Usage: node scripts/update-odoo-partner-company.js <amazonOrderId>');
  process.exit(1);
}

async function updateOdooPartner() {
  console.log('='.repeat(60));
  console.log('Update Odoo Partner with Company Name');
  console.log('='.repeat(60));
  console.log(`Order ID: ${amazonOrderId}\n`);

  // Connect to MongoDB
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  // Find the order
  const order = await db.collection('unified_orders').findOne({
    'sourceIds.amazonOrderId': amazonOrderId
  });

  if (!order) {
    console.log('❌ Order not found in MongoDB');
    await client.close();
    return;
  }

  console.log('Order found in MongoDB:');
  console.log(`  Odoo Sale Order: ${order.sourceIds?.odooSaleOrderName || '(not created)'}`);
  console.log(`  Odoo Partner ID: ${order.customer?.odooPartnerId || '(none)'}`);
  console.log(`  Enriched Company: ${order.shippingCompanyName || '(none)'}`);
  console.log(`  Recipient Name: ${order.shippingAddress?.name || '(none)'}`);

  const partnerId = order.customer?.odooPartnerId;
  const companyName = order.shippingCompanyName;

  if (!partnerId) {
    console.log('\n❌ No Odoo partner ID found in order');
    await client.close();
    return;
  }

  if (!companyName) {
    console.log('\n❌ No company name found in enrichment data');
    await client.close();
    return;
  }

  // Connect to Odoo
  console.log('\nConnecting to Odoo...');
  const odoo = new OdooDirectClient();
  await odoo.connect();
  console.log('Connected to Odoo');

  // Get current partner data
  const partners = await odoo.read('res.partner', [partnerId], ['name', 'is_company', 'company_type', 'parent_id', 'street', 'city']);

  if (!partners || partners.length === 0) {
    console.log(`\n❌ Partner ID ${partnerId} not found in Odoo`);
    await client.close();
    return;
  }

  const partner = partners[0];
  console.log('\nCurrent Odoo partner:');
  console.log(`  ID: ${partner.id}`);
  console.log(`  Name: ${partner.name}`);
  console.log(`  Is Company: ${partner.is_company}`);
  console.log(`  Parent Company: ${partner.parent_id ? partner.parent_id[1] : '(none)'}`);
  console.log(`  Address: ${partner.street}, ${partner.city}`);

  if (partner.parent_id) {
    console.log(`\n⚠️  Partner already linked to company: ${partner.parent_id[1]}`);
    console.log('No update needed.');
    await client.close();
    return;
  }

  // Check if company already exists in Odoo
  console.log(`\nSearching for existing company "${companyName}"...`);
  const existingCompanies = await odoo.searchRead('res.partner',
    [['name', 'ilike', companyName], ['is_company', '=', true]],
    ['id', 'name']
  );

  let companyId;
  if (existingCompanies.length > 0) {
    companyId = existingCompanies[0].id;
    console.log(`Found existing company: ${existingCompanies[0].name} (ID: ${companyId})`);
  } else {
    // Create the company
    console.log(`Company not found, creating new company "${companyName}"...`);
    companyId = await odoo.create('res.partner', {
      name: companyName,
      is_company: true,
      company_type: 'company',
      customer_rank: 1
    });
    console.log(`Created new company with ID: ${companyId}`);
  }

  // Update the contact to link to the company
  console.log(`\nLinking partner ${partnerId} to company ${companyId}...`);
  await odoo.write('res.partner', [partnerId], {
    parent_id: companyId
  });

  console.log('\n' + '='.repeat(60));
  console.log('✅ SUCCESS');
  console.log('='.repeat(60));
  console.log(`Partner "${partner.name}" (ID: ${partnerId})`);
  console.log(`  → Now linked to company "${companyName}" (ID: ${companyId})`);

  await client.close();
}

updateOdooPartner().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
