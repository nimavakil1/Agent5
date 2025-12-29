/**
 * Print API Routes
 *
 * Handles QZ Tray integration for direct thermal printing:
 * - Certificate serving for QZ Tray
 * - Request signing for silent printing
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Certificate and private key paths
const CERT_PATH = path.join(__dirname, '../../../certs/qz-cert.pem');
const KEY_PATH = path.join(__dirname, '../../../certs/qz-private-key.pem');

// Cache for loaded certificates
let cachedCert = null;
let cachedKey = null;

/**
 * Load or generate QZ Tray certificates
 * For development, we use a self-signed certificate
 */
function ensureCertificates() {
  const certsDir = path.dirname(CERT_PATH);

  // Create certs directory if it doesn't exist
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }

  // Check if certificates exist
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    if (!cachedCert) {
      cachedCert = fs.readFileSync(CERT_PATH, 'utf8');
      cachedKey = fs.readFileSync(KEY_PATH, 'utf8');
    }
    return { cert: cachedCert, key: cachedKey };
  }

  // Generate self-signed certificate for development
  console.log('[Print API] Generating QZ Tray certificates...');

  try {
    const { execSync } = require('child_process');

    // Generate private key
    execSync(`openssl genrsa -out "${KEY_PATH}" 2048`, { stdio: 'pipe' });

    // Generate self-signed certificate
    execSync(`openssl req -new -x509 -key "${KEY_PATH}" -out "${CERT_PATH}" -days 3650 -subj "/CN=Agent5 Print Service"`, { stdio: 'pipe' });

    cachedCert = fs.readFileSync(CERT_PATH, 'utf8');
    cachedKey = fs.readFileSync(KEY_PATH, 'utf8');

    console.log('[Print API] Certificates generated successfully');
    return { cert: cachedCert, key: cachedKey };
  } catch (error) {
    console.error('[Print API] Failed to generate certificates:', error.message);
    // Return demo certificate for QZ Tray (allows unsigned printing in development)
    return { cert: null, key: null };
  }
}

/**
 * Get QZ Tray certificate
 * GET /api/print/certificate
 *
 * Returns the public certificate for QZ Tray to verify signatures
 */
router.get('/certificate', (req, res) => {
  try {
    const { cert } = ensureCertificates();

    if (!cert) {
      // Return a placeholder that tells QZ Tray to allow unsigned requests
      // This works in development but should use real certs in production
      res.type('text/plain').send('');
      return;
    }

    res.type('text/plain').send(cert);
  } catch (error) {
    console.error('[Print API] Certificate error:', error);
    res.status(500).send('');
  }
});

/**
 * Sign a message for QZ Tray
 * POST /api/print/sign
 *
 * Signs the message with our private key for silent printing
 */
router.post('/sign', express.text({ type: '*/*' }), (req, res) => {
  try {
    const { key } = ensureCertificates();

    // Get the data to sign from request body
    let toSign = req.body;
    if (typeof toSign === 'object' && toSign.data) {
      toSign = toSign.data;
    }

    if (!key) {
      // Without a key, return empty signature
      // QZ Tray will prompt user for permission
      res.type('text/plain').send('');
      return;
    }

    // Sign with SHA512 and RSA
    const sign = crypto.createSign('SHA512');
    sign.update(toSign);
    const signature = sign.sign(key, 'base64');

    res.type('text/plain').send(signature);
  } catch (error) {
    console.error('[Print API] Signing error:', error);
    res.status(500).send('');
  }
});

/**
 * Get print status
 * GET /api/print/status
 *
 * Returns info about print configuration
 */
router.get('/status', (req, res) => {
  try {
    const { cert, key } = ensureCertificates();

    res.json({
      success: true,
      configured: !!(cert && key),
      certExists: !!cert,
      keyExists: !!key,
      message: cert && key
        ? 'Print service configured with signing certificates'
        : 'Print service running in unsigned mode (user approval required)'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
