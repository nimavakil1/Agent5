/**
 * BolCancellationHandler - Handle customer cancellation requests from Bol.com
 *
 * Workflow:
 * 1. Poll for orders with cancellation requests
 * 2. Check if Odoo delivery quantities are done
 * 3. If no qty done (all lines have 0 done) -> Accept cancellation, cancel Odoo order
 * 4. If any qty done (even partial) -> Reject cancellation (too late, already shipped)
 *
 * Reference: https://api.bol.com/retailer/public/Retailer-API/v10/functional/retailer-api/orders-shipments.html
 */

const BolOrder = require('../../models/BolOrder');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Rate limiting
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;

// Token cache
let accessToken = null;
let tokenExpiry = null;

// Cancellation reasons for Bol.com
const CANCELLATION_REASONS = {
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  REQUESTED_BY_CUSTOMER: 'REQUESTED_BY_CUSTOMER',
  BAD_CONDITION: 'BAD_CONDITION',
  HIGHER_SHIPCOST: 'HIGHER_SHIPCOST',
  INCORRECT_PRICE: 'INCORRECT_PRICE',
  NOT_AVAIL_IN_TIME: 'NOT_AVAIL_IN_TIME',
  NO_BOL_GUARANTEE: 'NO_BOL_GUARANTEE',
  ORDERED_TWICE: 'ORDERED_TWICE',
  RETAIN_ITEM: 'RETAIN_ITEM',
  TECH_ISSUE: 'TECH_ISSUE',
  UNFINDABLE_ITEM: 'UNFINDABLE_ITEM',
  OTHER: 'OTHER'
};

class BolCancellationHandler {
  constructor() {
    this.odoo = null;
    this.isRunning = false;
    this.lastCheck = null;
    this.lastResult = null;
  }

