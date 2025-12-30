const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function examineOVHBill() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get one existing OVH bill with full details
  const bill = await odoo.searchRead('account.move',
    [['id', '=', 358792]],
    ['id', 'name', 'ref', 'partner_id', 'journal_id', 'currency_id', 'invoice_date', 'date', 'amount_total', 'amount_untaxed', 'amount_tax', 'state', 'invoice_line_ids']
  );

  console.log('=== OVH Bill Structure ===');
  console.log(JSON.stringify(bill[0], null, 2));

  // Get invoice lines
  if (bill[0].invoice_line_ids && bill[0].invoice_line_ids.length > 0) {
    const lines = await odoo.read('account.move.line', bill[0].invoice_line_ids,
      ['id', 'name', 'account_id', 'quantity', 'price_unit', 'price_subtotal', 'tax_ids', 'product_id', 'display_type']
    );

    console.log('\n=== Invoice Lines ===');
    lines.forEach(line => {
      if (line.display_type !== 'line_section' && line.display_type !== 'line_note') {
        console.log(JSON.stringify(line, null, 2));
      }
    });
  }

  // Get OVHcloud partner ID
  console.log('\n=== Partner Info ===');
  console.log('Partner ID:', bill[0].partner_id[0], '| Name:', bill[0].partner_id[1]);
  console.log('Journal ID:', bill[0].journal_id[0], '| Name:', bill[0].journal_id[1]);
}

examineOVHBill().catch(console.error);
