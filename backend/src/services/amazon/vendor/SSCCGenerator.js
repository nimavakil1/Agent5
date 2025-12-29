/**
 * SSCCGenerator - Generate SSCC-18 codes for Amazon Vendor shipments
 *
 * SSCC (Serial Shipping Container Code) is an 18-digit GS1 standard
 * used to identify shipping containers (cartons, pallets).
 *
 * Structure: [Extension Digit][GS1 Company Prefix][Serial Reference][Check Digit]
 *
 * For Acropaq (GS1 Belgium):
 * - GS1 Company Prefix: 5400882 (7 digits)
 * - Extension Digit: 0-9 (we use 0 for cartons, 1 for pallets)
 * - Serial Reference: 9 digits (allows 1 billion unique codes)
 * - Check Digit: Mod 10 calculated
 *
 * @module SSCCGenerator
 */

const { getDb } = require('../../../db');

/**
 * Configuration
 */
const CONFIG = {
  // Acropaq's GS1 Belgium prefix (from EAN barcodes: 5400882xxxxxx)
  GS1_COMPANY_PREFIX: '5400882',

  // Extension digits to differentiate container types
  EXTENSION_CARTON: '0',
  EXTENSION_PALLET: '1',
  EXTENSION_MIXED: '2',

  // Serial number padding (to fill 17 digits before check digit)
  // 17 - 1 (extension) - 7 (prefix) = 9 digits for serial
  SERIAL_LENGTH: 9,

  // MongoDB collection for tracking issued SSCCs
  COLLECTION_NAME: 'sscc_codes'
};

/**
 * Calculate GS1 Mod 10 check digit
 * Used for EAN-13, GTIN-14, SSCC-18, etc.
 *
 * Algorithm:
 * 1. Number positions from right to left
 * 2. Sum digits at odd positions × 3
 * 3. Sum digits at even positions × 1
 * 4. Check digit = (10 - (sum mod 10)) mod 10
 *
 * @param {string} digits - 17 digits (without check digit)
 * @returns {string} Single check digit
 */
function calculateCheckDigit(digits) {
  if (digits.length !== 17) {
    throw new Error(`Expected 17 digits, got ${digits.length}`);
  }

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const digit = parseInt(digits[i], 10);
    // Position from right: 17-i (1-indexed)
    // Odd positions (from right) get ×3, even get ×1
    // But we're going left to right, so:
    // Position 0 (leftmost) is position 17 from right (odd) → ×3
    // Position 1 is position 16 from right (even) → ×1
    const multiplier = (i % 2 === 0) ? 3 : 1;
    sum += digit * multiplier;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit.toString();
}

/**
 * Validate a complete SSCC-18
 * @param {string} sscc - 18-digit SSCC
 * @returns {boolean} True if valid
 */
function validateSSCC(sscc) {
  if (!/^\d{18}$/.test(sscc)) {
    return false;
  }

  const digits = sscc.substring(0, 17);
  const expectedCheck = calculateCheckDigit(digits);
  return sscc[17] === expectedCheck;
}

/**
 * Parse SSCC into components
 * @param {string} sscc - 18-digit SSCC
 * @returns {Object} Parsed components
 */
function parseSSCC(sscc) {
  if (!validateSSCC(sscc)) {
    throw new Error('Invalid SSCC');
  }

  return {
    extensionDigit: sscc[0],
    gs1Prefix: sscc.substring(1, 8),
    serialReference: sscc.substring(8, 17),
    checkDigit: sscc[17],
    containerType: sscc[0] === '0' ? 'carton' : sscc[0] === '1' ? 'pallet' : 'other'
  };
}

class SSCCGenerator {
  constructor() {
    this.db = null;
    this.config = { ...CONFIG };
  }

  /**
   * Initialize the generator
   */
  async init() {
    this.db = getDb();
    await this.ensureIndexes();
    return this;
  }

