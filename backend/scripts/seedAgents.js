#!/usr/bin/env node
require('dotenv').config();
const connectDB = require('../src/config/database');
const AgentProfile = require('../src/models/AgentProfile');

async function upsertAgent({ name, language, voice, instructions, mcp_service }) {
  const existing = await AgentProfile.findOne({ name }).lean();
  if (existing) {
    await AgentProfile.updateOne({ _id: existing._id }, { $set: { language, voice, instructions, mcp_service } });
    return { name, action: 'updated', id: String(existing._id) };
  } else {
    const doc = await AgentProfile.create({ name, kind: 'call', language, voice, instructions, mcp_service, updatedBy: 'seed' });
    return { name, action: 'created', id: String(doc._id) };
  }
}

async function main() {
  await connectDB();
  const defaults = [
    { name: process.env.SEED_AGENT_NL_NAME || 'Agent NL', language: 'nl', voice: process.env.SEED_AGENT_NL_VOICE || 'shimmer', instructions: process.env.SEED_AGENT_NL_INSTRUCTIONS || 'Gebruik Nederlands. Houd het gesprek kort en duidelijk.', mcp_service: process.env.SEED_AGENT_NL_MCP || '/api/mcp' },
    { name: process.env.SEED_AGENT_FR_NAME || 'Agent FR', language: 'fr', voice: process.env.SEED_AGENT_FR_VOICE || 'shimmer', instructions: process.env.SEED_AGENT_FR_INSTRUCTIONS || 'Parlez en français. Soyez concis et utile.', mcp_service: process.env.SEED_AGENT_FR_MCP || '/api/mcp' },
    { name: process.env.SEED_AGENT_FALLBACK_NAME || 'Agent XYZ', language: '', voice: process.env.SEED_AGENT_FALLBACK_VOICE || 'shimmer', instructions: process.env.SEED_AGENT_FALLBACK_INSTRUCTIONS || 'Start in English; detect caller language and confirm.', mcp_service: process.env.SEED_AGENT_FALLBACK_MCP || '/api/mcp' },
  ];
  const results = [];
  for (const a of defaults) results.push(await upsertAgent(a));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

