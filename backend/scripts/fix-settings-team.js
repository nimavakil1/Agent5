#!/usr/bin/env node
/**
 * Check and fix team references in res.config.settings
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
  console.log('=== Fixing Settings Team References ===\n');

  const uid = await authenticate();

  // Check ir.property for any crm.team references (this is where Many2one defaults are stored)
  console.log('1. Checking ir.property for ALL crm.team references...');
  const propResult = await executeKw(uid, 'ir.property', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>value_reference</string></value>
        <value><string>ilike</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>value_reference</string></value>
      <value><string>res_id</string></value>
      <value><string>fields_id</string></value>
    </data></array></value></member>
  </struct>`);

  console.log('   ir.property crm.team entries:');
  console.log(propResult);

  // Check if any reference team 11 specifically
  if (propResult.includes('crm.team,11')) {
    console.log('\n   *** FOUND reference to team 11! ***');

    // Extract the property IDs that reference team 11
    const props = propResult.split('<struct>').filter(s => s.includes('crm.team,11'));
    for (const prop of props) {
      const idMatch = prop.match(/<name>id<\/name>\s*<value><int>(\d+)<\/int>/);
      const nameMatch = prop.match(/<name>name<\/name>\s*<value><string>([^<]+)<\/string>/);
      if (idMatch) {
        console.log(`   Property ID ${idMatch[1]}: ${nameMatch ? nameMatch[1] : 'unknown field'}`);
      }
    }

    // Extract all IDs from properties with team 11
    const allIds = [];
    const idMatches = propResult.matchAll(/<struct>[\s\S]*?crm\.team,11[\s\S]*?<name>id<\/name>\s*<value><int>(\d+)<\/int>/g);
    // That regex is complex, let's use a simpler approach
    const lines = propResult.split('\n');
    let currentId = null;
    let hasTeam11 = false;

    for (const line of lines) {
      if (line.includes('<name>id</name>')) {
        const idMatch = line.match(/<int>(\d+)<\/int>/);
        if (idMatch) currentId = parseInt(idMatch[1]);
      }
      if (line.includes('crm.team,11')) {
        hasTeam11 = true;
      }
      if (line.includes('</struct>')) {
        if (hasTeam11 && currentId) {
          allIds.push(currentId);
        }
        currentId = null;
        hasTeam11 = false;
      }
    }

    if (allIds.length > 0) {
      console.log(`\n   Updating ${allIds.length} properties to remove team 11 reference...`);
      for (const propId of allIds) {
        console.log(`   Clearing property ${propId}...`);
        const updateResult = await executeKw(uid, 'ir.property', 'write', `
          <array><data>
            <value><array><data><value><int>${propId}</int></value></data></array></value>
            <value><struct>
              <member><name>value_reference</name><value><boolean>0</boolean></value></member>
            </struct></value>
          </data></array>
        `);
        console.log(`   Result: ${updateResult.includes('True') || updateResult.includes('1') ? 'SUCCESS' : 'FAILED'}`);
      }
    }
  } else if (propResult.includes('<data></data>')) {
    console.log('   No ir.property entries for crm.team');
  } else {
    console.log('   No team 11 references found in ir.property');
  }

  // Also check res.company for team references
  console.log('\n2. Checking res.company for crm_team related fields...');
  const companyResult = await executeKw(uid, 'res.company', 'read', `
    <array><data><value><array><data>
      <value><int>1</int></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
    </data></array></value></member>
  </struct>`);
  console.log('   Company:', companyResult.substring(0, 300));

  // Get all fields on res.company that are Many2one to crm.team
  console.log('\n3. Checking res.company fields relating to crm.team...');
  const companyFieldsResult = await executeKw(uid, 'ir.model.fields', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>res.company</string></value>
      </data></array></value>
      <value><array><data>
        <value><string>relation</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>name</string></value>
      <value><string>field_description</string></value>
    </data></array></value></member>
  </struct>`);
  console.log('   Company fields with crm.team relation:', companyFieldsResult);

  console.log('\n=== Done ===');
  console.log('\nPlease try the following:');
  console.log('1. Clear your browser cache/cookies for acropaq.odoo.com');
  console.log('2. Log out and log back into Odoo');
  console.log('3. Try clicking Settings again');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
