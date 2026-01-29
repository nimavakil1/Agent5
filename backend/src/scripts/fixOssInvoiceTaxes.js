#!/usr/bin/env node
/**
 * Fix OSS Invoice Taxes Script
 *
 * This script fixes invoices that have:
 * - An OSS fiscal position (e.g., DE*OSS, FR*OSS)
 * - But invoice lines with BE*VAT tax instead of the correct OSS tax
 *
 * The fiscal position's tax mapping should have been applied but wasn't.
 * This script applies the correct tax based on the fiscal position.
 *
 * Usage:
 *   node src/scripts/fixOssInvoiceTaxes.js --dry-run    # Preview changes
 *   node src/scripts/fixOssInvoiceTaxes.js --fix        # Apply fixes
 */

require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

// BE*VAT tax IDs that should be remapped
const BE_VAT_TAX_IDS = [1, 2, 147]; // BE*VAT 21%, BE*VAT 21% S, BE*VAT 21% Included

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fix = args.includes('--fix');

  if (!dryRun && !fix) {
    console.log('Usage:');
    console.log('  node src/scripts/fixOssInvoiceTaxes.js --dry-run    # Preview changes');
    console.log('  node src/scripts/fixOssInvoiceTaxes.js --fix        # Apply fixes');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`OSS Invoice Tax Fix Script - ${dryRun ? 'DRY RUN' : 'APPLYING FIXES'}`);
  console.log(`${'='.repeat(60)}\n`);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // Step 1: Get all OSS fiscal positions and their tax mappings
  console.log('Loading OSS fiscal positions and tax mappings...');
  const ossFiscalPositions = await odoo.searchRead('account.fiscal.position',
    [['name', 'ilike', 'OSS']],
    ['id', 'name']
  );
  console.log(`Found ${ossFiscalPositions.length} OSS fiscal positions\n`);

  // Build mapping: fiscal_position_id -> { src_tax_id -> dest_tax_id }
  const fpTaxMappings = new Map();
  for (const fp of ossFiscalPositions) {
    const taxMaps = await odoo.searchRead('account.fiscal.position.tax',
      [['position_id', '=', fp.id]],
      ['tax_src_id', 'tax_dest_id']
    );

    const mapping = new Map();
    for (const tm of taxMaps) {
      if (tm.tax_src_id && tm.tax_dest_id) {
        mapping.set(tm.tax_src_id[0], {
          destId: tm.tax_dest_id[0],
          destName: tm.tax_dest_id[1]
        });
      }
    }
    fpTaxMappings.set(fp.id, { name: fp.name, mapping });
  }

  // Step 2: Find all OSS invoices with BE*VAT tax on lines
  console.log('Searching for invoices with incorrect taxes...\n');

  const ossFpIds = ossFiscalPositions.map(fp => fp.id);

  // Find invoice lines with BE*VAT tax in OSS invoices
  const problemLines = await odoo.searchRead('account.move.line', [
    ['move_id.fiscal_position_id', 'in', ossFpIds],
    ['move_id.state', '=', 'posted'],
    ['display_type', '=', 'product'],
    ['tax_ids', 'in', BE_VAT_TAX_IDS]
  ], ['id', 'move_id', 'name', 'tax_ids', 'price_unit', 'quantity'], 0, 1000);

  console.log(`Found ${problemLines.length} invoice lines with incorrect taxes\n`);

  if (problemLines.length === 0) {
    console.log('No issues found. All OSS invoices have correct taxes.');
    return;
  }

  // Group by invoice
  const invoiceMap = new Map();
  for (const line of problemLines) {
    const invId = line.move_id[0];
    if (!invoiceMap.has(invId)) {
      invoiceMap.set(invId, {
        id: invId,
        name: line.move_id[1],
        lines: []
      });
    }
    invoiceMap.get(invId).lines.push(line);
  }

  console.log(`Affecting ${invoiceMap.size} invoices:\n`);

  // Step 3: Process each invoice
  let totalFixed = 0;
  let totalErrors = 0;

  for (const [invId, invData] of invoiceMap) {
    // Get invoice fiscal position
    const [invoice] = await odoo.searchRead('account.move',
      [['id', '=', invId]],
      ['fiscal_position_id', 'state']
    );

    if (!invoice.fiscal_position_id) {
      console.log(`  SKIP: ${invData.name} - No fiscal position`);
      continue;
    }

    const fpId = invoice.fiscal_position_id[0];
    const fpData = fpTaxMappings.get(fpId);

    if (!fpData) {
      console.log(`  SKIP: ${invData.name} - Fiscal position not in OSS list`);
      continue;
    }

    console.log(`\nInvoice: ${invData.name}`);
    console.log(`  Fiscal Position: ${fpData.name}`);
    console.log(`  Lines to fix: ${invData.lines.length}`);

    for (const line of invData.lines) {
      // Get current tax
      const currentTaxId = line.tax_ids[0]; // First tax
      const taxMapping = fpData.mapping.get(currentTaxId);

      if (!taxMapping) {
        console.log(`    Line ${line.id}: No mapping for tax ${currentTaxId}, skipping`);
        continue;
      }

      console.log(`    Line ${line.id}: ${line.name.substring(0, 40)}`);
      console.log(`      Current tax ID: ${currentTaxId} -> Should be: ${taxMapping.destId} (${taxMapping.destName})`);

      if (fix) {
        try {
          // Need to reset to draft, update, then re-post
          // First check if invoice is posted
          if (invoice.state === 'posted') {
            // Reset to draft
            await odoo.execute('account.move', 'button_draft', [[invId]]);
          }

          // Update the line's tax
          await odoo.write('account.move.line', [line.id], {
            tax_ids: [[6, 0, [taxMapping.destId]]]
          });

          // Re-post the invoice
          await odoo.execute('account.move', 'action_post', [[invId]]);

          console.log(`      FIXED`);
          totalFixed++;
        } catch (err) {
          console.log(`      ERROR: ${err.message}`);
          totalErrors++;

          // Try to re-post if we left it in draft
          try {
            await odoo.execute('account.move', 'action_post', [[invId]]);
          } catch (e) {
            // Ignore
          }
        }
      } else {
        console.log(`      [DRY RUN] Would fix`);
        totalFixed++;
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Invoices affected: ${invoiceMap.size}`);
  console.log(`  Lines ${dryRun ? 'to fix' : 'fixed'}: ${totalFixed}`);
  if (totalErrors > 0) {
    console.log(`  Errors: ${totalErrors}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log('This was a dry run. Run with --fix to apply changes.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
