#!/usr/bin/env node
require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

// The invoices that were found as "already existing"
const FOUND_INVOICES = [
  { amazonOrderId: '402-1160083-6363529', foundInvoice: 'VBE/2025/12/02177', odooOrder: 'FBM402-1160083-6363529' },
  { amazonOrderId: '405-7031124-1753168', foundInvoice: 'VBE/2025/12/02183', odooOrder: 'FBM405-7031124-1753168' },
  { amazonOrderId: '407-6214261-6623568', foundInvoice: 'VBE/2025/12/02185', odooOrder: 'FBM407-6214261-6623568' },
  { amazonOrderId: '404-3134498-6558767', foundInvoice: 'VBE/2025/12/02182', odooOrder: 'FBM404-3134498-6558767' },
  { amazonOrderId: '402-3394787-4841132', foundInvoice: 'VOS/2025/12/03696', odooOrder: 'FBM402-3394787-4841132' },
  { amazonOrderId: '408-7203120-7093146', foundInvoice: 'VOS/2025/12/03757', odooOrder: 'FBM408-7203120-7093146' },
  { amazonOrderId: '403-4696052-1501900', foundInvoice: 'VOS/2025/12/03709', odooOrder: 'FBM403-4696052-1501900' },
  { amazonOrderId: '403-4652236-2349159', foundInvoice: 'VOS/2025/12/03708', odooOrder: 'FBM403-4652236-2349159' },
];

// The wrong invoices we reversed
const REVERSED_INVOICES = [
  { invoiceId: 360101, invoiceName: 'VOS/2025/12/03508', amazonOrderId: '402-1160083-6363529' },
  { invoiceId: 360103, invoiceName: 'VOS/2025/12/03519', amazonOrderId: '405-7031124-1753168' },
  { invoiceId: 360248, invoiceName: 'VOS/2025/12/03607', amazonOrderId: '303-7993887-6359566' },
  { invoiceId: 360254, invoiceName: 'VBE/2025/12/02184', amazonOrderId: '407-6214261-6623568' },
  { invoiceId: 360255, invoiceName: 'VBE/2025/12/02181', amazonOrderId: '404-3134498-6558767' },
  { invoiceId: 360258, invoiceName: 'VOS/2025/12/03696', amazonOrderId: '402-3394787-4841132' },
  { invoiceId: 360261, invoiceName: 'VOS/2025/12/03757', amazonOrderId: '408-7203120-7093146' },
  { invoiceId: 360262, invoiceName: 'VOS/2025/12/03709', amazonOrderId: '403-4696052-1501900' },
  { invoiceId: 360264, invoiceName: 'VOS/2025/12/03708', amazonOrderId: '403-4652236-2349159' },
];

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(80));
  console.log('CHECKING EXISTING INVOICES FOR THE 9 AMAZON ORDERS');
  console.log('='.repeat(80));

  for (const item of FOUND_INVOICES) {
    console.log(`\n--- Amazon Order: ${item.amazonOrderId} ---`);
    console.log(`Expected FBM Order: ${item.odooOrder}`);
    console.log(`Invoice found: ${item.foundInvoice}`);

    // Check what the reversed invoice was for this Amazon order
    const reversed = REVERSED_INVOICES.find(r => r.amazonOrderId === item.amazonOrderId);
    if (reversed) {
      console.log(`Reversed invoice: ${reversed.invoiceName} (ID: ${reversed.invoiceId})`);

      // Check if same or different
      if (reversed.invoiceName === item.foundInvoice) {
        console.log(`⚠️  SAME INVOICE! The reversed invoice is being detected.`);
      } else {
        console.log(`✓ Different invoices (good - might be correct invoice already exists)`);
      }
    }

    // Get details of the found invoice
    const invoices = await odoo.searchRead('account.move',
      [['name', '=', item.foundInvoice]],
      ['id', 'name', 'state', 'invoice_origin', 'ref', 'amount_total', 'partner_id', 'reversed_entry_id']
    );

    if (invoices.length > 0) {
      const inv = invoices[0];
      console.log(`\nInvoice details for ${item.foundInvoice}:`);
      console.log(`  ID: ${inv.id}`);
      console.log(`  State: ${inv.state}`);
      console.log(`  Amount: ${inv.amount_total}`);
      console.log(`  invoice_origin: ${inv.invoice_origin || '(empty)'}`);
      console.log(`  ref: ${inv.ref || '(empty)'}`);
      console.log(`  Partner: ${inv.partner_id ? inv.partner_id[1] : '(none)'}`);
      console.log(`  Reversed: ${inv.reversed_entry_id ? inv.reversed_entry_id[1] : 'No'}`);
    } else {
      console.log(`Invoice ${item.foundInvoice} NOT FOUND in Odoo!`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

main().catch(console.error);
