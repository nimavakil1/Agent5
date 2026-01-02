const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkWrongOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get ALL FBA orders with Elisa Barbier
  const elisaOrders = await odoo.searchRead('sale.order',
    [['name', 'like', 'FBA%'], ['partner_id', '=', 3150]], // 3150 = Elisa Barbier
    ['id', 'name', 'create_date', 'create_uid', 'warehouse_id'],
    200, 0, 'create_date asc'
  );

  console.log('=== FBA Orders with Elisa Barbier (ID 3150) ===');
  console.log('Total:', elisaOrders.length);

  if (elisaOrders.length > 0) {
    console.log('\nFirst created:', elisaOrders[0].create_date, '|', elisaOrders[0].name);
    console.log('Last created:', elisaOrders[elisaOrders.length - 1].create_date, '|', elisaOrders[elisaOrders.length - 1].name);
    console.log('Created by:', elisaOrders[0].create_uid ? elisaOrders[0].create_uid[1] : 'N/A');
    console.log('Warehouse:', elisaOrders[0].warehouse_id ? elisaOrders[0].warehouse_id[1] : 'N/A');
  }

  // Group by create_date (day)
  const byDate = {};
  for (const o of elisaOrders) {
    const day = o.create_date.split(' ')[0];
    if (!byDate[day]) byDate[day] = 0;
    byDate[day]++;
  }
  console.log('\nBy creation date:');
  Object.entries(byDate).forEach(([date, count]) => {
    console.log('  ', date, ':', count);
  });

  // Get ALL FBA orders with Gerstner
  const gerstnerOrders = await odoo.searchRead('sale.order',
    [['name', 'like', 'FBA%'], ['partner_id', '=', 3146]], // 3146 = Gerstner
    ['id', 'name', 'create_date', 'create_uid', 'warehouse_id'],
    200, 0, 'create_date asc'
  );

  console.log('\n=== FBA Orders with Gerstner (ID 3146) ===');
  console.log('Total:', gerstnerOrders.length);

  if (gerstnerOrders.length > 0) {
    console.log('\nFirst created:', gerstnerOrders[0].create_date, '|', gerstnerOrders[0].name);
    console.log('Last created:', gerstnerOrders[gerstnerOrders.length - 1].create_date, '|', gerstnerOrders[gerstnerOrders.length - 1].name);
    console.log('Created by:', gerstnerOrders[0].create_uid ? gerstnerOrders[0].create_uid[1] : 'N/A');
  }

  // Group by create_date (day)
  const byDate2 = {};
  for (const o of gerstnerOrders) {
    const day = o.create_date.split(' ')[0];
    if (!byDate2[day]) byDate2[day] = 0;
    byDate2[day]++;
  }
  console.log('\nBy creation date:');
  Object.entries(byDate2).forEach(([date, count]) => {
    console.log('  ', date, ':', count);
  });

  // Check what those orders' client_order_ref looks like
  console.log('\n=== Sample Elisa Barbier Orders ===');
  for (const o of elisaOrders.slice(0, 5)) {
    const full = await odoo.searchRead('sale.order', [['id', '=', o.id]], ['client_order_ref', 'team_id', 'fiscal_position_id']);
    console.log(o.name, '| Ref:', full[0]?.client_order_ref, '| Team:', full[0]?.team_id?.[1], '| FP:', full[0]?.fiscal_position_id?.[1] || 'None');
  }
}

checkWrongOrders().catch(console.error);
