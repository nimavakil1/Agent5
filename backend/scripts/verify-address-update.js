#!/usr/bin/env node
/**
 * Verify address updates in Odoo
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function verify() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const checkOrders = [
    "306-9691697-7865129",  // Besseler
    "303-6169907-9157169",  // Block Bauzäune
    "304-0991639-1563523",  // Saner Devrim
    "302-2817393-8507509"   // Trucker for Kids
  ];

  console.log("=== Verifying Updated Partners in Odoo ===\n");

  for (const ref of checkOrders) {
    const orders = await odoo.searchRead("sale.order",
      [["client_order_ref", "=", ref]],
      ["id", "name", "partner_shipping_id"]
    );

    if (orders.length === 0) continue;

    const shippingId = orders[0].partner_shipping_id && orders[0].partner_shipping_id[0];
    if (!shippingId) continue;

    const partners = await odoo.searchRead("res.partner",
      [["id", "=", shippingId]],
      ["id", "name", "street", "street2", "city", "zip", "country_id"]
    );

    if (partners.length === 0) continue;
    const p = partners[0];

    console.log("Order:", ref);
    console.log("  name:   ", p.name);
    console.log("  street: ", p.street);
    console.log("  street2:", p.street2 || "(none)");
    console.log("  city:   ", p.city, p.zip);
    console.log("");
  }

  process.exit(0);
}

verify().catch(e => { console.error(e); process.exit(1); });
