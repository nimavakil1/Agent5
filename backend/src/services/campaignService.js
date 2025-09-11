const CampaignDefinition = require('../models/CampaignDefinition');
const ScheduledJob = require('../models/ScheduledJob');

async function getAllCampaigns() {
  return CampaignDefinition.find({}).sort({ createdAt: -1 }).lean();
}

async function createCampaign(data) {
  const doc = await CampaignDefinition.create(normalizeCampaignInput(data));
  // If schedule.start_at is in future, set status scheduled and enqueue start job
  if (doc.schedule?.start_at && new Date(doc.schedule.start_at) > new Date()) {
    await CampaignDefinition.findByIdAndUpdate(doc._id, { status: 'scheduled' });
    await ScheduledJob.create({ type: 'start_campaign', run_at: new Date(doc.schedule.start_at), payload: { campaignObjectId: doc._id.toString() } });
  }
  return doc;
}

async function updateCampaign(id, data) {
  const update = normalizeCampaignInput(data);
  const doc = await CampaignDefinition.findByIdAndUpdate(id, update, { new: true });
  return doc;
}

async function deleteCampaign(id) {
  await CampaignDefinition.findByIdAndDelete(id);
}

function normalizeCampaignInput(b = {}) {
  const out = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.description !== undefined) out.description = b.description;
  if (b.status !== undefined && ['draft','scheduled','running','paused','ended'].includes(b.status)) out.status = b.status;
  if (b.audience !== undefined) out.audience = b.audience;
  if (b.schedule !== undefined) out.schedule = b.schedule;
  if (b.dialer !== undefined) out.dialer = b.dialer;
  if (b.script_profile !== undefined) out.script_profile = b.script_profile;
  if (b.notes !== undefined) out.notes = b.notes;
  return out;
}

module.exports = { getAllCampaigns, createCampaign, updateCampaign, deleteCampaign };

