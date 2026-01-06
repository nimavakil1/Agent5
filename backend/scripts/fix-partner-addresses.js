/**
 * Fix partner addresses for specific Amazon orders
 * Updates the shipping addresses to have correct company parent
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Data from TSV - extracted the relevant fields for the 5 orders
const ordersToFix = [
  {
    amazonOrderId: "305-1244460-1353967",
    recipientName: "Mara Mueller",
    buyerCompanyName: "Farben Schultze GmbH & Co. KG",
    address1: "Farben Schultze GmbH & Co. KG Niederlassung CYA Gerichshain",
    address2: "Zweenfurther Straße 1",
    city: "Gerichshain",
    zip: "04827",
    country: "DE",
    isBusinessOrder: true
  },
  {
    amazonOrderId: "303-4731269-9593136",
    recipientName: "Peter Heinreich",
    buyerCompanyName: "Baumeister Peter Heinreich, Ing.",
    address1: "Waldgasse 2",
    address2: "",
    city: "Kobersdorf",
    zip: "7332",
    country: "AT",
    isBusinessOrder: true
  },
  {
    amazonOrderId: "402-7693526-1453954",
    recipientName: "Morteau Anaïs",
    buyerCompanyName: "",
    address1: "33, Boulevard Tisseron",
    address2: "Easy-delivery 411QVT",
    city: "Marseille",
    zip: "13014",
    country: "FR",
    isBusinessOrder: false
  },
  {
    amazonOrderId: "305-6598021-3249103",
    recipientName: "Lene Stahlberg",
    buyerCompanyName: "",
    address1: "Wilhelm Pieck Straße 39",
    address2: "",
    city: "Dreetz",
    zip: "16845",
    country: "DE",
    isBusinessOrder: false
  },
  {
    amazonOrderId: "302-5797176-8380350",
    recipientName: "Susanne Riedl",
    buyerCompanyName: "",
    address1: "Eichenstr 7",
    address2: "",
    city: "Hohenkammer",
    zip: "85411",
    country: "DE",
    isBusinessOrder: false
  }
];

async function fixOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log("Connected to Odoo\n");

  for (const order of ordersToFix) {
    console.log("=== Processing", order.amazonOrderId, "===");

    // Find the sale order by client_order_ref
    const saleOrders = await odoo.searchRead("sale.order",
      [["client_order_ref", "=", order.amazonOrderId]],
      ["id", "name", "partner_id", "partner_shipping_id"]
    );

    if (saleOrders.length === 0) {
      console.log("  Order not found in Odoo");
      continue;
    }

    const so = saleOrders[0];
    console.log("  Found:", so.name, "| Partner:", so.partner_id ? so.partner_id[1] : "none");

    // Get the shipping partner
    const shippingPartnerId = so.partner_shipping_id ? so.partner_shipping_id[0] : (so.partner_id ? so.partner_id[0] : null);
    if (!shippingPartnerId) {
      console.log("  No shipping partner found");
      continue;
    }

    // Get current partner details
    const partners = await odoo.searchRead("res.partner",
      [["id", "=", shippingPartnerId]],
      ["id", "name", "street", "street2", "city", "zip", "country_id", "parent_id"]
    );

    if (partners.length === 0) {
      console.log("  Shipping partner not found");
      continue;
    }

    const partner = partners[0];
    console.log("  Current partner:", partner.name);
    console.log("    Street:", partner.street);
    console.log("    Parent:", partner.parent_id ? partner.parent_id[1] : "(none)");

    // Determine what needs to be updated
    const needsCompanyUpdate = order.isBusinessOrder && order.buyerCompanyName && !partner.parent_id;

    if (needsCompanyUpdate) {
      console.log("  -> Needs company parent:", order.buyerCompanyName);

      // Find or create the parent company
      const companyName = order.buyerCompanyName;
      let parentCompany = await odoo.searchRead("res.partner",
        [["name", "=", companyName], ["is_company", "=", true]],
        ["id", "name"]
      );

      let parentId;
      if (parentCompany.length > 0) {
        parentId = parentCompany[0].id;
        console.log("  -> Found existing company:", parentId);
      } else {
        // Get country ID
        const countries = await odoo.searchRead("res.country",
          [["code", "=", order.country]],
          ["id"]
        );
        const countryId = countries.length > 0 ? countries[0].id : null;

        // Determine street - if address1 contains company name, use address2
        let street = order.address1;
        if (order.address1.includes(companyName.split(' ')[0])) {
          street = order.address2 || order.address1;
        }

        // Create company
        parentId = await odoo.create("res.partner", {
          name: companyName,
          is_company: true,
          company_type: "company",
          customer_rank: 1,
          street: street,
          city: order.city,
          zip: order.zip,
          country_id: countryId
        });
        console.log("  -> Created company:", parentId);
      }

      // Update the delivery contact to have the company as parent
      await odoo.write("res.partner", [shippingPartnerId], {
        parent_id: parentId,
        name: order.recipientName,
        type: "delivery"
      });
      console.log("  -> Updated partner with parent_id:", parentId);

    } else {
      console.log("  -> No company update needed (B2C or already has parent)");
    }

    console.log("");
  }

  console.log("Done!");
}

fixOrders().catch(console.error);
