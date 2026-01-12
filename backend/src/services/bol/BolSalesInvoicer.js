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
 * Tax Logic:
 * - FBR orders (from BE warehouse): OSS for cross-border EU, BE domestic for Belgium
 * - FBB orders (from Bol.com NL warehouse):
 *   - **SPECIAL EXCEPTION**: FBB to Belgium → BE domestic regime (legally agreed with tax authorities)
 *   - FBB to other EU countries → OSS for that country
 *
 * This runs as a scheduled nightly job via BolScheduler.js
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { getModuleLogger } = require('../logging/ModuleLogger');

const logger = getModuleLogger('bol');

// OSS fiscal positions by destination country (for cross-border B2C)
const OSS_FISCAL_POSITIONS = {
  'AT': 6,   // AT*OSS
  'BG': 7,   // BG*OSS
  'HR': 8,   // HR*OSS
  'CY': 9,   // CY*OSS
  'CZ': 10,  // CZ*OSS
  'DK': 11,  // DK*OSS
  'EE': 12,  // EE*OSS
  'FI': 13,  // FI*OSS
  'FR': 14,  // FR*OSS
  'DE': 15,  // DE*OSS
  'GR': 16,  // GR*OSS
  'HU': 17,  // HU*OSS
  'IE': 18,  // IE*OSS
  'IT': 19,  // IT*OSS
  'LV': 20,  // LV*OSS
  'LT': 21,  // LT*OSS
  'LU': 22,  // LU*OSS
  'MT': 23,  // MT*OSS
  'NL': 24,  // NL*OSS
  'PL': 25,  // PL*OSS
  'PT': 26,  // PT*OSS
  'RO': 27,  // RO*OSS
  'SK': 28,  // SK*OSS
  'SI': 29,  // SI*OSS
  'ES': 30,  // ES*OSS
  'SE': 31,  // SE*OSS
  'BE': 35,  // BE*OSS (only used for non-FBB cross-border TO Belgium)
};

// Domestic fiscal positions (for same-country sales)
const DOMESTIC_FISCAL_POSITIONS = {
  'BE': 1,   // BE*VAT | Régime National
  'DE': 32,  // DE*VAT | Germany Domestic
  'FR': 33,  // FR*VAT | France Domestic
  'NL': 34,  // NL*VAT | Netherlands Domestic
};

// Journal codes by country (for Bol.com invoices we use VBE or VNL)
const COUNTRY_JOURNALS = {
  'BE': 1,   // VBE journal (INV*BE/ Invoices)
  'NL': 16,  // VNL journal (INV*NL/ Invoices)
};

