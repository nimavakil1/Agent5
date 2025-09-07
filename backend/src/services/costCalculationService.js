const CallCostTracking = require('../models/CallCostTracking');

class CostCalculationService {
  constructor() {
    // Initialize rate configuration from environment variables
    this.rates = {
      openai: {
        text_input: parseFloat(process.env.OPENAI_TEXT_INPUT_RATE || '0.0025') / 1000, // per token
        text_output: parseFloat(process.env.OPENAI_TEXT_OUTPUT_RATE || '0.01') / 1000, // per token  
        audio_input: parseFloat(process.env.OPENAI_AUDIO_INPUT_RATE || '0.006'), // per minute
        audio_output: parseFloat(process.env.OPENAI_AUDIO_OUTPUT_RATE || '0.024') // per minute
      },
      telnyx: {
        per_minute: parseFloat(process.env.TELNYX_RATE_PER_MINUTE || '0.02') // varies by destination
      },
      whatsapp: {
        per_message: parseFloat(process.env.WHATSAPP_RATE_PER_MESSAGE || '0.0045') // varies by region
      }
    };
  }

  /**
   * Create or update cost tracking for a call
   * @param {string} callId - Call identifier
   * @param {string} sessionType - Type of session ('agent_studio', 'pstn', 'whatsapp')
   * @param {Object} options - Cost calculation options
   * @returns {Promise<Object>} Updated cost tracking document
   */
  async updateCallCosts(callId, sessionType, options = {}) {
    try {
      let costTracking = await CallCostTracking.findOne({ call_id: callId });
      
      if (!costTracking) {
        costTracking = new CallCostTracking({
          call_id: callId,
          session_type: sessionType
        });
      }

      // Update LLM costs if provided
      if (options.llm) {
        const llmCost = CallCostTracking.calculateOpenAICosts(
          options.llm.input_tokens,
          options.llm.output_tokens,
          options.llm.audio_input_minutes,
          options.llm.audio_output_minutes
        );
        costTracking.llm_cost = llmCost;
      }

      // Update PSTN costs if provided
      if (options.pstn) {
        const pstncost = {
          duration_minutes: options.pstn.duration_minutes || 0,
          rate_per_minute: this.rates.telnyx.per_minute,
          total_cost_usd: (options.pstn.duration_minutes || 0) * this.rates.telnyx.per_minute
        };
        costTracking.pstn_cost = pstncost;
      }

      // Update WhatsApp costs if provided
      if (options.whatsapp) {
        const whatsappCost = {
          message_count: options.whatsapp.message_count || 0,
          rate_per_message: this.rates.whatsapp.per_message,
          total_cost_usd: (options.whatsapp.message_count || 0) * this.rates.whatsapp.per_message
        };
        costTracking.whatsapp_cost = whatsappCost;
      }

      // Update recording info if provided
      if (options.recording) {
        costTracking.recording = {
          ...costTracking.recording,
          ...options.recording
        };
      }

      // Update transcription if provided
      if (options.transcription) {
        costTracking.transcription = {
          ...costTracking.transcription,
          ...options.transcription
        };
      }

      // Save and let the pre-save hook calculate total_cost_usd
      await costTracking.save();
      
      console.log(`Cost tracking updated for call ${callId}: $${costTracking.total_cost_usd.toFixed(4)}`);
      
      return costTracking;
    } catch (error) {
      console.error(`Failed to update costs for call ${callId}:`, error);
      throw error;
    }
  }

  /**
   * Calculate estimated costs for real-time display
   * @param {Object} metrics - Current call metrics
   * @returns {Object} Estimated costs
   */
  estimateRealtimeCosts(metrics = {}) {
    const llm = CallCostTracking.calculateOpenAICosts(
      metrics.input_tokens || 0,
      metrics.output_tokens || 0,
      metrics.audio_input_minutes || 0,
      metrics.audio_output_minutes || 0
    );

    const pstn = {
      duration_minutes: metrics.duration_minutes || 0,
      total_cost_usd: (metrics.duration_minutes || 0) * this.rates.telnyx.per_minute
    };

    const whatsapp = {
      message_count: metrics.message_count || 0,
      total_cost_usd: (metrics.message_count || 0) * this.rates.whatsapp.per_message
    };

    return {
      llm_cost: llm.total_cost_usd,
      pstn_cost: pstn.total_cost_usd,
      whatsapp_cost: whatsapp.total_cost_usd,
      total_cost: llm.total_cost_usd + pstn.total_cost_usd + whatsapp.total_cost_usd
    };
  }

  /**
   * Get cost summary for dashboard
   * @param {Object} filters - Date range and other filters
   * @returns {Promise<Object>} Cost summary statistics
   */
  async getCostSummary(filters = {}) {
    try {
      const matchConditions = {};
      
      // Date range filter
      if (filters.startDate || filters.endDate) {
        matchConditions.created_at = {};
        if (filters.startDate) {
          matchConditions.created_at.$gte = new Date(filters.startDate);
        }
        if (filters.endDate) {
          matchConditions.created_at.$lte = new Date(filters.endDate);
        }
      }

      // Session type filter
      if (filters.sessionType) {
        matchConditions.session_type = filters.sessionType;
      }

      const summary = await CallCostTracking.aggregate([
        { $match: matchConditions },
        {
          $group: {
            _id: null,
            total_calls: { $sum: 1 },
            total_cost: { $sum: '$total_cost_usd' },
            total_llm_cost: { $sum: '$llm_cost.total_cost_usd' },
            total_pstn_cost: { $sum: '$pstn_cost.total_cost_usd' },
            total_whatsapp_cost: { $sum: '$whatsapp_cost.total_cost_usd' },
            total_audio_minutes: { 
              $sum: { 
                $add: ['$llm_cost.audio_input_minutes', '$llm_cost.audio_output_minutes'] 
              }
            },
            total_tokens: {
              $sum: {
                $add: ['$llm_cost.input_tokens', '$llm_cost.output_tokens']
              }
            },
            avg_cost_per_call: { $avg: '$total_cost_usd' }
          }
        }
      ]);

      // Get daily breakdown for charts
      const dailyBreakdown = await CallCostTracking.aggregate([
        { $match: matchConditions },
        {
          $group: {
            _id: {
              year: { $year: '$created_at' },
              month: { $month: '$created_at' },
              day: { $dayOfMonth: '$created_at' }
            },
            date: { $first: '$created_at' },
            calls: { $sum: 1 },
            cost: { $sum: '$total_cost_usd' },
            llm_cost: { $sum: '$llm_cost.total_cost_usd' },
            pstn_cost: { $sum: '$pstn_cost.total_cost_usd' },
            whatsapp_cost: { $sum: '$whatsapp_cost.total_cost_usd' }
          }
        },
        { $sort: { date: 1 } }
      ]);

      return {
        summary: summary[0] || {
          total_calls: 0,
          total_cost: 0,
          total_llm_cost: 0,
          total_pstn_cost: 0,
          total_whatsapp_cost: 0,
          total_audio_minutes: 0,
          total_tokens: 0,
          avg_cost_per_call: 0
        },
        dailyBreakdown,
        currentRates: this.rates
      };
    } catch (error) {
      console.error('Failed to get cost summary:', error);
      throw error;
    }
  }

  /**
   * Update rate configuration
   * @param {Object} newRates - New rate configuration
   */
  updateRates(newRates) {
    this.rates = { ...this.rates, ...newRates };
    console.log('Cost rates updated:', this.rates);
  }
}

module.exports = new CostCalculationService();