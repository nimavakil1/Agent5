#!/usr/bin/env node
/**
 * Find where team 11 is referenced in Odoo
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
  console.log('=== Finding Team 11 References ===\n');

  const uid = await authenticate();

  // Check various places where crm.team might be referenced

  // 1. Check all users' crm_team_id or sale_team_id
  console.log('1. Checking all users for team 11 reference...');
  const usersResult = await executeKw(uid, 'res.users', 'search_read', `
    <array><data><value><array><data></data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>sale_team_id</string></value>
    </data></array></value></member>
  </struct>`);

  if (usersResult.includes('>11<')) {
    console.log('   Found reference to 11 in users!');
    console.log(usersResult.substring(0, 1500));
  } else {
    console.log('   No team 11 reference in users');
  }

  // 2. Check ir.property for team references (default values)
  console.log('\n2. Checking ir.property for team 11 references...');
  const propResult = await executeKw(uid, 'ir.property', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>value_reference</string></value>
        <value><string>ilike</string></value>
        <value><string>crm.team,11</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>value_reference</string></value>
      <value><string>res_id</string></value>
    </data></array></value></member>
  </struct>`);

  if (propResult.includes('<int>') && !propResult.includes('<data></data>')) {
    console.log('   FOUND ir.property reference to team 11!');
    console.log(propResult);

    // Delete these properties
    console.log('\n   Deleting invalid properties...');
    const propIds = (propResult.match(/<int>(\d+)<\/int>/g) || [])
      .map(m => parseInt(m.match(/\d+/)[0]));

    if (propIds.length > 0) {
      const idsXml = propIds.map(id => `<value><int>${id}</int></value>`).join('');
      const deleteResult = await executeKw(uid, 'ir.property', 'unlink', `
        <array><data><value><array><data>${idsXml}</data></array></value></data></array>
      `);
      console.log('   Delete result:', deleteResult.includes('True') || deleteResult.includes('1') ? 'SUCCESS' : deleteResult);
    }
  } else {
    console.log('   No ir.property reference to team 11');
  }

  // 3. Check res.config.settings or crm related settings
  console.log('\n3. Checking for team reference in settings menus...');

  // Check ir.actions.act_window for references to team 11
  const actionResult = await executeKw(uid, 'ir.actions.act_window', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>res_model</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>res_id</string></value>
      <value><string>domain</string></value>
    </data></array></value></member>
  </struct>`);

  if (actionResult.includes('>11<')) {
    console.log('   Found action with res_id=11:');
    console.log(actionResult);
  } else {
    console.log('   No actions with team 11 as res_id');
  }

  // 4. Check ir.ui.view for team 11 references
  console.log('\n4. Checking views for team 11...');
  const viewResult = await executeKw(uid, 'ir.ui.view', 'search_count', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>arch_db</string></value>
        <value><string>ilike</string></value>
        <value><string>crm.team,11</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `);
  console.log('   Views with team 11 reference:', viewResult);

  // 5. Check for default values
  console.log('\n5. Checking ir.default for team 11...');
  const defaultResult = await executeKw(uid, 'ir.default', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>field_id.relation</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>field_id</string></value>
      <value><string>json_value</string></value>
    </data></array></value></member>
  </struct>`);

  if (defaultResult.includes('>11<') || defaultResult.includes('"11"')) {
    console.log('   FOUND ir.default with team 11!');
    console.log(defaultResult);
  } else {
    console.log('   ir.default result:', defaultResult.substring(0, 500));
  }

  console.log('\n=== Search complete ===');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
