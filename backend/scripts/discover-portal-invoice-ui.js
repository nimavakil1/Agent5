#!/usr/bin/env node
/**
 * Portal UI Discovery Script
 *
 * Opens the SDT supplier portal (s.distri-smart.com) in a visible browser,
 * logs in, and pauses so you can manually explore the invoice upload interface.
 *
 * Usage:
 *   node scripts/discover-portal-invoice-ui.js
 *
 * Prerequisites:
 *   Set SDT_PORTAL_USERNAME and SDT_PORTAL_PASSWORD in .env
 *
 * What to look for:
 *   1. The login form: selector for username, password, submit button
 *   2. Navigation to invoice upload section
 *   3. Supplier dropdown/search selector
 *   4. Invoice form fields: number, date, amount, file upload
 *   5. Submit button and success/error confirmation
 *
 * After discovery, update PORTAL_CONFIG.selectors in:
 *   src/services/invoice-sync/PortalInserter.js
 */

require('dotenv').config();
const puppeteer = require('puppeteer');

const PORTAL_URL = process.env.SDT_PORTAL_URL || 'https://s.distri-smart.com';
const USERNAME = process.env.SDT_PORTAL_USERNAME;
const PASSWORD = process.env.SDT_PORTAL_PASSWORD;

async function main() {
  console.log('=== SDT Supplier Portal UI Discovery ===');
  console.log(`Portal URL: ${PORTAL_URL}`);
  console.log();

  if (!USERNAME || !PASSWORD) {
    console.error('ERROR: Set SDT_PORTAL_USERNAME and SDT_PORTAL_PASSWORD in .env');
    process.exit(1);
  }

  // Launch visible browser (headful mode)
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--window-size=1400,900'],
    defaultViewport: { width: 1400, height: 900 },
  });

  const page = await browser.newPage();

  console.log('Opening portal...');
  await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  console.log('Page loaded. Current URL:', page.url());
  console.log();
  console.log('=== INSTRUCTIONS ===');
  console.log('1. The browser is now open. Log in manually or inspect the login form.');
  console.log('2. Navigate to the invoice upload section.');
  console.log('3. Right-click elements → Inspect to find CSS selectors.');
  console.log('4. Note down selectors for:');
  console.log('   - Login form: username input, password input, submit button');
  console.log('   - Supplier dropdown/search');
  console.log('   - Invoice number, date, amount fields');
  console.log('   - File upload input');
  console.log('   - Submit button');
  console.log('   - Success/error message elements');
  console.log();
  console.log('The browser will stay open. Press Ctrl+C to close when done.');
  console.log();

  // Log all form elements found on the page
  console.log('=== AUTO-DETECTED FORM ELEMENTS ===');
  const forms = await page.evaluate(() => {
    const elements = [];
    document.querySelectorAll('input, select, textarea, button').forEach(el => {
      elements.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        id: el.id || '',
        name: el.name || '',
        className: el.className || '',
        placeholder: el.placeholder || '',
        text: el.textContent?.trim().substring(0, 50) || '',
      });
    });
    return elements;
  });

  if (forms.length > 0) {
    for (const el of forms) {
      const selector = el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : `.${el.className.split(' ')[0]}`);
      console.log(`  ${el.tag}[type=${el.type}] → ${selector} ${el.placeholder ? `(placeholder: "${el.placeholder}")` : ''} ${el.text ? `(text: "${el.text}")` : ''}`);
    }
  } else {
    console.log('  (No form elements found on initial page)');
  }
  console.log();

  // Keep alive
  await new Promise(() => {}); // Wait forever until Ctrl+C
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
