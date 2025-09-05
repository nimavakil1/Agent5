let instructions = process.env.OPENAI_AGENT_INSTRUCTIONS || 'You are a helpful AI assistant for a call center.';
let voice = process.env.OPENAI_AGENT_VOICE || '';

function getSettings() {
  return { instructions, voice };
}

function setSettings(next) {
  if (typeof next.instructions === 'string') instructions = next.instructions;
  if (typeof next.voice === 'string') voice = next.voice;
}

module.exports = { getSettings, setSettings };