// Bol.com warehouse ID in Odoo (FBB orders ship from here)
const BOL_WAREHOUSE_ID = 3;  // Bol.com warehouse (NL)

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
   * Determine the fiscal position for a Bol order
   *
   * Logic:
   * - FBR (shipped from BE): OSS for cross-border, BE domestic for Belgium
   * - FBB (shipped from NL via Bol.com warehouse):
   *   - **SPECIAL EXCEPTION**: FBB to Belgium → BE domestic (legally agreed with tax authorities)
   *   - FBB to other EU countries → OSS for that country
   *
   * @param {object} order - Sale order with warehouse_id
   * @param {string} shipToCountry - Destination country code (e.g., 'BE', 'NL')
   * @returns {number|null} Fiscal position ID or null
   */
  determineFiscalPosition(order, shipToCountry) {
    const isFBB = order.warehouse_id && order.warehouse_id[0] === BOL_WAREHOUSE_ID;
    const shipFromCountry = isFBB ? 'NL' : 'BE';

    console.log(`[BolSalesInvoicer] Tax logic: ${order.name} | FBB=${isFBB} | From=${shipFromCountry} → To=${shipToCountry}`);

    // SPECIAL EXCEPTION: FBB orders to Belgium → BE domestic regime
    // This is legally agreed with tax authorities - treat NL→BE as BE→BE
    if (isFBB && shipToCountry === 'BE') {
      console.log(`[BolSalesInvoicer] SPECIAL: FBB→BE treated as BE domestic (fiscal_position: 1)`);
      return DOMESTIC_FISCAL_POSITIONS['BE']; // BE*VAT | Régime National
    }

    // Same-country sales → domestic regime
    if (shipFromCountry === shipToCountry) {
      const domesticFp = DOMESTIC_FISCAL_POSITIONS[shipToCountry];
      if (domesticFp) {
        console.log(`[BolSalesInvoicer] Domestic: ${shipFromCountry}→${shipToCountry} (fiscal_position: ${domesticFp})`);
        return domesticFp;
      }
    }

    // Cross-border EU sales → OSS for destination country
    const ossFp = OSS_FISCAL_POSITIONS[shipToCountry];
    if (ossFp) {
      console.log(`[BolSalesInvoicer] OSS: ${shipFromCountry}→${shipToCountry} (fiscal_position: ${ossFp})`);
      return ossFp;
    }

    // Fallback: no specific fiscal position
    console.log(`[BolSalesInvoicer] No fiscal position mapped for ${shipToCountry}`);
    return null;
  }

  /**
   * Determine the journal for a Bol order invoice
   *
   * @param {string} shipToCountry - Destination country code
   * @returns {number|null} Journal ID or null
   */
  determineJournal(shipToCountry) {
    // Use destination country's journal (VBE for Belgium, VNL for Netherlands)
    const journalId = COUNTRY_JOURNALS[shipToCountry];
    if (journalId) {
      return journalId;
    }
    // For other countries, fall back to VBE (Belgium journal for OSS)
    return COUNTRY_JOURNALS['BE'];
  }

  /**
   * Get the shipping destination country for an order
   *
   * @param {number} orderId - Sale order ID
   * @returns {Promise<string|null>} Country code (e.g., 'BE', 'NL') or null
   */
  async getShipToCountry(orderId) {
    // Get order with partner_shipping_id
    const [order] = await this.odoo.searchRead('sale.order',
      [['id', '=', orderId]],
      ['partner_shipping_id']
    );

    if (!order || !order.partner_shipping_id) {
      return null;
    }

    // Get partner's country
    const [partner] = await this.odoo.searchRead('res.partner',
      [['id', '=', order.partner_shipping_id[0]]],
      ['country_id']
    );

    if (!partner || !partner.country_id) {
      return null;
    }

    // Get country code
    const [country] = await this.odoo.searchRead('res.country',
      [['id', '=', partner.country_id[0]]],
      ['code']
    );

    return country ? country.code : null;
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

    // Get order details including warehouse_id for tax logic, team_id for invoice, and client_order_ref for BOL order number
    const [order] = await this.odoo.searchRead('sale.order',
      [['id', '=', orderId]],
      ['name', 'partner_id', 'order_line', 'warehouse_id', 'team_id', 'client_order_ref']
    );

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    console.log(`[BolSalesInvoicer] Creating invoice for order ${order.name}...`);

    // Get shipping destination country for tax logic
    const shipToCountry = await this.getShipToCountry(orderId);
    if (!shipToCountry) {
      console.log(`[BolSalesInvoicer] Warning: Could not determine ship-to country for ${order.name}`);
    }

    // Determine fiscal position and journal based on tax logic
    const fiscalPositionId = shipToCountry ? this.determineFiscalPosition(order, shipToCountry) : null;
    const journalId = shipToCountry ? this.determineJournal(shipToCountry) : null;

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

    // Build invoice data with tax-aware fields
    const invoiceData = {
      move_type: 'out_invoice',
      partner_id: order.partner_id[0],
      invoice_origin: order.name,
      invoice_line_ids: invoiceLines,
    };

    // Copy team_id from sale order to invoice
    if (order.team_id) {
      invoiceData.team_id = order.team_id[0];
    }

    // Add BOL order number to reference fields
    // The order name has FBB/FBR/BOL prefix (e.g., "FBBA000DD78MR")
    // The actual BOL order number is without the prefix (e.g., "A000DD78MR")
    if (order.name) {
      // Strip FBB, FBR, or BOL prefix to get actual BOL order number
      const bolOrderNumber = order.name.replace(/^(FBB|FBR|BOL)/, '');
      invoiceData.payment_reference = bolOrderNumber;       // Payment Reference
      invoiceData.ref = bolOrderNumber;                     // Customer Reference
      invoiceData.x_end_user_reference = bolOrderNumber;    // End User References (custom field)
      console.log(`[BolSalesInvoicer] Setting reference fields to BOL order: ${bolOrderNumber} (from ${order.name})`);
    }

    // Add fiscal position if determined
    if (fiscalPositionId) {
      invoiceData.fiscal_position_id = fiscalPositionId;
      console.log(`[BolSalesInvoicer] Setting fiscal_position_id: ${fiscalPositionId}`);
    }

    // Add journal if determined
    if (journalId) {
      invoiceData.journal_id = journalId;
      console.log(`[BolSalesInvoicer] Setting journal_id: ${journalId}`);
    }

    // Create the invoice
    const invoiceId = await this.odoo.create('account.move', invoiceData);

    if (!invoiceId) {
      throw new Error(`Failed to create invoice for order ${order.name}`);
    }

    console.log(`[BolSalesInvoicer] Invoice created with ID ${invoiceId}`);

    // Get invoice details
    const [invoice] = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['name', 'amount_total', 'amount_tax', 'state', 'fiscal_position_id', 'journal_id']
    );

    return {
      id: invoiceId,
      name: invoice?.name || `Draft #${invoiceId}`,
      amountTotal: invoice?.amount_total || 0,
      amountTax: invoice?.amount_tax || 0,
      state: invoice?.state || 'draft',
      fiscalPosition: invoice?.fiscal_position_id ? invoice.fiscal_position_id[1] : null,
      journal: invoice?.journal_id ? invoice.journal_id[1] : null,
      orderId: orderId,
      orderName: order.name,
      shipToCountry,
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
