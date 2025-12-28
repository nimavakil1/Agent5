/**
 * BolShipmentSync - Auto-confirm shipments to Bol.com when Odoo picking done
 *
 * Monitors Bol orders that have Odoo sale orders but haven't been confirmed on Bol.com.
 * When the Odoo picking is marked as 'done', confirms the shipment to Bol.com.
 *
 * Only processes FBR (Fulfillment by Retailer) orders - FBB orders are shipped by Bol.
 *
 * Flow:
 * 1. Find Bol orders with Odoo link but no shipment confirmation
 * 2. For each order, check if Odoo picking is 'done'
 * 3. If done, get tracking info and confirm shipment to Bol.com
 * 4. Update MongoDB with shipment confirmation status
 */

const BolOrder = require('../../models/BolOrder');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Carrier name to Bol transporter code mapping
// Reference: https://api.bol.com/retailer/public/Retailer-API/v10/functional/retailer-api/orders-shipments.html
// Note: Some use DASH, others use UNDERSCORE - must match exactly!
const CARRIER_MAP = {
  // PostNL variants
  'PostNL': 'TNT',              // Bol uses TNT code for PostNL
  'PostNL Domestic': 'TNT',
  'PostNL Extra': 'TNT-EXTRA',  // PostNL extra@home
  'PostNL Brief': 'TNT_BRIEF',  // PostNL Briefpost
  'TNT': 'TNT',
  'TNT Express': 'TNT-EXPRESS',

  // DHL variants
  'DHL': 'DHL',
  'DHL Express': 'DHL',
  'DHL Parcel': 'DHLFORYOU',
  'DHL For You': 'DHLFORYOU',
  'DHLFORYOU': 'DHLFORYOU',
  'DHL Germany': 'DHL_DE',
  'DHL DE': 'DHL_DE',
  'DHL Global Mail': 'DHL-GLOBAL-MAIL',
  'DHL Same Day': 'DHL-SD',

  // DPD variants
  'DPD': 'DPD-NL',
  'DPD NL': 'DPD-NL',
  'DPD Nederland': 'DPD-NL',
  'DPD BE': 'DPD-BE',
  'DPD Belgium': 'DPD-BE',

  // Bpost variants
  'Bpost': 'BPOST_BE',
  'bpost': 'BPOST_BE',
  'Bpost BE': 'BPOST_BE',
  'Bpost Brief': 'BPOST_BRIEF',

  // Other carriers
  'GLS': 'GLS',
  'UPS': 'UPS',
  'FedEx': 'FEDEX_NL',
  'FedEx NL': 'FEDEX_NL',
  'FedEx BE': 'FEDEX_BE',
  'Dynalogic': 'DYL',
  'Budbee': 'BUDBEE',
  'Trunkrs': 'TRUNKRS',
  'TransMission': 'TRANSMISSION',
  'Parcel.nl': 'PARCEL-NL',
  'Briefpost': 'BRIEFPOST',

  // Fallback
  'Other': 'OTHER'
};

// Rate limiting
const REQUEST_DELAY_MS = 100;
const MAX_RETRIES = 3;

// Token cache
let accessToken = null;
let tokenExpiry = null;

class BolShipmentSync {
  constructor() {
    this.odoo = null;
    this.isRunning = false;
    this.lastSync = null;
    this.lastResult = null;
  }

  /**
   * Initialize the sync service
   */
  async init() {
    if (!this.odoo) {
      this.odoo = new OdooDirectClient();
      await this.odoo.authenticate();
    }
    return this;
  }

