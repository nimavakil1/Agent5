#!/usr/bin/env node
/**
 * Test single SKU stock update to Amazon
 * SKU: P0014, Quantity: 3, Marketplace: BE
 */
require('dotenv').config();
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

const INVENTORY_FEED_TYPE = 'POST_INVENTORY_AVAILABILITY_DATA';
const MERCHANT_ID = process.env.AMAZON_MERCHANT_ID || 'A1GJ5ZORIRYSYA';

// BE marketplace ID
const BE_MARKETPLACE = 'AMEN7PMS3EDWL';

async function run() {
  console.log('Initializing Seller Client...');
  const sellerClient = getSellerClient();
  await sellerClient.init();
  const spClient = await sellerClient.getClient();

  // Test SKU
  const testSku = 'P0014';
  const testQuantity = 3;

  console.log(`\nTest: Update ${testSku} to quantity ${testQuantity}`);

  // Generate feed XML
  const feedXml = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${MERCHANT_ID}</MerchantIdentifier>
  </Header>
  <MessageType>Inventory</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <OperationType>Update</OperationType>
    <Inventory>
      <SKU>${testSku}</SKU>
      <Quantity>${testQuantity}</Quantity>
      <FulfillmentLatency>3</FulfillmentLatency>
    </Inventory>
  </Message>
</AmazonEnvelope>`;

  console.log('\nFeed XML:');
  console.log(feedXml);

  try {
    // Step 1: Create feed document
    console.log('\nStep 1: Creating feed document...');
    const createDocResponse = await spClient.callAPI({
      operation: 'feeds.createFeedDocument',
      body: {
        contentType: 'text/xml; charset=UTF-8'
      }
    });

    console.log('Feed document created:', createDocResponse.feedDocumentId);
    const feedDocumentId = createDocResponse.feedDocumentId;
    const uploadUrl = createDocResponse.url;

    // Step 2: Upload feed content
    console.log('\nStep 2: Uploading feed content...');
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
      body: feedXml
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }
    console.log('Feed content uploaded successfully');

    // Step 3: Submit feed
    console.log('\nStep 3: Submitting feed...');
    const submitResponse = await spClient.callAPI({
      operation: 'feeds.createFeed',
      body: {
        feedType: INVENTORY_FEED_TYPE,
        marketplaceIds: [BE_MARKETPLACE],
        inputFeedDocumentId: feedDocumentId
      }
    });

    console.log('\n=== SUCCESS ===');
    console.log('Feed ID:', submitResponse.feedId);
    console.log('Feed submitted for SKU:', testSku);
    console.log('Quantity:', testQuantity);
    console.log('Marketplace: BE');

  } catch (error) {
    console.error('\n=== ERROR ===');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
