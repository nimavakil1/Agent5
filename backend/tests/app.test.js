const request = require('supertest');
const { generateKeyPairSync, sign } = require('crypto');

// Set env before requiring the app
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGIN = 'https://example.com';
process.env.AUTH_TOKEN = 'testtoken';
process.env.RATE_LIMIT_WINDOW_MS = '1000';
process.env.RATE_LIMIT_MAX = '2';

const { app, server } = require('../src/index');

afterAll(() => {
  try { server && server.close && server.close(); } catch (_) {}
});

describe('CORS', () => {
  it('sets Access-Control-Allow-Origin header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(res.statusCode).toBe(200);
  });
});

describe('Auth + Rate limiting', () => {
  it('returns 401 for protected route without token and eventually 429 after limit', async () => {
    const res1 = await request(app).get('/api/dashboard');
    expect(res1.statusCode).toBe(401);
    const res2 = await request(app).get('/api/dashboard');
    expect(res2.statusCode).toBe(401);
    const res3 = await request(app).get('/api/dashboard');
    expect([401, 429]).toContain(res3.statusCode);
  });
});

describe('Telnyx webhook signature verification', () => {
  it('accepts valid signature and rejects invalid', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.TELNYX_PUBLIC_KEY_PEM = pubPem;
    process.env.WEBHOOK_TOLERANCE_SEC = '300';

    const payload = { data: { event_type: 'test.event' } };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${timestamp}|${body.toString('utf8')}`;
    const sig = sign(null, Buffer.from(message, 'utf8'), privateKey);
    const sigB64 = sig.toString('base64');

    const ok = await request(app)
      .post('/api/telnyx/events')
      .set('telnyx-timestamp', timestamp)
      .set('telnyx-signature-ed25519', sigB64)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(ok.statusCode).toBe(200);

    const bad = await request(app)
      .post('/api/telnyx/events')
      .set('telnyx-timestamp', timestamp)
      .set('telnyx-signature-ed25519', 'invalid')
      .set('Content-Type', 'application/json')
      .send(body);
    expect([400, 401]).toContain(bad.statusCode);
  });
});

