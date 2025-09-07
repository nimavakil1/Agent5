const mongoose = require('mongoose');

const callCostTrackingSchema = new mongoose.Schema({
  call_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  session_type: {
    type: String,
    enum: ['agent_studio', 'pstn', 'whatsapp'],
    required: true
  },
  
  // LLM Costs
  llm_cost: {
    input_tokens: { type: Number, default: 0 },
    output_tokens: { type: Number, default: 0 },
    audio_input_minutes: { type: Number, default: 0 },
    audio_output_minutes: { type: Number, default: 0 },
    total_cost_usd: { type: Number, default: 0 }
  },
  
  // Telecom Costs
  pstn_cost: {
    duration_minutes: { type: Number, default: 0 },
    rate_per_minute: { type: Number, default: 0 },
    total_cost_usd: { type: Number, default: 0 }
  },
  
  whatsapp_cost: {
    message_count: { type: Number, default: 0 },
    rate_per_message: { type: Number, default: 0 },
    total_cost_usd: { type: Number, default: 0 }
  },
  
  // Storage & Recording
  recording: {
    local_path: String,
    onedrive_url: String,
    onedrive_file_id: String,
    upload_status: {
      type: String,
      enum: ['pending', 'uploaded', 'failed'],
      default: 'pending'
    }
  },
  
  transcription: {
    full_text: String,
    language_detected: String,
    confidence_score: Number
  },
  
  // Totals
  total_cost_usd: { type: Number, default: 0 },
  
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Calculate total cost before saving
callCostTrackingSchema.pre('save', function() {
  this.total_cost_usd = 
    (this.llm_cost?.total_cost_usd || 0) + 
    (this.pstn_cost?.total_cost_usd || 0) + 
    (this.whatsapp_cost?.total_cost_usd || 0);
});

// Static method to calculate OpenAI costs
callCostTrackingSchema.statics.calculateOpenAICosts = function(inputTokens, outputTokens, audioInputMinutes, audioOutputMinutes) {
  const rates = {
    text_input: parseFloat(process.env.OPENAI_TEXT_INPUT_RATE || '0.0025') / 1000, // per token
    text_output: parseFloat(process.env.OPENAI_TEXT_OUTPUT_RATE || '0.01') / 1000, // per token
    audio_input: parseFloat(process.env.OPENAI_AUDIO_INPUT_RATE || '0.006'), // per minute
    audio_output: parseFloat(process.env.OPENAI_AUDIO_OUTPUT_RATE || '0.024') // per minute
  };
  
  const inputCost = (inputTokens || 0) * rates.text_input;
  const outputCost = (outputTokens || 0) * rates.text_output;
  const audioInputCost = (audioInputMinutes || 0) * rates.audio_input;
  const audioOutputCost = (audioOutputMinutes || 0) * rates.audio_output;
  
  return {
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    audio_input_minutes: audioInputMinutes || 0,
    audio_output_minutes: audioOutputMinutes || 0,
    total_cost_usd: inputCost + outputCost + audioInputCost + audioOutputCost
  };
};

module.exports = mongoose.model('CallCostTracking', callCostTrackingSchema);