#!/usr/bin/env node
/**
 * One-time script to create x_safety_stock field on product.template in Odoo
 *
 * Run: cd backend && node scripts/create-safety-stock-field.js
 */

require('dotenv').config();
const https = require('https');

const db = process.env.ODOO_DB;
const username = process.env.ODOO_USERNAME;
const password = process.env.ODOO_PASSWORD;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function xmlrpc(path, method, params, timeout = 60000) {
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

async function authenticate(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Authentication attempt ${i + 1}/${retries}...`);

      const result = await xmlrpc('/xmlrpc/2/common', 'authenticate', `
        <param><value><string>${db}</string></value></param>
        <param><value><string>${username}</string></value></param>
        <param><value><string>${password}</string></value></param>
        <param><value><struct></struct></value></param>
      `);

      const match = result.match(/<int>(\d+)<\/int>/);
      if (match) {
        const uid = parseInt(match[1]);
        console.log(`Authenticated! UID: ${uid}`);
        return uid;
      }

      // Check if response is HTML (indicates error page)
      if (result.includes('<html') || result.includes('<TITLE>')) {
        throw new Error('Odoo returned HTML - possible rate limiting');
      }

      throw new Error('Invalid authentication response');
    } catch (err) {
      console.log(`  Attempt ${i + 1} failed: ${err.message}`);
      if (i < retries - 1) {
        const waitTime = Math.pow(2, i) * 5000; // Exponential backoff: 5s, 10s, 20s, 40s
        console.log(`  Waiting ${waitTime / 1000}s before retry...`);
        await delay(waitTime);
      }
    }
  }
  throw new Error('Authentication failed after all retries');
}

async function executeKw(uid, model, method, args, kwargs = '<struct></struct>', retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await xmlrpc('/xmlrpc/2/object', 'execute_kw', `
        <param><value><string>${db}</string></value></param>
        <param><value><int>${uid}</int></value></param>
        <param><value><string>${password}</string></value></param>
        <param><value><string>${model}</string></value></param>
        <param><value><string>${method}</string></value></param>
        <param><value>${args}</value></param>
        <param><value>${kwargs}</value></param>
      `, 120000);

      return result;
    } catch (err) {
      console.log(`  Execute ${method} attempt ${i + 1} failed: ${err.message}`);
      if (i < retries - 1) {
        const waitTime = Math.pow(2, i) * 3000;
        console.log(`  Waiting ${waitTime / 1000}s before retry...`);
        await delay(waitTime);
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  console.log('=== Create Safety Stock Field Script ===\n');
  console.log('Database:', db);
  console.log('Username:', username);
  console.log('');

  // Step 1: Authenticate
  const uid = await authenticate();
  await delay(2000); // Small delay between operations

  // Step 2: Get model ID for product.template
  console.log('\nGetting model ID for product.template...');
  const modelResult = await executeKw(uid, 'ir.model', 'search', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>product.template</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, '<struct><member><name>limit</name><value><int>1</int></value></member></struct>');

  const modelMatch = modelResult.match(/<int>(\d+)<\/int>/);
  if (!modelMatch) {
    throw new Error('Could not find product.template model');
  }
  const modelId = parseInt(modelMatch[1]);
  console.log(`Model ID: ${modelId}`);
  await delay(2000);

  // Step 3: Check if field already exists
  console.log('\nChecking if x_safety_stock field already exists...');
  const fieldCheckResult = await executeKw(uid, 'ir.model.fields', 'search', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model_id</string></value>
        <value><string>=</string></value>
        <value><int>${modelId}</int></value>
      </data></array></value>
      <value><array><data>
        <value><string>name</string></value>
        <value><string>=</string></value>
        <value><string>x_safety_stock</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `);

  if (fieldCheckResult.includes('<int>') && !fieldCheckResult.includes('<data></data>')) {
    const existingMatch = fieldCheckResult.match(/<int>(\d+)<\/int>/);
    if (existingMatch) {
      console.log(`\n✓ Field already exists with ID: ${existingMatch[1]}`);
      console.log('\nNo action needed!');
      return;
    }
  }

  console.log('Field does not exist - creating...');
  await delay(3000);

  // Step 4: Create the field
  console.log('\nCreating x_safety_stock field...');
  console.log('(This may take 1-2 minutes as it modifies the database schema)');

  const createResult = await executeKw(uid, 'ir.model.fields', 'create', `
    <array><data><value><struct>
      <member><name>model_id</name><value><int>${modelId}</int></value></member>
      <member><name>name</name><value><string>x_safety_stock</string></value></member>
      <member><name>field_description</name><value><string>Safety Stock</string></value></member>
      <member><name>ttype</name><value><string>float</string></value></member>
      <member><name>store</name><value><boolean>1</boolean></value></member>
    </struct></value></data></array>
  `);

  const createdMatch = createResult.match(/<int>(\d+)<\/int>/);
  if (createdMatch) {
    console.log(`\n✓ SUCCESS! Field created with ID: ${createdMatch[1]}`);
  } else {
    console.log('\nCreate result:', createResult);
    throw new Error('Field creation did not return an ID');
  }

  // Step 5: Set default value for existing products
  console.log('\nSetting default value of 10 for all product templates...');
  await delay(2000);

  const updateResult = await executeKw(uid, 'product.template', 'search_read', `
    <array><data><value><array><data></data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
    </data></array></value></member>
    <member><name>limit</name><value><int>5000</int></value></member>
  </struct>`);

  // Count products
  const productIds = (updateResult.match(/<int>(\d+)<\/int>/g) || [])
    .map(m => parseInt(m.match(/\d+/)[0]));

  if (productIds.length > 0) {
    console.log(`Found ${productIds.length} products to update...`);

    // Update in batches
    const batchSize = 100;
    for (let i = 0; i < productIds.length; i += batchSize) {
      const batch = productIds.slice(i, i + batchSize);
      const idsXml = batch.map(id => `<value><int>${id}</int></value>`).join('');

      await executeKw(uid, 'product.template', 'write', `
        <array><data>
          <value><array><data>${idsXml}</data></array></value>
          <value><struct>
            <member><name>x_safety_stock</name><value><double>10</double></value></member>
          </struct></value>
        </data></array>
      `);

      console.log(`  Updated products ${i + 1} - ${Math.min(i + batchSize, productIds.length)}`);
      await delay(1000);
    }

    console.log('\n✓ Default values set!');
  }

  console.log('\n=== Script completed successfully! ===');
  console.log('\nThe x_safety_stock field is now available on product.template in Odoo.');
  console.log('You should now see it in the product form under Settings → Technical → Fields.');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
