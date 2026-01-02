require("dotenv").config();
const { OdooDirectClient } = require("../src/core/agents/integrations/OdooMCP");
const { connectDb, getDb } = require("../src/db");

async function fixTodayInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  await connectDb();
  const db = getDb();

  console.log("=== Finding invoices created today ===\n");

  // Get date from 3 days ago to catch recent invoices
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const dateFilter = threeDaysAgo.toISOString().split("T")[0];

  // Find VCS invoices created recently (VFR/VDE prefix)
  console.log("Looking for invoices since:", dateFilter);
  const invoices = await odoo.searchRead("account.move",
    [
      ["move_type", "=", "out_invoice"],
      ["create_date", ">=", dateFilter],
      "|", ["name", "like", "VFR/%"], ["name", "like", "VDE/%"]
    ],
    ["id", "name", "partner_id", "invoice_origin", "ref"],
    200
  );

  console.log("VCS invoices created today:", invoices.length);

  // Get B2C partner cache
  const b2cPartnerCache = {};

  async function getB2CPartner(countryCode) {
    if (b2cPartnerCache[countryCode]) return b2cPartnerCache[countryCode];

    const partnerName = `Amazon | AMZ_B2C_${countryCode}`;
    const existing = await odoo.searchRead("res.partner", [["name", "=", partnerName]], ["id"]);

    if (existing.length > 0) {
      b2cPartnerCache[countryCode] = existing[0].id;
      return existing[0].id;
    }

    // Create if not exists
    const countries = await odoo.searchRead("res.country", [["code", "=", countryCode]], ["id"]);
    const countryId = countries.length > 0 ? countries[0].id : null;

    const partnerId = await odoo.create("res.partner", {
      name: partnerName,
      company_type: "company",
      is_company: true,
      customer_rank: 1,
      country_id: countryId,
      comment: `Generic Amazon B2C customer for ${countryCode}`
    });

    console.log("Created B2C partner:", partnerName, "ID:", partnerId);
    b2cPartnerCache[countryCode] = partnerId;
    return partnerId;
  }

  async function getB2BPartner(vatNumber, countryCode) {
    const cleanVat = vatNumber.trim().toUpperCase();

    const existing = await odoo.searchRead("res.partner", [["vat", "=", cleanVat]], ["id", "name"]);
    if (existing.length > 0) {
      return existing[0].id;
    }

    const countries = await odoo.searchRead("res.country", [["code", "=", countryCode]], ["id"]);
    const countryId = countries.length > 0 ? countries[0].id : null;

    const partnerName = `Amazon B2B | ${cleanVat}`;
    const partnerId = await odoo.create("res.partner", {
      name: partnerName,
      company_type: "company",
      is_company: true,
      customer_rank: 1,
      vat: cleanVat,
      country_id: countryId,
      comment: `Amazon B2B customer. VAT: ${cleanVat}`
    });

    console.log("Created B2B partner:", partnerName, "ID:", partnerId);
    return partnerId;
  }

  let updated = 0;
  let skipped = 0;
  let noVcsData = 0;
  let errors = 0;

  for (const inv of invoices) {
    try {
      // Get VCS order data from MongoDB using invoice_origin (Amazon order ID)
      const amazonOrderId = inv.invoice_origin;

      const vcsOrder = await db.collection("amazon_vcs_orders").findOne({
        orderId: amazonOrderId
      });

      if (!vcsOrder) {
        console.log("No VCS data for:", inv.name, "| Origin:", amazonOrderId);
        noVcsData++;
        continue;
      }

      // Determine correct partner from VCS data
      let correctPartnerId;
      const buyerVat = vcsOrder.buyerTaxRegistration;
      const shipToCountry = vcsOrder.shipToCountry || "BE";

      if (buyerVat && buyerVat.trim() !== "") {
        correctPartnerId = await getB2BPartner(buyerVat, shipToCountry);
      } else {
        correctPartnerId = await getB2CPartner(shipToCountry);
      }

      // Check if partner needs updating
      const currentPartnerId = inv.partner_id ? inv.partner_id[0] : null;
      if (currentPartnerId === correctPartnerId) {
        skipped++;
        continue; // Already correct
      }

      // Update invoice
      await odoo.write("account.move", [inv.id], { partner_id: correctPartnerId });
      updated++;

      const partnerInfo = buyerVat ? `B2B:${buyerVat}` : `B2C:${shipToCountry}`;
      console.log("Updated:", inv.name, "|", partnerInfo);

    } catch (err) {
      console.error("Error updating", inv.name, ":", err.message);
      errors++;
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log("Total invoices found:", invoices.length);
  console.log("Updated:", updated);
  console.log("Already correct:", skipped);
  console.log("No VCS data:", noVcsData);
  console.log("Errors:", errors);

  process.exit(0);
}

fixTodayInvoices().catch(e => { console.error(e); process.exit(1); });
