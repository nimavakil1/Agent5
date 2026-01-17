#!/usr/bin/env node
/**
 * Check if x_safety_stock field exists
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
  console.log('=== Checking x_safety_stock field ===\n');

  const uid = await authenticate();

  // Search for fields containing "safety" on product.template
  console.log('1. Searching for "safety" fields on product.template...');
  const safetyResult = await executeKw(uid, 'ir.model.fields', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>product.template</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>name</string></value>
        <value><string>ilike</string></value>
        <value><string>safety</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>field_description</string></value>
      <value><string>ttype</string></value>
    </data></array></value></member>
  </struct>`);
  console.log('   Result:', safetyResult);

  // Also search for any x_ custom fields on product.template
  console.log('\n2. Searching for custom (x_) fields on product.template...');
  const customResult = await executeKw(uid, 'ir.model.fields', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>product.template</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>name</string></value>
        <value><string>like</string></value>
        <value><string>x_%</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>field_description</string></value>
      <value><string>ttype</string></value>
    </data></array></value></member>
  </struct>`);
  console.log('   Custom fields:', customResult);

  // Try to read the field directly from product.template
  console.log('\n3. Trying to read x_safety_stock from a product...');
  const productResult = await executeKw(uid, 'product.template', 'search_read', `
    <array><data><value><array><data></data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>x_safety_stock</string></value>
    </data></array></value></member>
    <member><name>limit</name><value><int>3</int></value></member>
  </struct>`);
  console.log('   Products with x_safety_stock:', productResult.substring(0, 1000));

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
