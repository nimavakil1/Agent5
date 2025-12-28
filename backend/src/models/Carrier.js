/**
 * Carrier Model
 *
 * Stores carrier/shipping provider configuration for:
 * - Logo display in the system
 * - API connection credentials (for future label generation)
 * - Bol.com transporter code mapping
 * - Carrier-specific settings
 */

const mongoose = require('mongoose');

const carrierSchema = new mongoose.Schema({
  // Basic info
  name: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  displayName: {
    type: String
  },

  // Visual
  logo: {
    type: String,  // URL or base64 data URI
    default: null
  },
  color: {
    type: String,  // Primary brand color (hex)
    default: '#000000'
  },

  // Bol.com integration
  bolTransporterCode: {
    type: String,  // The code to send to Bol.com API
    required: true
  },

  // Carrier type
  type: {
    type: String,
    enum: ['PARCEL', 'FREIGHT', 'MAIL', 'EXPRESS', 'SAME_DAY'],
    default: 'PARCEL'
  },

  // Countries served
  countries: [{
    type: String,
    uppercase: true
  }],

  // API connection (for future label generation)
  apiConfig: {
    provider: {
      type: String,  // e.g., 'postnl', 'dhl', 'dpd', 'sendcloud', 'shippo'
      default: null
    },
    baseUrl: {
      type: String,
      default: null
    },
    apiKey: {
      type: String,
      default: null
    },
    apiSecret: {
      type: String,
      default: null
    },
    accountNumber: {
      type: String,
      default: null
    },
    // Additional provider-specific fields
    extraFields: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    isConnected: {
      type: Boolean,
      default: false
    },
    lastTestedAt: {
      type: Date,
      default: null
    }
  },

  // Default shipping options
  defaults: {
    service: {
      type: String,  // Default service type
      default: null
    },
    labelFormat: {
      type: String,
      enum: ['PDF', 'ZPL', 'PNG'],
      default: 'PDF'
    },
    labelSize: {
      type: String,
      enum: ['A4', 'A6', '4x6'],
      default: 'A6'
    }
  },

  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },

  // Odoo integration
  odooCarrierId: {
    type: Number,
    default: null
  },
  odooCarrierName: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  collection: 'carriers'
});

// Indexes
carrierSchema.index({ isActive: 1, sortOrder: 1 });
carrierSchema.index({ bolTransporterCode: 1 });

// Pre-defined carriers with Bol.com codes
const PREDEFINED_CARRIERS = [
  {
    name: 'PostNL',
    code: 'POSTNL',
    displayName: 'PostNL',
    bolTransporterCode: 'TNT',
    color: '#FF6600',
    type: 'PARCEL',
    countries: ['NL', 'BE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/PostNL_Logo.svg/200px-PostNL_Logo.svg.png'
  },
  {
    name: 'DHL',
    code: 'DHL',
    displayName: 'DHL',
    bolTransporterCode: 'DHL',
    color: '#FFCC00',
    type: 'PARCEL',
    countries: ['NL', 'BE', 'DE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/DHL_Logo.svg/200px-DHL_Logo.svg.png'
  },
  {
    name: 'DHL For You',
    code: 'DHLFORYOU',
    displayName: 'DHL For You',
    bolTransporterCode: 'DHLFORYOU',
    color: '#FFCC00',
    type: 'PARCEL',
    countries: ['NL', 'BE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/DHL_Logo.svg/200px-DHL_Logo.svg.png'
  },
  {
    name: 'DPD NL',
    code: 'DPD_NL',
    displayName: 'DPD Nederland',
    bolTransporterCode: 'DPD-NL',
    color: '#DC0032',
    type: 'PARCEL',
    countries: ['NL'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/DPD_logo_%282015%29.svg/200px-DPD_logo_%282015%29.svg.png'
  },
  {
    name: 'DPD BE',
    code: 'DPD_BE',
    displayName: 'DPD Belgium',
    bolTransporterCode: 'DPD-BE',
    color: '#DC0032',
    type: 'PARCEL',
    countries: ['BE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/DPD_logo_%282015%29.svg/200px-DPD_logo_%282015%29.svg.png'
  },
  {
    name: 'GLS',
    code: 'GLS',
    displayName: 'GLS',
    bolTransporterCode: 'GLS',
    color: '#003A70',
    type: 'PARCEL',
    countries: ['NL', 'BE', 'DE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/43/GLS_Logo.svg/200px-GLS_Logo.svg.png'
  },
  {
    name: 'UPS',
    code: 'UPS',
    displayName: 'UPS',
    bolTransporterCode: 'UPS',
    color: '#351C15',
    type: 'PARCEL',
    countries: ['NL', 'BE', 'DE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/UPS_Logo_Shield_2017.svg/200px-UPS_Logo_Shield_2017.svg.png'
  },
  {
    name: 'Bpost',
    code: 'BPOST',
    displayName: 'bpost',
    bolTransporterCode: 'BPOST_BE',
    color: '#E30613',
    type: 'PARCEL',
    countries: ['BE'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Bpost_logo.svg/200px-Bpost_logo.svg.png'
  },
  {
    name: 'FedEx NL',
    code: 'FEDEX_NL',
    displayName: 'FedEx Nederland',
    bolTransporterCode: 'FEDEX_NL',
    color: '#4D148C',
    type: 'EXPRESS',
    countries: ['NL'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b9/FedEx_Corporation_-_2016_Logo.svg/200px-FedEx_Corporation_-_2016_Logo.svg.png'
  },
  {
    name: 'Budbee',
    code: 'BUDBEE',
    displayName: 'Budbee',
    bolTransporterCode: 'BUDBEE',
    color: '#00C389',
    type: 'SAME_DAY',
    countries: ['NL', 'BE'],
    logo: null
  },
  {
    name: 'Trunkrs',
    code: 'TRUNKRS',
    displayName: 'Trunkrs',
    bolTransporterCode: 'TRUNKRS',
    color: '#FF5A00',
    type: 'SAME_DAY',
    countries: ['NL', 'BE'],
    logo: null
  }
];

// Static method to seed predefined carriers
carrierSchema.statics.seedPredefined = async function() {
  const Carrier = this;
  let created = 0;

  for (const carrierData of PREDEFINED_CARRIERS) {
    const exists = await Carrier.findOne({ code: carrierData.code });
    if (!exists) {
      await Carrier.create(carrierData);
      created++;
    }
  }

  return { created, total: PREDEFINED_CARRIERS.length };
};

// Static method to get carrier by Bol transporter code
carrierSchema.statics.findByBolCode = function(bolCode) {
  return this.findOne({ bolTransporterCode: bolCode, isActive: true });
};

// Static method to get all active carriers
carrierSchema.statics.getActive = function() {
  return this.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
};

module.exports = mongoose.model('Carrier', carrierSchema);
module.exports.PREDEFINED_CARRIERS = PREDEFINED_CARRIERS;
