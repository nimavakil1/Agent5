/**
 * Carriers API Routes
 *
 * Manage shipping carriers:
 * - CRUD operations for carriers
 * - Carrier logo management
 * - API connection testing
 * - Bol.com transporter code mapping
 */

const express = require('express');
const router = express.Router();
const Carrier = require('../../models/Carrier');

// ============================================
// CARRIER CRUD ENDPOINTS
// ============================================

/**
 * Get all carriers
 * GET /api/carriers
 */
router.get('/', async (req, res) => {
  try {
    const { active, country } = req.query;

    const query = {};
    if (active === 'true') {
      query.isActive = true;
    }
    if (country) {
      query.countries = country.toUpperCase();
    }

    const carriers = await Carrier.find(query)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    res.json({
      success: true,
      count: carriers.length,
      carriers
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single carrier
 * GET /api/carriers/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const carrier = await Carrier.findById(req.params.id).lean();
    if (!carrier) {
      return res.status(404).json({ success: false, error: 'Carrier not found' });
    }

    res.json({
      success: true,
      carrier
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create new carrier
 * POST /api/carriers
 */
router.post('/', async (req, res) => {
  try {
    const carrierData = req.body;

    // Validate required fields
    if (!carrierData.name || !carrierData.code || !carrierData.bolTransporterCode) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, code, bolTransporterCode'
      });
    }

    // Check for duplicates
    const existing = await Carrier.findOne({
      $or: [
        { name: carrierData.name },
        { code: carrierData.code.toUpperCase() }
      ]
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: `Carrier already exists: ${existing.name}`
      });
    }

    const carrier = await Carrier.create({
      ...carrierData,
      code: carrierData.code.toUpperCase()
    });

    res.json({
      success: true,
      message: `Carrier "${carrier.name}" created`,
      carrier
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update carrier
 * PUT /api/carriers/:id
 */
router.put('/:id', async (req, res) => {
  try {
    const updates = req.body;

    // Don't allow changing code if it would conflict
    if (updates.code) {
      const existing = await Carrier.findOne({
        code: updates.code.toUpperCase(),
        _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(400).json({
          success: false,
          error: `Carrier code "${updates.code}" already exists`
        });
      }
      updates.code = updates.code.toUpperCase();
    }

    const carrier = await Carrier.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true }
    );

    if (!carrier) {
      return res.status(404).json({ success: false, error: 'Carrier not found' });
    }

    res.json({
      success: true,
      message: `Carrier "${carrier.name}" updated`,
      carrier
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete carrier
 * DELETE /api/carriers/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const carrier = await Carrier.findByIdAndDelete(req.params.id);

    if (!carrier) {
      return res.status(404).json({ success: false, error: 'Carrier not found' });
    }

    res.json({
      success: true,
      message: `Carrier "${carrier.name}" deleted`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// CARRIER MANAGEMENT ENDPOINTS
// ============================================

/**
 * Seed predefined carriers
 * POST /api/carriers/seed
 */
router.post('/seed', async (req, res) => {
  try {
    const result = await Carrier.seedPredefined();

    res.json({
      success: true,
      message: `Created ${result.created} carriers (${result.total} total predefined)`,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Toggle carrier active status
 * POST /api/carriers/:id/toggle-active
 */
router.post('/:id/toggle-active', async (req, res) => {
  try {
    const carrier = await Carrier.findById(req.params.id);

    if (!carrier) {
      return res.status(404).json({ success: false, error: 'Carrier not found' });
    }

    carrier.isActive = !carrier.isActive;
    await carrier.save();

    res.json({
      success: true,
      message: `Carrier "${carrier.name}" is now ${carrier.isActive ? 'active' : 'inactive'}`,
      isActive: carrier.isActive
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update carrier sort order
 * POST /api/carriers/reorder
 */
router.post('/reorder', async (req, res) => {
  try {
    const { order } = req.body; // Array of { id, sortOrder }

    if (!order || !Array.isArray(order)) {
      return res.status(400).json({
        success: false,
        error: 'Expected array of { id, sortOrder }'
      });
    }

    const updates = order.map(item =>
      Carrier.updateOne({ _id: item.id }, { sortOrder: item.sortOrder })
    );

    await Promise.all(updates);

    res.json({
      success: true,
      message: `Updated sort order for ${order.length} carriers`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// CARRIER API CONNECTION ENDPOINTS
// ============================================

/**
 * Update carrier API config
 * PUT /api/carriers/:id/api-config
 */
router.put('/:id/api-config', async (req, res) => {
  try {
    const { provider, baseUrl, apiKey, apiSecret, accountNumber, extraFields } = req.body;

    const carrier = await Carrier.findById(req.params.id);
    if (!carrier) {
      return res.status(404).json({ success: false, error: 'Carrier not found' });
    }

    carrier.apiConfig = {
      ...carrier.apiConfig,
      provider,
      baseUrl,
      apiKey,
      apiSecret,
      accountNumber,
      extraFields: extraFields || {},
      isConnected: false, // Reset connection status
      lastTestedAt: null
    };

    await carrier.save();

    res.json({
      success: true,
      message: `API config updated for "${carrier.name}"`,
      apiConfig: {
        provider: carrier.apiConfig.provider,
        baseUrl: carrier.apiConfig.baseUrl,
        isConnected: carrier.apiConfig.isConnected
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Test carrier API connection
 * POST /api/carriers/:id/test-connection
 */
router.post('/:id/test-connection', async (req, res) => {
  try {
    const carrier = await Carrier.findById(req.params.id);
    if (!carrier) {
      return res.status(404).json({ success: false, error: 'Carrier not found' });
    }

    if (!carrier.apiConfig?.provider) {
      return res.status(400).json({
        success: false,
        error: 'No API provider configured'
      });
    }

    let testResult = {
      success: false,
      message: `Connector for "${carrier.apiConfig.provider}" not yet implemented`
    };

    // Test connection based on provider
    switch (carrier.apiConfig.provider) {
      case 'gls': {
        const { GLSClient } = require('../../services/shipping/GLSClient');
        const glsClient = new GLSClient();
        testResult = await glsClient.testConnection();
        break;
      }
      case 'dachser': {
        const { getDachserClient } = require('../../services/shipping/DachserClient');
        const dachserClient = getDachserClient();
        testResult = await dachserClient.testConnection();
        break;
      }
      // Add other providers here as they're implemented
      default:
        break;
    }

    carrier.apiConfig.lastTestedAt = new Date();
    carrier.apiConfig.isConnected = testResult.success;
    await carrier.save();

    res.json({
      success: testResult.success,
      message: testResult.message,
      testedAt: carrier.apiConfig.lastTestedAt
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// BOL.COM MAPPING ENDPOINTS
// ============================================

/**
 * Get carrier by Bol.com transporter code
 * GET /api/carriers/bol/:bolCode
 */
router.get('/bol/:bolCode', async (req, res) => {
  try {
    const carrier = await Carrier.findByBolCode(req.params.bolCode);

    if (!carrier) {
      return res.status(404).json({
        success: false,
        error: `No carrier found for Bol.com code: ${req.params.bolCode}`
      });
    }

    res.json({
      success: true,
      carrier
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get all Bol.com transporter codes
 * GET /api/carriers/bol-codes
 */
router.get('/bol-codes', async (req, res) => {
  try {
    const carriers = await Carrier.find({ isActive: true })
      .select('name code bolTransporterCode logo')
      .sort({ name: 1 })
      .lean();

    const bolCodes = carriers.map(c => ({
      name: c.name,
      carrierCode: c.code,
      bolCode: c.bolTransporterCode,
      logo: c.logo
    }));

    // Also include valid Bol.com codes from documentation
    const allBolCodes = [
      'BRIEFPOST', 'UPS', 'TNT', 'TNT-EXTRA', 'TNT_BRIEF', 'TNT-EXPRESS',
      'DYL', 'DPD-NL', 'DPD-BE', 'BPOST_BE', 'BPOST_BRIEF', 'DHLFORYOU',
      'GLS', 'FEDEX_NL', 'FEDEX_BE', 'OTHER', 'DHL', 'DHL_DE',
      'DHL-GLOBAL-MAIL', 'DHL-SD', 'TSN', 'TRANSMISSION', 'PARCEL-NL',
      'PACKS', 'COURIER', 'PES', 'BUDBEE', 'TRUNKRS'
    ];

    res.json({
      success: true,
      configured: bolCodes,
      allValidBolCodes: allBolCodes
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
