#!/usr/bin/env node
/**
 * Test script for AddressCleanerAI
 *
 * Tests Claude Sonnet 4.5 address parsing with real Amazon FBM order data
 *
 * Usage: node scripts/test-address-cleaner-ai.js
 */

require('dotenv').config();
const { getAddressCleanerAI } = require('../src/services/amazon/seller/AddressCleanerAI');

// Test addresses from real Amazon data showing typical inconsistencies
const testAddresses = [
  // Case 1: Company name in address-1, street in address-2
  {
    recipientName: 'Joanna Zielinski',
    addressLine1: 'Drk Schwesternschaft Hamburg Bildungszentrum Schlump Ggmbh',
    addressLine2: 'Beim Schlump 86',
    addressLine3: '',
    city: 'Hamburg',
    postalCode: '20144',
    countryCode: 'DE',
    buyerName: '',
    buyerCompanyName: ''
  },

  // Case 2: PO number concatenated with recipient name
  {
    recipientName: 'Klauck BenediktPOOPB',
    addressLine1: 'Merziger Straße 3',
    addressLine2: '',
    addressLine3: '',
    city: 'Losheim Am See',
    postalCode: '66679',
    countryCode: 'DE',
    buyerName: '',
    buyerCompanyName: ''
  },

  // Case 3: Company with department in address-1, street in address-2
  {
    recipientName: 'Mara Mueller',
    addressLine1: 'Farben Schultze GmbH & Co. KG Niederlassung CYA Gerichshain',
    addressLine2: 'Zweenfurther Straße 1',
    addressLine3: '',
    city: 'Gerichshain',
    postalCode: '04827',
    countryCode: 'DE',
    buyerName: 'Amazon Business EU SARL',
    buyerCompanyName: 'Farben Schultze GmbH & Co. KG'
  },

  // Case 4: Normal B2C order (no issues)
  {
    recipientName: 'Hans Schmidt',
    addressLine1: 'Hauptstraße 15',
    addressLine2: '',
    addressLine3: '',
    city: 'Berlin',
    postalCode: '10115',
    countryCode: 'DE',
    buyerName: 'Hans Schmidt',
    buyerCompanyName: ''
  },

  // Case 5: Austrian business order
  {
    recipientName: 'Peter Heinreich',
    addressLine1: 'Waldgasse 2',
    addressLine2: '',
    addressLine3: '',
    city: 'Kobersdorf',
    postalCode: '7332',
    countryCode: 'AT',
    buyerName: '',
    buyerCompanyName: 'Baumeister Peter Heinreich, Ing.'
  },

  // Case 6: French address with attention info
  {
    recipientName: 'Morteau Anaïs',
    addressLine1: '33, Boulevard Tisseron',
    addressLine2: 'Easy-delivery 411QVT',
    addressLine3: '',
    city: 'Marseille',
    postalCode: '13014',
    countryCode: 'FR',
    buyerName: '',
    buyerCompanyName: ''
  }
];

async function runTests() {
  console.log('=== Testing AddressCleanerAI with Claude Sonnet 4.5 ===\n');

  const cleaner = getAddressCleanerAI();

  for (let i = 0; i < testAddresses.length; i++) {
    const raw = testAddresses[i];
    console.log(`\n--- Test Case ${i + 1} ---`);
    console.log('INPUT:');
    console.log(`  recipient-name: "${raw.recipientName}"`);
    console.log(`  ship-address-1: "${raw.addressLine1}"`);
    console.log(`  ship-address-2: "${raw.addressLine2}"`);
    console.log(`  ship-city: "${raw.city}"`);
    console.log(`  ship-postal-code: "${raw.postalCode}"`);
    console.log(`  ship-country: "${raw.countryCode}"`);
    if (raw.buyerCompanyName) {
      console.log(`  buyer-company-name: "${raw.buyerCompanyName}"`);
    }

    try {
      const result = await cleaner.cleanAddress(raw);

      console.log('\nOUTPUT:');
      console.log(`  Company: ${result.company || '(none)'}`);
      console.log(`  Contact: ${result.name || '(none)'}`);
      console.log(`  Street: ${result.street || '(none)'}`);
      console.log(`  Street2: ${result.street2 || '(none)'}`);
      console.log(`  ZIP: ${result.zip}`);
      console.log(`  City: ${result.city}`);
      console.log(`  Country: ${result.country}`);
      console.log(`  Is Business: ${result.isCompany}`);
      if (result.poNumber) {
        console.log(`  PO Number: ${result.poNumber}`);
      }
      console.log(`  Confidence: ${result.confidence}`);
      if (result.notes) {
        console.log(`  Notes: ${result.notes}`);
      }

    } catch (error) {
      console.error('ERROR:', error.message);
    }

    // Rate limiting - wait 500ms between calls
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== Tests Complete ===\n');
}

runTests().catch(console.error);
