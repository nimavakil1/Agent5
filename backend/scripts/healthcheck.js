#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');

async function main(){
  const url = process.env.HEALTHCHECK_URL || 'http://127.0.0.1:3000/readyz';
  const emailTo = process.env.HEALTHCHECK_EMAIL_TO || '';
  try {
    const r = await fetch(url, { timeout: 5000 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (!txt) throw new Error('empty');
    console.log('[healthcheck] OK', url);
    process.exit(0);
  } catch (e) {
    console.error('[healthcheck] FAIL', url, e.message);
    // Try notify via Brevo if configured
    if (emailTo) {
      try {
        const brevo = require('../src/api/services/brevoService');
        await brevo.sendEmail(emailTo, 'Agent5 healthcheck failed', `Failed to reach ${url}: ${e.message}`);
        console.log('[healthcheck] notification sent to', emailTo);
      } catch (e2) {
        console.error('[healthcheck] notify failed', e2.message);
      }
    }
    process.exit(1);
  }
}
main();

