#!/usr/bin/env node
/**
 * VCS Cleanup v3: Focused on invoices where x_vcs_invoice_number is empty
 *
 * Targets invoices where:
 * - ref contains a VCS number (not Amazon order ID pattern)
 * - x_vcs_invoice_number is empty
 *
 * Updates:
 * - Sets x_vcs_invoice_number = current ref value
 * - Sets ref = Amazon order ID (from VCS data or invoice_origin)
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const DATE_FROM = '2024-01-01';
const AMAZON_SELLER_TEAM_IDS = [11, 5, 25, 24, 17, 18, 19, 20, 21, 22, 16];
const AMAZON_ORDER_ID_REGEX = /^[0-9]{3}-[0-9]{7}-[0-9]{7}$/;

async function main() {
  console.log('=== VCS Cleanup v3: Focused on Missing VCS Numbers ===');
  console.log('Started:', new Date().toISOString());

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const db = mongo.db();

  // Build VCS index by invoice number
  console.log('Building VCS index by invoice number...');
  const vcsByInvoiceNumber = new Map();

  const cursor = db.collection('amazon_vcs_orders').find({});
  await cursor.forEach(doc => {
    if (doc.vatInvoiceNumber && doc.vatInvoiceNumber !== 'N/A') {
      vcsByInvoiceNumber.set(doc.vatInvoiceNumber, doc);
    }
  });
  console.log('VCS indexed:', vcsByInvoiceNumber.size);

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  let processed = 0;
  let updatedVcs = 0;
  let updatedRef = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches - fetch invoices where x_vcs_invoice_number is empty
  while (true) {
    const invoices = await odoo.searchRead('account.move',
      [
        ['move_type', '=', 'out_invoice'],
        ['invoice_date', '>=', DATE_FROM],
        ['team_id', 'in', AMAZON_SELLER_TEAM_IDS],
        '|', ['x_vcs_invoice_number', '=', false], ['x_vcs_invoice_number', '=', ''],
        ['ref', '!=', false]
      ],
      ['id', 'name', 'ref', 'invoice_origin'],
      { limit: 500 }
    );

    if (invoices.length === 0) break;

    for (const inv of invoices) {
      processed++;
      const currentRef = inv.ref || '';
      const origin = inv.invoice_origin || '';

      // Skip if ref is already Amazon order ID
      if (AMAZON_ORDER_ID_REGEX.test(currentRef)) {
        skipped++;
        continue;
      }

      // ref is VCS number - move it to x_vcs_invoice_number
      const updates = { x_vcs_invoice_number: currentRef };

      // Try to find Amazon order ID
      const vcs = vcsByInvoiceNumber.get(currentRef);
      if (vcs && vcs.orderId) {
        updates.ref = vcs.orderId;
      } else {
        // Try from invoice_origin
        const originMatch = origin.match(/[0-9]{3}-[0-9]{7}-[0-9]{7}/);
        if (originMatch) {
          updates.ref = originMatch[0];
        } else if (origin.startsWith('FBA') || origin.startsWith('FBM')) {
          const idPart = origin.substring(3);
          if (AMAZON_ORDER_ID_REGEX.test(idPart)) {
            updates.ref = idPart;
          }
        }
      }

      try {
        await odoo.write('account.move', [inv.id], updates);
        updatedVcs++;
        if (updates.ref && updates.ref !== currentRef) updatedRef++;
      } catch (e) {
        console.error('Error updating invoice', inv.id, ':', e.message);
        errors++;
      }

      if (processed % 1000 === 0) {
        console.log('Progress:', processed, '| VCS set:', updatedVcs, '| Ref updated:', updatedRef, '| Skip:', skipped);
      }
    }

    // Note: We don't increment offset since we filter by x_vcs_invoice_number = empty
    // After updating, those records won't match the filter anymore
    // So the next batch will get the next set of unprocessed records
  }

  console.log('\n=== CLEANUP COMPLETE ===');
  console.log('Total processed:', processed);
  console.log('VCS number set:', updatedVcs);
  console.log('Ref updated:', updatedRef);
  console.log('Skipped:', skipped);
  console.log('Errors:', errors);
  console.log('Finished:', new Date().toISOString());

  await mongo.close();
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
