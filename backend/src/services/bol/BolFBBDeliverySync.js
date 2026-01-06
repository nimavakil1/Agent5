/**
 * BolFBBDeliverySync - Sync FBB (Fulfillment by Bol) delivery status to Odoo
 *
 * FBB orders are fulfilled by Bol.com from their warehouse.
 * This service:
 * 1. Finds FBB orders in Odoo that are not yet marked as delivered
 * 2. Checks Bol.com API for shipment status
 * 3. When shipped, updates Odoo picking to "done" and sets qty_delivered
 *
 * This enables FBB orders to be invoiced via BolSalesInvoicer.
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { getDb } = require('../../db');
const BolShipment = require('../../models/BolShipment');
const { getModuleLogger } = require('../logging/ModuleLogger');

const logger = getModuleLogger('bol');

// Bol.com API
let accessToken = null;
let tokenExpiry = null;

// Stale order threshold: orders older than this that return 404 are marked and skipped
const STALE_ORDER_DAYS = 30;

class BolFBBDeliverySync {
  constructor() {
    this.odoo = null;
    this.isRunning = false;
    this.lastSync = null;
    this.lastResult = null;
    this.staleOrders = []; // Track orders marked as stale during this run
  }

  /**
   * Initialize the service
   */
  async init() {
    if (!this.odoo) {
      this.odoo = new OdooDirectClient();
      await this.odoo.authenticate();
    }
    // Ensure the stale marker field exists
    await this.ensureStaleFieldExists();
    return this;
  }

  /**
   * Ensure x_fbb_stale_404 field exists on sale.order
   */
  async ensureStaleFieldExists() {
    try {
      // Check if field exists
      const fields = await this.odoo.execute('ir.model.fields', 'search_read',
        [[['model', '=', 'sale.order'], ['name', '=', 'x_fbb_stale_404']]],
        { fields: ['id'] }
      );

      if (fields.length === 0) {
        // Create the field
        await this.odoo.execute('ir.model.fields', 'create', [{
          name: 'x_fbb_stale_404',
          field_description: 'FBB Stale 404 (Order not found on Bol)',
          model_id: (await this.odoo.execute('ir.model', 'search', [[['model', '=', 'sale.order']]]))[0],
          ttype: 'boolean',
          store: true
        }]);
        console.log('[BolFBBDeliverySync] Created x_fbb_stale_404 field on sale.order');
      }
    } catch (err) {
      // Field might already exist or we don't have permission - continue anyway
      console.log('[BolFBBDeliverySync] Note: Could not verify x_fbb_stale_404 field:', err.message);
    }
  }

  /**
   * Mark an order as stale 404 (order not found on Bol, older than 30 days)
   */
  async markOrderAsStale404(orderId, orderName, orderDate) {
    try {
      await this.odoo.write('sale.order', [orderId], { x_fbb_stale_404: true });
      console.log(`[BolFBBDeliverySync] Marked ${orderName} as stale 404 (order date: ${orderDate})`);
      this.staleOrders.push({ orderId, orderName, orderDate });
      return true;
    } catch (err) {
      console.log(`[BolFBBDeliverySync] Could not mark ${orderName} as stale:`, err.message);
      return false;
    }
  }

  /**
   * Check if an order is older than the stale threshold
   */
  isOrderStale(orderDate) {
    const orderDateObj = new Date(orderDate);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - STALE_ORDER_DAYS);
    return orderDateObj < cutoffDate;
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
   * Make a Bol.com API request
   */
  async bolRequest(endpoint, method = 'GET') {
    const token = await this.getAccessToken();

    const response = await fetch(`https://api.bol.com/retailer${endpoint}`, {
      method,
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.log(`[BolFBBDeliverySync] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, method);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Bol.com API error: ${response.status}`);
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
   * Extract Bol order ID from Odoo order name (e.g., "FBBA000DLU8TM" -> "A000DLU8TM")
   * FBB prefix is 3 chars, Bol order IDs start with "A" (e.g., A000DLU8TM)
   */
  extractBolOrderId(odooOrderName) {
    // Remove FBB prefix only (3 chars), keep the Bol order ID including the "A"
    if (odooOrderName.startsWith('FBB')) {
      return odooOrderName.substring(3);
    }
    return odooOrderName;
  }

  /**
   * Check if Bol order has been shipped (via API or local BolShipment collection)
   */
  async checkBolShipmentStatus(bolOrderId) {
    // First, check local BolShipment collection
    try {
      const shipment = await BolShipment.findOne({ orderId: bolOrderId });
      if (shipment) {
        return {
          shipped: true,
          shipmentId: shipment.shipmentId,
          shipmentDateTime: shipment.shipmentDateTime,
          trackAndTrace: shipment.transport?.trackAndTrace || '',
          source: 'mongodb'
        };
      }
    } catch (err) {
      console.log(`[BolFBBDeliverySync] MongoDB check failed for ${bolOrderId}:`, err.message);
    }

    // Fall back to Bol API
    try {
      const order = await this.bolRequest(`/orders/${bolOrderId}`);

      // Check if any order items are shipped by looking at quantityShipped > 0
      // The API doesn't have a 'fulfilmentStatus' field - we check quantityShipped instead
      let totalQuantity = 0;
      let totalShipped = 0;

      for (const item of order.orderItems || []) {
        totalQuantity += item.quantity || 0;
        totalShipped += item.quantityShipped || 0;
      }

      if (totalShipped > 0) {
        // At least some items have shipped
        const fullyShipped = totalShipped >= totalQuantity;
        return {
          shipped: true,
          fullyShipped,
          totalQuantity,
          totalShipped,
          shipmentDateTime: new Date(),
          source: 'api'
        };
      }

      return { shipped: false, totalQuantity, totalShipped };
    } catch (err) {
      // Order might not be found (404) - check shipments API
      console.log(`[BolFBBDeliverySync] Order API failed for ${bolOrderId}:`, err.message);
      return { shipped: false, error: err.message };
    }
  }

  /**
   * Mark Odoo picking as done and set qty_delivered on order lines
   */
  async markDelivered(saleOrderId, saleOrderName) {
    console.log(`[BolFBBDeliverySync] Marking ${saleOrderName} as delivered...`);

    // Get the picking
    const pickings = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', saleOrderId],
        ['picking_type_code', '=', 'outgoing'],
        ['state', '!=', 'done'],
        ['state', '!=', 'cancel']
      ],
      ['id', 'name', 'state', 'move_ids']
    );

    if (pickings.length === 0) {
      console.log(`[BolFBBDeliverySync] No open picking found for ${saleOrderName}`);
      // Try to set qty_delivered directly on order lines
      return this.setQtyDeliveredDirectly(saleOrderId, saleOrderName);
    }

    const picking = pickings[0];
    console.log(`[BolFBBDeliverySync] Found picking ${picking.name} in state ${picking.state}`);

    try {
      // First, check reserved quantity and set it on moves
      if (picking.move_ids && picking.move_ids.length > 0) {
        const moves = await this.odoo.searchRead('stock.move',
          [['id', 'in', picking.move_ids]],
          ['id', 'product_uom_qty', 'quantity_done']
        );

        for (const move of moves) {
          if (move.quantity_done < move.product_uom_qty) {
            // Set quantity_done = product_uom_qty
            await this.odoo.write('stock.move', [move.id], {
              quantity_done: move.product_uom_qty
            });
          }
        }
      }

      // Try to validate the picking
      await this.odoo.execute('stock.picking', 'button_validate', [[picking.id]]);

      console.log(`[BolFBBDeliverySync] Picking ${picking.name} validated`);
      return { success: true, method: 'picking_validate', pickingName: picking.name };

    } catch (error) {
      console.log(`[BolFBBDeliverySync] Could not validate picking: ${error.message}`);

      // Fall back to setting qty_delivered directly
      return this.setQtyDeliveredDirectly(saleOrderId, saleOrderName);
    }
  }

  /**
   * Set qty_delivered directly on sale order lines (fallback method)
   */
  async setQtyDeliveredDirectly(saleOrderId, saleOrderName) {
    console.log(`[BolFBBDeliverySync] Setting qty_delivered directly for ${saleOrderName}...`);

    // Get order lines
    const lines = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', saleOrderId], ['product_id', '!=', false]],
      ['id', 'product_uom_qty', 'qty_delivered']
    );

    let updated = 0;
    for (const line of lines) {
      if (line.qty_delivered < line.product_uom_qty) {
        await this.odoo.write('sale.order.line', [line.id], {
          qty_delivered: line.product_uom_qty
        });
        updated++;
      }
    }

    if (updated > 0) {
      console.log(`[BolFBBDeliverySync] Updated ${updated} lines for ${saleOrderName}`);
      return { success: true, method: 'qty_delivered_direct', linesUpdated: updated };
    }

    return { success: false, method: 'none', reason: 'No lines to update' };
  }

  /**
   * Process a single FBB order
   */
  async processOrder(order) {
    const result = {
      orderId: order.id,
      orderName: order.name,
      success: false,
      skipped: false,
      error: null
    };

    try {
      // Extract Bol order ID
      const bolOrderId = this.extractBolOrderId(order.name);

      // Check if shipped on Bol.com
      const shipmentStatus = await this.checkBolShipmentStatus(bolOrderId);

      if (!shipmentStatus.shipped) {
        result.skipped = true;
        if (shipmentStatus.error) {
          result.skipReason = shipmentStatus.error;

          // If order is older than 30 days AND returned 404/error, mark it as stale
          // so we don't keep checking it again and again
          if (shipmentStatus.error.includes('not found') && order.date_order && this.isOrderStale(order.date_order)) {
            await this.markOrderAsStale404(order.id, order.name, order.date_order);
            result.markedStale = true;
          }
        } else {
          result.skipReason = `Not yet shipped (${shipmentStatus.totalShipped || 0}/${shipmentStatus.totalQuantity || '?'} items shipped)`;
        }
        return result;
      }

      console.log(`[BolFBBDeliverySync] Order ${order.name} is shipped on Bol.com`);

      // Mark as delivered in Odoo
      const deliveryResult = await this.markDelivered(order.id, order.name);

      if (deliveryResult.success) {
        result.success = true;
        result.method = deliveryResult.method;
        result.pickingName = deliveryResult.pickingName;
        console.log(`[BolFBBDeliverySync] ✓ ${order.name} marked as delivered (${deliveryResult.method})`);
      } else {
        result.error = deliveryResult.reason || 'Failed to mark as delivered';
      }

    } catch (error) {
      result.error = error.message;
      console.error(`[BolFBBDeliverySync] Error processing ${order.name}:`, error.message);
    }

    return result;
  }

  /**
   * Run sync for all pending FBB orders
   */
  async syncAll(options = {}) {
    const { limit = 100 } = options;

    if (this.isRunning) {
      console.log('[BolFBBDeliverySync] Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    this.isRunning = true;
    this.staleOrders = []; // Reset stale orders list for this run
    const startTime = Date.now();
    const timer = logger.startTimer('FBB_DELIVERY_SYNC', 'scheduler');

    try {
      await this.init();

      console.log('[BolFBBDeliverySync] Finding FBB orders with pending delivery...');

      // Find FBB orders with invoice_status = 'no' (means qty_delivered = 0)
      // Sort by date_order DESC to process newest orders first (old orders often return 404)
      // Exclude orders already marked as stale 404
      const orders = await this.odoo.searchRead('sale.order',
        [
          ['name', 'like', 'FBBA%'],  // FBB orders have FBBA prefix
          ['state', 'in', ['sale', 'done']],
          ['invoice_status', '=', 'no'],  // Not yet deliverable for invoicing
          '|', ['x_fbb_stale_404', '=', false], ['x_fbb_stale_404', '=', null]  // Exclude stale 404 orders
        ],
        ['id', 'name', 'state', 'date_order'],
        { limit, order: 'date_order desc' }
      );

      console.log(`[BolFBBDeliverySync] Found ${orders.length} FBB orders with pending delivery`);

      if (orders.length === 0) {
        this.isRunning = false;
        await timer.info('No FBB orders need delivery sync');
        return { success: true, processed: 0, delivered: 0, skipped: 0, message: 'No pending orders' };
      }

      let processed = 0;
      let delivered = 0;
      let skipped = 0;
      let failed = 0;
      const errors = [];

      for (const order of orders) {
        processed++;
        const result = await this.processOrder(order);

        if (result.success) {
          delivered++;
        } else if (result.skipped) {
          skipped++;
        } else {
          failed++;
          errors.push({ orderName: order.name, error: result.error });
        }

        // Rate limiting
        await this.sleep(200);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastSync = new Date();
      this.lastResult = {
        processed,
        delivered,
        skipped,
        failed,
        duration,
        errors: errors.slice(0, 10),
        staleOrders: this.staleOrders
      };

      const staleCount = this.staleOrders.length;
      const summary = `FBB delivery sync: ${delivered} marked delivered, ${skipped} skipped, ${failed} failed, ${staleCount} marked stale`;
      if (delivered > 0) {
        await timer.success(summary, { details: this.lastResult });
      } else {
        await timer.info(summary, { details: this.lastResult });
      }

      console.log(`[BolFBBDeliverySync] Sync complete in ${duration}s: ${delivered} delivered, ${skipped} skipped, ${failed} failed, ${staleCount} marked stale`);

      // Log stale orders if any
      if (this.staleOrders.length > 0) {
        console.log(`[BolFBBDeliverySync] Stale 404 orders (older than ${STALE_ORDER_DAYS} days, not found on Bol):`);
        for (const staleOrder of this.staleOrders) {
          console.log(`  - ${staleOrder.orderName} (date: ${staleOrder.orderDate})`);
        }
      }

      return {
        success: true,
        processed,
        delivered,
        skipped,
        failed,
        duration: `${duration}s`,
        errors: errors.slice(0, 10),
        staleOrders: this.staleOrders
      };

    } catch (error) {
      console.error('[BolFBBDeliverySync] Sync error:', error);
      await timer.error('FBB delivery sync failed', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
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
 * Get or create the BolFBBDeliverySync instance
 */
async function getBolFBBDeliverySync() {
  if (!instance) {
    instance = new BolFBBDeliverySync();
  }
  return instance;
}

/**
 * Run FBB delivery sync (for scheduler)
 */
async function runFBBDeliverySync(options = {}) {
  const sync = await getBolFBBDeliverySync();
  return sync.syncAll(options);
}

module.exports = {
  BolFBBDeliverySync,
  getBolFBBDeliverySync,
  runFBBDeliverySync
};
