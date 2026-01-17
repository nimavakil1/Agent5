require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixLastInvoice() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find the invoice for order 028-1515191-7300310
  const invoices = await odoo.searchRead('account.move',
    [['ref', 'like', '028-1515191-7300310']],
    ['id', 'name', 'ref', 'state', 'team_id', 'fiscal_position_id'],
    { limit: 5 }
  );

  console.log('Found invoices:', invoices.length);

  if (invoices.length === 0) {
    console.log('No invoice found');
    return;
  }

  // Get Amazon DE team
  const teams = await odoo.searchRead('crm.team',
    [['name', 'like', 'Amazon DE']],
    ['id', 'name'],
    { limit: 5 }
  );
  const amazonDeTeam = teams[0];
  console.log('Amazon DE team:', amazonDeTeam);

  // Get DE domestic fiscal position
  const fps = await odoo.searchRead('account.fiscal.position',
    [['name', 'like', 'DE*VAT']],
    ['id', 'name'],
    { limit: 10 }
  );
  console.log('DE fiscal positions:', fps.map(f => f.name));

  // Find the domestic one
  const deDomesticFp = fps.find(f => f.name.includes('National') || f.name.includes('Extra'));
  console.log('Using FP:', deDomesticFp);

  for (const inv of invoices) {
    console.log('\nProcessing:', inv.name, '|', inv.ref);
    console.log('  Current team:', inv.team_id ? inv.team_id[1] : 'None');
    console.log('  Current FP:', inv.fiscal_position_id ? inv.fiscal_position_id[1] : 'None');

    const isPosted = inv.state === 'posted';

    try {
      // Reset to draft if posted
      if (isPosted) {
        try {
          await odoo.execute('account.move', 'button_draft', [[inv.id]]);
        } catch (e) {
          if (e.message.indexOf('cannot marshal None') === -1) throw e;
        }
        console.log('  -> Reset to draft');
      }

      // Update
      await odoo.write('account.move', [inv.id], {
        team_id: amazonDeTeam.id,
        fiscal_position_id: deDomesticFp.id
      });
      console.log('  -> Updated: Team = Amazon DE, FP = DE domestic');

      // Repost
      if (isPosted) {
        try {
          await odoo.execute('account.move', 'action_post', [[inv.id]]);
        } catch (e) {
          if (e.message.indexOf('cannot marshal None') === -1) throw e;
        }
        console.log('  -> Reposted');
      }

      console.log('  SUCCESS');
    } catch (error) {
      console.log('  ERROR:', error.message);
    }
  }
}

fixLastInvoice().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
