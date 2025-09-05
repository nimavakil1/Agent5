const express = require('express');
const rateLimit = require('express-rate-limit');
const { createPublicKey, verify } = require('crypto');

const router = express.Router();

// Per-route limiter for webhook
const webhookLimiter = rateLimit({
  windowMs: parseInt(process.env.WEBHOOK_RATE_WINDOW_MS || '10000', 10),
  max: parseInt(process.env.WEBHOOK_RATE_MAX || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
});

// Use raw body for signature verification
router.post('/events', webhookLimiter, express.raw({ type: '*/*' }), (req, res) => {
  try {
    const pubKeyPem = process.env.TELNYX_PUBLIC_KEY_PEM;
    if (!pubKeyPem) {
      return res.status(500).send('Webhook public key not configured');
    }

    const signatureB64 = req.header('telnyx-signature-ed25519') || req.header('Telnyx-Signature-Ed25519');
    const timestamp = req.header('telnyx-timestamp') || req.header('Telnyx-Timestamp');

    if (!signatureB64 || !timestamp) {
      return res.status(400).send('Missing signature headers');
    }

    const toleranceSec = parseInt(process.env.WEBHOOK_TOLERANCE_SEC || '300', 10);
    const now = Math.floor(Date.now() / 1000);
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > toleranceSec) {
      return res.status(400).send('Invalid or expired timestamp');
    }

    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    const message = `${timestamp}|${rawBody.toString('utf8')}`;

    const publicKey = createPublicKey(pubKeyPem);
    const sig = Buffer.from(signatureB64, 'base64');
    const isValid = verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
    if (!isValid) {
      return res.status(400).send('Invalid signature');
    }

    // Signature valid; parse payload as JSON if possible
    let payload = null;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
      // Non-JSON payloads can be ignored or handled as needed
    }

    // At this point, handle the event as required
    console.log('Verified Telnyx webhook:', payload ? payload.data?.event_type || 'unknown' : 'raw');
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error handling Telnyx webhook:', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
