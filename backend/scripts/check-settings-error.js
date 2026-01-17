#!/usr/bin/env node
/**
 * Check Settings (res.config.settings) and mail.activity for team 11 references
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
  console.log('=== Checking Settings Error Source ===\n');

  const uid = await authenticate();

  // 1. Check mail.activity for crm.team references
  console.log('1. Checking mail.activity for crm.team references...');
  const activityResult = await executeKw(uid, 'mail.activity', 'search_read', `
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
      <value><string>res_id</string></value>
      <value><string>res_model</string></value>
      <value><string>summary</string></value>
    </data></array></value></member>
  </struct>`);

  if (activityResult.includes('<int>11</int>') || activityResult.includes('>11<')) {
    console.log('   FOUND activity referencing crm.team 11!');
    console.log(activityResult);
  } else if (activityResult.includes('<data></data>')) {
    console.log('   No mail.activity records for crm.team');
  } else {
    console.log('   Activities found:', activityResult.substring(0, 800));
  }

  // 2. Check mail.followers for crm.team references
  console.log('\n2. Checking mail.followers for crm.team references...');
  const followerResult = await executeKw(uid, 'mail.followers', 'search_read', `
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
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>partner_id</string></value>
    </data></array></value></member>
  </struct>`);

  if (!followerResult.includes('<data></data>')) {
    console.log('   FOUND followers for crm.team 11!');
    console.log(followerResult);

    // Delete these followers
    const followerIds = (followerResult.match(/<member>\s*<name>id<\/name>\s*<value><int>(\d+)<\/int>/g) || [])
      .map(m => parseInt(m.match(/\d+/)[0]));

    if (followerIds.length > 0) {
      console.log(`   Deleting ${followerIds.length} orphan followers...`);
      const idsXml = followerIds.map(id => `<value><int>${id}</int></value>`).join('');
      const deleteResult = await executeKw(uid, 'mail.followers', 'unlink', `
        <array><data><value><array><data>${idsXml}</data></array></value></data></array>
      `);
      console.log('   Delete result:', deleteResult.includes('True') || deleteResult.includes('1') ? 'SUCCESS' : deleteResult);
    }
  } else {
    console.log('   No followers for crm.team 11');
  }

  // 3. Check if res.config.settings has crm_team related fields
  console.log('\n3. Checking res.config.settings fields...');
  const modelFieldsResult = await executeKw(uid, 'ir.model.fields', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>model</string></value>
        <value><string>=</string></value>
        <value><string>res.config.settings</string></value>
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

  console.log('   Fields relating to crm.team:', modelFieldsResult);

  // 4. Check ir.model.data for crm.team,11 external ID
  console.log('\n4. Checking ir.model.data for crm.team,11...');
  const modelDataResult = await executeKw(uid, 'ir.model.data', 'search_read', `
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
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>name</string></value>
      <value><string>module</string></value>
    </data></array></value></member>
  </struct>`);

  if (!modelDataResult.includes('<data></data>')) {
    console.log('   FOUND ir.model.data entry for crm.team 11!');
    console.log(modelDataResult);

    // This is likely the culprit - delete it
    const dataIds = (modelDataResult.match(/<member>\s*<name>id<\/name>\s*<value><int>(\d+)<\/int>/g) || [])
      .map(m => parseInt(m.match(/\d+/)[0]));

    if (dataIds.length > 0) {
      console.log(`   Deleting orphan ir.model.data entries...`);
      const idsXml = dataIds.map(id => `<value><int>${id}</int></value>`).join('');
      const deleteResult = await executeKw(uid, 'ir.model.data', 'unlink', `
        <array><data><value><array><data>${idsXml}</data></array></value></data></array>
      `);
      console.log('   Delete result:', deleteResult.includes('True') || deleteResult.includes('1') ? 'SUCCESS' : deleteResult);
    }
  } else {
    console.log('   No ir.model.data entry for crm.team 11');
  }

  // 5. Check crm.team.member for references to team 11
  console.log('\n5. Checking crm.team.member for team 11...');
  const memberResult = await executeKw(uid, 'crm.team.member', 'search_read', `
    <array><data><value><array><data>
      <value><array><data>
        <value><string>crm_team_id</string></value>
        <value><string>=</string></value>
        <value><int>11</int></value>
      </data></array></value>
    </data></array></value></data></array>
  `, `<struct>
    <member><name>fields</name><value><array><data>
      <value><string>id</string></value>
      <value><string>user_id</string></value>
    </data></array></value></member>
  </struct>`);

  if (!memberResult.includes('<data></data>')) {
    console.log('   FOUND crm.team.member referencing team 11!');
    console.log(memberResult);

    // Delete these members
    const memberIds = (memberResult.match(/<member>\s*<name>id<\/name>\s*<value><int>(\d+)<\/int>/g) || [])
      .map(m => parseInt(m.match(/\d+/)[0]));

    if (memberIds.length > 0) {
      console.log(`   Deleting ${memberIds.length} orphan team members...`);
      const idsXml = memberIds.map(id => `<value><int>${id}</int></value>`).join('');
      const deleteResult = await executeKw(uid, 'crm.team.member', 'unlink', `
        <array><data><value><array><data>${idsXml}</data></array></value></data></array>
      `);
      console.log('   Delete result:', deleteResult.includes('True') || deleteResult.includes('1') ? 'SUCCESS' : deleteResult);
    }
  } else {
    console.log('   No crm.team.member for team 11');
  }

  console.log('\n=== Check complete ===');
  console.log('\nIf no orphan references were found, the error might be caused by:');
  console.log('1. Browser cache - try clearing cookies/cache');
  console.log('2. Session data - try logging out and back in');
  console.log('3. A widget or dashboard that references team 11');
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
