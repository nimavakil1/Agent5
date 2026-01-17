#!/usr/bin/env node
/**
 * Set default value for x_safety_stock field and update all existing products
 */

require('dotenv').config();
const https = require('https');

const db = process.env.ODOO_DB;
const username = process.env.ODOO_USERNAME;
const password = process.env.ODOO_PASSWORD;

function xmlrpc(path, method, params, timeout = 120000) {
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  console.log('=== Set Safety Stock Defaults ===\n');

  const uid = await authenticate();

  // Step 1: Get the field ID for x_safety_stock
  console.log('1. Finding x_safety_stock field ID...');
  const fieldResult = await executeKw(uid, 'ir.model.fields', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>product.template</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>name</string></value>
        <value><string>=</string></value>
        <value><string>x_safety_stock</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
    </data></array></value></member>
  </struct>`);

  const fieldIdMatch = fieldResult.match(/<name>id<\/name>\s*<value><int>(\d+)<\/int>/);
  if (!fieldIdMatch) {
    throw new Error('Could not find x_safety_stock field');
  }
  const fieldId = parseInt(fieldIdMatch[1]);
  console.log(`   Field ID: ${fieldId}`);

  // Step 2: Set default value via ir.default
  console.log('\n2. Setting default value to 10 for new products...');

  // First check if default already exists
  const existingDefault = await executeKw(uid, 'ir.default', 'search', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>field_id</string></value>
        <value><string>=</string></value>
        <value><int>${fieldId}</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `);

  if (existingDefault.includes('<int>')) {
    console.log('   Default already exists, updating...');
    const defaultIds = (existingDefault.match(/<int>(\d+)<\/int>/g) || [])
      .map(m => parseInt(m.match(/\d+/)[0]));

    for (const defId of defaultIds) {
      await executeKw(uid, 'ir.default', 'write', `
        <array><data>
          <value><array><data><value><int>${defId}</int></value></data></array></value>
          <value><struct>
            <member><name>json_value</name><value><string>10.0</string></value></member>
          </struct></value>
        </data></array>
      `);
    }
    console.log('   ✓ Default updated');
  } else {
    console.log('   Creating new default...');
    const createResult = await executeKw(uid, 'ir.default', 'create', `
      <array><data><value><struct>
        <member><name>field_id</name><value><int>${fieldId}</int></value></member>
        <member><name>json_value</name><value><string>10.0</string></value></member>
      </struct></value></data></array>
    `);

    if (createResult.includes('<int>')) {
      console.log('   ✓ Default value set to 10');
    } else {
      console.log('   Result:', createResult);
    }
  }

  // Step 3: Update all existing products
  console.log('\n3. Updating all existing product templates to x_safety_stock = 10...');

  // Get all product template IDs
  const productsResult = await executeKw(uid, 'product.template', 'search', `
    <array><data><value><array><data></data></array></value></data></array>
  `, `<struct>
    <member><name>limit</name><value><int>10000</int></value></member>
  </struct>`);

  const productIds = (productsResult.match(/<int>(\d+)<\/int>/g) || [])
    .map(m => parseInt(m.match(/\d+/)[0]));

  console.log(`   Found ${productIds.length} product templates`);

  if (productIds.length === 0) {
    console.log('   No products to update');
  } else {
    // Update in batches of 200 to avoid timeout
    const batchSize = 200;
    let updated = 0;

    for (let i = 0; i < productIds.length; i += batchSize) {
      const batch = productIds.slice(i, i + batchSize);
      const idsXml = batch.map(id => `<value><int>${id}</int></value>`).join('');

      console.log(`   Updating batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(productIds.length / batchSize)} (${batch.length} products)...`);

      const updateResult = await executeKw(uid, 'product.template', 'write', `
        <array><data>
          <value><array><data>${idsXml}</data></array></value>
          <value><struct>
            <member><name>x_safety_stock</name><value><double>10</double></value></member>
          </struct></value>
        </data></array>
      `);

      if (updateResult.includes('True') || updateResult.includes('1')) {
        updated += batch.length;
      } else {
        console.log('   Batch result:', updateResult.substring(0, 200));
      }

      // Small delay between batches
      if (i + batchSize < productIds.length) {
        await delay(500);
      }
    }

    console.log(`   ✓ Updated ${updated} products`);
  }

  console.log('\n=== Done! ===');
  console.log('\nThe x_safety_stock field now:');
  console.log('- Has a default value of 10 for new products');
  console.log('- All existing products have x_safety_stock = 10');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
