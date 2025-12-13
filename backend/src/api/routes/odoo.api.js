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
 * Get products from Odoo
 */
router.get('/products', async (req, res) => {
  try {
    const { q, limit = 100, offset = 0, in_stock } = req.query;
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

    const products = await client.searchRead('product.product', domain, [
      'id',
      'name',
      'default_code',
      'barcode',
      'list_price',
      'standard_price',
      'qty_available',
      'virtual_available',
      'categ_id',
      'image_128',
      'type',
      'uom_id',
      'active'
    ], { limit: parseInt(limit), offset: parseInt(offset), order: 'name asc' });

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
      active: p.active
    }));

    res.json(transformed);
  } catch (error) {
    console.error('Odoo products error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get single product
 */
router.get('/products/:id', async (req, res) => {
  try {
    const client = await getOdooClient();
    const products = await client.read('product.product', [parseInt(req.params.id)], [
      'id', 'name', 'default_code', 'barcode', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'categ_id', 'image_1920',
      'type', 'uom_id', 'active', 'description_sale', 'weight', 'volume'
    ]);

    if (!products.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const p = products[0];
    res.json({
      id: p.id,
      name: p.name,
      sku: p.default_code || '',
      barcode: p.barcode || '',
      price: p.list_price,
      cost: p.standard_price,
      stock: p.qty_available,
      available: p.virtual_available,
      category: p.categ_id ? p.categ_id[1] : '',
      image: p.image_1920 ? `data:image/png;base64,${p.image_1920}` : null,
      type: p.type,
      uom: p.uom_id ? p.uom_id[1] : '',
      active: p.active,
      description: p.description_sale || '',
      weight: p.weight,
      volume: p.volume
    });
  } catch (error) {
    console.error('Odoo product error:', error);
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
