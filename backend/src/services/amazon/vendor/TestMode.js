/**
 * TestMode - Amazon Vendor Test Mode Manager
 *
 * Provides a test mode for the Amazon Vendor system that:
 * - Mocks all Amazon API calls with realistic responses
 * - Uses existing MongoDB data for realistic testing
 * - Allows full UI testing without external calls
 *
 * @module TestMode
 */

const { getDb } = require('../../../db');

/**
 * Test mode state (in-memory, resets on server restart)
 */
let testModeEnabled = false;
let testModeStartedAt = null;
let testModeUser = null;

/**
 * Mock transaction IDs counter
 */
let mockTransactionCounter = 1000;

/**
 * Check if test mode is enabled
 */
function isTestMode() {
  return testModeEnabled;
}

/**
 * Enable test mode
 * @param {string} user - User who enabled test mode
 */
function enableTestMode(user = 'system') {
  testModeEnabled = true;
  testModeStartedAt = new Date();
  testModeUser = user;
  console.log(`[TestMode] ENABLED by ${user} at ${testModeStartedAt.toISOString()}`);
  return getTestModeStatus();
}

/**
 * Disable test mode
 */
function disableTestMode() {
  const wasEnabled = testModeEnabled;
  testModeEnabled = false;
  const duration = testModeStartedAt ? Date.now() - testModeStartedAt.getTime() : 0;
  console.log(`[TestMode] DISABLED (was active for ${Math.round(duration / 1000)}s)`);
  testModeStartedAt = null;
  testModeUser = null;
  return { wasEnabled, duration };
}

/**
 * Get test mode status
 */
function getTestModeStatus() {
  return {
    enabled: testModeEnabled,
    startedAt: testModeStartedAt,
    startedBy: testModeUser,
    duration: testModeStartedAt ? Date.now() - testModeStartedAt.getTime() : 0
  };
}

/**
 * Generate a mock transaction ID
 */
function generateMockTransactionId() {
  mockTransactionCounter++;
  return `TEST-TXN-${Date.now()}-${mockTransactionCounter}`;
}

/**
 * Mock Vendor API Responses
 */
const MockResponses = {
  /**
   * Mock response for submitAcknowledgement
   */
  submitAcknowledgement(payload) {
    return {
      transactionId: generateMockTransactionId(),
      _testMode: true,
      _mockResponse: true
    };
  },

  /**
   * Mock response for submitInvoices
   */
  submitInvoices(payload) {
    const invoiceCount = payload.invoices?.length || 0;
    return {
      transactionId: generateMockTransactionId(),
      _testMode: true,
      _mockResponse: true,
      _invoiceCount: invoiceCount
    };
  },

  /**
   * Mock response for submitShipmentConfirmations (ASN)
   */
  submitShipmentConfirmations(payload) {
    const shipmentCount = payload.shipmentConfirmations?.length || 0;
    return {
      transactionId: generateMockTransactionId(),
      _testMode: true,
      _mockResponse: true,
      _shipmentCount: shipmentCount
    };
  },

  /**
   * Mock response for getTransactionStatus
   */
  getTransactionStatus(transactionId) {
    // If it's a test transaction, return success
    if (transactionId.startsWith('TEST-TXN-')) {
      return {
        transactionId,
        status: 'Success',
        _testMode: true,
        _mockResponse: true
      };
    }
    // For real transaction IDs, return pending (since we can't actually check)
    return {
      transactionId,
      status: 'Processing',
      _testMode: true,
      _mockResponse: true,
      _note: 'Real transaction ID queried in test mode - cannot verify actual status'
    };
  },

  /**
   * Mock response for getPurchaseOrders
   * Returns actual data from MongoDB instead of calling Amazon
   */
  async getPurchaseOrders(params) {
    const db = getDb();
    const collection = db.collection('vendor_purchase_orders');

    const query = {};
    if (params.purchaseOrderState) {
      query.purchaseOrderState = params.purchaseOrderState;
    }
    if (params.createdAfter) {
      query.purchaseOrderDate = query.purchaseOrderDate || {};
      query.purchaseOrderDate.$gte = new Date(params.createdAfter);
    }
    if (params.createdBefore) {
      query.purchaseOrderDate = query.purchaseOrderDate || {};
      query.purchaseOrderDate.$lte = new Date(params.createdBefore);
    }

    const orders = await collection.find(query)
      .sort({ purchaseOrderDate: -1 })
      .limit(params.limit || 50)
      .toArray();

    return {
      orders: orders.map(o => ({
        purchaseOrderNumber: o.purchaseOrderNumber,
        purchaseOrderState: o.purchaseOrderState,
        purchaseOrderDate: o.purchaseOrderDate,
        purchaseOrderType: o.purchaseOrderType,
        deliveryWindow: o.deliveryWindow,
        buyingParty: o.buyingParty,
        sellingParty: o.sellingParty,
        shipToParty: o.shipToParty,
        billToParty: o.billToParty,
        items: o.items
      })),
      _testMode: true,
      _mockResponse: true,
      _source: 'mongodb'
    };
  },

  /**
   * Mock response for getPurchaseOrder (single)
   */
  async getPurchaseOrder(purchaseOrderNumber) {
    const db = getDb();
    const collection = db.collection('vendor_purchase_orders');

    const order = await collection.findOne({ purchaseOrderNumber });

    if (!order) {
      const error = new Error(`Purchase order ${purchaseOrderNumber} not found`);
      error.code = 'NotFound';
      throw error;
    }

    return {
      purchaseOrderNumber: order.purchaseOrderNumber,
      purchaseOrderState: order.purchaseOrderState,
      purchaseOrderDate: order.purchaseOrderDate,
      purchaseOrderType: order.purchaseOrderType,
      deliveryWindow: order.deliveryWindow,
      buyingParty: order.buyingParty,
      sellingParty: order.sellingParty,
      shipToParty: order.shipToParty,
      billToParty: order.billToParty,
      items: order.items,
      _testMode: true,
      _mockResponse: true,
      _source: 'mongodb'
    };
  }
};

