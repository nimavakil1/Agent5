#!/usr/bin/env node
/**
 * Check which orders have generic names and whether MongoDB has real data
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await client.connect();
  const db = client.db();

  const orderIds = [
    '304-0991639-1563523',
    '306-9077674-2736349',
    '304-5646642-1021167',
    '303-7203959-9919565',
    '404-4746136-9718750',
    '404-2184358-2141908',
    '303-0052988-6672344',
    '302-4416259-1969902',
    '171-8006151-9140340',
    '028-8103139-7171525',
    '028-0584276-1072348'
  ];

  console.log('Checking MongoDB for real customer data:\n');

  for (const id of orderIds) {
    const order = await db.collection('seller_orders').findOne({ amazonOrderId: id });
    if (order) {
      const name = order.buyerName || order.shippingAddress?.name || '(none)';
      const addr = order.shippingAddress;
      const hasRealName = name && !name.includes('Amazon Customer') && !name.includes('Amazon |');
      const hasRealAddr = addr && addr.addressLine1 && addr.addressLine1 !== 'null';
      console.log(id);
      console.log('  Name:', name.substring(0, 50), hasRealName ? '[REAL]' : '[GENERIC]');
      console.log('  Addr:', (addr && addr.addressLine1) || '(none)', hasRealAddr ? '[REAL]' : '[MISSING]');
      console.log('');
    } else {
      console.log(id, '- NOT FOUND in MongoDB');
    }
  }

  await client.close();
}

check().catch(console.error);
