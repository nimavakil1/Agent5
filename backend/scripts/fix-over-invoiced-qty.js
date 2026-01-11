require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const ORDERS_TO_FIX = [
  'FBA306-6807390-9520350',
  'FBA028-3388441-7026761',
  'FBA304-5424861-0609139',
  'FBM303-0915466-8624366',
  'FBA305-7719602-8719536',
  'FBA402-1675691-3069126',
  'FBA407-8845531-3980311',
  'FBA407-4016096-5817920',
  'FBA304-1679169-9913904',
  'FBA304-9001810-6907537',
  'FBA402-5520625-5148348',
  'FBA171-3305595-8020367',
  'FBA171-7806495-3421915',
  'FBA404-6916998-9514737',
  'FBA305-1128908-6477126',
  'FBA403-2547772-9062738',
  'FBA403-4172574-1512303',
  'FBA171-3480971-6948300',
  'FBA028-5991154-4949126',
  'FBA302-8167692-7042706',
  'FBA406-0107934-9277935',
  'FBA303-7606838-6936328',
  'FBA403-0319111-3366718',
  'FBA028-7596739-8024350',
  'FBA405-3877071-2993168',
  'FBA302-5543628-1207550',
  'FBA404-4860277-2377966',
  'FBA302-2662638-3516361',
  'FBA304-7149448-2424318',
  'FBA304-8712898-9633907',
  'FBA306-0307415-1602769',
  'FBA304-8357190-9650716'
];

