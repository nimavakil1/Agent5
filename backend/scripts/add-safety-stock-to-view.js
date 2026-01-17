#!/usr/bin/env node
/**
 * Add x_safety_stock field to product.template form view
 * Places it in the Inventory tab, LOGISTICS section, after country_of_origin
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
  console.log('=== Add Safety Stock Field to Product Form View ===\n');

  const uid = await authenticate();

  // Step 1: Check if we already have an inherited view for this
  console.log('1. Checking for existing inherited view...');
  const existingView = await executeKw(uid, 'ir.ui.view', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>name</string></value>
        <value><string>=</string></value>
        <value><string>product.template.form.safety_stock</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
    </data></array></value></member>
  </struct>`);

  if (existingView.includes('<int>')) {
    console.log('   View already exists, skipping creation');
    console.log('   (Delete the view first if you want to recreate it)');
    return;
  }

  // Step 2: Find the main product.template form view
  console.log('\n2. Finding product.template form view...');
  const formViewResult = await executeKw(uid, 'ir.ui.view', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>product.template</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>type</string></value>
        <value><string>=</string></value>
        <value><string>form</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>inherit_id</string></value>
        <value><string>=</string></value>
        <value><boolean>0</boolean></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
    </data></array></value></member>
    <member><name>order</name><value><string>priority asc, id asc</string></value></member>
    <member><name>limit</name><value><int>5</int></value></member>
  </struct>`);

  console.log('   Form views found:', formViewResult);

  // Extract the first view ID (main product form)
  const viewIdMatch = formViewResult.match(/<name>id<\/name>\s*<value><int>(\d+)<\/int>/);
  if (!viewIdMatch) {
    throw new Error('Could not find product.template form view');
  }
  const parentViewId = parseInt(viewIdMatch[1]);
  console.log(`   Using parent view ID: ${parentViewId}`);

  // Step 3: Create inherited view to add the field
  console.log('\n3. Creating inherited view to add x_safety_stock field...');

  // The arch XML that adds the field after country_of_origin
  const archXml = `<?xml version="1.0"?>
<data>
  <xpath expr="//field[@name='country_of_origin']" position="after">
    <field name="x_safety_stock" string="Safety Stock (FBM)"/>
  </xpath>
</data>`;

  // Escape special characters for XML-RPC
  const escapedArch = archXml
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const createResult = await executeKw(uid, 'ir.ui.view', 'create', `
    <array><data><value><struct>
      <member><name>name</name><value><string>product.template.form.safety_stock</string></value></member>
      <member><name>model</name><value><string>product.template</string></value></member>
      <member><name>inherit_id</name><value><int>${parentViewId}</int></value></member>
      <member><name>arch</name><value><string>${escapedArch}</string></value></member>
      <member><name>priority</name><value><int>99</int></value></member>
    </struct></value></data></array>
  `);

  const newViewIdMatch = createResult.match(/<int>(\d+)<\/int>/);
  if (newViewIdMatch) {
    console.log(`   ✓ View created with ID: ${newViewIdMatch[1]}`);
    console.log('\n=== Done! ===');
    console.log('\nThe x_safety_stock field should now be visible in the product form');
    console.log('under the Inventory tab, in the LOGISTICS section, after Country of Origin.');
    console.log('\nRefresh your Odoo browser to see the change.');
  } else {
    console.log('   Create result:', createResult);
  }
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
