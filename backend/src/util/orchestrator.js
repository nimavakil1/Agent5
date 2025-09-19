const AgentProfile = require('../models/AgentProfile');
const CampaignDefinition = require('../models/CampaignDefinition');

async function resolveAgentAndMcp({ campaignId, detectedLanguage }) {
  let campaign = null;
  if (campaignId) {
    try {
      // Try to find campaign by different fields, handle ObjectId validation gracefully
      const query = { $or: [{ campaign_id: campaignId }, { name: campaignId }] };
      
      // Only add ObjectId lookup if campaignId looks like a valid ObjectId
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(campaignId)) {
        query.$or.unshift({ _id: campaignId });
      }
      
      campaign = await CampaignDefinition.findOne(query).lean();
    } catch (error) {
      console.warn(`PSTN: Campaign lookup failed for "${campaignId}":`, error.message);
      campaign = null;
    }
  }
  let mcp = campaign?.orchestrator?.mcp_service || '';
  let agentName = '';
  const lang = String(detectedLanguage || '').toLowerCase();
  if (campaign?.orchestrator?.language_routes && lang) {
    const hit = campaign.orchestrator.language_routes.find((r) => String(r.lang || '').toLowerCase() === lang);
    if (hit) agentName = hit.agent_profile;
  }
  if (!agentName && campaign?.orchestrator?.default_agent_profile) agentName = campaign.orchestrator.default_agent_profile;
  if (!agentName && lang) {
    const ap = await AgentProfile.findOne({ language: lang }).lean();
    if (ap) agentName = ap.name;
  }
  const agent = agentName ? await AgentProfile.findOne({ name: agentName }).lean() : null;
  return { agent, mcp_service: agent?.mcp_service || mcp || '' };
}

module.exports = { resolveAgentAndMcp };