  /**
   * Ensure MongoDB indexes
   */
  async ensureIndexes() {
    const collection = this.db.collection(this.config.COLLECTION_NAME);
    await collection.createIndexes([
      { key: { sscc: 1 }, unique: true },
      { key: { createdAt: -1 } },
      { key: { type: 1, status: 1 } },
      { key: { shipmentId: 1 } },
      { key: { purchaseOrderNumber: 1 } }
    ]);
  }

  /**
   * Get the next serial number for a given extension digit
   * Uses atomic counter to ensure uniqueness
   */
  async getNextSerial(extensionDigit = '0') {
    const counterCollection = this.db.collection('sscc_counters');

    const result = await counterCollection.findOneAndUpdate(
      { _id: `sscc_${extensionDigit}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );

    return result.seq;
  }

  /**
   * Generate a single SSCC
   * @param {Object} options
   * @param {string} options.type - 'carton' or 'pallet'
   * @param {string} options.purchaseOrderNumber - Associated PO
   * @param {string} options.shipmentId - Associated shipment
   * @param {Object} options.contents - What's in this container
   * @returns {Object} Generated SSCC with metadata
   */
  async generateSSCC(options = {}) {
    const {
      type = 'carton',
      purchaseOrderNumber = null,
      shipmentId = null,
      contents = null
    } = options;

    // Determine extension digit
    const extensionDigit = type === 'pallet'
      ? this.config.EXTENSION_PALLET
      : this.config.EXTENSION_CARTON;

    // Get next serial number
    const serialNum = await this.getNextSerial(extensionDigit);

    // Pad serial to required length
    const serialStr = serialNum.toString().padStart(this.config.SERIAL_LENGTH, '0');

    if (serialStr.length > this.config.SERIAL_LENGTH) {
      throw new Error(`Serial number overflow! Max ${this.config.SERIAL_LENGTH} digits exceeded.`);
    }

    // Build SSCC without check digit
    const ssccWithoutCheck = extensionDigit + this.config.GS1_COMPANY_PREFIX + serialStr;

    // Calculate and append check digit
    const checkDigit = calculateCheckDigit(ssccWithoutCheck);
    const sscc = ssccWithoutCheck + checkDigit;

    // Store in database
    const record = {
      sscc,
      type,
      extensionDigit,
      serialNumber: serialNum,
      gs1Prefix: this.config.GS1_COMPANY_PREFIX,
      checkDigit,
      purchaseOrderNumber,
      shipmentId,
      contents,
      status: 'generated', // generated, printed, shipped, received
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.db.collection(this.config.COLLECTION_NAME).insertOne(record);

    return {
      sscc,
      ssccFormatted: this.formatSSCC(sscc),
      ssccWithAI: '00' + sscc, // With GS1 Application Identifier
      type,
      serialNumber: serialNum,
      ...record
    };
  }

  /**
   * Generate multiple SSCCs for cartons
   * @param {number} count - Number of SSCCs to generate
   * @param {Object} options - Common options for all
   * @returns {Array} Array of generated SSCCs
   */
  async generateCartonSSCCs(count, options = {}) {
    const results = [];
    for (let i = 0; i < count; i++) {
      const result = await this.generateSSCC({
        ...options,
        type: 'carton'
      });
      results.push(result);
    }
    return results;
  }

  /**
   * Generate SSCC for a pallet with its cartons
   * @param {Array} cartonSSCCs - Array of carton SSCCs on this pallet
   * @param {Object} options - Pallet options
   * @returns {Object} Pallet SSCC with carton references
   */
  async generatePalletSSCC(cartonSSCCs = [], options = {}) {
    const palletSSCC = await this.generateSSCC({
      ...options,
      type: 'pallet',
      contents: {
        cartonCount: cartonSSCCs.length,
        cartonSSCCs: cartonSSCCs.map(c => typeof c === 'string' ? c : c.sscc)
      }
    });

    // Update cartons to reference this pallet
    if (cartonSSCCs.length > 0) {
      await this.db.collection(this.config.COLLECTION_NAME).updateMany(
        { sscc: { $in: cartonSSCCs.map(c => typeof c === 'string' ? c : c.sscc) } },
        { $set: { palletSSCC: palletSSCC.sscc, updatedAt: new Date() } }
      );
    }

    return palletSSCC;
  }

  /**
   * Format SSCC for human readability
   * @param {string} sscc - 18-digit SSCC
   * @returns {string} Formatted SSCC
   */
  formatSSCC(sscc) {
    // Format: X XXXXXXX XXXXXXXXX (extension + prefix + serial+check)
    return `${sscc[0]} ${sscc.substring(1, 8)} ${sscc.substring(8)}`;
  }

  /**
   * Get SSCC record by code
   * @param {string} sscc - 18-digit SSCC
   */
  async getSSCC(sscc) {
    return this.db.collection(this.config.COLLECTION_NAME).findOne({ sscc });
  }

  /**
   * Get SSCCs by shipment
   * @param {string} shipmentId - Shipment ID
   */
  async getSSCCsByShipment(shipmentId) {
    return this.db.collection(this.config.COLLECTION_NAME)
      .find({ shipmentId })
      .sort({ type: 1, createdAt: 1 })
      .toArray();
  }

  /**
   * Get SSCCs by PO
   * @param {string} purchaseOrderNumber - PO number
   */
  async getSSCCsByPO(purchaseOrderNumber) {
    return this.db.collection(this.config.COLLECTION_NAME)
      .find({ purchaseOrderNumber })
      .sort({ type: 1, createdAt: 1 })
      .toArray();
  }

  /**
   * Update SSCC status
   * @param {string} sscc - SSCC code
   * @param {string} status - New status
   * @param {Object} additionalData - Extra data to store
   */
  async updateStatus(sscc, status, additionalData = {}) {
    return this.db.collection(this.config.COLLECTION_NAME).updateOne(
      { sscc },
      {
        $set: {
          status,
          ...additionalData,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Update SSCC contents (items in carton)
   * @param {string} sscc - SSCC code
   * @param {Array} items - Items in this container
   */
  async updateContents(sscc, items) {
    return this.db.collection(this.config.COLLECTION_NAME).updateOne(
      { sscc },
      {
        $set: {
          contents: { items },
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Get statistics
   */
  async getStats() {
    const collection = this.db.collection(this.config.COLLECTION_NAME);

    const stats = await collection.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          cartons: { $sum: { $cond: [{ $eq: ['$type', 'carton'] }, 1, 0] } },
          pallets: { $sum: { $cond: [{ $eq: ['$type', 'pallet'] }, 1, 0] } },
          generated: { $sum: { $cond: [{ $eq: ['$status', 'generated'] }, 1, 0] } },
          printed: { $sum: { $cond: [{ $eq: ['$status', 'printed'] }, 1, 0] } },
          shipped: { $sum: { $cond: [{ $eq: ['$status', 'shipped'] }, 1, 0] } }
        }
      }
    ]).toArray();

    // Get counter values
    const counters = await this.db.collection('sscc_counters').find().toArray();

    return {
      gs1Prefix: this.config.GS1_COMPANY_PREFIX,
      ...(stats[0] || { total: 0, cartons: 0, pallets: 0, generated: 0, printed: 0, shipped: 0 }),
      counters: counters.reduce((acc, c) => {
        acc[c._id] = c.seq;
        return acc;
      }, {})
    };
  }
}

// Singleton instance
let ssccGeneratorInstance = null;

async function getSSCCGenerator() {
  if (!ssccGeneratorInstance) {
    ssccGeneratorInstance = new SSCCGenerator();
    await ssccGeneratorInstance.init();
  }
  return ssccGeneratorInstance;
}

module.exports = {
  SSCCGenerator,
  getSSCCGenerator,
  calculateCheckDigit,
  validateSSCC,
  parseSSCC,
  CONFIG
};
