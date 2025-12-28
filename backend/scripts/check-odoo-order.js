/**
 * Check Odoo lookup values
 * Usage: node scripts/check-odoo-order.js [orderId]
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const orderId = process.argv[2];

  try {
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Check country IDs for NL, BE, DE, FR
    console.log('=== Country IDs ===');
    const countries = await odoo.searchRead('res.country',
      [['code', 'in', ['NL', 'BE', 'DE', 'FR', 'NO']]],
      ['id', 'code', 'name']
    );
    countries.forEach(c => console.log(`  ${c.code}: ${c.id} (${c.name})`));

    // Check sales teams
    console.log('\n=== Sales Teams ===');
    const teams = await odoo.searchRead('crm.team',
      [],
      ['id', 'name']
    );
    teams.forEach(t => console.log(`  ${t.id}: ${t.name}`));

    // Check journals with INV in code
    console.log('\n=== Invoice Journals ===');
    const journals = await odoo.searchRead('account.journal',
      [['type', '=', 'sale']],
      ['id', 'code', 'name']
    );
    journals.forEach(j => console.log(`  ${j.id}: ${j.code} - ${j.name}`));

    // If orderId provided, show order details
    if (orderId) {
      console.log('\n=== Order Details ===');
      const orders = await odoo.searchRead('sale.order', [['id', '=', parseInt(orderId)]],
        ['name', 'client_order_ref', 'partner_id', 'team_id', 'journal_id', 'state']
      );
      if (orders.length > 0) {
        console.log(JSON.stringify(orders[0], null, 2));

        // Get partner country
        const partner = await odoo.searchRead('res.partner', [['id', '=', orders[0].partner_id[0]]],
          ['name', 'country_id']
        );
        console.log('\nPartner country:', partner[0]?.country_id);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
