#!/usr/bin/env node
/**
 * Import Amazon Vendor Party Mappings from Odoo
 *
 * This script reads all "Amazon EU SARL {partyId}" partners from Odoo
 * and imports them into the vendor_party_mapping MongoDB collection.
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { MongoClient } = require('mongodb');

async function importMappings() {
  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  const collection = db.collection('vendor_party_mapping');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find Amazon EU SARL partners
  const partners = await odoo.searchRead('res.partner',
    [['name', 'ilike', 'Amazon EU SARL']],
    ['id', 'name', 'vat', 'street', 'street2', 'city', 'zip', 'country_id', 'ref', 'parent_id'],
    { limit: 200 }
  );

  console.log('Found', partners.length, 'Amazon partners in Odoo');

  // Regex to extract party ID (3-5 alphanumeric chars at end of name)
  const partyIdRegex = /Amazon\s+EU\s+S[àa]rl\s+([A-Z0-9]{3,5})$/i;

  const mappings = [];
  const skipped = [];

  for (const p of partners) {
    const match = p.name.match(partyIdRegex);
    if (match) {
      const partyId = match[1].toUpperCase();

      // Build address string
      const addressParts = [
        p.street,
        p.street2,
        [p.zip, p.city].filter(Boolean).join(' ')
      ].filter(Boolean);

      mappings.push({
        partyId,
        partyType: 'shipTo',
        marketplace: null, // Will be determined from orders
        odooPartnerId: p.id,
        odooPartnerName: p.name,
        vatNumber: p.vat || null,
        address: addressParts.join(', ') || null,
        country: p.country_id ? p.country_id[1] : null,
        notes: 'Imported from Emipro vendor partner',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    } else {
      // Skipped - no party ID in name (parent companies like "Amazon EU SARL France")
      const parentPatterns = ['France', 'Deutschland', 'Pologne', 'CZECH', 'Espana', 'Italian', 'NETHERLANDS', 'Kingdom', 'vendor'];
      const isParent = parentPatterns.some(pat => p.name.includes(pat));
      if (!isParent && p.name !== 'Amazon EU SARL' && p.name !== 'amazon EU SARL') {
        skipped.push(p.name);
      }
    }
  }

  console.log('\nMappings to import:', mappings.length);
  if (skipped.length > 0) {
    console.log('\nSkipped (no party ID pattern):', skipped);
  }

  // Show what we found
  console.log('\nParty IDs found:');
  mappings.forEach(m => console.log(`  ${m.partyId} -> ${m.odooPartnerName} (Odoo ID: ${m.odooPartnerId})`));

  // Insert mappings
  let inserted = 0;
  let updated = 0;
  for (const m of mappings) {
    try {
      const result = await collection.updateOne(
        { partyId: m.partyId },
        {
          $set: { ...m, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
      if (result.upsertedCount > 0) inserted++;
      else if (result.modifiedCount > 0) updated++;
    } catch (e) {
      console.error('Failed to insert', m.partyId, e.message);
    }
  }

  console.log('\n=== Import Complete ===');
  console.log('  Inserted:', inserted);
  console.log('  Updated:', updated);
  console.log('  Total mappings now:', await collection.countDocuments({ active: true }));

  // Show sample mappings
  const samples = await collection.find({}).sort({ partyId: 1 }).limit(10).toArray();
  console.log('\nSample mappings in database:');
  samples.forEach(s => console.log(`  ${s.partyId} -> ${s.odooPartnerName} | VAT: ${s.vatNumber || 'none'}`));

  await mongoClient.close();
}

importMappings().catch(console.error);
