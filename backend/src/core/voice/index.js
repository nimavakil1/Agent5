/**
 * Voice Module - Main Export
 *
 * Exports all voice-related components for the platform
 */

const { VoiceProvider, STTProvider, TTSProvider, VoiceToVoiceProvider } = require('./VoiceProvider');
const { VoicePipelineManager, getVoicePipelineManager } = require('./VoicePipelineManager');
const OpenAIRealtimeProvider = require('./providers/OpenAIRealtimeProvider');
const DeepgramSTTProvider = require('./providers/DeepgramSTTProvider');
const ElevenLabsTTSProvider = require('./providers/ElevenLabsTTSProvider');
const CartesiaTTSProvider = require('./providers/CartesiaTTSProvider');

module.exports = {
  // Base classes
  VoiceProvider,
  STTProvider,
  TTSProvider,
  VoiceToVoiceProvider,

  // Pipeline manager
  VoicePipelineManager,
  getVoicePipelineManager,

  // Providers
  OpenAIRealtimeProvider,
  DeepgramSTTProvider,
  ElevenLabsTTSProvider,
  CartesiaTTSProvider,
};
