#!/usr/bin/env node
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function check() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get order with ALL fields
  const orders = await odoo.searchRead("sale.order",
    [["client_order_ref", "=", "306-9691697-7865129"]],
    [] // empty = all fields
  );

  if (orders.length > 0) {
    const o = orders[0];
    console.log("=== Order:", o.name, "===\n");
    console.log("All fields containing 'address', 'street', or relevant partner info:\n");

    for (const [key, value] of Object.entries(o)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("address") ||
          lowerKey.includes("street") ||
          lowerKey.includes("city") ||
          lowerKey.includes("zip") ||
          lowerKey.includes("country") ||
          (lowerKey.includes("partner") && value)) {
        console.log(key, ":", JSON.stringify(value));
      }
    }
  }

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
