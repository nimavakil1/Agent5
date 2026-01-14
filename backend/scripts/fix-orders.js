require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { skuResolver } = require('../src/services/amazon/SkuResolver');

async function createOrders() {
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  await skuResolver.load();

  const orderIds = ['402-6819718-3689940', '403-8672138-6101163'];

  for (const amazonOrderId of orderIds) {
    console.log('\n========================================');
    console.log('Creating order:', amazonOrderId);
    console.log('========================================');

    // Get order from seller_orders
    const order = await db.collection('seller_orders').findOne({ amazonOrderId });
    if (!order) {
      console.log('Order not found in MongoDB');
      continue;
    }

    console.log('Status:', order.orderStatus, '| Channel:', order.fulfillmentChannel);

    // Check if already in Odoo
    const existing = await odoo.searchRead('sale.order',
      [['client_order_ref', '=', amazonOrderId]],
      ['id', 'name']
    );
    if (existing.length > 0) {
      console.log('Already exists in Odoo:', existing[0].name);
      continue;
    }

    // Find products for each item
    const lines = [];
    for (const item of order.items) {
      const sku = item.sellerSku;
      if (!sku) {
        console.log('  SKIP: Missing SKU for item');
        continue;
      }

      const resolved = skuResolver.resolve(sku);
      const transformedSku = resolved.odooSku;

      // Find product
      let products = await odoo.searchRead('product.product',
        [['default_code', '=', transformedSku]],
        ['id', 'name']
      );

      if (products.length === 0 && transformedSku !== sku) {
        products = await odoo.searchRead('product.product',
          [['default_code', '=', sku]],
          ['id', 'name']
        );
      }

      if (products.length === 0) {
        console.log('  SKIP: Product not found for SKU:', sku);
        continue;
      }

      const product = products[0];
      const qty = item.quantityOrdered;
      const totalPrice = parseFloat(item.itemPrice?.amount || 0);
      const unitPrice = totalPrice / qty;

      console.log('  Product:', product.name.substring(0, 40), '| Qty:', qty, '| Price:', unitPrice.toFixed(2));

      lines.push([0, 0, {
        product_id: product.id,
        product_uom_qty: qty,
        price_unit: unitPrice,
        name: item.title || product.name
      }]);
    }

    if (lines.length === 0) {
      console.log('No valid lines, skipping order');
      continue;
    }

    // Create customer (simple generic one)
    const city = order.shippingAddress?.city || 'Unknown';
    const postalCode = order.shippingAddress?.postalCode || '';
    const countryCode = order.shippingAddress?.countryCode || 'FR';
    const customerName = 'Amazon Customer (' + city + ' ' + postalCode + ', ' + countryCode + ')';

    // Find or create customer
    let customers = await odoo.searchRead('res.partner',
      [['name', '=', customerName]],
      ['id']
    );

    let customerId;
    if (customers.length > 0) {
      customerId = customers[0].id;
    } else {
      // Get country ID
      const countries = await odoo.searchRead('res.country', [['code', '=', countryCode]], ['id']);
      const countryId = countries.length > 0 ? countries[0].id : false;

      customerId = await odoo.create('res.partner', {
        name: customerName,
        city: city,
        zip: postalCode,
        country_id: countryId,
        customer_rank: 1
      });
      console.log('Created customer:', customerName, '(ID:', customerId, ')');
    }

    // Create order with FBA warehouse (fr1 = ID 5)
    // Format date as YYYY-MM-DD HH:MM:SS for Odoo
    let dateOrder = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (order.purchaseDate) {
      const d = new Date(order.purchaseDate);
      dateOrder = d.toISOString().slice(0, 19).replace('T', ' ');
    }

    // Determine order prefix based on fulfillment channel
    const orderPrefix = order.fulfillmentChannel === 'AFN' ? 'FBA' : 'FBM';
    const orderName = `${orderPrefix}${amazonOrderId}`;

    const orderData = {
      name: orderName,  // Set consistent FBA/FBM prefix
      partner_id: customerId,
      partner_invoice_id: customerId,
      partner_shipping_id: customerId,
      client_order_ref: amazonOrderId,
      warehouse_id: 5, // FBA Amazon.fr
      order_line: lines,
      date_order: dateOrder
    };

    const orderId = await odoo.create('sale.order', orderData);
    console.log('Created order ID:', orderId);

    // Confirm the order
    await odoo.execute('sale.order', 'action_confirm', [[orderId]]);
    console.log('Order confirmed');

    // Get order name
    const created = await odoo.searchRead('sale.order', [['id', '=', orderId]], ['name']);
    console.log('Order name:', created[0].name);

    // If order is shipped, mark delivery as done
    if (order.orderStatus === 'Shipped') {
      console.log('Order is shipped, completing delivery...');

      const pickings = await odoo.searchRead('stock.picking',
        [['sale_id', '=', orderId]],
        ['id', 'name', 'state']
      );

      if (pickings.length > 0 && pickings[0].state !== 'done') {
        const picking = pickings[0];

        // Set quantities done on moves
        const moves = await odoo.searchRead('stock.move',
          [['picking_id', '=', picking.id]],
          ['id', 'product_uom_qty']
        );

        for (const move of moves) {
          await odoo.write('stock.move', [move.id], {
            quantity_done: move.product_uom_qty
          });
        }

        // Validate picking
        await odoo.execute('stock.picking', 'button_validate', [[picking.id]]);
        console.log('Delivery', picking.name, 'validated');
      }
    }
  }

  process.exit(0);
}

createOrders().catch(e => { console.error(e); process.exit(1); });
