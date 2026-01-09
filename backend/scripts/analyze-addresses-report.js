#!/usr/bin/env node
/**
 * Analyze addresses from TSV file and create comparison report
 */

require('dotenv').config();
const fs = require('fs');
const { getAddressCleanerAI } = require('../src/services/amazon/seller/AddressCleanerAI');

// Orders to analyze
const targetOrders = [
  '304-2147471-2782732',
  '403-3288756-5818749',
  '404-7110722-7736332',
  '028-6774440-1165947',
  '405-4356015-5274747',
  '028-1750481-7585166',
  '303-5137084-8236354',
  '405-9630993-5327557',
  '407-6121639-9865962'
];

// TSV file path
const tsvPath = '/Users/nimavakil/Downloads/131946386074020461.txt';

function parseTSV(content) {
  const lines = content.split('\n');
  const headers = lines[0].split('\t');
  const orders = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = lines[i].split('\t');
    const order = {};
    headers.forEach((header, idx) => {
      order[header] = values[idx] || '';
    });
    orders.push(order);
  }
  return orders;
}

async function analyzeAddresses() {
  console.log('='.repeat(80));
  console.log('ADDRESS ANALYSIS REPORT - AI vs Original Structure');
  console.log('='.repeat(80));
  console.log(`\nFile: ${tsvPath}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('='.repeat(80));

  // Read and parse TSV
  const content = fs.readFileSync(tsvPath, 'utf8');
  const allOrders = parseTSV(content);

  // Filter target orders
  const orders = allOrders.filter(o => targetOrders.includes(o['order-id']));
  console.log(`\nFound ${orders.length} of ${targetOrders.length} target orders\n`);

  const cleaner = getAddressCleanerAI();
  const results = [];

  for (const order of orders) {
    const orderId = order['order-id'];
    console.log('\n' + '─'.repeat(80));
    console.log(`ORDER: ${orderId}`);
    console.log('─'.repeat(80));

    // Extract original address fields
    const original = {
      recipientName: order['recipient-name'] || '',
      addressLine1: order['ship-address-1'] || '',
      addressLine2: order['ship-address-2'] || '',
      addressLine3: order['ship-address-3'] || '',
      city: order['ship-city'] || '',
      state: order['ship-state'] || '',
      postalCode: order['ship-postal-code'] || '',
      countryCode: order['ship-country'] || '',
      buyerName: order['buyer-name'] || '',
      buyerCompanyName: order['buyer-company-name'] || '',
      purchaseOrderNumber: order['purchase-order-number'] || '',
      addressType: order['address-type'] || '',
      isBusinessOrder: order['is-business-order'] === 'true'
    };

    console.log('\n📥 ORIGINAL TSV DATA:');
    console.log(`   recipient-name:     "${original.recipientName}"`);
    console.log(`   ship-address-1:     "${original.addressLine1}"`);
    console.log(`   ship-address-2:     "${original.addressLine2}"`);
    if (original.addressLine3) {
      console.log(`   ship-address-3:     "${original.addressLine3}"`);
    }
    console.log(`   ship-city:          "${original.city}"`);
    if (original.state) {
      console.log(`   ship-state:         "${original.state}"`);
    }
    console.log(`   ship-postal-code:   "${original.postalCode}"`);
    console.log(`   ship-country:       "${original.countryCode}"`);
    console.log(`   buyer-name:         "${original.buyerName}"`);
    console.log(`   buyer-company-name: "${original.buyerCompanyName}"`);
    if (original.purchaseOrderNumber) {
      console.log(`   purchase-order-no:  "${original.purchaseOrderNumber}"`);
    }
    console.log(`   address-type:       "${original.addressType}"`);
    console.log(`   is-business-order:  ${original.isBusinessOrder}`);

    // Run through AI cleaner
    try {
      const cleaned = await cleaner.cleanAddress(original);

      console.log('\n🤖 AI CLEANED OUTPUT:');
      console.log(`   Company:      ${cleaned.company || '(none)'}`);
      console.log(`   Name:         ${cleaned.name || '(none)'}`);
      console.log(`   Street:       ${cleaned.street || '(none)'}`);
      console.log(`   Street2:      ${cleaned.street2 || '(none)'}`);
      console.log(`   ZIP:          ${cleaned.zip || '(none)'}`);
      console.log(`   City:         ${cleaned.city || '(none)'}`);
      console.log(`   State:        ${cleaned.state || '(none)'}`);
      console.log(`   Country:      ${cleaned.country || '(none)'}`);
      console.log(`   Is Business:  ${cleaned.isCompany}`);
      if (cleaned.poNumber) {
        console.log(`   PO Number:    ${cleaned.poNumber}`);
      }
      console.log(`   Confidence:   ${cleaned.confidence}`);
      if (cleaned.notes) {
        console.log(`   Notes:        ${cleaned.notes}`);
      }

      // Analysis of changes
      console.log('\n📊 ANALYSIS:');
      const changes = [];

      // Check if company was detected in address-1
      if (cleaned.company && original.addressLine1 &&
          original.addressLine1.toLowerCase().includes(cleaned.company.toLowerCase().split(' ')[0])) {
        changes.push('Company name was in address-1 (moved to company field)');
      }

      // Check if street was in address-2
      if (cleaned.street && original.addressLine2 &&
          original.addressLine2.toLowerCase().includes(cleaned.street.toLowerCase().split(' ')[0])) {
        changes.push('Street was in address-2 (moved to street field)');
      }

      // Check if PO was extracted from name
      if (cleaned.poNumber && original.recipientName.includes('PO')) {
        changes.push(`PO number "${cleaned.poNumber}" extracted from recipient name`);
      }

      // Check if Amazon Business was filtered
      if (original.buyerName.includes('Amazon Business') && !cleaned.name?.includes('Amazon Business')) {
        changes.push('Amazon Business EU SARL filtered as billing intermediary');
      }

      // Check for name order correction
      if (cleaned.name && original.recipientName) {
        const originalParts = original.recipientName.replace(/PO.*/, '').trim().split(/\s+/);
        const cleanedParts = (cleaned.name || '').split(/\s+/);
        if (originalParts.length >= 2 && cleanedParts.length >= 2) {
          if (originalParts[0] !== cleanedParts[0] && originalParts[1] === cleanedParts[0]) {
            changes.push('Name order corrected (Last First → First Last)');
          }
        }
      }

      if (changes.length === 0) {
        changes.push('No significant restructuring needed');
      }

      changes.forEach(c => console.log(`   • ${c}`));

      results.push({
        orderId,
        original,
        cleaned,
        changes
      });

    } catch (error) {
      console.log(`\n❌ ERROR: ${error.message}`);
      results.push({
        orderId,
        original,
        cleaned: null,
        error: error.message
      });
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 600));
  }

  // Summary
  console.log('\n\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const successful = results.filter(r => r.cleaned);
  const highConfidence = successful.filter(r => r.cleaned?.confidence === 'high');
  const mediumConfidence = successful.filter(r => r.cleaned?.confidence === 'medium');
  const lowConfidence = successful.filter(r => r.cleaned?.confidence === 'low');

  console.log(`\nTotal Orders Analyzed: ${results.length}`);
  console.log(`Successfully Parsed:   ${successful.length}`);
  console.log(`  - High Confidence:   ${highConfidence.length}`);
  console.log(`  - Medium Confidence: ${mediumConfidence.length}`);
  console.log(`  - Low Confidence:    ${lowConfidence.length}`);

  const businessOrders = results.filter(r => r.cleaned?.isCompany);
  console.log(`\nBusiness Orders (B2B): ${businessOrders.length}`);
  console.log(`Consumer Orders (B2C): ${results.length - businessOrders.length}`);

  const withPO = results.filter(r => r.cleaned?.poNumber);
  console.log(`\nOrders with PO Number: ${withPO.length}`);
  if (withPO.length > 0) {
    withPO.forEach(r => console.log(`  - ${r.orderId}: PO ${r.cleaned.poNumber}`));
  }

  const companyInAddr1 = results.filter(r =>
    r.changes?.some(c => c.includes('Company name was in address-1'))
  );
  if (companyInAddr1.length > 0) {
    console.log(`\nOrders with Company in address-1: ${companyInAddr1.length}`);
    companyInAddr1.forEach(r => console.log(`  - ${r.orderId}`));
  }

  console.log('\n' + '='.repeat(80));
  console.log('END OF REPORT');
  console.log('='.repeat(80));
}

analyzeAddresses().catch(console.error);
