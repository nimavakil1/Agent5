require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== INVESTIGATING AMAZON ORDERS "TO INVOICE" ===\n');

  // Count Amazon orders to invoice (excluding recent ones)
  const cutoffDate = '2025-12-01'; // Orders before Dec 2025 should be invoiced

  const totalAmazon = await odoo.execute('sale.order', 'search_count', [
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBA%']
    ]
  ]);

  const totalAmazonFBM = await odoo.execute('sale.order', 'search_count', [
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBM%']
    ]
  ]);

  const amazonBeforeDec = await odoo.execute('sale.order', 'search_count', [
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBA%'],
      ['date_order', '<', cutoffDate]
    ]
  ]);

  const fbmBeforeDec = await odoo.execute('sale.order', 'search_count', [
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBM%'],
      ['date_order', '<', cutoffDate]
    ]
  ]);

  console.log('FBA orders "to invoice": ' + totalAmazon);
  console.log('FBM orders "to invoice": ' + totalAmazonFBM);
  console.log('Total Amazon: ' + (totalAmazon + totalAmazonFBM));
  console.log('');
  console.log('Orders BEFORE Dec 2025 (should be invoiced):');
  console.log('  FBA: ' + amazonBeforeDec);
  console.log('  FBM: ' + fbmBeforeDec);
  console.log('  Total: ' + (amazonBeforeDec + fbmBeforeDec));

  // Get sample of old orders and check their status
  console.log('\n\n=== ANALYZING OLD AMAZON ORDERS ===\n');

  const oldOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBA%'],
      ['date_order', '<', '2025-06-01']  // First half of 2025 and older
    ],
    ['id', 'name', 'date_order', 'amount_total', 'invoice_ids'],
    { limit: 100, order: 'date_order asc' }
  );

  console.log('Sample of oldest orders (before June 2025): ' + oldOrders.length + '\n');

  let noInvoice = 0;
  let hasInvoiceDraft = 0;
  let hasInvoicePosted = 0;
  let hasInvoiceNotLinked = 0;

  for (const order of oldOrders) {
    if (!order.invoice_ids || order.invoice_ids.length === 0) {
      noInvoice++;
    } else {
      // Has invoice - check state and linking
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', order.invoice_ids]],
        ['name', 'state']
      );
      
      const hasPosted = invoices.some(i => i.state === 'posted');
      const hasDraft = invoices.some(i => i.state === 'draft');
      
      if (hasPosted) hasInvoicePosted++;
      if (hasDraft && !hasPosted) hasInvoiceDraft++;

      // Check if lines are linked
      const lines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['qty_to_invoice', 'invoice_lines']
      );
      
      const unlinkedLines = lines.filter(l => l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0));
      if (unlinkedLines.length > 0) {
        hasInvoiceNotLinked++;
      }
    }
  }

  console.log('BREAKDOWN (sample of ' + oldOrders.length + ' orders):');
  console.log('  No invoice at all: ' + noInvoice + ' (' + Math.round(noInvoice/oldOrders.length*100) + '%)');
  console.log('  Has draft invoice only: ' + hasInvoiceDraft + ' (' + Math.round(hasInvoiceDraft/oldOrders.length*100) + '%)');
  console.log('  Has posted invoice: ' + hasInvoicePosted + ' (' + Math.round(hasInvoicePosted/oldOrders.length*100) + '%)');
  console.log('  Has invoice but lines not linked: ' + hasInvoiceNotLinked + ' (' + Math.round(hasInvoiceNotLinked/oldOrders.length*100) + '%)');

  // Check for duplicate orders (same Amazon order ID)
  console.log('\n\n=== CHECKING FOR DUPLICATE ORDERS ===\n');

  // Extract Amazon order IDs and check for duplicates
  const amazonIds = oldOrders.map(o => o.name.replace('FBA', ''));
  const duplicateCheck = {};
  for (const id of amazonIds) {
    duplicateCheck[id] = (duplicateCheck[id] || 0) + 1;
  }
  const duplicates = Object.entries(duplicateCheck).filter(([k, v]) => v > 1);
  
  console.log('Duplicate Amazon IDs in sample: ' + duplicates.length);
  if (duplicates.length > 0) {
    console.log('Examples: ' + duplicates.slice(0, 5).map(([k, v]) => k + ' (' + v + 'x)').join(', '));
  }

  // Check if there are multiple Odoo orders for same Amazon ID
  console.log('\n=== CHECKING FOR MULTIPLE ODOO ORDERS PER AMAZON ID ===\n');
  
  const sampleAmazonId = amazonIds[0];
  const ordersForSameId = await odoo.searchRead('sale.order',
    [['name', 'ilike', '%' + sampleAmazonId + '%']],
    ['id', 'name', 'state', 'invoice_status', 'date_order', 'invoice_ids']
  );
  
  console.log('Orders matching Amazon ID ' + sampleAmazonId + ':');
  for (const o of ordersForSameId) {
    console.log('  ' + o.name + ' (ID: ' + o.id + ') | state: ' + o.state + ' | invoice_status: ' + o.invoice_status + ' | invoices: ' + (o.invoice_ids || []).length);
  }
}

main().catch(e => console.error(e));
