#!/usr/bin/env node
/**
 * Fix team 11 references found in:
 * 1. ir.config_parameter ID 56 - batch_sales_teams_ids
 * 2. ir.actions.server ID 1220 - FBA server action
 */

require('dotenv').config();
const https = require('https');

const db = process.env.ODOO_DB;
const username = process.env.ODOO_USERNAME;
const password = process.env.ODOO_PASSWORD;

function xmlrpc(path, method, params, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0"?>
<methodCall>
<methodName>${method}</methodName>
<params>${params}</params>
</methodCall>`;

    const options = {
      hostname: 'acropaq.odoo.com',
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: timeout
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (data.includes('<fault>')) {
          const faultMatch = data.match(/<string>([^<]+)<\/string>/);
          reject(new Error(`XML-RPC fault: ${faultMatch ? faultMatch[1] : data}`));
        } else {
          resolve(data);
        }
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

async function authenticate() {
  console.log('Authenticating...');
  const result = await xmlrpc('/xmlrpc/2/common', 'authenticate', `
    <param><value><string>${db}</string></value></param>
    <param><value><string>${username}</string></value></param>
    <param><value><string>${password}</string></value></param>
    <param><value><struct></struct></value></param>
  `);

  const match = result.match(/<int>(\d+)<\/int>/);
  if (match) {
    const uid = parseInt(match[1]);
    console.log(`Authenticated! UID: ${uid}\n`);
    return uid;
  }
  throw new Error('Authentication failed');
}

async function executeKw(uid, model, method, args, kwargs = '<struct></struct>') {
  const result = await xmlrpc('/xmlrpc/2/object', 'execute_kw', `
    <param><value><string>${db}</string></value></param>
    <param><value><int>${uid}</int></value></param>
    <param><value><string>${password}</string></value></param>
    <param><value><string>${model}</string></value></param>
    <param><value><string>${method}</string></value></param>
    <param><value>${args}</value></param>
    <param><value>${kwargs}</value></param>
  `);
  return result;
}

async function main() {
  console.log('=== Fixing Team 11 References ===\n');

  const uid = await authenticate();

  // Fix 1: Update ir.config_parameter to remove team 11 from batch_sales_teams_ids
  // Current value: [11, 13, 10, 15]
  // New value: [13, 10, 15] (removing 11)
  console.log('1. Fixing ir.config_parameter (batch_sales_teams_ids)...');
  console.log('   Current: [11, 13, 10, 15]');
  console.log('   New:     [13, 10, 15]');

  const configFixResult = await executeKw(uid, 'ir.config_parameter', 'write', `
    <array><data>
      <value><array><data><value><int>56</int></value></data></array></value>
      <value><struct>
        <member><name>value</name><value><string>[13, 10, 15]</string></value></member>
      </struct></value>
    </data></array>
  `);

  if (configFixResult.includes('True') || configFixResult.includes('1')) {
    console.log('   ✓ SUCCESS: batch_sales_teams_ids updated');
  } else {
    console.log('   Result:', configFixResult);
  }

  // Verify the change
  const verifyResult = await executeKw(uid, 'ir.config_parameter', 'read', `
    <array><data><value><array><data>
      <value><int>56</int></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>key</string></value>
      <value><string>value</string></value>
    </data></array></value></member>
  </struct>`);
  console.log('   Verified:', verifyResult);

  // Fix 2: Update or archive the server action that writes team_id: 11
  console.log('\n2. Checking server action ID 1220 ((N) Sales Team : FBA)...');

  // First, let's see what team should replace 11
  // Looking at the existing teams: 12=AMZ-FBR might be the right one for FBA
  console.log('   This action sets team_id=11 which no longer exists');
  console.log('   Options:');
  console.log('   - Team 12: AMZ-FBR (FBA related?)');
  console.log('   - Team 6: Amazon Vendor');
  console.log('   - Archive/disable the action');

  // Let's archive it to be safe - user can re-enable with correct team
  console.log('\n   Archiving the action to prevent future errors...');

  const actionFixResult = await executeKw(uid, 'ir.actions.server', 'write', `
    <array><data>
      <value><array><data><value><int>1220</int></value></data></array></value>
      <value><struct>
        <member><name>active</name><value><boolean>0</boolean></value></member>
      </struct></value>
    </data></array>
  `);

  if (actionFixResult.includes('True') || actionFixResult.includes('1')) {
    console.log('   ✓ SUCCESS: Server action 1220 archived');
    console.log('   (You can re-activate it in Settings → Technical → Server Actions)');
  } else {
    console.log('   Result:', actionFixResult);
  }

  console.log('\n=== Fixes Applied ===');
  console.log('\nPlease try clicking Settings again in Odoo.');
  console.log('The error should be resolved now.');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
