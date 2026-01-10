require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  console.log('=== CHECKING VCS DATA FOR ORDERS WITHOUT INVOICES ===\n');

  const amazonOrderIds = [
    '404-8183028-7922726',
    '407-4474253-5502743',
    '028-8803988-3124331',
    '408-8951629-2289137',
    '028-8581618-1132350'
  ];

  console.log('Checking ' + amazonOrderIds.length + ' Amazon order IDs in unified_orders...\n');

  const unifiedOrders = mongoose.connection.collection('unified_orders');

  for (const orderId of amazonOrderIds) {
    const order = await unifiedOrders.findOne({
      $or: [
        { 'amazonOrderId': orderId },
        { 'amazonSeller.orderRef': orderId },
        { 'sourceIds.amazonOrderId': orderId }
      ]
    });

    if (order) {
      console.log('FOUND: ' + orderId);
      console.log('  Has VCS data: ' + (order.vcsData ? 'YES' : 'NO'));
      if (order.vcsData) {
        console.log('  VCS invoice: ' + (order.vcsData.vatInvoiceNumber || 'N/A'));
      }
      console.log('  Odoo SO ID: ' + (order.sourceIds?.odooSaleOrderId || 'NONE'));
      console.log('  Odoo Invoice ID: ' + (order.sourceIds?.odooInvoiceId || 'NONE'));
    } else {
      console.log('NOT IN UNIFIED_ORDERS: ' + orderId);
    }
    console.log('');
  }

  // Stats
  console.log('\n=== VCS DATA STATISTICS ===\n');
  
  const totalWithVcs = await unifiedOrders.countDocuments({
    'vcsData': { $exists: true, $ne: null }
  });
  
  const vcsWithOdooInvoice = await unifiedOrders.countDocuments({
    'vcsData': { $exists: true, $ne: null },
    'sourceIds.odooInvoiceId': { $exists: true, $ne: null }
  });

  const vcsWithoutOdooInvoice = totalWithVcs - vcsWithOdooInvoice;

  console.log('Total orders with VCS data: ' + totalWithVcs);
  console.log('VCS orders WITH Odoo invoice linked: ' + vcsWithOdooInvoice);
  console.log('VCS orders WITHOUT Odoo invoice: ' + vcsWithoutOdooInvoice);

  // Sample without Odoo invoice
  console.log('\n=== SAMPLE VCS WITHOUT ODOO INVOICE ===\n');
  
  const samples = await unifiedOrders.find({
    'vcsData': { $exists: true, $ne: null },
    'sourceIds.odooInvoiceId': { $exists: false }
  }).limit(5).toArray();

  for (const s of samples) {
    console.log('Order: ' + (s.amazonSeller?.orderRef || s.amazonOrderId || 'N/A'));
    console.log('  VCS Invoice: ' + (s.vcsData?.vatInvoiceNumber || 'N/A'));
    console.log('  Odoo SO: ' + (s.sourceIds?.odooSaleOrderId || 'NONE'));
    console.log('');
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
