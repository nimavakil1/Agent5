/**
 * Standalone script to update invoice_url field in Odoo for VCS invoiced orders
 *
 * Usage: node scripts/update-odoo-invoice-urls.js
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP.js');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

async function main() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();

  console.log('Connecting to Odoo...');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo as UID:', odoo.client.uid);

  // Find all invoiced orders with invoice URLs
  const orders = await db.collection('amazon_vcs_orders')
    .find({
      status: 'invoiced',
      invoiceUrl: { $exists: true, $ne: null, $ne: '' },
      odooInvoiceId: { $exists: true, $ne: null }
    })
    .toArray();

  console.log(`Found ${orders.length} invoiced orders with invoice URLs to update`);

  if (orders.length === 0) {
    console.log('No orders to update');
    await client.close();
    return;
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const progress = `[${i + 1}/${orders.length}]`;

    try {
      // Check if the invoice exists and already has the URL
      const invoice = await odoo.searchRead('account.move',
        [['id', '=', order.odooInvoiceId]],
        ['id', 'name', 'invoice_url']
      );

      if (invoice.length === 0) {
        console.log(`${progress} Invoice ID ${order.odooInvoiceId} not found - skipping`);
        skipped++;
        continue;
      }

      if (invoice[0].invoice_url === order.invoiceUrl) {
        console.log(`${progress} ${invoice[0].name} already has correct URL - skipping`);
        skipped++;
        continue;
      }

      // Update the invoice with the URL
      await odoo.write('account.move', [order.odooInvoiceId], {
        invoice_url: order.invoiceUrl
      });

      console.log(`${progress} Updated ${invoice[0].name} with invoice URL`);
      updated++;

      // Small delay to avoid overwhelming Odoo
      await new Promise(resolve => setTimeout(resolve, 50));

    } catch (error) {
      console.error(`${progress} Error updating order ${order.amazonOrderId}:`, error.message);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total: ${orders.length}`);

  await client.close();
}

main().catch(console.error);
