/**
 * Shipping API Routes
 *
 * Handles shipping carrier integrations:
 * - GLS label creation and retrieval
 * - Tracking information
 * - Shipment management
 */

const express = require('express');
const router = express.Router();
const { getGLSClient } = require('../../services/shipping/GLSClient');

// ============================================
// GLS ENDPOINTS
// ============================================

/**
 * Test GLS connection
 * GET /api/shipping/gls/test
 */
router.get('/gls/test', async (req, res) => {
  try {
    const client = getGLSClient();
    const result = await client.testConnection();

    res.json({
      success: result.success,
      message: result.message || result.error,
      carrier: 'GLS',
      hostname: process.env.GLS_API_HOSTNAME
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Create GLS shipment and get label
 * POST /api/shipping/gls/shipment
 *
 * Body: {
 *   sender: { name, street, streetNumber, zipCode, city, countryCode, email, phone },
 *   receiver: { name, street, streetNumber, zipCode, city, countryCode, email, phone },
 *   reference: string,
 *   weight: number (kg),
 *   product?: 'Parcel' | 'Express' | 'Freight',
 *   service?: string
 * }
 */
router.post('/gls/shipment', async (req, res) => {
  try {
    const { sender, receiver, reference, weight, product, service } = req.body;

    // Validate required fields
    if (!sender || !receiver || !reference) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sender, receiver, reference'
      });
    }

    const client = getGLSClient();
    const result = await client.createShipment({
      sender,
      receiver,
      reference,
      weight: weight || 1,
      product: product || 'Parcel',
      service
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      trackingNumber: result.trackingNumber,
      parcelNumber: result.parcelNumber,
      trackingUrl: client.getTrackingUrl(result.trackingNumber),
      labelPdf: result.labelPdf ? result.labelPdf.toString('base64') : null
    });
  } catch (error) {
    console.error('[Shipping API] GLS shipment error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get GLS label by tracking number (from stored shipments)
 * GET /api/shipping/gls/label/:trackingNumber
 */
router.get('/gls/label/:trackingNumber', async (req, res) => {
  try {
    const { trackingNumber: _trackingNumber } = req.params;

    // For now, we don't store labels - they should be retrieved at creation time
    // In the future, we can store labels in MongoDB or S3

    // Try to get from any stored shipment data
    // This is a placeholder - implement based on your storage solution
    res.status(404).json({
      success: false,
      error: 'Label not found. Labels are returned at shipment creation time.',
      hint: 'Use POST /api/shipping/gls/shipment to create a shipment and get the label'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Cancel GLS shipment
 * POST /api/shipping/gls/cancel/:trackingNumber
 */
router.post('/gls/cancel/:trackingNumber', async (req, res) => {
  try {
    const { trackingNumber } = req.params;

    const client = getGLSClient();
    const result = await client.cancelShipment(trackingNumber);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      status: result.status,
      message: `Shipment ${trackingNumber} cancellation: ${result.status}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get GLS tracking URL
 * GET /api/shipping/gls/tracking/:trackingNumber
 */
router.get('/gls/tracking/:trackingNumber', async (req, res) => {
  try {
    const { trackingNumber } = req.params;
    const client = getGLSClient();

    res.json({
      success: true,
      trackingNumber,
      trackingUrl: client.getTrackingUrl(trackingNumber)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// GENERIC LABEL PRINTING ENDPOINT
// ============================================

/**
 * Print a label directly (for testing)
 * POST /api/shipping/print-test
 *
 * Body: { pdfBase64: string }
 */
router.post('/print-test', async (req, res) => {
  try {
    const { pdfBase64 } = req.body;

    if (!pdfBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing pdfBase64 data'
      });
    }

    // This endpoint just validates the PDF data
    // Actual printing happens client-side via QZ Tray
    const buffer = Buffer.from(pdfBase64, 'base64');

    // Check if it's a valid PDF (starts with %PDF)
    const header = buffer.slice(0, 4).toString();
    if (header !== '%PDF') {
      return res.status(400).json({
        success: false,
        error: 'Invalid PDF data'
      });
    }

    res.json({
      success: true,
      message: 'PDF data is valid',
      size: buffer.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
