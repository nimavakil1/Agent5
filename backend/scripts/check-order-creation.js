const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkOrderCreation() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get one of the problematic orders with full detail
  const orders = await odoo.searchRead('sale.order',
    [['name', '=', 'FBA407-3022234-5598706']],
    ['id', 'name', 'partner_id', 'create_date', 'create_uid', 'write_date', 'write_uid', 'note', 'client_order_ref', 'warehouse_id', 'team_id']
  );

  if (orders.length > 0) {
    const o = orders[0];
    console.log('=== Order Details ===');
    console.log('Name:', o.name);
    console.log('Partner:', o.partner_id ? o.partner_id[1] : 'N/A', '(ID:', o.partner_id?.[0], ')');
    console.log('Created:', o.create_date);
    console.log('Created By:', o.create_uid ? o.create_uid[1] : 'N/A');
    console.log('Write Date:', o.write_date);
    console.log('Write By:', o.write_uid ? o.write_uid[1] : 'N/A');
    console.log('Warehouse:', o.warehouse_id ? o.warehouse_id[1] : 'N/A');
    console.log('Team:', o.team_id ? o.team_id[1] : 'N/A');
    console.log('Note:', o.note?.substring(0, 200) || 'N/A');
  }

  // Check how many FBA orders were created on Dec 30
  const dec30Orders = await odoo.searchRead('sale.order',
    [['name', 'like', 'FBA%'], ['create_date', '>=', '2025-12-30 00:00:00'], ['create_date', '<', '2025-12-31 00:00:00']],
    ['id', 'name', 'partner_id'],
    500
  );

  console.log('\n=== FBA Orders Created Dec 30 ===');
  console.log('Total:', dec30Orders.length);

  // Group by partner
  const byPartner = {};
  for (const o of dec30Orders) {
    const p = o.partner_id ? o.partner_id[1] : 'N/A';
    if (!byPartner[p]) byPartner[p] = 0;
    byPartner[p]++;
  }

  console.log('\nGrouped by Partner:');
  Object.entries(byPartner).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([partner, count]) => {
    console.log('  ', count.toString().padStart(3), '|', partner.substring(0, 60));
  });
}

checkOrderCreation().catch(console.error);
