const AgentSettings = require('../models/AgentSettings');

const DEFAULTS = {
  instructions: process.env.OPENAI_AGENT_INSTRUCTIONS || 'You are a helpful AI assistant for a call center.',
  voice: process.env.OPENAI_AGENT_VOICE || '',
};

async function getSettings() {
  try {
    const doc = await AgentSettings.findOne({ key: 'default' }).lean();
    if (!doc) return { ...DEFAULTS };
    return { instructions: doc.instructions || DEFAULTS.instructions, voice: doc.voice || DEFAULTS.voice };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

async function setSettings(next, updatedBy = 'admin') {
  const toSet = {};
  if (typeof next.instructions === 'string') toSet.instructions = next.instructions;
  if (typeof next.voice === 'string') toSet.voice = next.voice;
  if (Object.keys(toSet).length === 0) return getSettings();
  await AgentSettings.findOneAndUpdate(
    { key: 'default' },
    { $set: { ...toSet, updatedBy } },
    { upsert: true, new: true }
  );
  return getSettings();
}

module.exports = { getSettings, setSettings };
