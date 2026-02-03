/**
 * DachserClient - Dachser Freight Shipping Integration for Agent5
 *
 * Handles Dachser pallet shipping for Amazon Vendor consolidation.
 * Uses REST/JSON API.
 *
 * API Portal: https://api-portal.dachser.com/
 *
 * @module DachserClient
 */

const axios = require('axios');

// Default sender address (Acropaq warehouse)
const DEFAULT_SENDER = {
  name: 'Acropaq NV',
  street: 'Schoondonkweg 13',
  postalCode: '2830',
  city: 'Willebroek',
  countryCode: 'BE',
  phone: '+32 3 303 60 30',
  email: 'logistics@acropaq.com'
};

class DachserClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.DACHSER_API_BASE_URL || 'https://api-gateway.dachser.com/rest/v2';
    this.apiKey = options.apiKey || process.env.DACHSER_API_KEY;
    this.customerId = options.customerId || process.env.DACHSER_CUSTOMER_ID;

    // Remove trailing slash from baseUrl
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
  }

  /**
   * Check if client is configured
   */
  isConfigured() {
    return !!(this.apiKey && this.customerId);
  }

  /**
   * Get common headers for all requests
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': this.apiKey,
      'Customer-Id': this.customerId
    };
  }

  /**
   * Test API connection
   * @returns {Object} { success, message, error }
   */
  async testConnection() {
    const result = {
      success: false,
      message: null,
      error: null,
      details: {}
    };

    if (!this.isConfigured()) {
      result.error = 'Dachser credentials not configured. Set DACHSER_API_KEY and DACHSER_CUSTOMER_ID in .env';
      return result;
    }

    try {
      // Try to get shipment status for a non-existent tracking number
      // This should return an error but prove the API is accessible
      const response = await axios.get(`${this.baseUrl}/shipmentstatus`, {
        headers: this.getHeaders(),
        params: {
          trackingNumber: 'TEST-CONNECTION-CHECK'
        },
        timeout: 10000,
        validateStatus: (status) => status < 500 // Accept 4xx responses as successful connection
      });

      // If we get here, the API is accessible
      if (response.status === 401) {
        result.error = 'Invalid API key or credentials';
        result.details.status = response.status;
      } else if (response.status === 403) {
        result.error = 'API access forbidden - check if APIs are activated';
        result.details.status = response.status;
      } else if (response.status === 404) {
        // 404 for a test tracking number means the API is working
        result.success = true;
        result.message = 'Dachser API connection successful';
        result.details.status = response.status;
      } else if (response.status === 400) {
        // 400 Bad Request for test query means API is working but needs proper params
        // This is actually a successful connection test - credentials are valid
        result.success = true;
        result.message = 'Dachser API connection successful (credentials validated)';
        result.details.status = response.status;
        result.details.note = 'API responded with parameter validation error, confirming connectivity';
      } else if (response.status >= 200 && response.status < 300) {
        result.success = true;
        result.message = 'Dachser API connection successful';
        result.details.status = response.status;
      } else {
        result.error = `Unexpected response status: ${response.status}`;
        result.details.status = response.status;
        result.details.data = response.data;
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND') {
        result.error = 'Cannot reach Dachser API server';
      } else if (error.code === 'ETIMEDOUT') {
        result.error = 'Connection to Dachser API timed out';
      } else if (error.response) {
        result.error = `API error: ${error.response.status} - ${error.response.statusText}`;
        result.details.status = error.response.status;
        result.details.data = error.response.data;
      } else {
        result.error = error.message;
      }
      console.error('[DachserClient] Connection test error:', error.message);
    }

    return result;
  }

  /**
   * Get shipment status by tracking number (Domino Shipment Number)
   *
   * @param {string} trackingNumber - Dachser Domino Shipment Number (SN)
   * @returns {Object} { success, status, events, error }
   */
  async getShipmentStatus(trackingNumber) {
    const result = {
      success: false,
      status: null,
      statusDescription: null,
      events: [],
      error: null
    };

    if (!this.isConfigured()) {
      result.error = 'Dachser credentials not configured';
      return result;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/shipmentstatus`, {
        headers: this.getHeaders(),
        params: {
          trackingNumber: trackingNumber
        },
        timeout: 15000
      });

      if (response.status === 200) {
        result.success = true;
        result.status = response.data.status;
        result.statusDescription = response.data.statusDescription;
        result.events = response.data.events || [];
      }
    } catch (error) {
      if (error.response?.status === 404) {
        result.error = 'Shipment not found';
      } else {
        result.error = error.response?.data?.message || error.message;
      }
      console.error('[DachserClient] getShipmentStatus error:', error.message);
    }

    return result;
  }

  /**
   * Get full shipment history
   *
   * @param {string} trackingNumber - Dachser Domino Shipment Number
   * @returns {Object} { success, history, error }
   */
  async getShipmentHistory(trackingNumber) {
    const result = {
      success: false,
      history: [],
      error: null
    };

    if (!this.isConfigured()) {
      result.error = 'Dachser credentials not configured';
      return result;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/shipmenthistory`, {
        headers: this.getHeaders(),
        params: {
          trackingNumber: trackingNumber
        },
        timeout: 15000
      });

      if (response.status === 200) {
        result.success = true;
        result.history = response.data.history || response.data.events || [];
      }
    } catch (error) {
      result.error = error.response?.data?.message || error.message;
      console.error('[DachserClient] getShipmentHistory error:', error.message);
    }

    return result;
  }

  /**
   * Get quotation for a pallet shipment
   *
   * @param {Object} shipment - Shipment details
   * @param {Object} shipment.sender - Sender address (optional, uses Acropaq default)
   * @param {Object} shipment.receiver - Receiver address (required)
   * @param {Array} shipment.packages - Array of package details
   * @param {string} shipment.product - Product code (Y=targoflex, Z=targospeed, etc.)
   * @returns {Object} { success, price, currency, transitDays, error }
   */
  async getQuotation(shipment) {
    const result = {
      success: false,
      price: null,
      currency: 'EUR',
      transitDays: null,
      error: null
    };

    if (!this.isConfigured()) {
      result.error = 'Dachser credentials not configured';
      return result;
    }

    try {
      const requestBody = this.buildQuotationRequest(shipment);

      const response = await axios.post(`${this.baseUrl}/quotation`, requestBody, {
        headers: this.getHeaders(),
        timeout: 30000
      });

      if (response.status === 200) {
        result.success = true;
        result.price = response.data.totalPrice || response.data.price;
        result.currency = response.data.currency || 'EUR';
        result.transitDays = response.data.transitDays || response.data.deliveryDays;
        result.details = response.data;
      }
    } catch (error) {
      result.error = error.response?.data?.message || error.message;
      console.error('[DachserClient] getQuotation error:', error.message);
    }

    return result;
  }

  /**
   * Create a transport order (book a shipment)
   *
   * @param {Object} shipment - Shipment details
   * @param {Object} shipment.sender - Sender address (optional, uses Acropaq default)
   * @param {Object} shipment.receiver - Receiver address (required)
   * @param {Array} shipment.packages - Array of package details { packingType, quantity, weight, length, width, height }
   * @param {string} shipment.product - Product code (default: 'Y' = targoflex)
   * @param {string} shipment.termsOfDelivery - Terms code (default: '031' = free delivered)
   * @param {Array} shipment.references - Reference numbers [{ type, value }]
   * @param {Date} shipment.collectionDate - Requested pickup date
   * @returns {Object} { success, trackingNumber, shipmentId, labelPdf, error }
   */
  async createTransportOrder(shipment) {
    const result = {
      success: false,
      trackingNumber: null,
      shipmentId: null,
      labelPdf: null,
      error: null
    };

    if (!this.isConfigured()) {
      result.error = 'Dachser credentials not configured';
      return result;
    }

    try {
      const requestBody = this.buildTransportOrderRequest(shipment);

      console.log('[DachserClient] Creating transport order:', JSON.stringify(requestBody, null, 2));

      const response = await axios.post(`${this.baseUrl}/transportorder`, requestBody, {
        headers: this.getHeaders(),
        timeout: 60000
      });

      if (response.status === 200 || response.status === 201) {
        result.success = true;
        result.trackingNumber = response.data.trackingNumber || response.data.shipmentNumber;
        result.shipmentId = response.data.shipmentId || response.data.id;
        result.labelPdf = response.data.label || response.data.labelPdf;
        result.details = response.data;
        console.log('[DachserClient] Transport order created:', result.trackingNumber);
      }
    } catch (error) {
      result.error = error.response?.data?.message || error.message;
      if (error.response?.data) {
        result.details = error.response.data;
      }
      console.error('[DachserClient] createTransportOrder error:', error.message);
      if (error.response?.data) {
        console.error('[DachserClient] Error details:', JSON.stringify(error.response.data, null, 2));
      }
    }

    return result;
  }

  /**
   * Build quotation request body
   */
  buildQuotationRequest(shipment) {
    const sender = shipment.sender || DEFAULT_SENDER;
    const receiver = shipment.receiver;

    return {
      product: shipment.product || 'Y', // targoflex
      termsOfDelivery: shipment.termsOfDelivery || '031', // free delivered
      sender: {
        name: sender.name,
        street: sender.street,
        postalCode: sender.postalCode,
        city: sender.city,
        countryCode: sender.countryCode || 'BE'
      },
      receiver: {
        name: receiver.name,
        street: receiver.street,
        postalCode: receiver.postalCode,
        city: receiver.city,
        countryCode: receiver.countryCode
      },
      packages: (shipment.packages || []).map(pkg => ({
        packingType: pkg.packingType || 'EU', // Euro pallet
        quantity: pkg.quantity || 1,
        weight: pkg.weight || 0,
        length: pkg.length,
        width: pkg.width,
        height: pkg.height
      }))
    };
  }

  /**
   * Build transport order request body
   */
  buildTransportOrderRequest(shipment) {
    const sender = shipment.sender || DEFAULT_SENDER;
    const receiver = shipment.receiver;

    const request = {
      product: shipment.product || 'Y', // targoflex
      termsOfDelivery: shipment.termsOfDelivery || '031', // free delivered
      collectionDate: shipment.collectionDate
        ? new Date(shipment.collectionDate).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      sender: {
        name: sender.name,
        street: sender.street,
        postalCode: sender.postalCode,
        city: sender.city,
        countryCode: sender.countryCode || 'BE',
        phone: sender.phone,
        email: sender.email
      },
      receiver: {
        name: receiver.name,
        street: receiver.street,
        postalCode: receiver.postalCode,
        city: receiver.city,
        countryCode: receiver.countryCode,
        phone: receiver.phone,
        email: receiver.email
      },
      packages: (shipment.packages || []).map(pkg => ({
        packingType: pkg.packingType || 'EU', // Euro pallet
        quantity: pkg.quantity || 1,
        weight: pkg.weight || 0,
        length: pkg.length,
        width: pkg.width,
        height: pkg.height
      })),
      references: shipment.references || []
    };

    // Add goods value if provided
    if (shipment.goodsValue && shipment.goodsValue.amount > 0) {
      request.goodsValue = {
        amount: shipment.goodsValue.amount,
        currency: shipment.goodsValue.currency || 'EUR'
      };
    }

    // Add nature of goods
    if (shipment.natureOfGoods) {
      request.natureOfGoods = shipment.natureOfGoods;
    }

    // Add delivery instructions (order texts)
    if (shipment.deliveryInstructions) {
      request.orderTexts = {
        deliveryInstructions: shipment.deliveryInstructions
      };
    }

    // Add delivery notice if receiver has phone/email
    if (receiver.phone || receiver.email) {
      request.services = request.services || [];
      request.services.push({
        type: 'DN', // Delivery notice
        phone: receiver.phone,
        email: receiver.email
      });
    }

    return request;
  }

  /**
   * Get tracking URL for a shipment
   *
   * @param {string} trackingNumber - Dachser tracking number
   * @returns {string} Tracking URL
   */
  getTrackingUrl(trackingNumber) {
    return `https://www.dachser.com/int/en/track-trace_8654.htm?shipmentsearch=${trackingNumber}`;
  }
}

// Singleton instance
let dachserClientInstance = null;

/**
 * Get or create DachserClient instance
 */
function getDachserClient() {
  if (!dachserClientInstance) {
    dachserClientInstance = new DachserClient();
  }
  return dachserClientInstance;
}

module.exports = {
  DachserClient,
  getDachserClient,
  DEFAULT_SENDER
};
