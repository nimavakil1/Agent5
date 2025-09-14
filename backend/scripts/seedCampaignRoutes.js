#!/usr/bin/env node
require('dotenv').config();
const connectDB = require('../src/config/database');
const CampaignDefinition = require('../src/models/CampaignDefinition');

function parseArgs(argv) {
  const out = { routes: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' || a === '--campaign') out.id = argv[++i];
    else if (a === '--default') out.defaultAgent = argv[++i];
    else if (a === '--mcp') out.mcp = argv[++i];
    else if (a === '--route') {
      const v = argv[++i]; // format lang:Agent Name
      const idx = v.indexOf(':');
      if (idx > 0) out.routes.push({ lang: v.slice(0, idx), agent_profile: v.slice(idx + 1) });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error('Usage: node backend/scripts/seedCampaignRoutes.js --id <campaignId|campaign_id|name> --mcp /api/mcp --default "Agent XYZ" --route nl:"Agent NL" --route fr:"Agent FR"');
    process.exit(1);
  }
  await connectDB();
  const camp = await CampaignDefinition.findOne({ $or: [ { _id: args.id }, { campaign_id: args.id }, { name: args.id }, { title: args.id } ] });
  if (!camp) {
    console.error('Campaign not found:', args.id);
    process.exit(2);
  }
  const orchestrator = camp.orchestrator || {};
  if (args.mcp) orchestrator.mcp_service = args.mcp;
  if (args.defaultAgent) orchestrator.default_agent_profile = args.defaultAgent;
  if (args.routes && args.routes.length) orchestrator.language_routes = args.routes;
  camp.orchestrator = orchestrator;
  await camp.save();
  console.log(JSON.stringify({ ok: true, id: String(camp._id), orchestrator: orchestrator }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

