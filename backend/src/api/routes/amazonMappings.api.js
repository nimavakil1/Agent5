/**
 * Amazon Product Mappings API
 *
 * CRUD endpoints for managing ASIN to Odoo product mappings.
 * Independent of Emipro modules - uses our own MongoDB collection.
 */

const express = require('express');
const router = express.Router();
const { getAmazonProductMapper, MARKETPLACES } = require('../../services/amazon/AmazonProductMapper');

/**
 * GET /api/amazon/mappings
 * List all mappings with pagination and search
 */
router.get('/', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();

    const options = {
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 50,
      search: req.query.search || '',
      marketplace: req.query.marketplace || null,
      includeInactive: req.query.includeInactive === 'true'
    };

    const result = await mapper.getMappings(options);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[AmazonMappings] Error getting mappings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/amazon/mappings/stats
 * Get mapping statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const stats = await mapper.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[AmazonMappings] Error getting stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/amazon/mappings/marketplaces
 * Get list of supported marketplaces
 */
router.get('/marketplaces', (req, res) => {
  res.json({
    success: true,
    marketplaces: MARKETPLACES
  });
});

/**
 * GET /api/amazon/mappings/by-asin/:asin
 * Find mapping by ASIN
 */
router.get('/by-asin/:asin', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const { asin } = req.params;
    const marketplace = req.query.marketplace || 'ALL';

    const mapping = await mapper.findByAsin(asin, marketplace);

    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found'
      });
    }

    res.json({
      success: true,
      mapping
    });
  } catch (error) {
    console.error('[AmazonMappings] Error finding mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/amazon/mappings/by-product/:productId
 * Find all mappings for an Odoo product
 */
router.get('/by-product/:productId', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const productId = parseInt(req.params.productId);

    const mappings = await mapper.findByOdooProduct(productId);

    res.json({
      success: true,
      mappings
    });
  } catch (error) {
    console.error('[AmazonMappings] Error finding mappings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/amazon/mappings
 * Create or update a mapping
 */
router.post('/', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();

    const {
      asin,
      marketplace,
      odooProductId,
      odooSku,
      odooProductName,
      sellerSku,
      barcode,
      fulfillmentBy
    } = req.body;

    if (!asin) {
      return res.status(400).json({
        success: false,
        error: 'ASIN is required'
      });
    }

    if (!odooProductId) {
      return res.status(400).json({
        success: false,
        error: 'Odoo product ID is required'
      });
    }

    const result = await mapper.upsertMapping({
      asin,
      marketplace: marketplace || 'ALL',
      odooProductId,
      odooSku,
      odooProductName,
      sellerSku,
      barcode,
      fulfillmentBy
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[AmazonMappings] Error creating mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/amazon/mappings/:asin
 * Update a mapping
 */
router.put('/:asin', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const { asin } = req.params;
    const marketplace = req.body.marketplace || 'ALL';

    const result = await mapper.upsertMapping({
      asin,
      marketplace,
      ...req.body
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[AmazonMappings] Error updating mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/amazon/mappings/:asin
 * Delete a mapping (hard delete)
 */
router.delete('/:asin', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const { asin } = req.params;
    const marketplace = req.query.marketplace || 'ALL';

    const deleted = await mapper.deleteMapping(asin, marketplace);

    res.json({
      success: true,
      deleted
    });
  } catch (error) {
    console.error('[AmazonMappings] Error deleting mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/amazon/mappings/:asin/deactivate
 * Soft delete (deactivate) a mapping
 */
router.post('/:asin/deactivate', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const { asin } = req.params;
    const marketplace = req.body.marketplace || 'ALL';

    const deactivated = await mapper.deactivateMapping(asin, marketplace);

    res.json({
      success: true,
      deactivated
    });
  } catch (error) {
    console.error('[AmazonMappings] Error deactivating mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/amazon/mappings/bulk-import
 * Import mappings in bulk
 */
router.post('/bulk-import', async (req, res) => {
  try {
    const mapper = await getAmazonProductMapper();
    const { mappings } = req.body;

    if (!mappings || !Array.isArray(mappings)) {
      return res.status(400).json({
        success: false,
        error: 'mappings array is required'
      });
    }

    const result = await mapper.bulkImport(mappings);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[AmazonMappings] Error bulk importing:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
