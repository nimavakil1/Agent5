require('dotenv').config();
const fs = require('fs');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function createInvoices() {
  const data = JSON.parse(fs.readFileSync('/tmp/order_lines_analysis.json', 'utf-8'));
  const linesToInvoice = data.noInvoiceExists;

  console.log('Lines needing invoice creation:', linesToInvoice.length);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Group lines by sale order
  const orderGroups = new Map();
  for (const line of linesToInvoice) {
    if (!orderGroups.has(line.saleOrderId)) {
      orderGroups.set(line.saleOrderId, {
        saleOrderId: line.saleOrderId,
        saleOrderName: line.saleOrderName,
        amazonOrderId: line.amazonOrderId,
        lines: []
      });
    }
    orderGroups.get(line.saleOrderId).lines.push(line);
  }

  console.log('Unique sale orders:', orderGroups.size);

  // Separate valid orders from zero-price orders
  const validOrders = [];
  const zeroPriceOrders = [];

  for (const [orderId, orderData] of orderGroups) {
    // Check if all lines have price 0
    const allZeroPrice = orderData.lines.every(l => l.price === 0);
    const hasValidLines = orderData.lines.some(l => l.price !== 0);

    if (allZeroPrice) {
      zeroPriceOrders.push(orderData);
    } else {
      validOrders.push(orderData);
    }
  }

  console.log('\nOrders with valid prices:', validOrders.length);
  console.log('Orders with ALL zero prices (skipping):', zeroPriceOrders.length);

  if (zeroPriceOrders.length > 0) {
    console.log('\nZero-price orders skipped:');
    for (const o of zeroPriceOrders) {
      console.log('  ', o.saleOrderName);
    }
  }

  // Create invoices for valid orders
  console.log('\n========================================');
  console.log('CREATING INVOICES');
  console.log('========================================\n');

  const results = {
    created: [],
    errors: []
  };

  for (const orderData of validOrders) {
    try {
      console.log('Processing:', orderData.saleOrderName);

      // Get the full sale order details
      const saleOrder = await odoo.searchRead('sale.order',
        [['id', '=', orderData.saleOrderId]],
        ['id', 'name', 'partner_id', 'partner_invoice_id', 'pricelist_id', 'currency_id', 'fiscal_position_id', 'payment_term_id', 'warehouse_id']
      );

      if (saleOrder.length === 0) {
        throw new Error('Sale order not found');
      }

      const so = saleOrder[0];

      // Get the order lines that need invoicing
      const lineIds = orderData.lines.map(l => l.saleOrderLineId);
      const orderLines = await odoo.searchRead('sale.order.line',
        [['id', 'in', lineIds]],
        ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'price_unit', 'tax_id', 'name', 'discount']
      );

      // Build invoice lines
      const invoiceLines = [];
      for (const ol of orderLines) {
        // Skip if already invoiced
        if (ol.qty_invoiced >= ol.product_uom_qty) continue;

        const qtyToInvoice = ol.product_uom_qty - ol.qty_invoiced;
        if (qtyToInvoice <= 0) continue;

        invoiceLines.push([0, 0, {
          product_id: ol.product_id ? ol.product_id[0] : false,
          quantity: qtyToInvoice,
          price_unit: ol.price_unit,
          name: ol.name,
          tax_ids: ol.tax_id ? [[6, 0, ol.tax_id]] : false,
          sale_line_ids: [[6, 0, [ol.id]]], // Link to sale order line
          discount: ol.discount || 0
        }]);
      }

      if (invoiceLines.length === 0) {
        console.log('  No lines to invoice, skipping');
        continue;
      }

      // Create the invoice
      const invoiceData = {
        move_type: 'out_invoice',
        partner_id: so.partner_invoice_id ? so.partner_invoice_id[0] : so.partner_id[0],
        invoice_origin: orderData.amazonOrderId,
        ref: orderData.amazonOrderId,
        fiscal_position_id: so.fiscal_position_id ? so.fiscal_position_id[0] : false,
        invoice_payment_term_id: so.payment_term_id ? so.payment_term_id[0] : false,
        currency_id: so.currency_id ? so.currency_id[0] : false,
        invoice_line_ids: invoiceLines
      };

      const invoiceId = await odoo.create('account.move', invoiceData);
      console.log('  Created invoice ID:', invoiceId);

      // Get invoice name
      const invoice = await odoo.searchRead('account.move',
        [['id', '=', invoiceId]],
        ['name', 'amount_total']
      );

      console.log('  Invoice:', invoice[0].name, '| Amount:', invoice[0].amount_total);

      results.created.push({
        saleOrderId: orderData.saleOrderId,
        saleOrderName: orderData.saleOrderName,
        invoiceId: invoiceId,
        invoiceName: invoice[0].name,
        amount: invoice[0].amount_total
      });

    } catch (error) {
      console.log('  ERROR:', error.message);
      results.errors.push({
        saleOrderId: orderData.saleOrderId,
        saleOrderName: orderData.saleOrderName,
        error: error.message
      });
    }
  }

  console.log('\n========================================');
  console.log('RESULTS');
  console.log('========================================\n');

  console.log('Invoices created:', results.created.length);
  console.log('Errors:', results.errors.length);
  console.log('Skipped (zero price):', zeroPriceOrders.length);

  if (results.created.length > 0) {
    console.log('\nCreated invoices:');
    for (const r of results.created) {
      console.log('  ', r.saleOrderName, '->', r.invoiceName, '(€' + r.amount + ')');
    }
  }

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of results.errors) {
      console.log('  ', e.saleOrderName, ':', e.error);
    }
  }

  // Save results
  fs.writeFileSync('/tmp/fbm_invoice_results.json', JSON.stringify({
    created: results.created,
    errors: results.errors,
    skippedZeroPrice: zeroPriceOrders.map(o => o.saleOrderName)
  }, null, 2));

  console.log('\nResults saved to /tmp/fbm_invoice_results.json');
}

createInvoices().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
