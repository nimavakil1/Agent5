#!/usr/bin/env node
/**
 * Check user 2's cached records and favorites
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
  console.log('=== Checking User 2 Cached Data ===\n');

  const uid = await authenticate();

  // 1. Check mail.message for team 11 references (notifications/messages)
  console.log('1. Checking mail.message for team 11 references...');
  const msgResult = await executeKw(uid, 'mail.message', 'search_count', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>res_id</string></value>
        <value><string>=</string></value>
        <value><int>11</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `);
  console.log('   Messages referencing crm.team(11):', msgResult);

  // 2. Check ir.attachment for team 11
  console.log('\n2. Checking ir.attachment for team 11...');
  const attachResult = await executeKw(uid, 'ir.attachment', 'search_count', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>res_model</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>res_id</string></value>
        <value><string>=</string></value>
        <value><int>11</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `);
  console.log('   Attachments for crm.team(11):', attachResult);

  // 3. Check ir.filters (saved filters/favorites)
  console.log('\n3. Checking ir.filters for team 11...');
  const filterResult = await executeKw(uid, 'ir.filters', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model_id</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>domain</string></value>
      <value><string>user_id</string></value>
    </data></array></value></member>
  </struct>`);
  console.log('   Filters:', filterResult);

  // 4. Check ir.ui.view.custom (user-customized views)
  console.log('\n4. Checking ir.ui.view.custom for user 2...');
  const viewCustomResult = await executeKw(uid, 'ir.ui.view.custom', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>user_id</string></value>
        <value><string>=</string></value>
        <value><int>2</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>ref_id</string></value>
      <value><string>arch</string></value>
    </data></array></value></member>
  </struct>`);

  if (viewCustomResult.includes('team') || viewCustomResult.includes('11')) {
    console.log('   Custom views with potential team 11 reference:');
    console.log(viewCustomResult);
  } else {
    console.log('   No suspicious custom views found');
  }

  // 5. Check res.users.settings (user settings/preferences)
  console.log('\n5. Checking res.users.settings...');
  try {
    const userSettingsResult = await executeKw(uid, 'res.users.settings', 'search_read', `
      <array><data><value><array><data>
        <value><array><data>
          <value><string>user_id</string></value>
          <value><string>=</string></value>
          <value><int>2</int></value>
        </data></array></value>
      </data></array></value></data></array>
    `, `<struct>
      <member><name>fields</name><value><array><data>
        <value><string>id</string></value>
      </data></array></value></member>
    </struct>`);
    console.log('   User settings:', userSettingsResult.substring(0, 500));
  } catch (e) {
    console.log('   Model not found or inaccessible');
  }

  // 6. Direct SQL-like search in any model that might have crm_team_id = 11
  console.log('\n6. Checking crm.lead for team_id = 11...');
  const leadResult = await executeKw(uid, 'crm.lead', 'search_count', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>team_id</string></value>
        <value><string>=</string></value>
        <value><int>11</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `);
  console.log('   Leads with team_id=11:', leadResult);

  // 7. sale.order with team_id = 11
  console.log('\n7. Checking sale.order for team_id = 11...');
  const saleResult = await executeKw(uid, 'sale.order', 'search_count', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>team_id</string></value>
        <value><string>=</string></value>
        <value><int>11</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `);
  console.log('   Sales orders with team_id=11:', saleResult);

  // 8. account.move with team_id = 11
  console.log('\n8. Checking account.move for team_id = 11...');
  const invoiceResult = await executeKw(uid, 'account.move', 'search_count', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>team_id</string></value>
        <value><string>=</string></value>
        <value><int>11</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `);
  console.log('   Invoices with team_id=11:', invoiceResult);

  console.log('\n=== Done ===');
  console.log('\nIf counts are > 0, those records reference the deleted team 11');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