  /**
   * Get Bol.com access token
   */
  async getAccessToken() {
    const clientId = process.env.BOL_CLIENT_ID;
    const clientSecret = process.env.BOL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Bol.com credentials not configured');
    }

    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
      return accessToken;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://login.bol.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    return accessToken;
  }

  /**
   * Make a Bol.com API request with retry logic
   */
  async bolRequest(endpoint, method = 'GET', body = null, retries = MAX_RETRIES) {
    const token = await this.getAccessToken();

    const options = {
      method,
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/vnd.retailer.v10+json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`https://api.bol.com/retailer${endpoint}`, options);

    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.log(`[BolShipmentSync] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, method, body, retries - 1);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Bol.com API error: ${response.status}`);
    }

    if (response.status === 204) {
      return { success: true };
    }

    return response.json();
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get carrier code for Bol.com from Odoo carrier name
   */
  getTransporterCode(carrierName) {
    if (!carrierName) return 'OTHER';

    for (const [pattern, code] of Object.entries(CARRIER_MAP)) {
      if (carrierName.toLowerCase().includes(pattern.toLowerCase())) {
        return code;
      }
    }

    return 'OTHER';
  }

  /**
   * Check Odoo picking status for a sale order
   */
  async getPickingStatus(saleOrderId) {
    const pickings = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', saleOrderId],
        ['picking_type_code', '=', 'outgoing']
      ],
      ['id', 'name', 'state', 'carrier_tracking_ref', 'carrier_id', 'date_done']
    );

    if (pickings.length === 0) {
      return null;
    }

    // Get the most recent picking (in case of backorders)
    const donePicking = pickings.find(p => p.state === 'done');
    if (!donePicking) {
      // Return pending if any picking exists but not done
      return { state: pickings[0].state, picking: pickings[0] };
    }

    // Get carrier name if available
    let carrierName = null;
    if (donePicking.carrier_id) {
      const carriers = await this.odoo.read('delivery.carrier',
        [donePicking.carrier_id[0]],
        ['name']
      );
      if (carriers.length > 0) {
        carrierName = carriers[0].name;
      }
    }

    return {
      state: 'done',
      picking: donePicking,
      pickingName: donePicking.name,
      trackingRef: donePicking.carrier_tracking_ref || '',
      carrierName,
      dateDone: donePicking.date_done
    };
  }

  /**
   * Confirm shipment to Bol.com for an order
   */
  async confirmShipment(bolOrderId, orderItems, transport) {
    const shipmentData = {
      orderItems: orderItems.map(item => ({
        orderItemId: item.orderItemId
      }))
    };

    if (transport) {
      shipmentData.transport = transport;
    }

    return this.bolRequest('/shipments', 'POST', shipmentData);
  }

  /**
   * Process a single Bol order for shipment confirmation
   */
  async processOrder(bolOrder) {
    const result = {
      orderId: bolOrder.orderId,
      success: false,
      skipped: false,
      error: null
    };

    try {
      // Skip if already confirmed
      if (bolOrder.shipmentConfirmedAt) {
        result.skipped = true;
        result.skipReason = 'Already confirmed';
        return result;
      }

      // Skip FBB orders (fulfilled by Bol)
      if (bolOrder.fulfilmentMethod === 'FBB') {
        result.skipped = true;
        result.skipReason = 'FBB order - fulfilled by Bol';
        return result;
      }

      // Check if has Odoo order
      if (!bolOrder.odoo?.saleOrderId) {
        result.skipped = true;
        result.skipReason = 'No Odoo order linked';
        return result;
      }

      // Get Odoo picking status
      const pickingStatus = await this.getPickingStatus(bolOrder.odoo.saleOrderId);

      if (!pickingStatus) {
        result.skipped = true;
        result.skipReason = 'No picking found in Odoo';
        return result;
      }

      if (pickingStatus.state !== 'done') {
        result.skipped = true;
        result.skipReason = `Picking not done (state: ${pickingStatus.state})`;
        return result;
      }

      // Build transport info
      const transport = {
        transporterCode: this.getTransporterCode(pickingStatus.carrierName)
      };

      if (pickingStatus.trackingRef) {
        transport.trackAndTrace = pickingStatus.trackingRef;
      }

      // Confirm shipment to Bol.com
      await this.confirmShipment(
        bolOrder.orderId,
        bolOrder.orderItems || [],
        transport
      );

      // Update MongoDB
      await BolOrder.updateOne(
        { orderId: bolOrder.orderId },
        {
          $set: {
            shipmentConfirmedAt: new Date(),
            shipmentReference: pickingStatus.pickingName,
            trackingCode: pickingStatus.trackingRef || '',
            status: 'SHIPPED'
          }
        }
      );

      result.success = true;
      result.pickingName = pickingStatus.pickingName;
      result.trackingRef = pickingStatus.trackingRef;

      console.log(`[BolShipmentSync] Confirmed shipment for order ${bolOrder.orderId}`);

    } catch (error) {
      result.error = error.message;
      console.error(`[BolShipmentSync] Error processing order ${bolOrder.orderId}:`, error);
    }

    return result;
  }

  /**
   * Run shipment sync for all pending orders
   */
  async syncAll() {
    if (this.isRunning) {
      console.log('[BolShipmentSync] Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      await this.init();

      // Find FBR orders with Odoo link but no shipment confirmation
      const pendingOrders = await BolOrder.find({
        'odoo.saleOrderId': { $exists: true, $ne: null },
        shipmentConfirmedAt: { $exists: false },
        fulfilmentMethod: 'FBR',
        status: { $ne: 'CANCELLED' }
      })
        .sort({ orderPlacedDateTime: -1 })
        .limit(100)
        .lean();

      console.log(`[BolShipmentSync] Found ${pendingOrders.length} pending orders to check`);

      if (pendingOrders.length === 0) {
        this.isRunning = false;
        return { success: true, confirmed: 0, skipped: 0, message: 'No pending orders' };
      }

      let confirmed = 0;
      let skipped = 0;
      let failed = 0;
      const errors = [];

      for (const order of pendingOrders) {
        const result = await this.processOrder(order);

        if (result.success) {
          confirmed++;
        } else if (result.skipped) {
          skipped++;
        } else {
          failed++;
          errors.push({ orderId: order.orderId, error: result.error });
        }

        await this.sleep(REQUEST_DELAY_MS);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastSync = new Date();
      this.lastResult = { confirmed, skipped, failed, duration, errors: errors.slice(0, 10) };

      console.log(`[BolShipmentSync] Sync complete in ${duration}s: ${confirmed} confirmed, ${skipped} skipped, ${failed} failed`);

      return {
        success: true,
        confirmed,
        skipped,
        failed,
        duration: `${duration}s`,
        errors: errors.slice(0, 10)
      };

    } catch (error) {
      console.error('[BolShipmentSync] Sync error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Confirm shipment for a single order (manual trigger)
   */
  async confirmSingleOrder(orderId) {
    await this.init();

    const bolOrder = await BolOrder.findOne({ orderId }).lean();
    if (!bolOrder) {
      return { success: false, error: 'Order not found' };
    }

    return this.processOrder(bolOrder);
  }

  /**
   * Get sync status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastSync: this.lastSync,
      lastResult: this.lastResult
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolShipmentSync instance
 */
async function getBolShipmentSync() {
  if (!instance) {
    instance = new BolShipmentSync();
  }
  return instance;
}

/**
 * Run shipment sync (for scheduler)
 */
async function runShipmentSync() {
  const sync = await getBolShipmentSync();
  return sync.syncAll();
}

module.exports = {
  BolShipmentSync,
  getBolShipmentSync,
  runShipmentSync,
  CARRIER_MAP
};
