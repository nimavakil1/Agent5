/**
 * Odoo Integration API Routes
 *
 * Provides REST endpoints for Odoo data (products, orders, customers, etc.)
 */

const express = require('express');
const router = express.Router();
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const Warehouse = require('../../models/Warehouse');

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
 * Get stock by warehouse for all products
 * Returns { productId: { warehouseId: qty, ... }, ... }
 * NOTE: This route MUST be defined before /products/:id to avoid being caught by the param route
 */
router.get('/products/stock-by-warehouse', async (req, res) => {
  try {
    const client = await getOdooClient();

    // Get all warehouses with their stock locations
    const warehouses = await client.searchRead('stock.warehouse', [], [
      'id', 'name', 'code', 'lot_stock_id'
    ], { order: 'id asc' });

    const warehouseMap = {};
    const locationToWarehouse = {};
    for (const w of warehouses) {
      if (w.lot_stock_id) {
        warehouseMap[w.id] = { id: w.id, name: w.name, code: w.code, locationId: w.lot_stock_id[0] };
        locationToWarehouse[w.lot_stock_id[0]] = w.id;
      }
    }

    // Get all stock quants for internal locations
    const locationIds = Object.keys(locationToWarehouse).map(Number);
    const quants = await client.searchRead('stock.quant', [
      ['location_id', 'in', locationIds],
      ['quantity', '!=', 0]
    ], [
      'product_id', 'location_id', 'quantity'
    ], { limit: 100000 });

    // Build stock map: { productId: { warehouseId: qty } }
    const stockByProduct = {};
    for (const q of quants) {
      const productId = q.product_id[0];
      const locationId = q.location_id[0];
      const warehouseId = locationToWarehouse[locationId];

      if (!warehouseId) continue;

      if (!stockByProduct[productId]) {
        stockByProduct[productId] = {};
      }
      stockByProduct[productId][warehouseId] = (stockByProduct[productId][warehouseId] || 0) + q.quantity;
    }

    res.json({
      success: true,
      warehouses: Object.values(warehouseMap),
      stockByProduct
    });
  } catch (error) {
    console.error('Odoo stock by warehouse error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== PRODUCT SYNC (MongoDB Cache) ====================
// IMPORTANT: These routes MUST come before /products/:id

const { getProductSyncService } = require('../../services/ProductSyncService');
const Product = require('../../models/Product');

/**
 * Get all products from MongoDB (for inventory page) - FAST!
 */
router.get('/products/all', async (req, res) => {
  try {
    const count = await Product.countDocuments();

    if (count === 0) {
      return res.json({
        success: false,
        message: 'Product cache is empty. Please trigger a sync first.',
        syncRequired: true,
        products: []
      });
    }

    const products = await Product.find({ active: true, canSell: true })
      .sort({ name: 1 })
      .lean();

    const transformed = products.map(p => ({
      id: p.odooId,
      name: p.name,
      sku: p.sku,
      barcode: p.barcode,
      price: p.salePrice,
      cost: p.cost,
      stock: p.totalStock,
      available: p.totalStock,
      category: p.category,
      categoryId: p.categoryId,
      image: p.image,
      type: p.type,
      uom: p.uom,
      active: p.active,
      stockByWarehouse: p.stockByWarehouse instanceof Map
        ? Object.fromEntries(p.stockByWarehouse)
        : p.stockByWarehouse,
      cwStock: p.cwStock
    }));

    res.json({
      success: true,
      count: transformed.length,
      products: transformed
    });
  } catch (error) {
    console.error('Products all error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get products from MongoDB cache with search/filter
 */
router.get('/products/cached', async (req, res) => {
  try {
    const { q, limit = 100, offset = 0, in_stock } = req.query;

    const count = await Product.countDocuments();

    if (count === 0) {
      return res.json({
        success: false,
        message: 'Product cache is empty. Please trigger a sync first.',
        syncRequired: true,
        count: 0,
        products: []
      });
    }

    const query = { active: true, canSell: true };

    if (q) {
      query.$or = [
        { name: { $regex: q, $options: 'i' } },
        { sku: { $regex: q, $options: 'i' } },
        { barcode: { $regex: q, $options: 'i' } }
      ];
    }

    if (in_stock === '1' || in_stock === 'true') {
      query.totalStock = { $gt: 0 };
    }

    const products = await Product.find(query)
      .sort({ name: 1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .lean();

    const transformed = products.map(p => ({
      id: p.odooId,
      name: p.name,
      sku: p.sku,
      barcode: p.barcode,
      price: p.salePrice,
      cost: p.cost,
      stock: p.totalStock,
      available: p.totalStock,
      category: p.category,
      categoryId: p.categoryId,
      image: p.image,
      type: p.type,
      uom: p.uom,
      active: p.active,
      stockByWarehouse: p.stockByWarehouse instanceof Map
        ? Object.fromEntries(p.stockByWarehouse)
        : p.stockByWarehouse,
      cwStock: p.cwStock
    }));

    res.json({
      success: true,
      count: transformed.length,
      total: count,
      products: transformed
    });
  } catch (error) {
    console.error('Product cache error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get product sync status
 */
router.get('/products/sync/status', async (req, res) => {
  try {
    const syncService = getProductSyncService();
    const status = await syncService.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Product sync status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger full product sync from Odoo
 */
router.post('/products/sync/full', async (req, res) => {
  try {
    const syncService = getProductSyncService();

    if (syncService.isRunning) {
      return res.json({
        success: false,
        message: 'Sync already in progress',
        isRunning: true
      });
    }

    // Start sync in background
    syncService.fullSync().catch(err => {
      console.error('[ProductSync] Full sync error:', err);
    });

    res.json({
      success: true,
      message: 'Full sync started in background'
    });
  } catch (error) {
    console.error('Product full sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger incremental product sync
 */
router.post('/products/sync/incremental', async (req, res) => {
  try {
    const syncService = getProductSyncService();

    if (syncService.isRunning) {
      return res.json({
        success: false,
        message: 'Sync already in progress',
        isRunning: true
      });
    }

    const result = await syncService.incrementalSync();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Product incremental sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger stock-only sync
 */
router.post('/products/sync/stock', async (req, res) => {
  try {
    const syncService = getProductSyncService();

    if (syncService.isRunning) {
      return res.json({
        success: false,
        message: 'Sync already in progress',
        isRunning: true
      });
    }

    const result = await syncService.syncStock();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Product stock sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get single product with all details
 */
router.get('/products/:id', async (req, res) => {
  try {
    const client = await getOdooClient();

    // Fetch ALL fields for comprehensive product view
    const allFields = [
      // Identity
      'id', 'name', 'display_name', 'default_code', 'barcode', 'active',
      // Images
      'image_1920', 'image_128',
      // Pricing
      'list_price', 'standard_price', 'lst_price',
      // Inventory
      'qty_available', 'virtual_available', 'incoming_qty', 'outgoing_qty',
      'free_qty', 'reordering_min_qty', 'reordering_max_qty',
      // Classification
      'categ_id', 'type', 'detailed_type',
      // Units
      'uom_id', 'uom_po_id',
      // Physical
      'weight', 'volume',
      // Sales & Purchase
      'sale_ok', 'purchase_ok', 'invoice_policy',
      // Descriptions
      'description', 'description_sale', 'description_purchase',
      // Supplier
      'seller_ids',
      // Tracking
      'tracking',
      // Taxes
      'taxes_id', 'supplier_taxes_id',
      // Routes & Warehouse
      'route_ids', 'responsible_id',
      // Dates
      'create_date', 'write_date', 'create_uid', 'write_uid',
      // Variants
      'product_tmpl_id', 'product_variant_count', 'attribute_line_ids',
      // Accounting
      'property_account_income_id', 'property_account_expense_id',
      // Extra
      'company_id', 'currency_id',
      // Packaging
      'packaging_ids'
    ];

    const products = await client.read('product.product', [parseInt(req.params.id)], allFields);

    if (!products.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const p = products[0];

    // Return both raw Odoo data and transformed data
    res.json({
      success: true,
      product: {
        // Core identity
        id: p.id,
        name: p.name,
        displayName: p.display_name,
        sku: p.default_code || '',
        barcode: p.barcode || '',
        active: p.active,
        type: p.type,
        detailedType: p.detailed_type,

        // Images
        image: p.image_1920 ? `data:image/png;base64,${p.image_1920}` : null,
        thumbnail: p.image_128 ? `data:image/png;base64,${p.image_128}` : null,

        // Pricing
        salePrice: p.list_price,
        cost: p.standard_price,
        listPrice: p.lst_price,

        // Inventory
        qtyOnHand: p.qty_available,
        qtyForecasted: p.virtual_available,
        qtyIncoming: p.incoming_qty,
        qtyOutgoing: p.outgoing_qty,
        qtyFree: p.free_qty,
        reorderMin: p.reordering_min_qty,
        reorderMax: p.reordering_max_qty,

        // Classification
        category: p.categ_id ? p.categ_id[1] : '',
        categoryId: p.categ_id ? p.categ_id[0] : null,

        // Units
        uom: p.uom_id ? p.uom_id[1] : '',
        uomId: p.uom_id ? p.uom_id[0] : null,
        purchaseUom: p.uom_po_id ? p.uom_po_id[1] : '',
        purchaseUomId: p.uom_po_id ? p.uom_po_id[0] : null,

        // Physical
        weight: p.weight,
        volume: p.volume,

        // Sales & Purchase
        canSell: p.sale_ok,
        canPurchase: p.purchase_ok,
        invoicePolicy: p.invoice_policy,
        tracking: p.tracking,

        // Descriptions
        description: p.description || '',
        descriptionSale: p.description_sale || '',
        descriptionPurchase: p.description_purchase || '',

        // Suppliers
        supplierCount: Array.isArray(p.seller_ids) ? p.seller_ids.length : 0,

        // Taxes
        salesTaxes: p.taxes_id || [],
        purchaseTaxes: p.supplier_taxes_id || [],

        // Routes
        routes: p.route_ids || [],
        responsible: p.responsible_id ? p.responsible_id[1] : null,

        // Template & Variants
        templateId: p.product_tmpl_id ? p.product_tmpl_id[0] : null,
        templateName: p.product_tmpl_id ? p.product_tmpl_id[1] : null,
        variantCount: p.product_variant_count || 1,

        // Company & Currency
        company: p.company_id ? p.company_id[1] : null,
        currency: p.currency_id ? p.currency_id[1] : 'EUR',

        // Accounting
        incomeAccount: p.property_account_income_id ? p.property_account_income_id[1] : null,
        expenseAccount: p.property_account_expense_id ? p.property_account_expense_id[1] : null,

        // Logistics (these fields may not exist in all Odoo instances)
        hsCode: '',
        originCountry: null,
        originCountryId: null,
        saleDelay: 0,
        produceDelay: 0,
        packagingCount: Array.isArray(p.packaging_ids) ? p.packaging_ids.length : 0,

        // Audit
        createdAt: p.create_date,
        updatedAt: p.write_date,
        createdBy: p.create_uid ? p.create_uid[1] : null,
        updatedBy: p.write_uid ? p.write_uid[1] : null
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
      salePrice: 'list_price',
      cost: 'standard_price',
      descriptionSale: 'description_sale',
      descriptionPurchase: 'description_purchase',
      weight: 'weight',
      volume: 'volume',
      active: 'active',
      categoryId: 'categ_id',
      canSell: 'sale_ok',
      canPurchase: 'purchase_ok',
      tracking: 'tracking',
      invoicePolicy: 'invoice_policy'
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
 * Get product attachments
 */
router.get('/products/:id/attachments', async (req, res) => {
  try {
    const client = await getOdooClient();
    const productId = parseInt(req.params.id);

    // Get attachments linked to this product
    const attachments = await client.searchRead('ir.attachment', [
      ['res_model', '=', 'product.product'],
      ['res_id', '=', productId]
    ], [
      'id', 'name', 'mimetype', 'file_size', 'create_date', 'create_uid',
      'datas', 'type', 'url', 'description'
    ], { order: 'create_date desc' });

    // Also check product.template attachments
    const products = await client.read('product.product', [productId], ['product_tmpl_id']);
    if (products.length && products[0].product_tmpl_id) {
      const templateId = products[0].product_tmpl_id[0];
      const templateAttachments = await client.searchRead('ir.attachment', [
        ['res_model', '=', 'product.template'],
        ['res_id', '=', templateId]
      ], [
        'id', 'name', 'mimetype', 'file_size', 'create_date', 'create_uid',
        'datas', 'type', 'url', 'description'
      ], { order: 'create_date desc' });
      attachments.push(...templateAttachments);
    }

    // Categorize attachments
    const categorized = {
      pictures: [],
      videos: [],
      packaging: [],
      documents: []
    };

    attachments.forEach(a => {
      const item = {
        id: a.id,
        name: a.name,
        mimetype: a.mimetype,
        size: a.file_size,
        createdAt: a.create_date,
        createdBy: a.create_uid ? a.create_uid[1] : null,
        description: a.description || '',
        url: a.type === 'url' ? a.url : null,
        data: a.datas ? `data:${a.mimetype};base64,${a.datas}` : null
      };

      const mime = a.mimetype || '';
      const name = (a.name || '').toLowerCase();

      if (mime.startsWith('image/')) {
        categorized.pictures.push(item);
      } else if (mime.startsWith('video/')) {
        categorized.videos.push(item);
      } else if (name.includes('packaging') || name.includes('package') || name.includes('box') || name.includes('carton')) {
        categorized.packaging.push(item);
      } else {
        categorized.documents.push(item);
      }
    });

    res.json({ success: true, attachments: categorized, total: attachments.length });
  } catch (error) {
    console.error('Odoo attachments error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload attachment to product
 */
router.post('/products/:id/attachments', async (req, res) => {
  try {
    const client = await getOdooClient();
    const productId = parseInt(req.params.id);
    const { name, data, mimetype, category, description } = req.body;

    if (!name || !data) {
      return res.status(400).json({ error: 'Name and data are required' });
    }

    // Extract base64 data
    const base64Data = data.includes(',') ? data.split(',')[1] : data;

    // Create attachment in Odoo
    const attachmentId = await client.create('ir.attachment', {
      name: category ? `[${category}] ${name}` : name,
      datas: base64Data,
      res_model: 'product.product',
      res_id: productId,
      mimetype: mimetype || 'application/octet-stream',
      description: description || ''
    });

    res.json({ success: true, attachmentId, message: 'Attachment uploaded' });
  } catch (error) {
    console.error('Odoo attachment upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete attachment
 */
router.delete('/products/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const client = await getOdooClient();
    const attachmentId = parseInt(req.params.attachmentId);

    await client.unlink('ir.attachment', [attachmentId]);

    res.json({ success: true, message: 'Attachment deleted' });
  } catch (error) {
    console.error('Odoo attachment delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get product packaging
 */
router.get('/products/:id/packaging', async (req, res) => {
  try {
    const client = await getOdooClient();
    const productId = parseInt(req.params.id);

    // Get packaging linked to this product
    const packaging = await client.searchRead('product.packaging', [
      ['product_id', '=', productId]
    ], [
      'id', 'name', 'qty', 'barcode', 'sequence', 'product_uom_id',
      'create_date', 'write_date', 'create_uid', 'write_uid'
    ], { order: 'sequence asc, name asc' });

    res.json({
      success: true,
      packaging: packaging.map(p => ({
        id: p.id,
        name: p.name,
        qty: p.qty,
        barcode: p.barcode || '',
        sequence: p.sequence || 0,
        uom: p.product_uom_id ? p.product_uom_id[1] : '',
        uomId: p.product_uom_id ? p.product_uom_id[0] : null,
        createdAt: p.create_date,
        updatedAt: p.write_date,
        createdBy: p.create_uid ? p.create_uid[1] : null,
        updatedBy: p.write_uid ? p.write_uid[1] : null
      }))
    });
  } catch (error) {
    console.error('Odoo packaging fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create product packaging
 */
router.post('/products/:id/packaging', async (req, res) => {
  try {
    const client = await getOdooClient();
    const productId = parseInt(req.params.id);
    const { name, qty, barcode } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Create packaging in Odoo
    const packagingId = await client.create('product.packaging', {
      product_id: productId,
      name: name,
      qty: qty || 1,
      barcode: barcode || false
    });

    // Log the change
    console.log(`[ProductPackaging] Created packaging "${name}" (ID: ${packagingId}) for product ${productId}`);

    // Fetch the created packaging
    const created = await client.read('product.packaging', [packagingId], [
      'id', 'name', 'qty', 'barcode', 'sequence', 'product_uom_id'
    ]);

    res.json({
      success: true,
      message: 'Packaging created successfully',
      packaging: {
        id: created[0].id,
        name: created[0].name,
        qty: created[0].qty,
        barcode: created[0].barcode || '',
        sequence: created[0].sequence || 0,
        uom: created[0].product_uom_id ? created[0].product_uom_id[1] : ''
      }
    });
  } catch (error) {
    console.error('Odoo packaging create error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update product packaging
 */
router.put('/products/:id/packaging/:packagingId', async (req, res) => {
  try {
    const client = await getOdooClient();
    const packagingId = parseInt(req.params.packagingId);
    const { name, qty, barcode } = req.body;

    // Build update object
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (qty !== undefined) updates.qty = qty;
    if (barcode !== undefined) updates.barcode = barcode || false;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Log what we're updating
    console.log(`[ProductPackaging] Updating packaging ${packagingId}:`, updates);

    // Update in Odoo
    await client.write('product.packaging', [packagingId], updates);

    // Fetch updated packaging
    const updated = await client.read('product.packaging', [packagingId], [
      'id', 'name', 'qty', 'barcode', 'sequence', 'product_uom_id', 'write_date'
    ]);

    res.json({
      success: true,
      message: 'Packaging updated successfully',
      packaging: {
        id: updated[0].id,
        name: updated[0].name,
        qty: updated[0].qty,
        barcode: updated[0].barcode || '',
        sequence: updated[0].sequence || 0,
        uom: updated[0].product_uom_id ? updated[0].product_uom_id[1] : '',
        updatedAt: updated[0].write_date
      }
    });
  } catch (error) {
    console.error('Odoo packaging update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete product packaging
 */
router.delete('/products/:id/packaging/:packagingId', async (req, res) => {
  try {
    const client = await getOdooClient();
    const packagingId = parseInt(req.params.packagingId);

    // Get packaging name for logging before deletion
    const packaging = await client.read('product.packaging', [packagingId], ['name']);
    const packagingName = packaging.length ? packaging[0].name : 'Unknown';

    // Delete from Odoo
    await client.unlink('product.packaging', [packagingId]);

    console.log(`[ProductPackaging] Deleted packaging "${packagingName}" (ID: ${packagingId})`);

    res.json({ success: true, message: 'Packaging deleted successfully' });
  } catch (error) {
    console.error('Odoo packaging delete error:', error);
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
 * Get warehouses list - uses MongoDB cache (fast!)
 * Warehouses are synced from Odoo via Settings > Warehouses
 */
router.get('/warehouses', async (req, res) => {
  try {
    // Get warehouses from MongoDB cache
    const warehouses = await Warehouse.getActive();

    if (warehouses.length > 0) {
      return res.json({
        success: true,
        cached: true,
        warehouses: warehouses.map(w => ({
          id: w.odooId,
          name: w.name,
          code: w.code,
          stockLocationId: w.stockLocationId
        }))
      });
    }

    // No cached warehouses - return default Central Warehouse
    // User should sync warehouses from Settings > Warehouses
    console.log('[Odoo API] No cached warehouses found. Please sync from Settings > Warehouses.');
    res.json({
      success: true,
      cached: false,
      needsSync: true,
      warehouses: [
        { id: 1, name: 'Central Warehouse', code: 'CW' }
      ]
    });
  } catch (error) {
    console.error('Odoo warehouses error:', error);
    res.json({
      success: true,
      warehouses: [{ id: 1, name: 'Central Warehouse', code: 'CW' }]
    });
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
