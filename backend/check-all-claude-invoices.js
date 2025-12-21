/**
 * Check ALL records created by Claude AI in account.move (all types, all states)
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function check() {
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Find Claude AI user
  const users = await odoo.searchRead('res.users',
    [['name', 'ilike', 'Claude']],
    ['id', 'name']
  );
  const claudeUserId = users[0].id;
  console.log(`Claude AI user ID: ${claudeUserId}`);

  // Get ALL records by Claude AI in account.move (no move_type filter)
  const allMoves = await odoo.searchRead('account.move',
    [['create_uid', '=', claudeUserId]],
    ['id', 'name', 'move_type', 'state', 'invoice_origin', 'create_date'],
    0, 0
  );

  console.log(`\nTotal account.move records by Claude AI: ${allMoves.length}`);

  // Group by move_type
  const byType = {};
  for (const m of allMoves) {
    const type = m.move_type || 'unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(m);
  }

  console.log('\n=== By move_type ===');
  for (const [type, moves] of Object.entries(byType)) {
    console.log(`  ${type}: ${moves.length}`);
  }

  // Group by state
  const byState = {};
  for (const m of allMoves) {
    const state = m.state || 'unknown';
    if (!byState[state]) byState[state] = [];
    byState[state].push(m);
  }

  console.log('\n=== By state ===');
  for (const [state, moves] of Object.entries(byState)) {
    console.log(`  ${state}: ${moves.length}`);
  }

  // Group by create_date month
  const byMonth = {};
  for (const m of allMoves) {
    const month = m.create_date ? m.create_date.substring(0, 7) : 'unknown';
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(m);
  }

  console.log('\n=== By create_date month ===');
  for (const [month, moves] of Object.entries(byMonth).sort()) {
    console.log(`  ${month}: ${moves.length}`);
  }

  // Check out_invoice specifically
  const outInvoices = allMoves.filter(m => m.move_type === 'out_invoice');
  console.log(`\n=== out_invoice details ===`);
  console.log(`Total out_invoice: ${outInvoices.length}`);

  // Count how many have FBA/FBM origin
  const withAmazonOrigin = outInvoices.filter(m => m.invoice_origin && (m.invoice_origin.startsWith('FBA') || m.invoice_origin.startsWith('FBM')));
  console.log(`With FBA/FBM origin: ${withAmazonOrigin.length}`);

  // Show a few without FBA/FBM origin
  const withoutAmazonOrigin = outInvoices.filter(m => !m.invoice_origin || (!m.invoice_origin.startsWith('FBA') && !m.invoice_origin.startsWith('FBM')));
  if (withoutAmazonOrigin.length > 0) {
    console.log(`\nInvoices without FBA/FBM origin (${withoutAmazonOrigin.length}):`);
    for (const inv of withoutAmazonOrigin.slice(0, 20)) {
      console.log(`  ID: ${inv.id}, Name: ${inv.name}, Origin: ${inv.invoice_origin}, State: ${inv.state}`);
    }
  }
}

check().catch(console.error);