  /**
   * Initialize the handler
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
      console.log(`[BolCancellation] Rate limited, waiting ${retryAfter}s...`);
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
   * Check Odoo delivery status for a sale order
   * Returns: { canCancel: boolean, reason: string, doneQty: number }
   */
  async checkDeliveryStatus(saleOrderId) {
    // Get all outgoing pickings for this sale order
    const pickings = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', saleOrderId],
        ['picking_type_code', '=', 'outgoing']
      ],
      ['id', 'name', 'state', 'move_ids']
    );

    if (pickings.length === 0) {
      // No picking yet - can cancel
      return { canCancel: true, reason: 'No delivery created yet', doneQty: 0 };
    }

    // Check all move lines for done quantities
    let totalDoneQty = 0;
    let hasShippingLabel = false;

    for (const picking of pickings) {
      // If picking is done, cannot cancel
      if (picking.state === 'done') {
        return {
          canCancel: false,
          reason: `Delivery ${picking.name} is already done`,
          doneQty: -1 // Indicates fully shipped
        };
      }

      // Check individual move lines
      if (picking.move_ids && picking.move_ids.length > 0) {
        const moves = await this.odoo.read('stock.move', picking.move_ids,
          ['quantity_done', 'product_uom_qty']
        );

        for (const move of moves) {
          totalDoneQty += move.quantity_done || 0;
        }
      }

      // Check if there's a tracking reference (shipping label created)
      const pickingDetail = await this.odoo.read('stock.picking', [picking.id],
        ['carrier_tracking_ref']
      );
      if (pickingDetail[0]?.carrier_tracking_ref) {
        hasShippingLabel = true;
      }
    }

    if (hasShippingLabel) {
      return {
        canCancel: false,
        reason: 'Shipping label already created',
        doneQty: totalDoneQty
      };
    }

    if (totalDoneQty > 0) {
      return {
        canCancel: false,
        reason: `Partial quantity already processed (${totalDoneQty} units done)`,
        doneQty: totalDoneQty
      };
    }

    return {
      canCancel: true,
      reason: 'No quantities processed yet',
      doneQty: 0
    };
  }

  /**
   * Cancel an order in Odoo
   */
  async cancelOdooOrder(saleOrderId) {
    try {
      // Get current order state
      const orders = await this.odoo.read('sale.order', [saleOrderId], ['state', 'name']);
      if (!orders.length) {
        return { success: false, error: 'Order not found in Odoo' };
      }

      const order = orders[0];

      // Cancel pickings first
      const pickings = await this.odoo.searchRead('stock.picking',
        [['sale_id', '=', saleOrderId], ['state', 'not in', ['done', 'cancel']]],
        ['id', 'name']
      );

      for (const picking of pickings) {
        try {
          await this.odoo.execute('stock.picking', 'action_cancel', [[picking.id]]);
          console.log(`[BolCancellation] Cancelled picking ${picking.name}`);
        } catch (e) {
          console.warn(`[BolCancellation] Could not cancel picking ${picking.name}: ${e.message}`);
        }
      }

      // Cancel the sale order
      if (order.state === 'sale') {
        await this.odoo.execute('sale.order', 'action_cancel', [[saleOrderId]]);
        console.log(`[BolCancellation] Cancelled Odoo order ${order.name}`);
      }

      return { success: true, orderName: order.name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Accept cancellation on Bol.com
   */
  async acceptCancellation(orderItemId) {
    // Bol.com cancellation is done by not shipping the item
    // The order will be automatically cancelled after the delivery deadline
    // Or we can explicitly cancel via the API
    try {
      await this.bolRequest(`/orders/${orderItemId}/cancellation`, 'PUT', {
        reasonCode: CANCELLATION_REASONS.REQUESTED_BY_CUSTOMER
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Reject cancellation - ship the order
   * (The order will be shipped normally, customer can return after receiving)
   */
  async rejectCancellation(_orderId) {
    // No API call needed - just continue with shipment
    // Customer can return the item after receiving it
    return {
      success: true,
      message: 'Cancellation rejected - order will be shipped. Customer can return after receiving.'
    };
  }

  /**
   * Process a single cancellation request
   */
  async processCancellationRequest(bolOrder) {
    const result = {
      orderId: bolOrder.orderId,
      success: false,
      action: null,
      reason: null,
      error: null
    };

    try {
      // Check if order has Odoo link
      if (!bolOrder.odoo?.saleOrderId) {
        result.action = 'ACCEPT';
        result.reason = 'No Odoo order exists, accepting cancellation';

        // Accept cancellation for all items
        for (const item of (bolOrder.orderItems || [])) {
          if (item.cancellationRequest) {
            await this.acceptCancellation(item.orderItemId);
          }
        }

        // Update MongoDB
        await BolOrder.updateOne(
          { orderId: bolOrder.orderId },
          {
            $set: {
              cancelledAt: new Date(),
              cancellationReason: 'Customer request - no Odoo order',
              status: 'CANCELLED'
            }
          }
        );

        result.success = true;
        return result;
      }

      // Check delivery status in Odoo
      const deliveryStatus = await this.checkDeliveryStatus(bolOrder.odoo.saleOrderId);

      if (deliveryStatus.canCancel) {
        // Accept cancellation
        result.action = 'ACCEPT';
        result.reason = deliveryStatus.reason;

        // Cancel in Odoo
        const odooResult = await this.cancelOdooOrder(bolOrder.odoo.saleOrderId);
        if (!odooResult.success) {
          result.error = `Odoo cancellation failed: ${odooResult.error}`;
          return result;
        }

        // Accept on Bol.com
        for (const item of (bolOrder.orderItems || [])) {
          if (item.cancellationRequest) {
            await this.acceptCancellation(item.orderItemId);
          }
        }

        // Update MongoDB
        await BolOrder.updateOne(
          { orderId: bolOrder.orderId },
          {
            $set: {
              cancelledAt: new Date(),
              cancellationReason: 'Customer request - accepted',
              status: 'CANCELLED'
            }
          }
        );

        result.success = true;
        console.log(`[BolCancellation] Accepted cancellation for order ${bolOrder.orderId}`);

      } else {
        // Reject cancellation
        result.action = 'REJECT';
        result.reason = deliveryStatus.reason;

        // Update MongoDB to clear cancellation request flag
        await BolOrder.updateOne(
          { orderId: bolOrder.orderId },
          {
            $set: {
              'orderItems.$[].cancellationRequest': false,
              cancellationReason: `Rejected: ${deliveryStatus.reason}`
            }
          }
        );

        result.success = true;
        console.log(`[BolCancellation] Rejected cancellation for order ${bolOrder.orderId}: ${deliveryStatus.reason}`);
      }

    } catch (error) {
      result.error = error.message;
      console.error(`[BolCancellation] Error processing order ${bolOrder.orderId}:`, error);
    }

    return result;
  }

  /**
   * Check for and process all pending cancellation requests
   */
  async processAllCancellations() {
    if (this.isRunning) {
      console.log('[BolCancellation] Already running, skipping');
      return { success: false, message: 'Already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      await this.init();

      // Find orders with cancellation requests
      const ordersWithCancellation = await BolOrder.find({
        'orderItems.cancellationRequest': true,
        status: { $nin: ['CANCELLED', 'SHIPPED'] }
      })
        .sort({ orderPlacedDateTime: -1 })
        .limit(50)
        .lean();

      console.log(`[BolCancellation] Found ${ordersWithCancellation.length} orders with cancellation requests`);

      if (ordersWithCancellation.length === 0) {
        this.isRunning = false;
        return { success: true, processed: 0, message: 'No cancellation requests to process' };
      }

      let accepted = 0;
      let rejected = 0;
      let failed = 0;
      const errors = [];

      for (const order of ordersWithCancellation) {
        const result = await this.processCancellationRequest(order);

        if (result.success) {
          if (result.action === 'ACCEPT') {
            accepted++;
          } else {
            rejected++;
          }
        } else {
          failed++;
          errors.push({ orderId: order.orderId, error: result.error });
        }

        await this.sleep(REQUEST_DELAY_MS);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastCheck = new Date();
      this.lastResult = { accepted, rejected, failed, duration, errors: errors.slice(0, 10) };

      console.log(`[BolCancellation] Complete in ${duration}s: ${accepted} accepted, ${rejected} rejected, ${failed} failed`);

      return {
        success: true,
        processed: ordersWithCancellation.length,
        accepted,
        rejected,
        failed,
        duration: `${duration}s`,
        errors: errors.slice(0, 10)
      };

    } catch (error) {
      console.error('[BolCancellation] Error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Manually check cancellation status for a single order
   */
  async checkOrder(orderId) {
    await this.init();

    const bolOrder = await BolOrder.findOne({ orderId }).lean();
    if (!bolOrder) {
      return { success: false, error: 'Order not found' };
    }

    if (!bolOrder.odoo?.saleOrderId) {
      return {
        success: true,
        orderId,
        canCancel: true,
        reason: 'No Odoo order linked'
      };
    }

    const deliveryStatus = await this.checkDeliveryStatus(bolOrder.odoo.saleOrderId);

    return {
      success: true,
      orderId,
      odooOrderId: bolOrder.odoo.saleOrderId,
      odooOrderName: bolOrder.odoo.saleOrderName,
      ...deliveryStatus
    };
  }

  /**
   * Get handler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastCheck: this.lastCheck,
      lastResult: this.lastResult
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolCancellationHandler instance
 */
async function getBolCancellationHandler() {
  if (!instance) {
    instance = new BolCancellationHandler();
  }
  return instance;
}

/**
 * Run cancellation check (for scheduler)
 */
async function runCancellationCheck() {
  const handler = await getBolCancellationHandler();
  return handler.processAllCancellations();
}

module.exports = {
  BolCancellationHandler,
  getBolCancellationHandler,
  runCancellationCheck,
  CANCELLATION_REASONS
};
