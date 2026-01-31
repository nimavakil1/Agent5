#!/usr/bin/env node
/**
 * Fix Italian Exception Invoices
 *
 * Phase 1: Create credit notes for wrong invoices (with SAME wrong settings)
 * Phase 2: Reset MongoDB status and create new correct invoices
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { VcsOdooInvoicer } = require('../src/services/amazon/VcsOdooInvoicer');
const { connectDb, getDb } = require('../src/db');

// Expected fiscal positions for Italian exceptions
const EXPECTED_FISCAL_POSITIONS = {
  'B2C domestic IT->IT': 'IT*OSS',
  'B2C cross-border': 'OSS', // destination country OSS
  'B2B cross-border': 'Intra-Community',
  'B2B domestic IT->IT': 'IT*OSS', // best effort
  'Export': null // 0% export
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const phase = args.includes('--phase2') ? 2 : 1;

  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Phase: ${phase}`);
  console.log('');

  await connectDb();
  const db = getDb();

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  if (phase === 1) {
    await phase1CreateCreditNotes(odoo, db, dryRun);
  } else {
    await phase2CreateCorrectInvoices(odoo, db, dryRun);
  }

  process.exit(0);
}

async function phase1CreateCreditNotes(odoo, db, dryRun) {
  console.log('=== PHASE 1: Create Credit Notes for Wrong Invoices ===\n');

  // Get Italian exception orders with wrong fiscal positions
  const wrongInvoices = await findWrongInvoices(odoo, db);

  console.log(`Found ${wrongInvoices.length} wrong invoices to reverse\n`);

  if (wrongInvoices.length === 0) {
    console.log('No wrong invoices found. Done.');
    return;
  }

  let created = 0;
  let failed = 0;

  for (const inv of wrongInvoices) {
    console.log(`Processing: ${inv.invoiceName} (Order: ${inv.orderId})`);
    console.log(`  Scenario: ${inv.scenario}`);
    console.log(`  Current fiscal position: ${inv.fiscalPosition}`);
    console.log(`  Invoice total: ${inv.amountTotal}`);

    if (dryRun) {
      console.log('  [DRY RUN] Would create credit note\n');
      continue;
    }

    try {
      // Create credit note using Odoo's reversal wizard
      const reversalResult = await odoo.execute('account.move', 'action_reverse', [[inv.invoiceId]]);

      // The action_reverse returns an action, we need to use the reversal wizard
      // Let's use a direct approach: create the reversal wizard and execute it
      const wizardId = await odoo.create('account.move.reversal', {
        move_ids: [[6, 0, [inv.invoiceId]]],
        reason: 'Correction: Wrong fiscal position for Italian exception order',
        refund_method: 'refund', // Create credit note only (don't reconcile)
        journal_id: inv.journalId
      });

      // Execute the wizard
      const wizardResult = await odoo.execute('account.move.reversal', 'reverse_moves', [[wizardId]]);

      // Get the created credit note
      if (wizardResult && wizardResult.res_id) {
        const creditNote = await odoo.searchRead('account.move',
          [['id', '=', wizardResult.res_id]],
          ['name', 'state']
        );
        if (creditNote.length > 0) {
          console.log(`  Created credit note: ${creditNote[0].name}`);

          // Post the credit note
          if (creditNote[0].state === 'draft') {
            await odoo.execute('account.move', 'action_post', [[wizardResult.res_id]]);
            console.log('  Posted credit note');
          }
          created++;
        }
      }
      console.log('');
    } catch (err) {
      console.log(`  ERROR: ${err.message}\n`);
      failed++;
    }
  }

  console.log('\n=== PHASE 1 SUMMARY ===');
  console.log(`Credit notes created: ${created}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total wrong invoices: ${wrongInvoices.length}`);
}

async function phase2CreateCorrectInvoices(odoo, db, dryRun) {
  console.log('=== PHASE 2: Create Correct Invoices ===\n');

  // Get Italian exception orders that had wrong invoices (and now have credit notes)
  const ordersToReinvoice = await findOrdersToReinvoice(odoo, db);

  console.log(`Found ${ordersToReinvoice.length} orders to reinvoice\n`);

  if (ordersToReinvoice.length === 0) {
    console.log('No orders to reinvoice. Done.');
    return;
  }

  // Reset MongoDB status for these orders
  console.log('Resetting MongoDB status...');
  const orderIds = ordersToReinvoice.map(o => o.orderId);

  if (!dryRun) {
    const resetResult = await db.collection('amazon_vcs_orders').updateMany(
      { orderId: { $in: orderIds } },
      {
        $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' },
        $set: { status: 'pending' }
      }
    );
    console.log(`Reset ${resetResult.modifiedCount} orders in MongoDB\n`);
  } else {
    console.log(`[DRY RUN] Would reset ${orderIds.length} orders\n`);
  }

  // Get MongoDB _ids for these orders
  const orders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: { orderId: { $in: orderIds } } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  const mongoIds = orders.map(o => o._id.toString());

  console.log(`Creating invoices for ${mongoIds.length} orders...\n`);

  if (dryRun) {
    console.log('[DRY RUN] Would create invoices with new Italian exception logic');
    return;
  }

  const invoicer = new VcsOdooInvoicer(odoo);
  await invoicer.loadCache();

  const result = await invoicer.createInvoices({
    orderIds: mongoIds,
    dryRun: false,
    logCallback: (level, msg) => console.log(`[${level}] ${msg}`)
  });

  console.log('\n=== PHASE 2 SUMMARY ===');
  console.log(`Invoices created: ${result.created || 0}`);
  console.log(`Failed: ${result.failed || 0}`);
}

async function findWrongInvoices(odoo, db) {
  const wrongInvoices = [];

  // Get Italian exception orders
  const italianOrders = await db.collection('amazon_vcs_orders').find({
    shipFromCountry: 'IT',
    isAmazonInvoiced: false,
    $or: [
      { vatInvoiceNumber: 'N/A' },
      { vatInvoiceNumber: { $exists: false } },
      { vatInvoiceNumber: null }
    ],
    odooInvoiceId: { $exists: true, $ne: null }
  }).toArray();

  console.log(`Checking ${italianOrders.length} Italian exception orders with invoices...\n`);

  for (const order of italianOrders) {
    // Determine expected scenario
    const isB2B = !!(order.buyerTaxRegistration && order.buyerTaxRegistration.trim());
    const isDomestic = order.shipToCountry === 'IT';
    const isExport = !['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'].includes(order.shipToCountry);

    let scenario, expectedFpPattern;
    if (isExport) {
      scenario = 'Export IT->' + order.shipToCountry;
      expectedFpPattern = null; // No fiscal position or BE export
    } else if (isB2B && !isDomestic) {
      scenario = 'B2B cross-border IT->' + order.shipToCountry;
      expectedFpPattern = 'Intra';
    } else if (isB2B && isDomestic) {
      scenario = 'B2B domestic IT->IT';
      expectedFpPattern = 'IT';
    } else if (isDomestic) {
      scenario = 'B2C domestic IT->IT';
      expectedFpPattern = 'IT';
    } else {
      scenario = 'B2C cross-border IT->' + order.shipToCountry;
      expectedFpPattern = order.shipToCountry;
    }

    // Get invoice from Odoo
    const invoices = await odoo.searchRead('account.move',
      [['id', '=', order.odooInvoiceId]],
      ['id', 'name', 'state', 'fiscal_position_id', 'amount_total', 'journal_id']
    );

    if (invoices.length === 0) continue;

    const inv = invoices[0];
    const fpName = inv.fiscal_position_id ? inv.fiscal_position_id[1] : 'None';

    // Check if fiscal position is wrong
    let isWrong = false;
    if (expectedFpPattern === null) {
      // Export: should have no FP or BE-related FP
      isWrong = inv.fiscal_position_id && !fpName.includes('BE') && fpName !== 'None';
    } else if (expectedFpPattern === 'Intra') {
      isWrong = !fpName.includes('Intra');
    } else {
      // Should contain the expected country pattern (e.g., IT*OSS, FR*OSS)
      isWrong = !fpName.includes(expectedFpPattern);
    }

    if (isWrong) {
      wrongInvoices.push({
        orderId: order.orderId,
        mongoId: order._id.toString(),
        invoiceId: inv.id,
        invoiceName: inv.name,
        fiscalPosition: fpName,
        expectedPattern: expectedFpPattern,
        scenario: scenario,
        amountTotal: inv.amount_total,
        journalId: inv.journal_id ? inv.journal_id[0] : null
      });
    }
  }

  return wrongInvoices;
}

async function findOrdersToReinvoice(odoo, db) {
  // Find orders that have credit notes (meaning they had wrong invoices that were reversed)
  // These orders should have their MongoDB status reset and be reinvoiced

  const italianOrders = await db.collection('amazon_vcs_orders').find({
    shipFromCountry: 'IT',
    isAmazonInvoiced: false,
    $or: [
      { vatInvoiceNumber: 'N/A' },
      { vatInvoiceNumber: { $exists: false } },
      { vatInvoiceNumber: null }
    ],
    odooInvoiceId: { $exists: true, $ne: null }
  }).toArray();

  const ordersToReinvoice = [];

  for (const order of italianOrders) {
    // Check if the original invoice has been credit noted
    const invoices = await odoo.searchRead('account.move',
      [['id', '=', order.odooInvoiceId]],
      ['id', 'name', 'payment_state', 'amount_residual']
    );

    if (invoices.length === 0) continue;

    const inv = invoices[0];

    // If payment_state is 'reversed' or amount_residual is 0 with credit notes
    // then we should reinvoice
    if (inv.payment_state === 'reversed' || inv.amount_residual === 0) {
      ordersToReinvoice.push({
        orderId: order.orderId,
        mongoId: order._id.toString(),
        invoiceName: inv.name
      });
    }
  }

  return ordersToReinvoice;
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
