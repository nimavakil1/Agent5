function validateEnv() {
  if (process.env.NODE_ENV === 'test') return;

  // Base requirements for UI + LiveKit + Mongo
  const required = [
    'MONGO_URI',
    'AUTH_TOKEN',
    'OPENAI_API_KEY',
    'LIVEKIT_SERVER_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
  ];

  // PSTN/Telnyx requirements only if explicitly enabled
  const enablePstn = String(process.env.ENABLE_PSTN_WS || '1') !== '0';
  if (enablePstn) {
    required.push(
      'TELNYX_API_KEY',
      'TELNYX_CONNECTION_ID',
      'TELNYX_PHONE_NUMBER',
      'TELNYX_PUBLIC_KEY_PEM'
    );
  }

  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    // Fail fast in production if secrets are missing
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (enablePstn && !process.env.TELNYX_STREAM_URL) {
    console.warn('[config] TELNYX_STREAM_URL not set; defaulting to ws://localhost for dev only');
  }
  if (!process.env.CORS_ORIGIN) {
    console.warn('[config] CORS_ORIGIN not set; APIs won\'t be accessible from browsers');
  }
}

module.exports = validateEnv;
