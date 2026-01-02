require("dotenv").config();
const { OdooDirectClient } = require("../src/core/agents/integrations/OdooMCP");

const PARTNER_FIX_MAP = {
  3146: 234720, // Gerstner → Amazon | AMZ_B2C_DE
  3150: 234719, // Elisa Barbier → Amazon | AMZ_B2C_FR
};

async function fixAllInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log("Connected to Odoo\n");

  for (const [wrongId, correctId] of Object.entries(PARTNER_FIX_MAP)) {
    const wrongPartnerId = parseInt(wrongId);
    console.log(`\n=== Fixing invoices with partner ${wrongPartnerId} → ${correctId} ===`);

    let totalFixed = 0;
    let offset = 0;
    const batchSize = 100;

    while (true) {
      // Get batch of invoice IDs
      const invoices = await odoo.searchRead("account.move",
        [["partner_id", "=", wrongPartnerId], ["move_type", "=", "out_invoice"]],
        ["id"],
        batchSize, offset
      );

      if (invoices.length === 0) break;

      const invoiceIds = invoices.map(i => i.id);

      // Update this batch
      await odoo.write("account.move", invoiceIds, { partner_id: correctId });

      totalFixed += invoices.length;

      if (totalFixed % 1000 === 0) {
        console.log(`  Progress: ${totalFixed} invoices fixed...`);
      }

      // Move to next batch - but since we're changing the partner,
      // the next search will return different invoices at offset 0
      // So we don't increment offset, we just keep fetching from start

      if (invoices.length < batchSize) break;
    }

    console.log(`Completed: ${totalFixed} invoices fixed for partner ${wrongPartnerId}`);
  }

  // Verification
  console.log("\n=== VERIFICATION ===");
  let remaining3146 = 0, remaining3150 = 0;
  let offset = 0;
  while (true) {
    const batch = await odoo.searchRead("account.move",
      [["partner_id", "=", 3146], ["move_type", "=", "out_invoice"]],
      ["id"], 100, offset
    );
    if (batch.length === 0) break;
    remaining3146 += batch.length;
    offset += 100;
  }
  offset = 0;
  while (true) {
    const batch = await odoo.searchRead("account.move",
      [["partner_id", "=", 3150], ["move_type", "=", "out_invoice"]],
      ["id"], 100, offset
    );
    if (batch.length === 0) break;
    remaining3150 += batch.length;
    offset += 100;
  }

  console.log("Gerstner (3146) remaining:", remaining3146);
  console.log("Elisa (3150) remaining:", remaining3150);
}

fixAllInvoices().catch(e => { console.error(e); process.exit(1); });
