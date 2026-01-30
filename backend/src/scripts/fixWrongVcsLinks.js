#!/usr/bin/env node
/**
 * Fix VCS orders that were incorrectly linked to non-Amazon orders
 *
 * This script:
 * 1. Finds VCS orders linked to non-Amazon orders (BOL, direct sales)
 * 2. Deletes the draft invoices in Odoo (if they exist and are drafts)
 * 3. Resets the VCS orders in MongoDB to "pending" for re-processing
 *
 * Usage:
 *   node src/scripts/fixWrongVcsLinks.js --dry-run    # Preview changes
 *   node src/scripts/fixWrongVcsLinks.js --fix        # Apply fixes
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

async function fixWrongLinks() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fix = args.includes('--fix');

  if (!dryRun && !fix) {
    console.log('Usage:');
    console.log('  node src/scripts/fixWrongVcsLinks.js --dry-run    # Preview changes');
    console.log('  node src/scripts/fixWrongVcsLinks.js --fix        # Apply fixes');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Fix Wrongly Linked VCS Orders - ${dryRun ? 'DRY RUN' : 'APPLYING FIXES'}`);
  console.log(`${'='.repeat(60)}\n`);

  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to MongoDB and Odoo\n');

  // Find all invoiced VCS orders linked to non-Amazon orders
  const wrongLinks = await db.collection('amazon_vcs_orders')
    .find({
      status: 'invoiced',
      odooSaleOrderName: { $exists: true },
      $and: [
        { odooSaleOrderName: { $not: /^FBA/ } },
        { odooSaleOrderName: { $not: /^FBM/ } }
      ]
    })
    .toArray();

  console.log(`Found ${wrongLinks.length} VCS orders linked to non-Amazon orders\n`);

  if (wrongLinks.length === 0) {
    console.log('Nothing to fix!');
    await mongoClient.close();
    return;
  }

  let fixed = 0;
  let errors = 0;

  for (const vcsOrder of wrongLinks) {
    console.log(`\nOrder: ${vcsOrder.orderId}`);
    console.log(`  Wrong link: ${vcsOrder.odooSaleOrderName}`);
    console.log(`  Invoice: ${vcsOrder.odooInvoiceName || 'N/A'} (ID: ${vcsOrder.odooInvoiceId || 'N/A'})`);

    if (fix) {
      try {
        // Step 1: Delete the draft invoice in Odoo (if exists and is draft)
        if (vcsOrder.odooInvoiceId) {
          const invoices = await odoo.searchRead('account.move',
            [['id', '=', vcsOrder.odooInvoiceId]],
            ['id', 'name', 'state']
          );

          if (invoices.length > 0) {
            const invoice = invoices[0];
            if (invoice.state === 'draft') {
              console.log(`  Deleting draft invoice ${invoice.name}...`);
              await odoo.execute('account.move', 'unlink', [[invoice.id]]);
              console.log(`  Deleted.`);
            } else {
              console.log(`  WARNING: Invoice ${invoice.name} is ${invoice.state}, not draft. Skipping delete.`);
            }
          } else {
            console.log(`  Invoice ID ${vcsOrder.odooInvoiceId} not found in Odoo.`);
          }
        }

        // Step 2: Reset the VCS order in MongoDB
        await db.collection('amazon_vcs_orders').updateOne(
          { _id: vcsOrder._id },
          {
            $set: { status: 'pending' },
            $unset: {
              odooInvoiceId: '',
              odooInvoiceName: '',
              odooSaleOrderId: '',
              odooSaleOrderName: '',
              invoicedAt: '',
              processingStep: '',
              processingRunId: ''
            }
          }
        );
        console.log(`  Reset to pending.`);
        fixed++;
      } catch (err) {
        console.log(`  ERROR: ${err.message}`);
        errors++;
      }
    } else {
      console.log(`  [DRY RUN] Would delete invoice and reset to pending`);
      fixed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Orders ${dryRun ? 'to fix' : 'fixed'}: ${fixed}`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log('This was a dry run. Run with --fix to apply changes.');
  }

  await mongoClient.close();
}

fixWrongLinks().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
