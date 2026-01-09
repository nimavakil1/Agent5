/**
 * Fix addresses on existing orders using AddressCleanerAI
 *
 * Usage: node scripts/fix-addresses-with-ai.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { getAddressCleanerAI } = require('../src/services/amazon/seller/AddressCleanerAI');

const ORDER_NAMES = ['S15293', 'S15294', 'S15295', 'S15296', 'S15297', 'S15298', 'S15299', 'S15300', 'S15301', 'S15302', 'S15303'];

async function main() {
  // Connect
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  const cleaner = getAddressCleanerAI();

  console.log('Connected to MongoDB and Odoo\n');

  // Get orders from Odoo
  const orders = await odoo.searchRead('sale.order',
    [['name', 'in', ORDER_NAMES]],
    ['name', 'client_order_ref', 'partner_id', 'partner_shipping_id']
  );

  console.log(`Processing ${orders.length} orders...\n`);

  // Get TSV data from MongoDB
  const amazonOrderIds = orders.map(o => o.client_order_ref);
  const unifiedOrders = await db.collection('unified_orders').find({
    'sourceIds.amazonOrderId': { $in: amazonOrderIds }
  }).toArray();

  // Create lookup
  const tsvDataByAmazonId = {};
  for (const uo of unifiedOrders) {
    tsvDataByAmazonId[uo.sourceIds?.amazonOrderId] = uo;
  }

  let updated = 0;
  let skipped = 0;

  // Process each order
  for (const order of orders) {
    const amazonId = order.client_order_ref;
    const tsvData = tsvDataByAmazonId[amazonId];

    console.log(`=== ${order.name} (${amazonId}) ===`);

    if (!tsvData) {
      console.log('  SKIP: No TSV data found in MongoDB');
      skipped++;
      continue;
    }

    // Prepare address for AI
    const rawAddress = {
      recipientName: tsvData.shippingAddress?.name || '',
      addressLine1: tsvData.shippingAddress?.addressLine1 || '',
      addressLine2: tsvData.shippingAddress?.addressLine2 || '',
      addressLine3: tsvData.shippingAddress?.addressLine3 || '',
      city: tsvData.shippingAddress?.city || '',
      postalCode: tsvData.shippingAddress?.postalCode || '',
      countryCode: tsvData.shippingAddress?.countryCode || '',
      buyerName: tsvData.buyerInfo?.name || '',
      buyerCompanyName: tsvData.buyerInfo?.companyName || '',
      isBusinessOrder: tsvData.isBusinessOrder || false
    };

    console.log(`  Input: recipientName="${rawAddress.recipientName}"`);
    console.log(`         address1="${rawAddress.addressLine1}"`);
    console.log(`         buyerName="${rawAddress.buyerName}"`);
    console.log(`         buyerCompanyName="${rawAddress.buyerCompanyName}"`);

    // Run AI cleaner
    const cleaned = await cleaner.cleanAddress(rawAddress);
    console.log(`  AI Result:`);
    console.log(`    company: ${cleaned.company}`);
    console.log(`    name: ${cleaned.name}`);
    console.log(`    street: ${cleaned.street}`);
    console.log(`    street2: ${cleaned.street2}`);
    console.log(`    isCompany: ${cleaned.isCompany}`);
    console.log(`    confidence: ${cleaned.confidence}`);
    if (cleaned.notes) console.log(`    notes: ${cleaned.notes}`);

    // Get current partner data
    const partnerId = order.partner_id[0];
    const shippingId = order.partner_shipping_id[0];

    const [partner] = await odoo.searchRead('res.partner', [['id', '=', partnerId]], ['name', 'is_company']);
    const [shipping] = await odoo.searchRead('res.partner', [['id', '=', shippingId]], ['name', 'street', 'street2', 'city', 'zip']);

    console.log(`  Current Odoo:`);
    console.log(`    Partner: "${partner.name}" (company=${partner.is_company})`);
    console.log(`    Shipping: "${shipping.name}" at "${shipping.street}"`);

    // Determine new customer name
    const newCustomerName = cleaned.company || cleaned.name || partner.name;
    const newIsCompany = cleaned.isCompany || !!cleaned.company;

    // Determine delivery contact name
    const newDeliveryName = newIsCompany && cleaned.company
      ? (cleaned.name || tsvData.shippingAddress?.name || shipping.name)
      : (cleaned.name || shipping.name);

    // Update parent customer if name changed
    if (partner.name !== newCustomerName || partner.is_company !== newIsCompany) {
      console.log(`  UPDATE Partner: "${partner.name}" -> "${newCustomerName}" (company=${newIsCompany})`);
      await odoo.write('res.partner', [partnerId], {
        name: newCustomerName,
        is_company: newIsCompany,
        company_type: newIsCompany ? 'company' : 'person'
      });
    }

    // Update shipping address
    const shipUpdates = {};
    if (shipping.name !== newDeliveryName) shipUpdates.name = newDeliveryName;
    if (cleaned.street && shipping.street !== cleaned.street) shipUpdates.street = cleaned.street;
    if (cleaned.street2 !== undefined && shipping.street2 !== (cleaned.street2 || false)) {
      shipUpdates.street2 = cleaned.street2 || false;
    }
    if (cleaned.city && shipping.city !== cleaned.city) shipUpdates.city = cleaned.city;
    if (cleaned.zip && shipping.zip !== cleaned.zip) shipUpdates.zip = cleaned.zip;

    if (Object.keys(shipUpdates).length > 0) {
      console.log(`  UPDATE Shipping:`, shipUpdates);
      await odoo.write('res.partner', [shippingId], shipUpdates);
    } else {
      console.log(`  Shipping address unchanged`);
    }

    updated++;
    console.log(`  DONE\n`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
