#!/usr/bin/env node
/**
 * Update Safety Stock field to show no decimals
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
  console.log('=== Update Safety Stock Display (No Decimals) ===\n');

  const uid = await authenticate();

  // Updated arch with digits="(12, 0)" for no decimal places
  const archXml = `<?xml version="1.0"?>
<data>
  <xpath expr="//field[@name='country_of_origin']" position="after">
    <field name="x_safety_stock" string="Safety Stock (FBM/FBR)" digits="[12, 0]"/>
  </xpath>
</data>`;

  const escapedArch = archXml
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  console.log('Updating view to show integers only...');

  const updateResult = await executeKw(uid, 'ir.ui.view', 'write', `
    <array><data>
      <value><array><data><value><int>4821</int></value></data></array></value>
      <value><struct>
        <member><name>arch</name><value><string>${escapedArch}</string></value></member>
      </struct></value>
    </data></array>
  `);

  if (updateResult.includes('True') || updateResult.includes('1')) {
    console.log('✓ Field now displays as integer (no decimals)');
    console.log('\nRefresh your Odoo browser to see the change.');
  } else {
    console.log('Result:', updateResult);
  }
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
