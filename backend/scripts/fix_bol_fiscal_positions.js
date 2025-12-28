require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const BolOrder = require('../src/models/BolOrder');
const mongoose = require('mongoose');

// Fiscal position mapping
const TAX_CONFIG = {
  'NL->NL': { fiscalPositionId: 42 },   // NL*VAT | Régime National (TxIn)
  'NL->BE': { fiscalPositionId: 40 },   // BE*OSS | B2C Belgium (TxIn)
  'BE->NL': { fiscalPositionId: 46 },   // NL*OSS | B2C Netherlands (TxIn)
  'BE->BE': { fiscalPositionId: 41 },   // BE*VAT | Régime National (TxIn)
};

async function fixFiscalPositions() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Find Bol orders in Odoo (FBR or FBB prefix)
  const bolOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['client_order_ref', '=like', 'FBR%'],
      ['client_order_ref', '=like', 'FBB%']
    ],
    ['id', 'name', 'client_order_ref', 'fiscal_position_id', 'partner_id', 'state'],
    { limit: 500 }
  );

  console.log(`Found ${bolOrders.length} Bol orders in Odoo`);

  // Filter orders without fiscal position
  const ordersToFix = bolOrders.filter(o => !o.fiscal_position_id);
  console.log(`Orders without fiscal position: ${ordersToFix.length}`);

  if (ordersToFix.length === 0) {
    console.log('All orders already have fiscal positions set!');
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  let errors = [];

  for (const order of ordersToFix) {
    try {
      // Get order ref (FBR123456 or FBB123456)
      const ref = order.client_order_ref;
      const prefix = ref.substring(0, 3);
      const bolOrderId = ref.substring(3);

      // Get destination country from MongoDB
      const bolOrder = await BolOrder.findOne({ orderId: bolOrderId }).lean();
      const destCountry = bolOrder?.shipmentDetails?.countryCode || 'NL';

      // Determine ship-from based on prefix
      const shipFrom = prefix === 'FBB' ? 'NL' : 'BE';
      const configKey = `${shipFrom}->${destCountry}`;
      const config = TAX_CONFIG[configKey] || TAX_CONFIG['BE->NL'];

      // Update the order
      await odoo.write('sale.order', [order.id], {
        fiscal_position_id: config.fiscalPositionId
      });

      updated++;
      console.log(`  [UPDATED] ${order.name} (${ref}): ${configKey} -> FP ${config.fiscalPositionId}`);

    } catch (err) {
      errors.push({ order: order.name, error: err.message });
      console.log(`  [ERROR] ${order.name}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`Done. Updated: ${updated}, Errors: ${errors.length}`);

  await mongoose.disconnect();
}

fixFiscalPositions().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
