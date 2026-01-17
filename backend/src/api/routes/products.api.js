/**
 * Products API Routes - Safety Stock Management
 *
 * Endpoints for managing product safety stock levels.
 * Safety stock is deducted from free quantity when sending to Amazon FBM.
 */

const express = require('express');
const router = express.Router();
const Product = require('../../models/Product');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const multer = require('multer');
const ExcelJS = require('exceljs');

// Configure multer for Excel file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload an Excel (.xlsx) or CSV file.'));
    }
  }
});

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
 * GET /api/products-api/safety-stock
 * Get all products with their safety stock values
 * Supports pagination and search
 */
router.get('/safety-stock', async (req, res) => {
  try {
    const { q, limit = 100, offset = 0 } = req.query;

    const query = { active: true, canSell: true };

    if (q) {
      query.$or = [
        { name: { $regex: q, $options: 'i' } },
        { sku: { $regex: q, $options: 'i' } },
        { barcode: { $regex: q, $options: 'i' } }
      ];
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('odooId name sku barcode safetyStock totalStock cwStock')
        .sort({ name: 1 })
        .skip(parseInt(offset))
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(query)
    ]);

    res.json({
      success: true,
      count: products.length,
      total,
      products: products.map(p => ({
        odooId: p.odooId,
        name: p.name,
        sku: p.sku || '',
        barcode: p.barcode || '',
        safetyStock: p.safetyStock ?? 10,
        totalStock: p.totalStock || 0,
        cwStock: p.cwStock || 0
      }))
    });
  } catch (error) {
    console.error('[Products API] Get safety stock error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/products-api/:odooId/safety-stock
 * Update safety stock for a single product
 * Updates both MongoDB and Odoo
 */
router.put('/:odooId/safety-stock', async (req, res) => {
  try {
    const odooId = parseInt(req.params.odooId);
    const { safetyStock } = req.body;

    if (isNaN(odooId)) {
      return res.status(400).json({ success: false, error: 'Invalid Odoo ID' });
    }

    if (typeof safetyStock !== 'number' || safetyStock < 0) {
      return res.status(400).json({
        success: false,
        error: 'Safety stock must be a non-negative number'
      });
    }

    // Update in MongoDB
    const product = await Product.findOneAndUpdate(
      { odooId },
      { $set: { safetyStock } },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found in local database'
      });
    }

    // Update in Odoo
    try {
      const client = await getOdooClient();
      await client.write('product.product', [odooId], {
        x_safety_stock: safetyStock
      });
      console.log(`[Products API] Updated safety stock for ${product.sku || odooId} to ${safetyStock} in Odoo`);
    } catch (odooError) {
      console.error('[Products API] Failed to update Odoo:', odooError.message);
      // Continue - MongoDB is updated, Odoo will sync eventually
    }

    res.json({
      success: true,
      message: 'Safety stock updated',
      product: {
        odooId: product.odooId,
        name: product.name,
        sku: product.sku,
        safetyStock: product.safetyStock
      }
    });
  } catch (error) {
    console.error('[Products API] Update safety stock error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/products-api/safety-stock/bulk
 * Bulk update safety stock via JSON array
 * Body: { items: [{ sku: string, safetyStock: number }, ...] } or { updates: [...] }
 */
router.post('/safety-stock/bulk', async (req, res) => {
  try {
    // Accept both 'items' (from UI) and 'updates' (legacy) format
    let updates = req.body.items || req.body.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Items array is required'
      });
    }

    // Resolve SKUs to OdooIDs if needed
    const skuItems = updates.filter(u => u.sku && !u.odooId);
    if (skuItems.length > 0) {
      const skus = skuItems.map(u => u.sku);
      const products = await Product.find({ sku: { $in: skus } })
        .select('odooId sku')
        .lean();

      const skuToOdooId = {};
      products.forEach(p => {
        skuToOdooId[p.sku] = p.odooId;
      });

      skuItems.forEach(u => {
        if (skuToOdooId[u.sku]) {
          u.odooId = skuToOdooId[u.sku];
        }
      });
    }

    // Filter to items with valid odooId
    const validUpdates = updates.filter(u => u.odooId);
    const notFoundCount = updates.length - validUpdates.length;

    if (validUpdates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid products found to update',
        notFound: notFoundCount
      });
    }

    // Validate all updates
    const validationErrors = [];
    validUpdates.forEach((update, index) => {
      if (typeof update.odooId !== 'number') {
        validationErrors.push(`Row ${index + 1}: Invalid Odoo ID`);
      }
      if (typeof update.safetyStock !== 'number' || update.safetyStock < 0) {
        validationErrors.push(`Row ${index + 1}: Safety stock must be a non-negative number`);
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors
      });
    }

    // Build bulk operations for MongoDB
    const bulkOps = updates.map(u => ({
      updateOne: {
        filter: { odooId: u.odooId },
        update: { $set: { safetyStock: u.safetyStock } }
      }
    }));

    // Execute MongoDB bulk update
    const mongoResult = await Product.bulkWrite(bulkOps, { ordered: false });

    // Update Odoo in batches
    let odooUpdated = 0;
    let odooErrors = [];

    try {
      const client = await getOdooClient();

      // Update each product in Odoo (batch writes not supported for different values)
      for (const update of updates) {
        try {
          await client.write('product.product', [update.odooId], {
            x_safety_stock: update.safetyStock
          });
          odooUpdated++;
        } catch (err) {
          odooErrors.push({ odooId: update.odooId, error: err.message });
        }
      }
    } catch (odooError) {
      console.error('[Products API] Odoo connection error:', odooError.message);
      odooErrors.push({ error: 'Odoo connection failed: ' + odooError.message });
    }

    console.log(`[Products API] Bulk safety stock update: MongoDB=${mongoResult.modifiedCount}, Odoo=${odooUpdated}`);

    res.json({
      success: true,
      message: 'Bulk update completed',
      updated: mongoResult.modifiedCount,
      notFound: notFoundCount,
      results: {
        requested: updates.length,
        mongoUpdated: mongoResult.modifiedCount,
        odooUpdated,
        odooErrors: odooErrors.length > 0 ? odooErrors : undefined
      }
    });
  } catch (error) {
    console.error('[Products API] Bulk update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/products-api/safety-stock/upload
 * Bulk update safety stock via Excel file upload
 * Expected columns: SKU or OdooID, SafetyStock
 */
router.post('/safety-stock/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ success: false, error: 'No worksheet found in file' });
    }

    // Find header row and column indices
    const headerRow = worksheet.getRow(1);
    let skuColIndex = -1;
    let odooIdColIndex = -1;
    let safetyStockColIndex = -1;

    headerRow.eachCell((cell, colNumber) => {
      const value = String(cell.value || '').toLowerCase().trim();
      if (value === 'sku' || value === 'default_code' || value === 'product_code') {
        skuColIndex = colNumber;
      } else if (value === 'odooid' || value === 'odoo_id' || value === 'id') {
        odooIdColIndex = colNumber;
      } else if (value === 'safetystock' || value === 'safety_stock' || value === 'safety stock') {
        safetyStockColIndex = colNumber;
      }
    });

    if (safetyStockColIndex === -1) {
      return res.status(400).json({
        success: false,
        error: 'SafetyStock column not found. Expected column header: SafetyStock, Safety_Stock, or Safety Stock'
      });
    }

    if (skuColIndex === -1 && odooIdColIndex === -1) {
      return res.status(400).json({
        success: false,
        error: 'SKU or OdooID column not found. Expected column header: SKU, Default_Code, OdooID, or ID'
      });
    }

    // Parse rows
    const updates = [];
    const errors = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const safetyStockValue = row.getCell(safetyStockColIndex).value;
      const safetyStock = parseFloat(safetyStockValue);

      if (isNaN(safetyStock) || safetyStock < 0) {
        errors.push({ row: rowNumber, error: 'Invalid safety stock value' });
        return;
      }

      if (odooIdColIndex !== -1) {
        const odooId = parseInt(row.getCell(odooIdColIndex).value);
        if (!isNaN(odooId)) {
          updates.push({ odooId, safetyStock, row: rowNumber });
          return;
        }
      }

      if (skuColIndex !== -1) {
        const sku = String(row.getCell(skuColIndex).value || '').trim();
        if (sku) {
          updates.push({ sku, safetyStock, row: rowNumber });
          return;
        }
      }

      errors.push({ row: rowNumber, error: 'No valid SKU or OdooID found' });
    });

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid rows found in file',
        parseErrors: errors
      });
    }

    // Resolve SKUs to OdooIDs
    const skuUpdates = updates.filter(u => u.sku && !u.odooId);
    if (skuUpdates.length > 0) {
      const skus = skuUpdates.map(u => u.sku);
      const products = await Product.find({ sku: { $in: skus } })
        .select('odooId sku')
        .lean();

      const skuToOdooId = {};
      products.forEach(p => {
        skuToOdooId[p.sku] = p.odooId;
      });

      skuUpdates.forEach(u => {
        if (skuToOdooId[u.sku]) {
          u.odooId = skuToOdooId[u.sku];
        } else {
          errors.push({ row: u.row, sku: u.sku, error: 'SKU not found in database' });
        }
      });
    }

    // Filter to only updates with valid odooId
    const validUpdates = updates.filter(u => u.odooId);

    if (validUpdates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid products found to update',
        parseErrors: errors
      });
    }

    // Build bulk operations for MongoDB
    const bulkOps = validUpdates.map(u => ({
      updateOne: {
        filter: { odooId: u.odooId },
        update: { $set: { safetyStock: u.safetyStock } }
      }
    }));

    // Execute MongoDB bulk update
    const mongoResult = await Product.bulkWrite(bulkOps, { ordered: false });

    // Update Odoo
    let odooUpdated = 0;
    let odooErrors = [];

    try {
      const client = await getOdooClient();

      for (const update of validUpdates) {
        try {
          await client.write('product.product', [update.odooId], {
            x_safety_stock: update.safetyStock
          });
          odooUpdated++;
        } catch (err) {
          odooErrors.push({ odooId: update.odooId, error: err.message });
        }
      }
    } catch (odooError) {
      console.error('[Products API] Odoo connection error:', odooError.message);
      odooErrors.push({ error: 'Odoo connection failed: ' + odooError.message });
    }

    console.log(`[Products API] Excel upload: ${validUpdates.length} valid rows, MongoDB=${mongoResult.modifiedCount}, Odoo=${odooUpdated}`);

    res.json({
      success: true,
      message: 'File processed successfully',
      results: {
        totalRows: updates.length + errors.length,
        validRows: validUpdates.length,
        mongoUpdated: mongoResult.modifiedCount,
        odooUpdated,
        parseErrors: errors.length > 0 ? errors : undefined,
        odooErrors: odooErrors.length > 0 ? odooErrors : undefined
      }
    });
  } catch (error) {
    console.error('[Products API] Excel upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/products-api/safety-stock/template
 * Download Excel template for bulk safety stock upload
 */
router.get('/safety-stock/template', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Safety Stock');

    // Add headers
    worksheet.columns = [
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Name', key: 'name', width: 40 },
      { header: 'Current Safety Stock', key: 'currentSafetyStock', width: 20 },
      { header: 'SafetyStock', key: 'safetyStock', width: 15 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Get sample products
    const products = await Product.find({ active: true, canSell: true })
      .select('sku name safetyStock')
      .sort({ name: 1 })
      .limit(100)
      .lean();

    // Add product rows
    products.forEach(p => {
      worksheet.addRow({
        sku: p.sku || '',
        name: p.name,
        currentSafetyStock: p.safetyStock ?? 10,
        safetyStock: '' // Leave empty for user to fill
      });
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=safety_stock_template.xlsx');

    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('[Products API] Template download error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/products-api/safety-stock/preview
 * Preview Excel file for bulk safety stock upload
 * Returns parsed items without updating
 */
router.post('/safety-stock/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ success: false, error: 'No worksheet found in file' });
    }

    // Find header row and column indices
    const headerRow = worksheet.getRow(1);
    let skuColIndex = -1;
    let safetyStockColIndex = -1;

    headerRow.eachCell((cell, colNumber) => {
      const value = String(cell.value || '').toLowerCase().trim();
      if (value === 'sku' || value === 'default_code' || value === 'product_code') {
        skuColIndex = colNumber;
      } else if (value === 'safetystock' || value === 'safety_stock' || value === 'safety stock') {
        safetyStockColIndex = colNumber;
      }
    });

    if (safetyStockColIndex === -1) {
      return res.status(400).json({
        success: false,
        error: 'SafetyStock column not found. Expected: SafetyStock, Safety_Stock, or Safety Stock'
      });
    }

    if (skuColIndex === -1) {
      return res.status(400).json({
        success: false,
        error: 'SKU column not found. Expected: SKU, Default_Code, or Product_Code'
      });
    }

    // Parse rows
    const items = [];
    const errors = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const sku = String(row.getCell(skuColIndex).value || '').trim();
      const safetyStockValue = row.getCell(safetyStockColIndex).value;
      const safetyStock = parseFloat(safetyStockValue);

      if (!sku) {
        errors.push({ row: rowNumber, error: 'Empty SKU' });
        return;
      }

      if (isNaN(safetyStock) || safetyStock < 0) {
        errors.push({ row: rowNumber, sku, error: 'Invalid safety stock value' });
        return;
      }

      items.push({ sku, safetyStock: Math.round(safetyStock) });
    });

    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid rows found in file',
        parseErrors: errors
      });
    }

    res.json({
      success: true,
      items,
      parseErrors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('[Products API] Preview error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/products-api/safety-stock/export
 * Export all products with safety stock to Excel
 */
router.get('/safety-stock/export', async (req, res) => {
  try {
    const products = await Product.find({ active: true, canSell: true })
      .select('sku name safetyStock totalStock cwStock')
      .sort({ sku: 1 })
      .lean();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Safety Stock Export');

    // Add headers
    worksheet.columns = [
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Product Name', key: 'name', width: 45 },
      { header: 'SafetyStock', key: 'safetyStock', width: 15 },
      { header: 'Total Stock', key: 'totalStock', width: 15 },
      { header: 'CW Stock', key: 'cwStock', width: 15 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF8B5CF6' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add product rows
    products.forEach(p => {
      if (p.sku) {
        worksheet.addRow({
          sku: p.sku,
          name: p.name,
          safetyStock: p.safetyStock ?? 10,
          totalStock: p.totalStock || 0,
          cwStock: p.cwStock || 0
        });
      }
    });

    // Set response headers
    const filename = `safety_stock_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('[Products API] Export error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
