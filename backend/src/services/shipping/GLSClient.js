/**
 * GLSClient - GLS Shipping Integration for Agent5
 *
 * Handles GLS shipping label creation and shipment management.
 * Based on the Odoo GLS integration (gls_shipping_ns module).
 *
 * API: GLS ShipIT Web Service (SOAP)
 * Documentation: https://shipit.gls-group.eu/
 *
 * @module GLSClient
 */

const axios = require('axios');

class GLSClient {
  constructor(options = {}) {
    this.hostname = options.hostname || process.env.GLS_API_HOSTNAME || 'https://shipit-wbm-be01.gls-group.eu:8443';
    this.userId = options.userId || process.env.GLS_USER_ID;
    this.password = options.password || process.env.GLS_PASSWORD;
    this.contactId = options.contactId || process.env.GLS_CONTACT_ID;

    if (!this.userId || !this.password) {
      throw new Error('GLS credentials not configured. Set GLS_USER_ID and GLS_PASSWORD in .env');
    }
  }

  /**
   * Get the API URL for shipment processing
   */
  getShipmentApiUrl() {
    return `${this.hostname}/backend/ShipmentProcessingService/ShipmentProcessingPortType`;
  }

  /**
   * Get auth header for requests
   */
  getAuthHeader() {
    const authString = `${this.userId}:${this.password}`;
    const encoded = Buffer.from(authString).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * Create a shipment and get shipping label
   *
   * @param {Object} shipment - Shipment data
   * @param {Object} shipment.sender - Sender address
   * @param {Object} shipment.receiver - Receiver address
   * @param {string} shipment.reference - Shipment reference (e.g., picking name)
   * @param {number} shipment.weight - Package weight in kg
   * @param {string} shipment.product - GLS product type: Parcel, Express, Freight
   * @param {string} shipment.service - Optional GLS service
   * @returns {Object} { success, trackingNumber, labelPdf, error }
   */
  async createShipment(shipment) {
    const result = {
      success: false,
      trackingNumber: null,
      labelPdf: null,
      parcelNumber: null,
      error: null
    };

    try {
      const requestBody = this.buildShipmentRequest(shipment);
      const response = await this.sendRequest(requestBody);

      if (response.success) {
        const parsed = this.parseCreateShipmentResponse(response.data);
        result.success = true;
        result.trackingNumber = parsed.trackingNumber;
        result.parcelNumber = parsed.parcelNumber;
        result.labelPdf = parsed.labelPdf;
      } else {
        result.error = response.error;
      }
    } catch (error) {
      result.error = error.message;
      console.error('[GLSClient] Error creating shipment:', error);
    }

    return result;
  }

  /**
   * Cancel a shipment
   *
   * @param {string} trackingNumber - The tracking number to cancel
   * @returns {Object} { success, status, error }
   */
  async cancelShipment(trackingNumber) {
    const result = {
      success: false,
      status: null,
      error: null
    };

    try {
      const url = `${this.hostname}/backend/rs/shipments/cancel/${trackingNumber}`;

      const response = await axios.post(url, null, {
        headers: {
          'Authorization': this.getAuthHeader()
        }
      });

      if (response.status === 200 || response.status === 201) {
        const data = response.data;
        const status = data.result?.toUpperCase();

        if (status === 'CANCELLED' || status === 'CANCELLATION_PENDING') {
          result.success = true;
          result.status = status;
        } else {
          result.error = `Unexpected status: ${status}`;
        }
      } else {
        result.error = `HTTP ${response.status}: ${response.statusText}`;
      }
    } catch (error) {
      result.error = error.message;
      console.error('[GLSClient] Error cancelling shipment:', error);
    }

    return result;
  }

  /**
   * Get tracking URL for a shipment
   *
   * @param {string} trackingNumber - The tracking number
   * @returns {string} Tracking URL
   */
  getTrackingUrl(trackingNumber) {
    return `https://www.gls-pakete.de/sendungsverfolgung?match=${trackingNumber}`;
  }

  /**
   * Send SOAP request to GLS API
   */
  async sendRequest(requestBody) {
    const url = this.getShipmentApiUrl();

    console.log(`[GLSClient] Sending request to ${url}`);

    try {
      const response = await axios.post(url, requestBody, {
        headers: {
          'Authorization': this.getAuthHeader(),
          'SOAPAction': 'http://fpcs.gls-group.eu/v1/createShipment',
          'Content-Type': 'text/xml; charset="utf-8"'
        }
      });

      if (response.status === 200 || response.status === 201) {
        return { success: true, data: response.data };
      } else {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
    } catch (error) {
      if (error.response) {
        return { success: false, error: error.response.data || error.message };
      }
      throw error;
    }
  }

  /**
   * Build SOAP request body for creating a shipment
   */
  buildShipmentRequest(shipment) {
    const {
      sender,
      receiver,
      reference,
      weight,
      product = 'Parcel',
      service = null,
      shippingDate = null
    } = shipment;

    const today = shippingDate || new Date().toISOString().split('T')[0];

    // Truncate names to 39 chars (GLS limit)
    const truncateName = (name, maxLen = 39) => {
      if (!name) return '';
      return name.length > maxLen ? name.substring(0, maxLen) : name;
    };

    const senderName1 = truncateName(sender.name);
    const senderName2 = truncateName(sender.name?.substring(39, 78) || '');
    const receiverName1 = truncateName(receiver.name);
    const receiverName2 = truncateName(receiver.name?.substring(39, 78) || '');

    let serviceXml = '';
    if (service) {
      serviceXml = `
        <Service>
          <Service xmlns="http://fpcs.gls-group.eu/v1/Common">
            <ServiceName>${service}</ServiceName>
          </Service>
        </Service>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <ShipmentRequestData xmlns="http://fpcs.gls-group.eu/v1/ShipmentProcessing/types">
      <Shipment>
        <ShipmentReference>${reference}</ShipmentReference>
        <ShippingDate>${today}</ShippingDate>
        <IncotermCode></IncotermCode>
        <Identifier></Identifier>
        <Product>${product}</Product>
        <Consignee>
          <ConsigneeID xmlns="http://fpcs.gls-group.eu/v1/Common">${receiver.id || ''}</ConsigneeID>
          <CostCenter xmlns="http://fpcs.gls-group.eu/v1/Common">${receiver.id || ''}</CostCenter>
          <Address xmlns="http://fpcs.gls-group.eu/v1/Common">
            <Name1>${this.escapeXml(receiverName1)}</Name1>
            <Name2>${this.escapeXml(receiverName2)}</Name2>
            <Name3></Name3>
            <CountryCode>${receiver.countryCode || ''}</CountryCode>
            <Province>${receiver.province || ''}</Province>
            <ZIPCode>${receiver.zipCode || ''}</ZIPCode>
            <City>${this.escapeXml(receiver.city || '')}</City>
            <Street>${this.escapeXml(receiver.street || '')}</Street>
            <StreetNumber>${this.escapeXml(receiver.streetNumber || '')}</StreetNumber>
            <eMail>${receiver.email || ''}</eMail>
            <ContactPerson>${this.escapeXml(receiverName1)}</ContactPerson>
            <FixedLinePhonenumber></FixedLinePhonenumber>
            <MobilePhoneNumber>${receiver.phone || ''}</MobilePhoneNumber>
          </Address>
        </Consignee>
        <Shipper>
          <ContactID xmlns="http://fpcs.gls-group.eu/v1/Common">${this.contactId}</ContactID>
          <AlternativeShipperAddress xmlns="http://fpcs.gls-group.eu/v1/Common">
            <Name1>${this.escapeXml(senderName1)}</Name1>
            <Name2>${this.escapeXml(senderName2)}</Name2>
            <Name3></Name3>
            <CountryCode>${sender.countryCode || ''}</CountryCode>
            <Province>${sender.province || ''}</Province>
            <ZIPCode>${sender.zipCode || ''}</ZIPCode>
            <City>${this.escapeXml(sender.city || '')}</City>
            <Street>${this.escapeXml((sender.street || '') + ' ' + (sender.streetNumber || ''))}</Street>
            <StreetNumber></StreetNumber>
            <eMail>${sender.email || ''}</eMail>
            <ContactPerson>${this.escapeXml(senderName1)}</ContactPerson>
            <FixedLinePhonenumber></FixedLinePhonenumber>
            <MobilePhoneNumber>${sender.phone || ''}</MobilePhoneNumber>
          </AlternativeShipperAddress>
        </Shipper>
        <ShipmentUnit>
          <ShipmentUnitReference>${reference}</ShipmentUnitReference>
          <Weight>${weight || 1}</Weight>
          <Service></Service>
        </ShipmentUnit>
        ${serviceXml}
      </Shipment>
      <PrintingOptions>
        <ReturnLabels>
          <TemplateSet>NONE</TemplateSet>
          <LabelFormat>PDF</LabelFormat>
        </ReturnLabels>
      </PrintingOptions>
    </ShipmentRequestData>
  </Body>
</Envelope>`;
  }

  /**
   * Parse the CreateShipment response
   */
  parseCreateShipmentResponse(xmlData) {
    const result = {
      trackingNumber: null,
      parcelNumber: null,
      labelPdf: null
    };

    // Simple XML parsing - extract values using regex
    // For production, consider using a proper XML parser like xml2js

    // Extract TrackID
    const trackIdMatch = xmlData.match(/<TrackID>([^<]+)<\/TrackID>/);
    if (trackIdMatch) {
      result.trackingNumber = trackIdMatch[1];
    }

    // Extract ParcelNumber
    const parcelMatch = xmlData.match(/<ParcelNumber>([^<]+)<\/ParcelNumber>/);
    if (parcelMatch) {
      result.parcelNumber = parcelMatch[1];
    }

    // Extract label PDF data (base64)
    const dataMatch = xmlData.match(/<Data>([^<]+)<\/Data>/);
    if (dataMatch) {
      result.labelPdf = Buffer.from(dataMatch[1], 'base64');
    }

    return result;
  }

  /**
   * Escape XML special characters
   */
  escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Test the connection to GLS API
   */
  async testConnection() {
    console.log('[GLSClient] Testing connection to GLS API...');
    console.log(`  Hostname: ${this.hostname}`);
    console.log(`  User ID: ${this.userId}`);
    console.log(`  Contact ID: ${this.contactId}`);

    // Try a simple request to verify credentials
    // GLS doesn't have a dedicated health check, so we'll just verify the URL is reachable
    try {
      const response = await axios.get(this.hostname, {
        headers: {
          'Authorization': this.getAuthHeader()
        },
        timeout: 10000,
        validateStatus: () => true // Accept any status
      });

      console.log(`[GLSClient] Connection test: HTTP ${response.status}`);
      return {
        success: true,
        message: `Connected to GLS API (HTTP ${response.status})`
      };
    } catch (error) {
      console.error('[GLSClient] Connection test failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the GLSClient instance
 */
function getGLSClient() {
  if (!instance) {
    instance = new GLSClient();
  }
  return instance;
}

module.exports = {
  GLSClient,
  getGLSClient
};
