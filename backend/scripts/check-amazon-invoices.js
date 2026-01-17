require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { MongoClient } = require('mongodb');

async function checkAmazonInvoices() {
  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();

  console.log('========================================');
  console.log('FINDING AMAZON INVOICES (Jan 10-15)');
  console.log('========================================\n');

  // Find invoices created Jan 10-15 with Amazon order pattern in ref
  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['create_date', '>=', '2026-01-10'],
      ['create_date', '<=', '2026-01-15 23:59:59'],
      ['ref', '!=', false]
    ],
    ['id', 'name', 'ref', 'invoice_origin', 'state', 'team_id', 'fiscal_position_id',
     'journal_id', 'partner_id', 'amount_total', 'invoice_date'],
    { limit: 1000 }
  );

  console.log('Total invoices found:', invoices.length);

  // Filter for Amazon order pattern (FBA or FBM followed by order ID)
  const amazonPattern = /^(FBA|FBM|F)?\d{3}-\d{7}-\d{7}/;
  const amazonInvoices = invoices.filter(inv => {
    const ref = inv.ref || '';
    return amazonPattern.test(ref);
  });

  console.log('Amazon invoices (matching pattern):', amazonInvoices.length);

  if (amazonInvoices.length === 0) {
    console.log('No Amazon invoices found. Checking ref patterns...');
    // Show sample refs
    const sampleRefs = invoices.slice(0, 20).map(i => i.ref);
    console.log('Sample refs:', sampleRefs);
    await mongoClient.close();
    return;
  }

  // Get existing fiscal positions and journals for reference
  const fiscalPositions = await odoo.searchRead('account.fiscal.position',
    [],
    ['id', 'name'],
    { limit: 100 }
  );
  const fpMap = {};
  for (const fp of fiscalPositions) {
    fpMap[fp.id] = fp.name;
  }

  const journals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id', 'name', 'code'],
    { limit: 50 }
  );
  const journalMap = {};
  for (const j of journals) {
    journalMap[j.id] = j.name;
  }

  // Get sales teams
  const teams = await odoo.searchRead('crm.team',
    [],
    ['id', 'name'],
    { limit: 50 }
  );
  const teamMap = {};
  for (const t of teams) {
    teamMap[t.id] = t.name;
  }

  console.log('\nAvailable Sales Teams:');
  for (const t of teams) {
    console.log('  ID:', t.id, '|', t.name);
  }

  console.log('\nAvailable Journals (sale):');
  for (const j of journals) {
    console.log('  ID:', j.id, '|', j.code, '|', j.name);
  }

  // Process each Amazon invoice
  console.log('\n========================================');
  console.log('CHECKING EACH INVOICE');
  console.log('========================================\n');

  const issues = [];
  let checkedCount = 0;

  for (const inv of amazonInvoices) {
    // Extract Amazon order ID from ref
    const ref = inv.ref || '';
    const orderIdMatch = ref.match(/\d{3}-\d{7}-\d{7}/);
    if (!orderIdMatch) continue;

    const amazonOrderId = orderIdMatch[0];
    checkedCount++;

    // Look up VCS data
    const vcsData = await db.collection('amazon_vcs_orders').findOne({
      orderId: amazonOrderId
    });

    const invoiceIssues = {
      invoiceId: inv.id,
      invoiceName: inv.name,
      invoiceRef: inv.ref,
      amazonOrderId,
      state: inv.state,
      amount: inv.amount_total,
      currentTeam: inv.team_id ? { id: inv.team_id[0], name: inv.team_id[1] } : null,
      currentFiscalPosition: inv.fiscal_position_id ? { id: inv.fiscal_position_id[0], name: inv.fiscal_position_id[1] } : null,
      currentJournal: inv.journal_id ? { id: inv.journal_id[0], name: inv.journal_id[1] } : null,
      vcsData: null,
      expectedTeam: null,
      expectedFiscalPosition: null,
      expectedJournal: null,
      teamMismatch: false,
      fiscalPositionMismatch: false,
      journalMismatch: false,
      taxIssues: []
    };

    if (vcsData) {
      invoiceIssues.vcsData = {
        marketplace: vcsData.marketplaceId,
        shipFromCountry: vcsData.shipFromCountry,
        shipToCountry: vcsData.shipToCountry,
        taxReportingScheme: vcsData.taxReportingScheme,
        currency: vcsData.currency
      };

      // Determine expected settings based on marketplace
      const marketplace = vcsData.marketplaceId;

      // Expected Sales Team (by marketplace)
      const teamMapping = {
        'DE': 'Amazon DE',
        'FR': 'Amazon FR',
        'GB': 'Amazon UK',
        'UK': 'Amazon UK',
        'IT': 'Amazon IT',
        'ES': 'Amazon ES',
        'NL': 'Amazon NL',
        'BE': 'Amazon BE',
        'PL': 'Amazon PL',
        'SE': 'Amazon SE'
      };
      invoiceIssues.expectedTeamName = teamMapping[marketplace] || `Amazon ${marketplace}`;

      // Check if current team matches expected
      const currentTeamName = inv.team_id ? inv.team_id[1] : '';
      if (!currentTeamName.includes(marketplace) &&
          !(marketplace === 'GB' && currentTeamName.includes('UK')) &&
          !(marketplace === 'UK' && currentTeamName.includes('UK'))) {
        invoiceIssues.teamMismatch = true;
      }

      // Determine expected fiscal position based on ship from/to
      const shipFrom = vcsData.shipFromCountry;
      const shipTo = vcsData.shipToCountry;

      // Simplified fiscal position logic
      if (shipFrom === shipTo) {
        // Domestic sale
        invoiceIssues.expectedFiscalPositionType = `${shipFrom}*VAT | Régime National`;
      } else if (['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'AT', 'CZ'].includes(shipFrom) &&
                 ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'AT', 'CZ'].includes(shipTo)) {
        // EU to EU - could be OSS or intra-community
        invoiceIssues.expectedFiscalPositionType = `${shipTo}*OSS | B2C ${shipTo}`;
      } else if (shipFrom === 'GB' || shipTo === 'GB') {
        // UK involved - export/import
        invoiceIssues.expectedFiscalPositionType = 'GB*VAT | Régime National or Export';
      }

      // Check fiscal position
      const currentFpName = inv.fiscal_position_id ? inv.fiscal_position_id[1] : '';
      if (invoiceIssues.expectedFiscalPositionType &&
          !currentFpName.includes(shipTo) &&
          !currentFpName.includes(shipFrom)) {
        invoiceIssues.fiscalPositionMismatch = true;
      }

    } else {
      invoiceIssues.vcsDataMissing = true;
    }

    // Get invoice lines and check taxes
    const invoiceLines = await odoo.searchRead('account.move.line',
      [['move_id', '=', inv.id], ['display_type', '=', 'product']],
      ['id', 'name', 'tax_ids', 'price_unit', 'quantity'],
      { limit: 50 }
    );

    for (const line of invoiceLines) {
      const taxNames = [];
      if (line.tax_ids && line.tax_ids.length > 0) {
        const taxes = await odoo.searchRead('account.tax',
          [['id', 'in', line.tax_ids]],
          ['id', 'name', 'amount']
        );
        for (const t of taxes) {
          taxNames.push(`${t.name} (${t.amount}%)`);
        }
      }
      invoiceIssues.taxIssues.push({
        lineId: line.id,
        lineName: line.name?.substring(0, 40),
        currentTaxes: taxNames.length > 0 ? taxNames : ['No tax']
      });
    }

    // Only add to issues list if there are problems
    if (invoiceIssues.teamMismatch || invoiceIssues.fiscalPositionMismatch ||
        invoiceIssues.journalMismatch || invoiceIssues.vcsDataMissing) {
      issues.push(invoiceIssues);
    }
  }

  await mongoClient.close();

  // Summary report
  console.log('========================================');
  console.log('SUMMARY REPORT');
  console.log('========================================\n');

  console.log('Total Amazon invoices checked:', checkedCount);
  console.log('Invoices with potential issues:', issues.length);

  // Group by issue type
  const teamIssues = issues.filter(i => i.teamMismatch);
  const fpIssues = issues.filter(i => i.fiscalPositionMismatch);
  const missingVcs = issues.filter(i => i.vcsDataMissing);

  console.log('\nIssue breakdown:');
  console.log('  Sales Team mismatch:', teamIssues.length);
  console.log('  Fiscal Position mismatch:', fpIssues.length);
  console.log('  Missing VCS data:', missingVcs.length);

  // Show details
  if (issues.length > 0) {
    console.log('\n========================================');
    console.log('DETAILED ISSUES (first 30)');
    console.log('========================================\n');

    for (const issue of issues.slice(0, 30)) {
      console.log('Invoice:', issue.invoiceName, '| Ref:', issue.invoiceRef);
      console.log('  Amazon Order:', issue.amazonOrderId, '| Amount:', issue.amount, '| State:', issue.state);

      if (issue.vcsData) {
        console.log('  VCS: Marketplace:', issue.vcsData.marketplace,
                    '| From:', issue.vcsData.shipFromCountry,
                    '| To:', issue.vcsData.shipToCountry);
        console.log('  Tax Scheme:', issue.vcsData.taxReportingScheme);
      } else {
        console.log('  VCS: NOT FOUND');
      }

      console.log('  Current Team:', issue.currentTeam?.name || 'None');
      console.log('  Expected Team:', issue.expectedTeamName || 'Unknown');
      console.log('  Team Mismatch:', issue.teamMismatch ? 'YES' : 'No');

      console.log('  Current Fiscal Position:', issue.currentFiscalPosition?.name || 'None');
      console.log('  Expected FP Type:', issue.expectedFiscalPositionType || 'Unknown');
      console.log('  FP Mismatch:', issue.fiscalPositionMismatch ? 'YES' : 'No');

      console.log('  Current Journal:', issue.currentJournal?.name || 'None');

      if (issue.taxIssues.length > 0) {
        console.log('  Line Taxes:');
        for (const tax of issue.taxIssues.slice(0, 3)) {
          console.log('    -', tax.currentTaxes.join(', '));
        }
      }
      console.log('');
    }
  }

  // Save full report
  const fs = require('fs');
  fs.writeFileSync('/tmp/amazon_invoice_check.json', JSON.stringify({
    summary: {
      totalChecked: checkedCount,
      issuesFound: issues.length,
      teamMismatches: teamIssues.length,
      fiscalPositionMismatches: fpIssues.length,
      missingVcsData: missingVcs.length
    },
    issues
  }, null, 2));
  console.log('\nFull report saved to /tmp/amazon_invoice_check.json');
}

checkAmazonInvoices().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
