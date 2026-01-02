const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function compareAllFields() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get ALL fields from account.move model
  const fields = await odoo.execute("account.move", "fields_get", [], {});

  // Find fields related to attachment, pdf, document, file
  const relevantFields = Object.keys(fields).filter(f =>
    f.includes("attach") ||
    f.includes("pdf") ||
    f.includes("document") ||
    f.includes("file") ||
    f.includes("image") ||
    f.includes("binary")
  );

  console.log("=== Relevant fields on account.move ===");
  for (const f of relevantFields) {
    console.log(f, ":", fields[f].type);
  }

  // Now get these fields from both bills
  const fieldsToCheck = ["message_main_attachment_id", ...relevantFields];

  console.log("\n=== Working bill 352267 ===");
  const working = await odoo.searchRead("account.move", [["id", "=", 352267]], fieldsToCheck);
  for (const [key, value] of Object.entries(working[0])) {
    if (value !== false && value !== null && key !== "id") {
      console.log(key, ":", JSON.stringify(value));
    }
  }

  console.log("\n=== Non-working bill 359383 ===");
  const broken = await odoo.searchRead("account.move", [["id", "=", 359383]], fieldsToCheck);
  for (const [key, value] of Object.entries(broken[0])) {
    if (value !== false && value !== null && key !== "id") {
      console.log(key, ":", JSON.stringify(value));
    }
  }
}

compareAllFields().catch(console.error);
