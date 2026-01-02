require("dotenv").config();
const { OdooDirectClient } = require("../src/core/agents/integrations/OdooMCP");

// Mapping of wrong partners to correct B2C partners
const PARTNER_FIX_MAP = {
  3150: 234719, // Elisa Barbier → Amazon | AMZ_B2C_FR
  3146: 234720, // Gerstner → Amazon | AMZ_B2C_DE
};

async function fixWrongPartners() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log("Connected to Odoo\n");

  // Get the partner names for logging
  const partnerInfo = await odoo.searchRead("res.partner",
    [["id", "in", [3150, 3146, 234719, 234720]]],
    ["id", "name"]
  );
  const partnerNames = {};
  partnerInfo.forEach(p => partnerNames[p.id] = p.name);

  console.log("Partner mapping:");
  console.log(`  ${partnerNames[3150]} (3150) → ${partnerNames[234719]} (234719)`);
  console.log(`  ${partnerNames[3146]} (3146) → ${partnerNames[234720]} (234720)`);
  console.log("");

  let totalOrdersFixed = 0;
  let totalInvoicesFixed = 0;
  let totalDeliveriesFixed = 0;

  for (const [wrongId, correctId] of Object.entries(PARTNER_FIX_MAP)) {
    const wrongPartnerId = parseInt(wrongId);
    const correctPartnerId = correctId;

    console.log(`\n=== Fixing orders with partner ID ${wrongPartnerId} (${partnerNames[wrongPartnerId]}) ===`);

    // Find FBA orders with wrong partner
    const orders = await odoo.searchRead("sale.order",
      [["name", "like", "FBA%"], ["partner_id", "=", wrongPartnerId]],
      ["id", "name", "partner_id", "picking_ids", "invoice_ids"],
      500
    );

    console.log(`Found ${orders.length} FBA orders to fix`);

    for (const order of orders) {
      // Update sale order
      await odoo.write("sale.order", [order.id], {
        partner_id: correctPartnerId,
        partner_invoice_id: correctPartnerId,
        partner_shipping_id: correctPartnerId
      });
      totalOrdersFixed++;

      // Update related invoices
      if (order.invoice_ids && order.invoice_ids.length > 0) {
        await odoo.write("account.move", order.invoice_ids, {
          partner_id: correctPartnerId
        });
        totalInvoicesFixed += order.invoice_ids.length;
      }

      // Update related deliveries/pickings
      if (order.picking_ids && order.picking_ids.length > 0) {
        await odoo.write("stock.picking", order.picking_ids, {
          partner_id: correctPartnerId
        });
        totalDeliveriesFixed += order.picking_ids.length;
      }

      if (totalOrdersFixed % 25 === 0) {
        console.log(`  Progress: ${totalOrdersFixed} orders fixed...`);
      }
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Sale orders fixed: ${totalOrdersFixed}`);
  console.log(`Invoices fixed: ${totalInvoicesFixed}`);
  console.log(`Deliveries fixed: ${totalDeliveriesFixed}`);

  // Verify by checking if any remain
  console.log("\n=== VERIFICATION ===");
  for (const wrongId of Object.keys(PARTNER_FIX_MAP)) {
    const remaining = await odoo.searchRead("sale.order",
      [["name", "like", "FBA%"], ["partner_id", "=", parseInt(wrongId)]],
      ["id"],
      10
    );
    console.log(`FBA orders still with partner ${wrongId}: ${remaining.length}`);
  }
}

fixWrongPartners().catch(e => { console.error(e); process.exit(1); });
