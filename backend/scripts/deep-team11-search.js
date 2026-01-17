#!/usr/bin/env node
/**
 * Deep search for team 11 references - checking all possible locations
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
  console.log('=== Deep Search for Team 11 References ===\n');

  const uid = await authenticate();

  // 1. Check ir.config_parameter for team references
  console.log('1. Checking ir.config_parameter (system parameters)...');
  const configResult = await executeKw(uid, 'ir.config_parameter', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>value</string></value>
        <value><string>ilike</string></value>
        <value><string>11</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>key</string></value>
      <value><string>value</string></value>
    </data></array></value></member>
  </struct>`);

  if (configResult.includes('team') || configResult.includes('crm')) {
    console.log('   Found team-related config params:');
    console.log(configResult);
  } else {
    console.log('   Config params with "11":', configResult.substring(0, 800));
  }

  // 2. Check digest.digest for team references
  console.log('\n2. Checking digest.digest...');
  try {
    const digestResult = await executeKw(uid, 'digest.digest', 'search_read', `
      <array><data><value><array><data></data></array></value></data></array>
    `, `<struct>
      <member><name>fields</name><value><array><data>
        <value><string>id</string></value>
        <value><string>name</string></value>
      </data></array></value></member>
    </struct>`);
    console.log('   Digests:', digestResult.substring(0, 500));
  } catch (e) {
    console.log('   digest.digest not accessible');
  }

  // 3. Check website related models
  console.log('\n3. Checking website.menu for team references...');
  try {
    const menuResult = await executeKw(uid, 'website.menu', 'search_read', `
      <array><data><value><array><data>
        <value><array><data>
          <value><string>url</string></value>
          <value><string>ilike</string></value>
          <value><string>team</string></value>
        </data></array></value>
      </data></array></value></data></array>
    `, `<struct>
      <member><name>fields</name><value><array><data>
        <value><string>id</string></value>
        <value><string>name</string></value>
        <value><string>url</string></value>
      </data></array></value></member>
    </struct>`);
    console.log('   Website menus:', menuResult.substring(0, 500));
  } catch (e) {
    console.log('   website.menu not accessible');
  }

  // 4. Check fetchmail.server - sometimes has team_id
  console.log('\n4. Checking fetchmail.server for team_id = 11...');
  try {
    const fetchmailResult = await executeKw(uid, 'fetchmail.server', 'search_read', `
      <array><data><value><array><data>
        <value><array><data>
          <value><string>object_id</string></value>
          <value><string>ilike</string></value>
          <value><string>crm.team</string></value>
        </data></array></value>
      </data></array></value></data></array>
    `, `<struct>
      <member><name>fields</name><value><array><data>
        <value><string>id</string></value>
        <value><string>name</string></value>
      </data></array></value></member>
    </struct>`);
    console.log('   Fetchmail servers:', fetchmailResult);
  } catch (e) {
    console.log('   fetchmail.server not accessible');
  }

  // 5. Check crm.team.member more thoroughly
  console.log('\n5. Checking ALL crm.team.member records...');
  const memberResult = await executeKw(uid, 'crm.team.member', 'search_read', `
    <array><data><value><array><data></data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>crm_team_id</string></value>
      <value><string>user_id</string></value>
    </data></array></value></member>
    <member><name>limit</name><value><int>100</int></value></member>
  </struct>`);

  if (memberResult.includes('>11<')) {
    console.log('   FOUND team member with team 11!');
    console.log(memberResult);
  } else {
    console.log('   Team members (first 100):', memberResult.substring(0, 1000));
  }

  // 6. Check ir.rule for team 11 in domain
  console.log('\n6. Checking ir.rule domains for team 11...');
  const ruleResult = await executeKw(uid, 'ir.rule', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>domain_force</string></value>
        <value><string>ilike</string></value>
        <value><string>team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>domain_force</string></value>
    </data></array></value></member>
  </struct>`);

  if (ruleResult.includes('11')) {
    console.log('   FOUND rule with 11:');
    console.log(ruleResult);
  } else {
    console.log('   Rules with "team" in domain:', ruleResult.substring(0, 800));
  }

  // 7. Check mail.alias for team 11
  console.log('\n7. Checking mail.alias for crm.team references...');
  const aliasResult = await executeKw(uid, 'mail.alias', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>alias_model_id.model</string></value>
        <value><string>=</string></value>
        <value><string>crm.team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>alias_name</string></value>
      <value><string>alias_force_thread_id</string></value>
    </data></array></value></member>
  </struct>`);

  if (aliasResult.includes('>11<')) {
    console.log('   FOUND alias referencing team 11!');
    console.log(aliasResult);
  } else {
    console.log('   Aliases for crm.team:', aliasResult);
  }

  // 8. Check base_automation (automated actions)
  console.log('\n8. Checking base.automation for team references...');
  try {
    const autoResult = await executeKw(uid, 'base.automation', 'search_read', `
      <array><data><value><array><data>
        <value><array><data>
          <value><string>model_id.model</string></value>
          <value><string>=</string></value>
          <value><string>crm.team</string></value>
        </data></array></value>
      </data></array></value></data></array>
    `, `<struct>
      <member><name>fields</name><value><array><data>
        <value><string>id</string></value>
        <value><string>name</string></value>
      </data></array></value></member>
    </struct>`);
    console.log('   Automated actions for crm.team:', autoResult);
  } catch (e) {
    console.log('   base.automation not accessible');
  }

  // 9. Check ir.actions.server with team references
  console.log('\n9. Checking ir.actions.server for team 11...');
  const serverActionResult = await executeKw(uid, 'ir.actions.server', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>code</string></value>
        <value><string>ilike</string></value>
        <value><string>team</string></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>code</string></value>
    </data></array></value></member>
  </struct>`);

  if (serverActionResult.includes('11')) {
    console.log('   FOUND server action with 11:');
    console.log(serverActionResult);
  } else {
    console.log('   Server actions with "team":', serverActionResult.substring(0, 500));
  }

  // 10. Check res.users more thoroughly - ALL team-related fields
  console.log('\n10. Checking res.users for ALL team-related field values...');
  const userDetailResult = await executeKw(uid, 'res.users', 'read', `
    <array><data><value><array><data>
      <value><int>2</int></value>
    </data></array></value></data></array>
  `, `<struct></struct>`);

  // Look for any field containing 11 that might be team-related
  if (userDetailResult.includes('_team') && userDetailResult.includes('>11<')) {
    console.log('   FOUND team field with value 11 on user 2!');
  }
  console.log('   User 2 full data (searching for 11):');
  const lines = userDetailResult.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('>11<') || lines[i].includes('team')) {
      console.log(`   ${lines[i]}`);
    }
  }

  console.log('\n=== Deep search complete ===');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
