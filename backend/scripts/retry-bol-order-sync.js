/**
 * Retry Bol order sync to Odoo
 * Usage: node scripts/retry-bol-order-sync.js <orderId>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BolOrderCreator = require('../src/services/bol/BolOrderCreator');

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.log('Usage: node scripts/retry-bol-order-sync.js <orderId>');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const ordersCollection = mongoose.connection.collection('bol_orders');
    const order = await ordersCollection.findOne({ orderId });

    if (!order) {
      console.log(`Order ${orderId} not found`);
      process.exit(1);
    }

    console.log(`Order found: ${order.orderId}`);
    console.log(`Current Odoo ID: ${order.odoo?.id || 'none'}`);
    console.log(`Sync error: ${order.odoo?.syncError || 'none'}`);

    const creator = new BolOrderCreator();
    const result = await creator.createOrLink(order);
    console.log('Result:', JSON.stringify(result, null, 2));

    // Check the order again
    const updatedOrder = await ordersCollection.findOne({ orderId });
    console.log(`\nAfter sync:`);
    console.log(`Odoo ID: ${updatedOrder.odoo?.id || 'none'}`);
    console.log(`Sync error: ${updatedOrder.odoo?.syncError || 'none'}`);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.data) {
      console.error('Error data:', JSON.stringify(error.data, null, 2));
    }
    process.exit(1);
  }
}

main();