const SERVICE_PRODUCT_IDS = [16401, 16402, 16403, 16404];
const TAX_LOCK_DATE = '2025-11-30';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX OVER-INVOICED ORDERS (Qty Mismatch) ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Orders to fix: ' + ORDERS_TO_FIX.length + '\n');

  let fixed = 0;
  let errors = 0;
  let creditNotesCreated = 0;

  for (const orderName of ORDERS_TO_FIX) {
    console.log('\n=== Processing: ' + orderName + ' ===');

    try {
      // Get order
      const orders = await odoo.searchRead('sale.order',
        [['name', '=', orderName]],
        ['id', 'name', 'invoice_ids', 'amount_total', 'partner_id']
      );

      if (orders.length === 0) {
        console.log('  ERROR: Order not found');
        errors++;
        continue;
      }

      const order = orders[0];

      if (order.invoice_ids.length === 0) {
        console.log('  ERROR: No invoices linked');
        errors++;
        continue;
      }

      // Get order lines (sum by product)
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id', 'product_id', 'qty_delivered', 'price_unit']
      );

      const orderQtyByProduct = {};
      for (const line of orderLines) {
        if (!line.product_id) continue;
        const productId = line.product_id[0];
        if (SERVICE_PRODUCT_IDS.includes(productId)) continue;
        orderQtyByProduct[productId] = (orderQtyByProduct[productId] || 0) + line.qty_delivered;
      }

      // Process each invoice
      for (const invoiceId of order.invoice_ids) {
        const invoices = await odoo.searchRead('account.move',
          [['id', '=', invoiceId]],
          ['id', 'name', 'state', 'move_type', 'invoice_date', 'amount_total', 'journal_id', 'currency_id']
        );

        if (invoices.length === 0) continue;
        const invoice = invoices[0];

        // Skip credit notes
        if (invoice.move_type !== 'out_invoice') continue;

        console.log('  Invoice: ' + invoice.name + ' [' + invoice.state + '] Date: ' + invoice.invoice_date);

        // Get invoice lines
        const invoiceLines = await odoo.searchRead('account.move.line',
          [['move_id', '=', invoiceId], ['display_type', '=', 'product']],
          ['id', 'product_id', 'quantity', 'price_unit', 'sale_line_ids']
        );

        // Sum invoice qty by product
        const invoiceQtyByProduct = {};
        const invoiceLinesByProduct = {};
        for (const line of invoiceLines) {
          if (!line.product_id) continue;
          const productId = line.product_id[0];
          if (SERVICE_PRODUCT_IDS.includes(productId)) continue;
          invoiceQtyByProduct[productId] = (invoiceQtyByProduct[productId] || 0) + line.quantity;
          if (!invoiceLinesByProduct[productId]) invoiceLinesByProduct[productId] = [];
          invoiceLinesByProduct[productId].push(line);
        }

        // Find over-invoiced products
        const overInvoiced = [];
        for (const [productId, invoiceQty] of Object.entries(invoiceQtyByProduct)) {
          const orderQty = orderQtyByProduct[productId] || 0;
          if (invoiceQty > orderQty) {
            overInvoiced.push({
              productId: parseInt(productId),
              orderQty,
              invoiceQty,
              excess: invoiceQty - orderQty,
              lines: invoiceLinesByProduct[productId]
            });
          }
        }

        if (overInvoiced.length === 0) {
          console.log('    No over-invoicing found on this invoice');
          continue;
        }

        for (const item of overInvoiced) {
          console.log('    Product ' + item.productId + ': Order qty=' + item.orderQty + ', Invoice qty=' + item.invoiceQty + ' (excess: ' + item.excess + ')');
        }

        // Determine action based on invoice state and date
        const invoiceDate = invoice.invoice_date;
        const isLocked = invoiceDate <= TAX_LOCK_DATE;

        if (invoice.state === 'draft') {
          // Case A: Invoice is draft - directly modify
          console.log('    Action: Modify draft invoice');

          if (!dryRun) {
            for (const item of overInvoiced) {
              // Reduce qty on invoice lines to match order qty
              let remainingToReduce = item.excess;
              for (const line of item.lines) {
                if (remainingToReduce <= 0) break;
                const reduction = Math.min(line.quantity, remainingToReduce);
                const newQty = line.quantity - reduction;

                if (newQty === 0) {
                  // Delete the line
                  await odoo.execute('account.move.line', 'unlink', [[line.id]]);
                  console.log('      Deleted invoice line ' + line.id);
                } else {
                  // Reduce qty
                  await odoo.execute('account.move.line', 'write', [[line.id], { quantity: newQty }]);
                  console.log('      Reduced line ' + line.id + ' qty from ' + line.quantity + ' to ' + newQty);
                }
                remainingToReduce -= reduction;
              }
            }
            fixed++;
          } else {
            console.log('    [DRY RUN] Would modify invoice lines');
          }

        } else if (invoice.state === 'posted') {
          // Case B & C: Posted invoice - create credit note (safest approach)
          // Case C: Posted and locked - create credit note
          console.log('    Action: Create credit note (invoice is locked)');

          if (!dryRun) {
            // Create credit note for excess amounts
            const creditNoteLines = [];
            for (const item of overInvoiced) {
              // Find the price from invoice line
              const priceLine = item.lines[0];
              creditNoteLines.push([0, 0, {
                product_id: item.productId,
                quantity: item.excess,
                price_unit: priceLine.price_unit,
                name: 'Correction for over-invoicing',
                sale_line_ids: priceLine.sale_line_ids ? [[6, 0, priceLine.sale_line_ids]] : false
              }]);
            }

            // Create credit note using same journal as original invoice
            const creditNote = await odoo.execute('account.move', 'create', [{
              move_type: 'out_refund',
              partner_id: order.partner_id[0],
              journal_id: invoice.journal_id[0],
              invoice_date: new Date().toISOString().split('T')[0],
              ref: 'Correction for ' + orderName,
              invoice_line_ids: creditNoteLines
            }]);

            console.log('      Created credit note ID: ' + creditNote);

            // Link credit note to the sale order
            const currentInvoiceIds = order.invoice_ids;
            currentInvoiceIds.push(creditNote);
            await odoo.execute('sale.order', 'write', [[order.id], { invoice_ids: [[6, 0, currentInvoiceIds]] }]);
            console.log('      Linked credit note to order');

            // Post credit note
            await odoo.execute('account.move', 'action_post', [[creditNote]]);
            console.log('      Posted credit note');

            creditNotesCreated++;
            fixed++;
          } else {
            console.log('    [DRY RUN] Would create and post credit note');
          }
        }
      }

      // Mark order lines as invoiced if needed
      if (!dryRun) {
        const allOrderLines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', order.id]],
          ['id', 'invoice_status']
        );
        const lineIds = allOrderLines.map(l => l.id);
        await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        console.log('  Marked all order lines as invoiced');
      }

    } catch (err) {
      console.log('  ERROR: ' + err.message);
      errors++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders processed: ' + ORDERS_TO_FIX.length);
  console.log('Fixed: ' + fixed);
  console.log('Credit notes created: ' + creditNotesCreated);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
