const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function audit() {
  const client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  const db = client.db('agent5');
  
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  
  const pending = await db.collection('seller_orders').find({
    fulfillmentChannel: 'MFN',
    'odoo.saleOrderId': { $ne: null },
    'odoo.trackingPushed': { $ne: true }
  }).toArray();
  
  console.log('Total pending:', pending.length);
  
  let correct = 0;
  let wrong = 0;
  let notShipped = 0;
  
  const wrongOrders = [];
  
  for (const order of pending) {
    const saleOrderId = order.odoo.saleOrderId;
    
    const odooOrders = await odoo.searchRead('sale.order',
      [['id', '=', saleOrderId]],
      ['id', 'name', 'state', 'picking_ids']
    );
    
    if (odooOrders.length === 0) {
      wrong++;
      wrongOrders.push({ amazon: order.amazonOrderId, issue: 'Odoo order not found' });
      continue;
    }
    
    const odooOrder = odooOrders[0];
    
    // Check if this is the right FBM order
    if (!odooOrder.name.includes(order.amazonOrderId)) {
      wrong++;
      wrongOrders.push({ 
        amazon: order.amazonOrderId, 
        odooName: odooOrder.name,
        odooId: saleOrderId,
        issue: 'Wrong order linked' 
      });
      continue;
    }
    
    // Check if shipped
    if (odooOrder.picking_ids && odooOrder.picking_ids.length > 0) {
      const pickings = await odoo.searchRead('stock.picking',
        [['id', 'in', odooOrder.picking_ids], ['state', '=', 'done']],
        ['id', 'carrier_tracking_ref']
      );
      if (pickings.length === 0) {
        notShipped++;
      } else if (pickings[0].carrier_tracking_ref) {
        correct++;
      } else {
        notShipped++;
      }
    } else {
      notShipped++;
    }
  }
  
  console.log('\n=== AUDIT RESULTS ===');
  console.log('Correct (shipped with tracking):', correct);
  console.log('Wrong order linked:', wrong);
  console.log('Not shipped/no tracking:', notShipped);
  
  if (wrongOrders.length > 0) {
    console.log('\n=== Wrong Order Links ===');
    for (const w of wrongOrders) {
      console.log(' ', w.amazon, '->', w.odooName, '(ID:', w.odooId + ')', '|', w.issue);
    }
  }
  
  await client.close();
}

audit().catch(console.error);
