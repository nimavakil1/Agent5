/**
 * Fix Bol partner names that incorrectly have MALE/FEMALE prefix
 *
 * The Bol.com API returns salutation as "MALE" or "FEMALE" (gender),
 * which was incorrectly included in customer names.
 *
 * Usage:
 *   node scripts/fix-bol-partner-names.js              # Dry run
 *   node scripts/fix-bol-partner-names.js --fix        # Actually fix
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const dryRun = !process.argv.includes('--fix');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix Bol Partner Names (MALE/FEMALE prefix) ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : '⚠️  LIVE - WILL UPDATE PARTNERS'}\n`);

  // Find partners with names starting with "MALE " or "FEMALE "
  const malePartners = await odoo.searchRead('res.partner',
    [['name', '=like', 'MALE %']],
    ['id', 'name', 'zip', 'city'],
    { limit: 10000 }
  );

  const femalePartners = await odoo.searchRead('res.partner',
    [['name', '=like', 'FEMALE %']],
    ['id', 'name', 'zip', 'city'],
    { limit: 10000 }
  );

  const allPartners = [...malePartners, ...femalePartners];

  console.log(`Found ${malePartners.length} partners starting with "MALE"`);
  console.log(`Found ${femalePartners.length} partners starting with "FEMALE"`);
  console.log(`Total to fix: ${allPartners.length}\n`);

  if (allPartners.length === 0) {
    console.log('No partners to fix!');
    return;
  }

  // Show examples
  console.log('=== Examples ===\n');
  for (const p of allPartners.slice(0, 20)) {
    // Apply same cleaning logic as the fix
    let cleanName = p.name
      .replace(/^MALE\s+/g, '')
      .replace(/^FEMALE\s+/g, '')
      .replace(/,\s*MALE\s+/g, ', ')
      .replace(/,\s*FEMALE\s+/g, ', ')
      .trim();

    // Handle fully duplicated names
    if (cleanName.includes(', ')) {
      const parts = cleanName.split(', ');
      if (parts[0] === parts[1]) {
        cleanName = parts[0];
      }
    }

    console.log(`ID ${p.id}: "${p.name}" → "${cleanName}"`);
  }

  if (dryRun) {
    console.log('\n=== DRY RUN - No changes made ===');
    console.log(`Would fix ${allPartners.length} partner names`);
    console.log('\nRun with --fix flag to apply changes:');
    console.log('  node scripts/fix-bol-partner-names.js --fix');
    return;
  }

  // Actually fix the names
  console.log('\n=== Fixing partner names ===\n');

  let fixed = 0;
  let errors = [];

  for (const p of allPartners) {
    // Remove all occurrences of "MALE " and "FEMALE " prefix
    let cleanName = p.name
      .replace(/^MALE\s+/g, '')
      .replace(/^FEMALE\s+/g, '')
      .replace(/,\s*MALE\s+/g, ', ')  // Handle duplicated names with MALE in middle
      .replace(/,\s*FEMALE\s+/g, ', ')
      .trim();

    // Handle fully duplicated names (e.g., "Name, Name" -> "Name")
    if (cleanName.includes(', ')) {
      const parts = cleanName.split(', ');
      if (parts[0] === parts[1]) {
        cleanName = parts[0];
      }
    }

    try {
      await odoo.write('res.partner', [p.id], { name: cleanName });
      fixed++;
      if (fixed % 50 === 0) {
        console.log(`Fixed ${fixed}/${allPartners.length} partners...`);
      }
    } catch (error) {
      errors.push({ id: p.id, name: p.name, error: error.message });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const err of errors.slice(0, 10)) {
      console.log(`  ID ${err.id} (${err.name}): ${err.error}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
