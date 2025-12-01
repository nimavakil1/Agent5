/**
 * Platform Modules
 *
 * Export all available platform modules
 */

const VoiceModule = require('./VoiceModule');
const { AgentModule } = require('../agents');

module.exports = {
  VoiceModule,
  AgentModule,
};