/**
 * MockVendorClient - Wraps VendorClient to intercept calls in test mode
 */
class MockVendorClient {
  constructor(realClient) {
    this.realClient = realClient;
    this.marketplace = realClient?.marketplace || 'DE';
  }

  async submitAcknowledgement(payload) {
    if (isTestMode()) {
      console.log('[TestMode] Mock submitAcknowledgement called');
      return MockResponses.submitAcknowledgement(payload);
    }
    return this.realClient.submitAcknowledgement(payload);
  }

  async submitInvoices(payload) {
    if (isTestMode()) {
      console.log('[TestMode] Mock submitInvoices called');
      return MockResponses.submitInvoices(payload);
    }
    return this.realClient.submitInvoices(payload);
  }

  async submitShipmentConfirmations(payload) {
    if (isTestMode()) {
      console.log('[TestMode] Mock submitShipmentConfirmations called');
      return MockResponses.submitShipmentConfirmations(payload);
    }
    return this.realClient.submitShipmentConfirmations(payload);
  }

  async getTransactionStatus(transactionId) {
    if (isTestMode()) {
      console.log('[TestMode] Mock getTransactionStatus called');
      return MockResponses.getTransactionStatus(transactionId);
    }
    return this.realClient.getTransactionStatus(transactionId);
  }

  async getPurchaseOrders(params) {
    if (isTestMode()) {
      console.log('[TestMode] Mock getPurchaseOrders called');
      return MockResponses.getPurchaseOrders(params);
    }
    return this.realClient.getPurchaseOrders(params);
  }

  async getPurchaseOrder(purchaseOrderNumber) {
    if (isTestMode()) {
      console.log('[TestMode] Mock getPurchaseOrder called');
      return MockResponses.getPurchaseOrder(purchaseOrderNumber);
    }
    return this.realClient.getPurchaseOrder(purchaseOrderNumber);
  }

  // Pass through other methods unchanged
  async init() {
    if (!isTestMode()) {
      return this.realClient.init();
    }
    return this;
  }

  async getClient() {
    if (!isTestMode()) {
      return this.realClient.getClient();
    }
    return this;
  }

  buildAcknowledgement(...args) {
    return this.realClient.buildAcknowledgement(...args);
  }

  buildInvoice(...args) {
    return this.realClient.buildInvoice(...args);
  }

  buildShipmentConfirmation(...args) {
    return this.realClient.buildShipmentConfirmation(...args);
  }
}

/**
 * Wrap a VendorClient with test mode support
 * @param {VendorClient} client - Real VendorClient instance
 * @returns {MockVendorClient} - Wrapped client
 */
function wrapWithTestMode(client) {
  return new MockVendorClient(client);
}

/**
 * Generate test data - create simulated new POs from historical data
 * @param {number} count - Number of test POs to generate
 */
async function generateTestPOs(count = 5) {
  const db = getDb();
  const collection = db.collection('vendor_purchase_orders');

  // Get some historical POs to use as templates
  const historicalPOs = await collection.find({})
    .sort({ purchaseOrderDate: -1 })
    .limit(20)
    .toArray();

  if (historicalPOs.length === 0) {
    return { generated: 0, error: 'No historical POs to use as templates' };
  }

  const generatedPOs = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const template = historicalPOs[i % historicalPOs.length];
    const testPO = {
      ...template,
      _id: undefined, // Will be auto-generated
      purchaseOrderNumber: `TEST-PO-${now.getTime()}-${i + 1}`,
      purchaseOrderState: 'New',
      purchaseOrderDate: now, // Use Date object, not string
      _testData: true,
      _generatedAt: now,
      deliveryWindow: {
        startDate: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
        endDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      },
      odoo: null, // Clear Odoo link
      invoice: null,
      shipment: null,
      acknowledgment: null
    };

    await collection.insertOne(testPO);
    generatedPOs.push(testPO.purchaseOrderNumber);
  }

  return {
    generated: generatedPOs.length,
    poNumbers: generatedPOs
  };
}

/**
 * Clean up test data
 */
async function cleanupTestData() {
  const db = getDb();
  const collection = db.collection('vendor_purchase_orders');

  const result = await collection.deleteMany({ _testData: true });

  return {
    deleted: result.deletedCount
  };
}

module.exports = {
  isTestMode,
  enableTestMode,
  disableTestMode,
  getTestModeStatus,
  MockVendorClient,
  wrapWithTestMode,
  generateTestPOs,
  cleanupTestData,
  MockResponses
};
