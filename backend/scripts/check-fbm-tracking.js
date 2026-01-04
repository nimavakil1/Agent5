const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function check() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log("Fetching FBM orders from Odoo...");

  const fbmOrders = await odoo.searchRead("sale.order",
    [["name", "like", "FBM%"]],
    ["id", "name", "client_order_ref", "picking_ids", "state"],
    { limit: 500 }
  );

  console.log("Total FBM orders in Odoo:", fbmOrders.length);

  const allPickingIds = [];
  for (const o of fbmOrders) {
    if (o.picking_ids && o.picking_ids.length > 0) {
      allPickingIds.push(...o.picking_ids);
    }
  }

  console.log("Total deliveries to check:", allPickingIds.length);

  const deliveries = await odoo.searchRead("stock.picking",
    [["id", "in", allPickingIds]],
    ["id", "name", "origin", "state", "carrier_tracking_ref", "carrier_id"],
    { limit: 1000 }
  );

  const done = deliveries.filter(d => d.state === "done");
  const doneWithTracking = done.filter(d => d.carrier_tracking_ref && d.carrier_tracking_ref.trim() !== "");
  const doneNoTracking = done.filter(d => !d.carrier_tracking_ref || d.carrier_tracking_ref.trim() === "");

  console.log("\n=== FBM Delivery Statistics ===");
  console.log("Total deliveries:", deliveries.length);
  console.log("Done (shipped):", done.length);
  console.log("Done WITH tracking:", doneWithTracking.length);
  console.log("Done WITHOUT tracking:", doneNoTracking.length);

  if (doneNoTracking.length > 0) {
    console.log("\n=== Done deliveries WITHOUT tracking (first 15) ===");
    for (const d of doneNoTracking.slice(0, 15)) {
      const carrier = d.carrier_id ? d.carrier_id[1] : "(no carrier)";
      console.log(" ", d.name, "|", d.origin, "|", carrier);
    }
  }

  console.log("\n=== Done deliveries WITH tracking (last 10) ===");
  for (const d of doneWithTracking.slice(-10)) {
    const carrier = d.carrier_id ? d.carrier_id[1] : "(no carrier)";
    console.log(" ", d.name, "|", d.origin, "| Tracking:", d.carrier_tracking_ref, "|", carrier);
  }
}

check().catch(console.error);
