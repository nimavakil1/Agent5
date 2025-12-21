/**
 * Import Amazon SKU Mappings to MongoDB
 *
 * This script:
 * 1. Reads parsed mappings from data/amazon-sku-mappings.json
 * 2. Filters out mappings that can be auto-resolved by SkuResolver
 * 3. Imports only custom mappings that need manual resolution
 * 4. Adds the return pattern for Amazon return SKUs
 *
 * Usage: node scripts/import-amazon-sku-mappings.js
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Simulate SkuResolver logic to determine if mapping can be auto-resolved
function canAutoResolve(amazonSku, odooSku) {
  let sku = amazonSku.trim();
  const upper = sku.toUpperCase();

  // Strip FBM/FBMA suffixes
  if (upper.endsWith('-FBMA')) {
    sku = sku.slice(0, -5);
  } else if (upper.endsWith('-FBM')) {
    sku = sku.slice(0, -4);
  }

  // Strip common suffixes
  const suffixesToStrip = ['-stickerless', '-stickered', '-bundle', '-new', '-refurb'];
  for (const suffix of suffixesToStrip) {
    if (sku.toLowerCase().endsWith(suffix)) {
      sku = sku.slice(0, -suffix.length);
      break;
    }
  }

  // Strip trailing "A" only (only for 5-digit SKUs with trailing A)
  // e.g., "01023A" → "01023", but NOT "10005B" (B is a color code)
  if (/^[0-9]{5}A$/i.test(sku)) {
    sku = sku.slice(0, -1);
  }

  // Pad with leading zeros for numeric SKUs
  if (/^[0-9]{1,4}$/.test(sku)) {
    sku = sku.padStart(5, '0');
  }

  // Compare with expected Odoo SKU (case-insensitive)
  return sku.toUpperCase() === odooSku.toUpperCase();
}

async function main() {
  console.log('=== Amazon SKU Mappings Import ===\n');

  // Read parsed mappings
  const mappingsPath = path.join(__dirname, '../data/amazon-sku-mappings.json');
  const allMappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf-8'));

  console.log(`Total mappings in file: ${allMappings.length}`);

  // Analyze mappings
  const autoResolvable = [];
  const needsCustomMapping = [];
  const problematic = [];

  for (const m of allMappings) {
    // Skip problematic entries (like the Dutch text one)
    if (m.amazonSku.length > 50 || m.amazonSku.includes(' ')) {
      problematic.push(m);
      continue;
    }

    if (canAutoResolve(m.amazonSku, m.odooSku)) {
      autoResolvable.push(m);
    } else {
      needsCustomMapping.push(m);
    }
  }

  console.log(`Auto-resolvable (no mapping needed): ${autoResolvable.length}`);
  console.log(`Needs custom mapping: ${needsCustomMapping.length}`);
  console.log(`Problematic (skipped): ${problematic.length}`);

  if (problematic.length > 0) {
    console.log('\nProblematic entries:');
    problematic.forEach(p => console.log(`  - "${p.amazonSku.substring(0, 40)}..." -> "${p.odooSku}"`));
  }

  console.log('\nCustom mappings to import:');
  needsCustomMapping.forEach(m => console.log(`  - "${m.amazonSku}" -> "${m.odooSku}"`));

  // Connect to MongoDB
  console.log('\nConnecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  // Import custom mappings
  if (needsCustomMapping.length > 0) {
    console.log('\nImporting custom mappings...');
    const operations = needsCustomMapping.map(m => ({
      updateOne: {
        filter: { amazonSku: m.amazonSku.toUpperCase() },
        update: {
          $set: {
            amazonSku: m.amazonSku.toUpperCase(),
            odooSku: m.odooSku,
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        upsert: true
      }
    }));

    const result = await db.collection('amazon_sku_mappings').bulkWrite(operations);
    console.log(`  Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);
  }

  // Add return pattern
  console.log('\nAdding return pattern...');
  const returnPattern = {
    pattern: 'amzn\\.gr\\.([A-Z0-9.]+)-',  // Captures SKU like P0213 or B42030.A
    extractGroup: 1,
    flags: 'i'
  };

  await db.collection('amazon_config').updateOne(
    { type: 'sku_patterns' },
    {
      $set: {
        returnPatterns: [returnPattern],
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
  console.log(`  Return pattern added: /${returnPattern.pattern}/${returnPattern.flags}`);

  // Summary
  const mappingCount = await db.collection('amazon_sku_mappings').countDocuments();
  const config = await db.collection('amazon_config').findOne({ type: 'sku_patterns' });

  console.log('\n=== Summary ===');
  console.log(`Total custom mappings in DB: ${mappingCount}`);
  console.log(`Return patterns configured: ${config?.returnPatterns?.length || 0}`);

  await client.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
