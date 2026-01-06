/**
 * Bol.com Sales Invoicer
 *
 * Automatically creates and posts customer invoices for Bol.com orders.
 *
 * Flow:
 * 1. Find Bol orders (FBB/FBR/BOL prefix) with invoice_status = 'to invoice'
 * 2. Check that orders are fully delivered (no open qty)
 * 3. Create invoices from sale orders using Odoo's native method
 * 4. Post the invoices automatically
 *
 * This runs as a scheduled nightly job via BolScheduler.js
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { getModuleLogger } = require('../logging/ModuleLogger');

const logger = getModuleLogger('bol');

class BolSalesInvoicer {
  constructor(odooClient = null) {
    this.odoo = odooClient;
  }

  /**
   * Initialize Odoo client if not provided
   */
  async init() {
    if (!this.odoo) {
      this.odoo = new OdooDirectClient();
      await this.odoo.authenticate();
    }
  }

  /**
   * Find Bol orders that are ready for invoicing:
   * - Status 'to invoice'
   * - Fully delivered (all order lines have qty_delivered >= qty_ordered)
   * - Order state is 'sale' or 'done'
   *
   * @param {object} options - Query options
   * @param {number} options.limit - Maximum orders to return (default: 500)
   * @returns {Promise<object[]>} Array of orders ready for invoicing
   */
  async findOrdersReadyForInvoicing(options = {}) {
    const { limit = 500 } = options;

    await this.init();

    console.log('[BolSalesInvoicer] Finding Bol orders ready for invoicing...');

    // Search for Bol orders with invoice_status = 'to invoice'
    // Bol orders have prefixes: FBB (Fulfillment by Bol), FBR (Fulfillment by Retailer), BOL
    const orders = await this.odoo.searchRead('sale.order',
      [
        ['invoice_status', '=', 'to invoice'],
        ['state', 'in', ['sale', 'done']],
        '|', '|',
        ['name', 'like', 'FBB%'],
        ['name', 'like', 'FBR%'],
        ['name', 'like', 'BOL%']
      ],
      ['id', 'name', 'client_order_ref', 'partner_id', 'amount_total', 'order_line', 'state'],
      { limit, order: 'id asc' }
    );

    console.log(`[BolSalesInvoicer] Found ${orders.length} Bol orders with invoice_status='to invoice'`);

    if (orders.length === 0) {
      return [];
    }

    // Filter to only fully delivered orders
    const ordersReadyForInvoicing = [];

    for (const order of orders) {
      // Get order lines to check delivery status
      const lines = await this.odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'product_id']
      );

      // Skip orders with no product lines
      const productLines = lines.filter(l => l.product_id);
      if (productLines.length === 0) {
        console.log(`[BolSalesInvoicer] Skipping ${order.name}: no product lines`);
        continue;
      }

      // Check if all lines are fully delivered (or at least qty_to_invoice > 0)
      // An order is "ready for invoicing" if:
      // - qty_delivered >= qty_invoiced for all lines (something to invoice)
      // - And typically qty_delivered > 0 for FBB orders (shipped)
      let hasQtyToInvoice = false;
      let allDelivered = true;

      for (const line of productLines) {
        const qtyToInvoice = line.qty_delivered - line.qty_invoiced;
        if (qtyToInvoice > 0) {
          hasQtyToInvoice = true;
        }
        // For FBB orders (fulfilled by Bol), qty_delivered should match qty_ordered
        // For FBR orders (fulfilled by retailer), we check if shipment was done
        if (line.qty_delivered < line.product_uom_qty) {
          // Not fully delivered yet
          allDelivered = false;
        }
      }

      // For nightly invoicing, we only invoice fully delivered orders
      // This ensures we don't invoice partial shipments
      if (hasQtyToInvoice && allDelivered) {
        ordersReadyForInvoicing.push({
          ...order,
          lineCount: productLines.length
        });
      } else if (!allDelivered) {
        // Skip partially delivered orders (they'll be invoiced when fully delivered)
        console.log(`[BolSalesInvoicer] Skipping ${order.name}: not fully delivered yet`);
      }
    }

    console.log(`[BolSalesInvoicer] ${ordersReadyForInvoicing.length} orders ready for invoicing (fully delivered)`);
    return ordersReadyForInvoicing;
  }

  /**
   * Create an invoice from a sale order
   *
   * @param {number} orderId - Odoo sale.order ID
   * @returns {Promise<object>} Created invoice info
   */
  async createInvoiceFromOrder(orderId) {
    await this.init();

    // Get order details
    const [order] = await this.odoo.searchRead('sale.order',
      [['id', '=', orderId]],
      ['name', 'partner_id', 'order_line']
    );

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    console.log(`[BolSalesInvoicer] Creating invoice for order ${order.name}...`);

    // Get order lines with product info
    const orderLines = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', orderId]],
      ['id', 'product_id', 'name', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'price_unit', 'tax_id']
    );

    // Build invoice lines from order lines (only for qty not yet invoiced)
    const invoiceLines = [];
    for (const line of orderLines) {
      if (!line.product_id) continue;

      const qtyToInvoice = line.qty_delivered - line.qty_invoiced;
      if (qtyToInvoice <= 0) continue;

      invoiceLines.push([0, 0, {
        product_id: line.product_id[0],
        name: line.name,
        quantity: qtyToInvoice,
        price_unit: line.price_unit,
        tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
        sale_line_ids: [[4, line.id]], // Link to sale order line
      }]);
    }

    if (invoiceLines.length === 0) {
      throw new Error(`No lines to invoice for order ${order.name}`);
    }

    // Create the invoice
    const invoiceId = await this.odoo.create('account.move', {
      move_type: 'out_invoice',
      partner_id: order.partner_id[0],
      invoice_origin: order.name,
      invoice_line_ids: invoiceLines,
    });

    if (!invoiceId) {
      throw new Error(`Failed to create invoice for order ${order.name}`);
    }

    console.log(`[BolSalesInvoicer] Invoice created with ID ${invoiceId}`);

    // Get invoice details
    const [invoice] = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['name', 'amount_total', 'amount_tax', 'state']
    );

    return {
      id: invoiceId,
      name: invoice?.name || `Draft #${invoiceId}`,
      amountTotal: invoice?.amount_total || 0,
      amountTax: invoice?.amount_tax || 0,
      state: invoice?.state || 'draft',
      orderId: orderId,
      orderName: order.name,
    };
  }

  /**
   * Post (validate) an invoice
   *
   * @param {number} invoiceId - Odoo account.move ID
   * @returns {Promise<object>} Posted invoice info
   */
  async postInvoice(invoiceId) {
    await this.init();

    console.log(`[BolSalesInvoicer] Posting invoice ${invoiceId}...`);

    try {
      await this.odoo.execute('account.move', 'action_post', [[invoiceId]]);
    } catch (error) {
      console.error(`[BolSalesInvoicer] Error posting invoice ${invoiceId}:`, error.message);
      throw error;
    }

    // Get updated invoice details
    const [invoice] = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['name', 'state', 'amount_total']
    );

    if (invoice?.state !== 'posted') {
      throw new Error(`Invoice ${invoiceId} not posted. State: ${invoice?.state}`);
    }

    console.log(`[BolSalesInvoicer] Invoice ${invoice.name} posted successfully`);

    return {
      id: invoiceId,
      name: invoice.name,
      state: invoice.state,
      amountTotal: invoice.amount_total,
    };
  }

  /**
   * Create and post invoices for all ready Bol orders
   *
   * @param {object} options - Options
   * @param {number} options.limit - Maximum orders to process (default: 100)
   * @param {boolean} options.dryRun - If true, don't actually create invoices
   * @returns {Promise<object>} Results summary
   */
  async processAllReadyOrders(options = {}) {
    const { limit = 100, dryRun = false } = options;
    const timer = logger.startTimer('BOL_SALES_INVOICING', 'invoicer');

    await this.init();

    const results = {
      processed: 0,
      created: 0,
      posted: 0,
      errors: [],
      invoices: []
    };

    try {
      // Find orders ready for invoicing
      const orders = await this.findOrdersReadyForInvoicing({ limit });

      if (orders.length === 0) {
        await timer.info('No Bol orders ready for invoicing');
        return results;
      }

      console.log(`[BolSalesInvoicer] Processing ${orders.length} orders for invoicing...`);

      for (const order of orders) {
        results.processed++;

        if (dryRun) {
          console.log(`[BolSalesInvoicer] [DRY RUN] Would invoice: ${order.name} (€${order.amount_total})`);
          results.invoices.push({
            orderName: order.name,
            orderId: order.id,
            amountTotal: order.amount_total,
            dryRun: true
          });
          continue;
        }

        try {
          // Step 1: Create invoice
          const invoice = await this.createInvoiceFromOrder(order.id);
          results.created++;

          // Step 2: Post invoice
          const posted = await this.postInvoice(invoice.id);
          results.posted++;

          results.invoices.push({
            invoiceId: posted.id,
            invoiceName: posted.name,
            orderName: order.name,
            orderId: order.id,
            amountTotal: posted.amountTotal,
            state: posted.state
          });

          console.log(`[BolSalesInvoicer] ✓ ${order.name} → ${posted.name} (€${posted.amountTotal})`);

        } catch (error) {
          console.error(`[BolSalesInvoicer] ✗ ${order.name}: ${error.message}`);
          results.errors.push({
            orderName: order.name,
            orderId: order.id,
            error: error.message
          });
        }
      }

      // Log results
      const summary = `Bol invoicing complete: ${results.created} created, ${results.posted} posted, ${results.errors.length} errors`;
      if (results.errors.length > 0) {
        await timer.error(summary, null, { details: results });
      } else if (results.posted > 0) {
        await timer.success(summary, { details: { processed: results.processed, created: results.created, posted: results.posted } });
      } else {
        await timer.info(summary, { details: results });
      }

      return results;

    } catch (error) {
      await timer.error('Bol sales invoicing failed', error);
      throw error;
    }
  }

  /**
   * Get status/stats for Bol invoicing
   */
  async getStatus() {
    await this.init();

    // Count orders by invoice_status
    const toInvoice = await this.odoo.searchRead('sale.order',
      [
        ['invoice_status', '=', 'to invoice'],
        ['state', 'in', ['sale', 'done']],
        '|', '|',
        ['name', 'like', 'FBB%'],
        ['name', 'like', 'FBR%'],
        ['name', 'like', 'BOL%']
      ],
      ['id'],
      { limit: 5000 }
    );

    const invoiced = await this.odoo.searchRead('sale.order',
      [
        ['invoice_status', '=', 'invoiced'],
        '|', '|',
        ['name', 'like', 'FBB%'],
        ['name', 'like', 'FBR%'],
        ['name', 'like', 'BOL%']
      ],
      ['id'],
      { limit: 5000 }
    );

    // Find orders ready for invoicing (fully delivered)
    const readyOrders = await this.findOrdersReadyForInvoicing({ limit: 1000 });

    return {
      toInvoice: toInvoice.length,
      invoiced: invoiced.length,
      readyForInvoicing: readyOrders.length,
    };
  }
}

/**
 * Get singleton instance
 */
let instance = null;
async function getBolSalesInvoicer() {
  if (!instance) {
    instance = new BolSalesInvoicer();
    await instance.init();
  }
  return instance;
}

/**
 * Run the invoicing job (for scheduler)
 */
async function runBolSalesInvoicing(options = {}) {
  const invoicer = await getBolSalesInvoicer();
  return invoicer.processAllReadyOrders(options);
}

module.exports = {
  BolSalesInvoicer,
  getBolSalesInvoicer,
  runBolSalesInvoicing
};
