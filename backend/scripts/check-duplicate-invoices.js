require("dotenv").config();
const { connectDb, getDb } = require("../src/db");
const { OdooDirectClient } = require("../src/core/agents/integrations/OdooMCP");

async function checkDuplicateInvoices() {
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log("=== Checking December 2025 Amazon Orders for Duplicate Invoices ===\n");

  // Get Amazon orders from December 2025
  const startDate = new Date("2025-12-01");
  const endDate = new Date("2026-01-01");

  const amazonOrders = await db.collection("seller_orders").find({
    purchaseDate: { $gte: startDate, $lt: endDate }
  }).project({ amazonOrderId: 1, fulfillmentChannel: 1 }).toArray();

  console.log("Amazon orders in December 2025:", amazonOrders.length);

  // Check each order in Odoo
  const results = [];
  let checked = 0;
  let withMultipleInvoices = 0;

  for (const order of amazonOrders) {
    const amazonOrderId = order.amazonOrderId;
    const fbaName = `FBA${amazonOrderId}`;
    const fbmName = `FBM${amazonOrderId}`;

    // Search for Odoo orders by various fields
    const odooOrders = await odoo.searchRead("sale.order",
      ["|", "|", "|",
        ["name", "=", fbaName],
        ["name", "=", fbmName],
        ["client_order_ref", "=", amazonOrderId],
        ["amz_order_reference", "=", amazonOrderId]
      ],
      ["id", "name", "client_order_ref", "invoice_ids", "order_line"]
    );

    if (odooOrders.length === 0) {
      continue; // No Odoo order found
    }

    // Check invoices for each Odoo order
    for (const odooOrder of odooOrders) {
      const invoiceCount = odooOrder.invoice_ids ? odooOrder.invoice_ids.length : 0;

      if (invoiceCount > 1) {
        withMultipleInvoices++;

        // Get invoice details
        const invoices = await odoo.searchRead("account.move",
          [["id", "in", odooOrder.invoice_ids]],
          ["id", "name", "state", "amount_total", "invoice_date"]
        );

        results.push({
          amazonOrderId,
          odooOrderName: odooOrder.name,
          odooOrderId: odooOrder.id,
          invoiceCount,
          invoices: invoices.map(i => ({
            name: i.name,
            state: i.state,
            amount: i.amount_total,
            date: i.invoice_date
          }))
        });
      }
    }

    checked++;
    if (checked % 100 === 0) {
      console.log(`Checked ${checked}/${amazonOrders.length} orders...`);
    }
  }

  console.log("\n=== RESULTS ===");
  console.log("Total Amazon orders checked:", checked);
  console.log("Orders with multiple invoices:", withMultipleInvoices);

  if (results.length > 0) {
    console.log("\n=== ORDERS WITH MULTIPLE INVOICES ===\n");
    for (const r of results) {
      console.log(`Amazon: ${r.amazonOrderId} | Odoo: ${r.odooOrderName} | Invoices: ${r.invoiceCount}`);
      for (const inv of r.invoices) {
        console.log(`  - ${inv.name} | ${inv.state} | ${inv.amount} | ${inv.date}`);
      }
    }
  }

  // Also check for over-invoiced order lines
  console.log("\n=== Checking for Over-Invoiced Order Lines ===");

  const overInvoicedLines = await odoo.searchRead("sale.order.line",
    [["qty_invoiced", ">", 0]],
    ["id", "order_id", "product_id", "product_uom_qty", "qty_invoiced", "qty_delivered"],
    1000
  );

  let overInvoiced = 0;
  for (const line of overInvoicedLines) {
    if (line.qty_invoiced > line.product_uom_qty) {
      overInvoiced++;
      if (overInvoiced <= 20) {
        console.log(`Order: ${line.order_id[1]} | Product: ${line.product_id ? line.product_id[1].substring(0, 30) : 'N/A'} | Qty: ${line.product_uom_qty} | Invoiced: ${line.qty_invoiced}`);
      }
    }
  }

  console.log(`\nTotal over-invoiced lines found: ${overInvoiced}`);

  // Also check for duplicate invoice_origins
  console.log("\n=== Checking for Duplicate Invoice Origins ===");

  const allInvoices = await odoo.searchRead("account.move",
    [["move_type", "=", "out_invoice"], ["create_date", ">=", "2025-12-01"]],
    ["id", "name", "invoice_origin", "state", "amount_total"],
    2000
  );

  console.log("Total invoices since Dec 1:", allInvoices.length);

  // Group by invoice_origin
  const byOrigin = {};
  for (const inv of allInvoices) {
    const origin = inv.invoice_origin || "NO_ORIGIN";
    if (!byOrigin[origin]) byOrigin[origin] = [];
    byOrigin[origin].push(inv);
  }

  // Find duplicates (excluding NO_ORIGIN and false)
  const duplicates = Object.entries(byOrigin).filter(([k, v]) =>
    v.length > 1 && k !== "NO_ORIGIN" && k !== "false" && k.includes("-")
  );

  console.log("Origins with multiple invoices:", duplicates.length);

  if (duplicates.length > 0) {
    console.log("\n=== DUPLICATE ORIGINS ===");
    for (const [origin, invs] of duplicates.slice(0, 30)) {
      console.log("\nOrigin:", origin, "| Count:", invs.length);
      for (const inv of invs) {
        console.log("  ", inv.name, "|", inv.state, "|", inv.amount_total);
      }
    }
  }

  process.exit(0);
}

checkDuplicateInvoices().catch(e => { console.error(e); process.exit(1); });
