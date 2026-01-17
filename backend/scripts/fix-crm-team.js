#!/usr/bin/env node
/**
 * Script to diagnose and fix missing CRM team reference
 * Error: "Record does not exist or has been deleted. (Record: crm.team(11,), User: 2)"
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

function parseIds(xmlResult) {
  const matches = xmlResult.match(/<int>(\d+)<\/int>/g) || [];
  return matches.map(m => parseInt(m.match(/\d+/)[0]));
}

function parseRecords(xmlResult) {
  // Simple parser for search_read results
  const records = [];
  const structMatches = xmlResult.match(/<struct>[\s\S]*?<\/struct>/g) || [];

  for (const struct of structMatches) {
    const record = {};
    const memberMatches = struct.match(/<member>[\s\S]*?<\/member>/g) || [];

    for (const member of memberMatches) {
      const nameMatch = member.match(/<name>([^<]+)<\/name>/);
      const valueMatch = member.match(/<(string|int|boolean)>([^<]*)<\/(string|int|boolean)>/);

      if (nameMatch && valueMatch) {
        const name = nameMatch[1];
        let value = valueMatch[2];
        if (valueMatch[1] === 'int') value = parseInt(value);
        if (valueMatch[1] === 'boolean') value = value === '1';
        record[name] = value;
      }
    }

    if (Object.keys(record).length > 0) {
      records.push(record);
    }
  }
  return records;
}

async function main() {
  console.log('=== CRM Team Diagnostic Script ===\n');

  const uid = await authenticate();

  // Step 1: List all existing CRM teams
  console.log('1. Listing all CRM teams...');
  const teamsResult = await executeKw(uid, 'crm.team', 'search_read', `
    <array><data><value><array><data></data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>active</string></value>
    </data></array></value></member>
  </struct>`);

  const teams = parseRecords(teamsResult);
  const teamIds = parseIds(teamsResult);

  console.log(`   Found ${teams.length} CRM team(s):`);
  teams.forEach(t => console.log(`   - ID ${t.id}: "${t.name}" (active: ${t.active})`));

  const team11Exists = teamIds.includes(11);
  console.log(`\n   Team ID 11 exists: ${team11Exists ? 'YES' : 'NO'}`);

  // Step 2: Check user 2's sale_team_id preference
  console.log('\n2. Checking user 2 preferences...');
  const userResult = await executeKw(uid, 'res.users', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>id</string></value>
        <value><string>=</string></value>
        <value><int>2</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>login</string></value>
      <value><string>sale_team_id</string></value>
    </data></array></value></member>
  </struct>`);

  console.log('   User 2 data:', userResult.substring(0, 500));

  // Check if sale_team_id references team 11
  const saleTeamMatch = userResult.match(/sale_team_id[\s\S]*?<int>(\d+)<\/int>/);
  const userSaleTeamId = saleTeamMatch ? parseInt(saleTeamMatch[1]) : null;
  console.log(`   User 2 sale_team_id: ${userSaleTeamId || 'Not set'}`);

  // Step 3: Provide fix options
  console.log('\n3. DIAGNOSIS:');

  if (!team11Exists && userSaleTeamId === 11) {
    console.log('   ✗ Problem found: User 2 references team 11 which does not exist');
    console.log('\n   SOLUTION OPTIONS:');
    console.log('   A) Clear the sale_team_id reference on user 2');
    console.log('   B) Recreate team 11');

    // Ask which solution to apply
    console.log('\n   Applying solution A (clearing reference)...');

    const fixResult = await executeKw(uid, 'res.users', 'write', `
      <array><data>
        <value><array><data><value><int>2</int></value></data></array></value>
        <value><struct>
          <member><name>sale_team_id</name><value><boolean>0</boolean></value></member>
        </struct></value>
      </data></array>
    `);

    if (fixResult.includes('<boolean>1</boolean>') || fixResult.includes('True')) {
      console.log('   ✓ Successfully cleared sale_team_id on user 2');
      console.log('\n   Please refresh Odoo and try clicking Settings again.');
    } else {
      console.log('   Fix result:', fixResult);
    }
  } else if (!team11Exists) {
    console.log('   Team 11 does not exist, but user 2 is not directly referencing it.');
    console.log('   The reference might be in a different field or another user.');
    console.log('\n   Checking company defaults...');

    // Check res.company for team references
    const companyResult = await executeKw(uid, 'res.company', 'search_read', `
      <array><data><value><array><data></data></array></value></data></array>
    `, `<struct>
      <member><name>fields</name><value><array><data>
        <value><string>id</string></value>
        <value><string>name</string></value>
      </data></array></value></member>
    </struct>`);
    console.log('   Company data:', companyResult.substring(0, 300));
  } else {
    console.log('   ✓ Team 11 exists. The error might be transient.');
    console.log('   Try clearing browser cache and refreshing Odoo.');
  }

  console.log('\n=== Script completed ===');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
