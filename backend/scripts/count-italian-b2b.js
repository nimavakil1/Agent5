#!/usr/bin/env node
/**
 * Count Italian domestic B2B orders
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DB_NAME || 'agent5');

  try {
    // Count Italian domestic B2B orders (IT->IT with buyer VAT registration)
    const domesticB2B = await db.collection('amazon_vcs_orders').countDocuments({
      shipFromCountry: 'IT',
      shipToCountry: 'IT',
      buyerTaxRegistration: { $exists: true, $ne: '' }
    });

    console.log('Italian domestic B2B orders (IT->IT with buyer VAT):', domesticB2B);

    // Breakdown of all Italian orders
    const italianOrders = await db.collection('amazon_vcs_orders').aggregate([
      { $match: { shipFromCountry: 'IT' } },
      {
        $group: {
          _id: {
            shipTo: '$shipToCountry',
            hasBuyerVat: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$buyerTaxRegistration', ''] } }, 0] }, 'B2B', 'B2C'] }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    console.log('\nAll Italian FBA orders breakdown:');
    console.log('Route  | Type | Orders');
    console.log('-------|------|-------');
    italianOrders.forEach(r => {
      console.log(`IT->${r._id.shipTo.padEnd(2)} | ${r._id.hasBuyerVat}  | ${r.count}`);
    });

    // Total
    const totalIT = italianOrders.reduce((sum, r) => sum + r.count, 0);
    console.log('\nTotal Italian FBA orders:', totalIT);

  } finally {
    await mongo.close();
  }
}

main().catch(console.error);
