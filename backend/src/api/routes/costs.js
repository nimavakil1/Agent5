const express = require('express');
const CallCostTracking = require('../../models/CallCostTracking');
const costCalculationService = require('../../services/costCalculationService');
const onedriveService = require('../../services/onedriveService');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();

// Protect all cost routes with authentication
router.use(requireSession);

// Get cost summary for dashboard
router.get('/summary', async (req, res) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      sessionType: req.query.sessionType
    };
    
    const summary = await costCalculationService.getCostSummary(filters);
    res.json(summary);
  } catch (error) {
    console.error('Cost summary error:', error);
    res.status(500).json({ message: 'Failed to get cost summary' });
  }
});

// Get detailed cost tracking for a specific call
router.get('/call/:callId', async (req, res) => {
  try {
    const callId = req.params.callId;
    const costTracking = await CallCostTracking.findOne({ call_id: callId });
    
    if (!costTracking) {
      return res.status(404).json({ message: 'Cost tracking not found' });
    }
    
    res.json(costTracking);
  } catch (error) {
    console.error('Get call cost error:', error);
    res.status(500).json({ message: 'Failed to get call costs' });
  }
});

// Get all cost records with pagination
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    const filters = {};
    if (req.query.sessionType) {
      filters.session_type = req.query.sessionType;
    }
    if (req.query.startDate || req.query.endDate) {
      filters.created_at = {};
      if (req.query.startDate) {
        filters.created_at.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filters.created_at.$lte = new Date(req.query.endDate);
      }
    }
    
    const costs = await CallCostTracking.find(filters)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    const total = await CallCostTracking.countDocuments(filters);
    
    res.json({
      costs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get costs error:', error);
    res.status(500).json({ message: 'Failed to get costs' });
  }
});

// Test OneDrive connection
router.get('/onedrive/test', async (req, res) => {
  try {
    const testResult = await onedriveService.testConnection();
    res.json(testResult);
  } catch (error) {
    console.error('OneDrive test error:', error);
    res.status(500).json({ message: 'OneDrive test failed', error: error.message });
  }
});

// Manually update cost rates (admin only)
router.put('/rates', async (req, res) => {
  try {
    const newRates = req.body;
    costCalculationService.updateRates(newRates);
    res.json({ message: 'Rates updated successfully', rates: newRates });
  } catch (error) {
    console.error('Update rates error:', error);
    res.status(500).json({ message: 'Failed to update rates' });
  }
});

// Export costs to CSV
router.get('/export', async (req, res) => {
  try {
    const filters = {};
    if (req.query.sessionType) {
      filters.session_type = req.query.sessionType;
    }
    if (req.query.startDate || req.query.endDate) {
      filters.created_at = {};
      if (req.query.startDate) {
        filters.created_at.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filters.created_at.$lte = new Date(req.query.endDate);
      }
    }
    
    const costs = await CallCostTracking.find(filters).sort({ created_at: -1 }).lean();
    
    // Generate CSV
    const csvHeader = 'Call ID,Session Type,Date,LLM Cost,PSTN Cost,WhatsApp Cost,Total Cost,Audio Minutes,Tokens,OneDrive URL\n';
    const csvRows = costs.map(cost => {
      const audioMinutes = (cost.llm_cost?.audio_input_minutes || 0) + (cost.llm_cost?.audio_output_minutes || 0);
      const totalTokens = (cost.llm_cost?.input_tokens || 0) + (cost.llm_cost?.output_tokens || 0);
      
      return [
        cost.call_id,
        cost.session_type,
        cost.created_at.toISOString().split('T')[0],
        cost.llm_cost?.total_cost_usd?.toFixed(4) || '0.0000',
        cost.pstn_cost?.total_cost_usd?.toFixed(4) || '0.0000',
        cost.whatsapp_cost?.total_cost_usd?.toFixed(4) || '0.0000',
        cost.total_cost_usd?.toFixed(4) || '0.0000',
        audioMinutes.toFixed(2),
        totalTokens,
        cost.recording?.onedrive_url || ''
      ].join(',');
    }).join('\n');
    
    const csv = csvHeader + csvRows;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="call-costs-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
    
  } catch (error) {
    console.error('Export costs error:', error);
    res.status(500).json({ message: 'Failed to export costs' });
  }
});

module.exports = router;