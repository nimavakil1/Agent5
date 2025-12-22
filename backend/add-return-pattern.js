require('dotenv').config();
const { connectDb, getDb } = require('./src/db');

async function addPattern() {
  await connectDb(process.env.MONGO_URI);
  const db = getDb();

  // Add return pattern for amzn.gr. SKUs
  // Pattern: amzn.gr.[base-sku]-[random-suffix]
  // The random suffix contains underscores, letters, and numbers
  const pattern = '^amzn\\.gr\\.(.+?)-[_A-Za-z0-9]{8,}';

  await db.collection('amazon_config').updateOne(
    { type: 'sku_patterns' },
    {
      $set: {
        returnPatterns: [
          { pattern: pattern, extractGroup: 1, flags: 'i' }
        ],
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  console.log('Added return pattern:', pattern);

  // Verify
  const config = await db.collection('amazon_config').findOne({ type: 'sku_patterns' });
  console.log('Current config:', JSON.stringify(config, null, 2));

  // Test the pattern
  const testSku = 'amzn.gr.P0181-FBM-_q7pkYlp4PatZk09iTg-LN';
  const regex = new RegExp(pattern, 'i');
  const match = testSku.match(regex);
  console.log('\nTest SKU:', testSku);
  console.log('Match:', match);
  if (match) {
    console.log('Extracted base:', match[1]);
  }

  process.exit(0);
}
addPattern();
