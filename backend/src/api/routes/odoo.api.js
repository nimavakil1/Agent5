/**
 * Odoo Integration API Routes
 *
 * Provides REST endpoints for Odoo data (products, orders, customers, etc.)
 */

const express = require('express');
const router = express.Router();
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

let odooClient = null;

/**
 * Get or create Odoo client
 */
async function getOdooClient() {
  if (!odooClient) {
    odooClient = new OdooDirectClient();
    await odooClient.authenticate();
  }
  return odooClient;
}

/**
 * Check Odoo connection status
 */
router.get('/status', async (req, res) => {
  try {
    const client = await getOdooClient();
    res.json({
      connected: true,
      url: process.env.ODOO_URL,
      db: process.env.ODOO_DB
    });
  } catch (error) {
    res.json({
      connected: false,
      error: error.message
    });
  }
});

/**
 * Get products from Odoo with pagination support
 * Use ?all=true to fetch all products (with pagination handled server-side)
 */
router.get('/products', async (req, res) => {
  try {
    const { q, limit = 100, offset = 0, in_stock, all, fields } = req.query;
    const client = await getOdooClient();

    let domain = [['sale_ok', '=', true]];

    if (q) {
      domain.push('|', '|',
        ['name', 'ilike', q],
        ['default_code', 'ilike', q],
        ['barcode', 'ilike', q]
      );
    }

    if (in_stock === '1' || in_stock === 'true') {
      domain.push(['qty_available', '>', 0]);
    }

    // Extended fields for list view
    const defaultFields = [
      'id', 'name', 'default_code', 'barcode', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'categ_id', 'image_128', 'type',
      'uom_id', 'active', 'create_date', 'write_date', 'weight', 'volume',
      'description_sale', 'sale_ok', 'purchase_ok'
    ];

    // If all=true, fetch all products with pagination
    let products = [];
    if (all === 'true' || all === '1') {
      const batchSize = 500;
      let currentOffset = 0;
      let hasMore = true;

      while (hasMore) {
        const batch = await client.searchRead('product.product', domain, defaultFields, {
          limit: batchSize,
          offset: currentOffset,
          order: 'name asc'
        });
        products = products.concat(batch);
        currentOffset += batchSize;
        hasMore = batch.length === batchSize;

        // Safety limit
        if (products.length > 50000) break;
      }
    } else {
      products = await client.searchRead('product.product', domain, defaultFields, {
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: 'name asc'
      });
    }

    // Transform for frontend
    const transformed = products.map(p => ({
      id: p.id,
      name: p.name,
      sku: p.default_code || '',
      barcode: p.barcode || '',
      price: p.list_price,
      cost: p.standard_price,
      stock: p.qty_available,
      available: p.virtual_available,
      category: p.categ_id ? p.categ_id[1] : '',
      categoryId: p.categ_id ? p.categ_id[0] : null,
      image: p.image_128 ? `data:image/png;base64,${p.image_128}` : null,
      type: p.type,
      uom: p.uom_id ? p.uom_id[1] : '',
      active: p.active,
      createdAt: p.create_date,
      updatedAt: p.write_date,
      weight: p.weight,
      volume: p.volume,
      description: p.description_sale || '',
      canSell: p.sale_ok,
      canPurchase: p.purchase_ok
    }));

    res.json({
      success: true,
      count: transformed.length,
      products: transformed
    });
  } catch (error) {
    console.error('Odoo products error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get single product with all details
 */
router.get('/products/:id', async (req, res) => {
  try {
    const client = await getOdooClient();
    const products = await client.read('product.product', [parseInt(req.params.id)], [
      'id', 'name', 'default_code', 'barcode', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'categ_id', 'image_1920',
      'type', 'uom_id', 'active', 'description_sale', 'weight', 'volume',
      'sale_ok', 'purchase_ok', 'create_date', 'write_date'
    ]);

    if (!products.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const p = products[0];
    res.json({
      success: true,
      product: {
        id: p.id,
        name: p.name,
        sku: p.default_code || '',
        barcode: p.barcode || '',
        price: p.list_price,
        cost: p.standard_price,
        stock: p.qty_available,
        available: p.virtual_available,
        category: p.categ_id ? p.categ_id[1] : '',
        categoryId: p.categ_id ? p.categ_id[0] : null,
        image: p.image_1920 ? `data:image/png;base64,${p.image_1920}` : null,
        type: p.type,
        uom: p.uom_id ? p.uom_id[1] : '',
        uomId: p.uom_id ? p.uom_id[0] : null,
        active: p.active,
        description: p.description_sale || '',
        weight: p.weight,
        volume: p.volume,
        canSell: p.sale_ok,
        canPurchase: p.purchase_ok,
        createdAt: p.create_date,
        updatedAt: p.write_date
      }
    });
  } catch (error) {
    console.error('Odoo product error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a product in Odoo
 */
router.put('/products/:id', async (req, res) => {
  try {
    const client = await getOdooClient();
    const productId = parseInt(req.params.id);
    const updates = req.body;

    // Map frontend field names to Odoo field names
    const fieldMapping = {
      name: 'name',
      sku: 'default_code',
      barcode: 'barcode',
      price: 'list_price',
      cost: 'standard_price',
      description: 'description_sale',
      weight: 'weight',
      volume: 'volume',
      active: 'active',
      categoryId: 'categ_id',
      canSell: 'sale_ok',
      canPurchase: 'purchase_ok'
    };

    // Build Odoo update object
    const odooUpdates = {};
    for (const [frontendKey, odooKey] of Object.entries(fieldMapping)) {
      if (updates[frontendKey] !== undefined) {
        odooUpdates[odooKey] = updates[frontendKey];
      }
    }

    // Update in Odoo
    await client.write('product.product', [productId], odooUpdates);

    // Fetch updated product
    const products = await client.read('product.product', [productId], [
      'id', 'name', 'default_code', 'barcode', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'categ_id', 'type', 'uom_id',
      'active', 'description_sale', 'weight', 'volume', 'write_date'
    ]);

    const p = products[0];
    res.json({
      success: true,
      message: 'Product updated successfully',
      product: {
        id: p.id,
        name: p.name,
        sku: p.default_code || '',
        barcode: p.barcode || '',
        price: p.list_price,
        cost: p.standard_price,
        stock: p.qty_available,
        available: p.virtual_available,
        category: p.categ_id ? p.categ_id[1] : '',
        categoryId: p.categ_id ? p.categ_id[0] : null,
        type: p.type,
        uom: p.uom_id ? p.uom_id[1] : '',
        active: p.active,
        description: p.description_sale || '',
        weight: p.weight,
        volume: p.volume,
        updatedAt: p.write_date
      }
    });
  } catch (error) {
    console.error('Odoo product update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get product categories
 */
router.get('/categories', async (req, res) => {
  try {
    const client = await getOdooClient();
    const categories = await client.searchRead('product.category', [], [
      'id', 'name', 'parent_id', 'complete_name'
    ], { limit: 500, order: 'complete_name asc' });

    res.json(categories.map(c => ({
      id: c.id,
      name: c.name,
      fullName: c.complete_name,
      parentId: c.parent_id ? c.parent_id[0] : null
    })));
  } catch (error) {
    console.error('Odoo categories error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get sales orders
 */
router.get('/sales-orders', async (req, res) => {
  try {
    const { limit = 50, offset = 0, state } = req.query;
    const client = await getOdooClient();

    let domain = [];
    if (state) {
      domain.push(['state', '=', state]);
    }

    const orders = await client.searchRead('sale.order', domain, [
      'id', 'name', 'partner_id', 'date_order', 'amount_total',
      'state', 'invoice_status', 'delivery_status', 'user_id'
    ], { limit: parseInt(limit), offset: parseInt(offset), order: 'date_order desc' });

    res.json(orders.map(o => ({
      id: o.id,
      name: o.name,
      customer: o.partner_id ? o.partner_id[1] : '',
      customerId: o.partner_id ? o.partner_id[0] : null,
      date: o.date_order,
      total: o.amount_total,
      state: o.state,
      invoiceStatus: o.invoice_status,
      deliveryStatus: o.delivery_status,
      salesperson: o.user_id ? o.user_id[1] : ''
    })));
  } catch (error) {
    console.error('Odoo sales orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get customers
 */
router.get('/customers', async (req, res) => {
  try {
    const { q, limit = 100, offset = 0 } = req.query;
    const client = await getOdooClient();

    let domain = [['customer_rank', '>', 0]];
    if (q) {
      domain.push('|', '|',
        ['name', 'ilike', q],
        ['email', 'ilike', q],
        ['phone', 'ilike', q]
      );
    }

    const customers = await client.searchRead('res.partner', domain, [
      'id', 'name', 'email', 'phone', 'mobile', 'street', 'city',
      'country_id', 'customer_rank', 'credit', 'total_invoiced'
    ], { limit: parseInt(limit), offset: parseInt(offset), order: 'name asc' });

    res.json(customers.map(c => ({
      id: c.id,
      name: c.name,
      email: c.email || '',
      phone: c.phone || c.mobile || '',
      address: [c.street, c.city].filter(Boolean).join(', '),
      country: c.country_id ? c.country_id[1] : '',
      credit: c.credit,
      totalInvoiced: c.total_invoiced
    })));
  } catch (error) {
    console.error('Odoo customers error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get invoices
 */
router.get('/invoices', async (req, res) => {
  try {
    const { limit = 50, offset = 0, state } = req.query;
    const client = await getOdooClient();

    let domain = [['move_type', 'in', ['out_invoice', 'out_refund']]];
    if (state) {
      domain.push(['state', '=', state]);
    }

    const invoices = await client.getInvoices(domain.slice(1), {
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json(invoices.map(i => ({
      id: i.id,
      name: i.name,
      customer: i.partner_id ? i.partner_id[1] : '',
      date: i.invoice_date,
      dueDate: i.invoice_date_due,
      total: i.amount_total,
      residual: i.amount_residual,
      state: i.state,
      paymentState: i.payment_state,
      type: i.move_type
    })));
  } catch (error) {
    console.error('Odoo invoices error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get dashboard summary
 */
router.get('/dashboard', async (req, res) => {
  try {
    const client = await getOdooClient();

    // Get counts in parallel
    const [products, orders, customers, invoices] = await Promise.all([
      client.search('product.product', [['sale_ok', '=', true], ['active', '=', true]]),
      client.search('sale.order', [['state', 'in', ['sale', 'done']]]),
      client.search('res.partner', [['customer_rank', '>', 0]]),
      client.search('account.move', [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', '!=', 'paid']])
    ]);

    res.json({
      products: products.length,
      orders: orders.length,
      customers: customers.length,
      unpaidInvoices: invoices.length
    });
  } catch (error) {
    console.error('Odoo dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
