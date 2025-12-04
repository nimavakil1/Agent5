/**
 * Telnyx Webhook Routes
 *
 * Handles incoming webhooks from Telnyx with proper signature verification
 * SECURITY: Ed25519 signature verification is REQUIRED for production
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createPublicKey, verify } = require('crypto');
const pino = require('pino');

const router = express.Router();
const logger = pino({ name: 'telnyx-webhook' });

// Load public key for signature verification
const pubKeyPem = process.env.TELNYX_PUBLIC_KEY_PEM || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAM5oZwPo7kSm4J+/rGTkSdvKGMhSoGM2mlCPQAgeRSUc=
-----END PUBLIC KEY-----`;

let publicKey = null;
try {
  publicKey = createPublicKey(pubKeyPem);
} catch (error) {
  logger.error({ error: error.message }, 'Failed to load Telnyx public key - signature verification will fail');
}

// Per-route limiter for webhook
const webhookLimiter = rateLimit({
  windowMs: parseInt(process.env.WEBHOOK_RATE_WINDOW_MS || '10000', 10),
  max: parseInt(process.env.WEBHOOK_RATE_MAX || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Verify Telnyx webhook signature
 */
function verifySignature(signatureB64, timestamp, rawBody) {
  if (!publicKey) {
    throw new Error('Telnyx public key not configured');
  }

  const message = `${timestamp}|${rawBody.toString('utf8')}`;
  const sig = Buffer.from(signatureB64, 'base64');

  return verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
}

/**
 * Telnyx webhook event handler
 */
router.post('/events', webhookLimiter, express.raw({ type: '*/*' }), async (req, res) => {
  const startTime = Date.now();

  try {
    const signatureB64 = req.header('telnyx-signature-ed25519') || req.header('Telnyx-Signature-Ed25519');
    const timestamp = req.header('telnyx-timestamp') || req.header('Telnyx-Timestamp');

    // SECURITY: Skip verification only in explicit dev mode
    const skipVerification = process.env.SKIP_TELNYX_SIGNATURE === '1' && process.env.NODE_ENV === 'development';

    if (!skipVerification) {
      // Validate required headers
      if (!signatureB64 || !timestamp) {
        logger.warn({ ip: req.ip }, 'Missing Telnyx signature headers');
        return res.status(400).json({ error: 'Missing signature headers' });
      }

      // Validate timestamp to prevent replay attacks
      const toleranceSec = parseInt(process.env.WEBHOOK_TOLERANCE_SEC || '300', 10);
      const now = Math.floor(Date.now() / 1000);
      const tsNum = Number(timestamp);

      if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > toleranceSec) {
        logger.warn({ timestamp, now, tolerance: toleranceSec }, 'Invalid or expired webhook timestamp');
        return res.status(400).json({ error: 'Invalid or expired timestamp' });
      }

      // Verify signature
      const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');

      try {
        const isValid = verifySignature(signatureB64, timestamp, rawBody);
        if (!isValid) {
          logger.warn({ ip: req.ip }, 'Invalid Telnyx webhook signature');
          return res.status(400).json({ error: 'Invalid signature' });
        }
      } catch (error) {
        logger.error({ error: error.message }, 'Signature verification error');
        return res.status(500).json({ error: 'Signature verification failed' });
      }
    } else {
      logger.warn('Telnyx signature verification SKIPPED (dev mode only)');
    }

    // Parse and process the webhook payload
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    let payload = null;

    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (parseError) {
      logger.warn({ error: parseError.message }, 'Failed to parse webhook payload as JSON');
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const eventType = payload?.data?.event_type || 'unknown';
    const callControlId = payload?.data?.payload?.call_control_id;

    logger.info({
      eventType,
      callControlId,
      latencyMs: Date.now() - startTime,
    }, 'Telnyx webhook received');

    // Process different event types
    switch (eventType) {
      case 'call.initiated':
      case 'call.answered':
      case 'call.hangup':
      case 'call.machine.detection.ended':
      case 'streaming.started':
      case 'streaming.stopped':
        // These events are handled by the WebSocket connection
        // Just acknowledge receipt
        break;

      case 'call.recording.saved':
        // Handle recording saved events
        logger.info({ callControlId, recording: payload?.data?.payload?.recording_urls }, 'Call recording saved');
        break;

      default:
        logger.debug({ eventType }, 'Unhandled Telnyx event type');
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      latencyMs: Date.now() - startTime,
    }, 'Error handling Telnyx webhook');

    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Health check for Telnyx integration
 */
router.get('/health', (req, res) => {
  res.json({
    status: publicKey ? 'healthy' : 'degraded',
    signatureVerification: !!publicKey,
    publicKeyConfigured: !!process.env.TELNYX_PUBLIC_KEY_PEM,
  });
});

module.exports = router;
