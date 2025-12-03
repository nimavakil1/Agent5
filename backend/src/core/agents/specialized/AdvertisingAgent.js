/**
 * AI-Powered Advertising Agent
 *
 * Intelligent agent for managing and optimizing advertising campaigns
 * across Amazon and Bol.com platforms.
 *
 * Capabilities:
 * - Campaign performance analysis
 * - AI-driven bid optimization
 * - Keyword recommendations
 * - Budget allocation optimization
 * - Cross-platform insights
 * - Automated campaign adjustments
 * - Performance alerts
 *
 * @module AdvertisingAgent
 */

const LLMAgent = require('../LLMAgent');
const { AmazonAdsClient, CAMPAIGN_TYPE, TARGETING_TYPE, MATCH_TYPE } = require('../integrations/AmazonAds');
const { BolAdsClient, CAMPAIGN_STATUS, AD_STATUS } = require('../integrations/BolAds');

/**
 * Platform identifiers
 */
const Platform = {
  AMAZON: 'amazon',
  BOLCOM: 'bolcom',
  ALL: 'all'
};

/**
 * Optimization goals
 */
const OptimizationGoal = {
  MAXIMIZE_SALES: 'maximize_sales',
  MAXIMIZE_PROFIT: 'maximize_profit',
  TARGET_ACOS: 'target_acos',
  TARGET_ROAS: 'target_roas',
  MAXIMIZE_IMPRESSIONS: 'maximize_impressions'
};

class AdvertisingAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Advertising Agent',
      role: 'advertising',
      capabilities: [
        'campaign_management',
        'bid_optimization',
        'keyword_analysis',
        'budget_optimization',
        'performance_reporting',
        'cross_platform_analysis',
        'ai_recommendations',
        'automated_adjustments'
      ],
      systemPrompt: `You are an AI Advertising Specialist responsible for managing and optimizing
advertising campaigns across Amazon and Bol.com marketplaces.

Your expertise includes:
1. Campaign Strategy: Creating and structuring effective campaigns
2. Bid Management: Optimizing bids for target ACoS/ROAS
3. Keyword Optimization: Finding high-performing keywords, adding negatives
4. Budget Allocation: Distributing budget across campaigns effectively
5. Performance Analysis: Identifying trends and optimization opportunities
6. A/B Testing: Suggesting tests for ad creatives and targeting

When making recommendations:
- Always consider the business goal (sales vs profit vs brand awareness)
- Provide specific, actionable recommendations with expected impact
- Consider seasonality and market trends
- Balance short-term performance with long-term growth
- Flag urgent issues that need immediate attention

Key metrics to optimize:
- ACoS (Advertising Cost of Sales) - target typically 15-25%
- ROAS (Return on Ad Spend) - higher is better
- CTR (Click-Through Rate) - indicates ad relevance
- Conversion Rate - indicates product page effectiveness
- Impression Share - indicates bid competitiveness`,
      ...config
    });

    // Initialize platform clients
    this.amazonAdsClient = null;
    this.bolAdsClient = null;

    // Platform status
    this.platformStatus = {
      amazon: { connected: false, lastSync: null, error: null },
      bolcom: { connected: false, lastSync: null, error: null }
    };

    // Default optimization settings
    this.settings = {
      targetACoS: config.targetACoS || 20,
      targetROAS: config.targetROAS || 5,
      minDailyBudget: config.minDailyBudget || 5,
      maxBidAdjustment: config.maxBidAdjustment || 30, // percentage
      autoOptimize: config.autoOptimize || false
    };

    // Cache for performance data
    this.performanceCache = new Map();
    this.cacheExpiry = 15 * 60 * 1000; // 15 minutes
  }

  /**
   * Initialize the Advertising Agent
   */
  async init(platform) {
    await super.init(platform);

    // Initialize Amazon Ads client
    try {
      if (process.env.AMAZON_ADS_CLIENT_ID) {
        this.amazonAdsClient = new AmazonAdsClient();
        await this.amazonAdsClient.init();
        this.platformStatus.amazon.connected = true;
        this.logger?.info('Amazon Ads API connected');
      }
    } catch (error) {
      this.platformStatus.amazon.error = error.message;
      this.logger?.warn('Amazon Ads API connection failed:', error.message);
    }

    // Initialize Bol.com Ads client
    try {
      if (process.env.BOL_CLIENT_ID) {
        this.bolAdsClient = new BolAdsClient();
        await this.bolAdsClient.authenticate();
        this.platformStatus.bolcom.connected = true;
        this.logger?.info('Bol.com Ads API connected');
      }
    } catch (error) {
      this.platformStatus.bolcom.error = error.message;
      this.logger?.warn('Bol.com Ads API connection failed:', error.message);
    }

    // Register tools
    this._registerTools();

    this.logger?.info('AdvertisingAgent initialized', {
      amazon: this.platformStatus.amazon.connected,
      bolcom: this.platformStatus.bolcom.connected
    });
  }

  /**
   * Register agent tools
   */
  _registerTools() {
    // Campaign overview tools
    this.registerTool('get_campaigns_overview', {
      description: 'Get overview of all advertising campaigns across platforms',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'] }
        }
      },
      handler: this._getCampaignsOverview.bind(this)
    });

    this.registerTool('get_campaign_performance', {
      description: 'Get detailed performance metrics for a specific campaign',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true },
          days: { type: 'number', description: 'Number of days to analyze' }
        },
        required: ['platform', 'campaign_id']
      },
      handler: this._getCampaignPerformance.bind(this)
    });

    // Optimization tools
    this.registerTool('get_optimization_recommendations', {
      description: 'Get AI-powered optimization recommendations for campaigns',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'] },
          campaign_id: { type: 'string', description: 'Specific campaign or all' },
          goal: { type: 'string', enum: ['maximize_sales', 'maximize_profit', 'target_acos', 'target_roas'] }
        }
      },
      handler: this._getOptimizationRecommendations.bind(this)
    });

    this.registerTool('optimize_bids', {
      description: 'Apply bid optimization recommendations',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true },
          apply_recommendations: { type: 'boolean', description: 'Whether to apply changes' }
        },
        required: ['platform', 'campaign_id']
      },
      handler: this._optimizeBids.bind(this)
    });

    // Campaign management tools
    this.registerTool('create_campaign', {
      description: 'Create a new advertising campaign',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          name: { type: 'string', required: true },
          daily_budget: { type: 'number', required: true },
          targeting_type: { type: 'string', enum: ['automatic', 'manual'] },
          products: { type: 'array', description: 'EANs/ASINs to advertise' }
        },
        required: ['platform', 'name', 'daily_budget']
      },
      handler: this._createCampaign.bind(this)
    });

    this.registerTool('pause_campaign', {
      description: 'Pause an advertising campaign',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true },
          reason: { type: 'string' }
        },
        required: ['platform', 'campaign_id']
      },
      handler: this._pauseCampaign.bind(this)
    });

    this.registerTool('update_campaign_budget', {
      description: 'Update campaign daily budget',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true },
          daily_budget: { type: 'number', required: true }
        },
        required: ['platform', 'campaign_id', 'daily_budget']
      },
      handler: this._updateCampaignBudget.bind(this)
    });

    // Keyword tools
    this.registerTool('get_keyword_analysis', {
      description: 'Analyze keyword performance and get recommendations',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true }
        },
        required: ['platform', 'campaign_id']
      },
      handler: this._getKeywordAnalysis.bind(this)
    });

    this.registerTool('add_keywords', {
      description: 'Add keywords to a campaign',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true },
          keywords: { type: 'array', description: 'Keywords to add with bids' }
        },
        required: ['platform', 'campaign_id', 'keywords']
      },
      handler: this._addKeywords.bind(this)
    });

    this.registerTool('add_negative_keywords', {
      description: 'Add negative keywords to prevent wasted spend',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          campaign_id: { type: 'string', required: true },
          keywords: { type: 'array', description: 'Negative keywords to add' }
        },
        required: ['platform', 'campaign_id', 'keywords']
      },
      handler: this._addNegativeKeywords.bind(this)
    });

    // Cross-platform analysis
    this.registerTool('get_cross_platform_analysis', {
      description: 'Compare performance across Amazon and Bol.com',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days to analyze' }
        }
      },
      handler: this._getCrossPlatformAnalysis.bind(this)
    });

    // Budget optimization
    this.registerTool('get_budget_recommendations', {
      description: 'Get AI recommendations for budget allocation across campaigns',
      parameters: {
        type: 'object',
        properties: {
          total_budget: { type: 'number', description: 'Total daily budget to allocate' },
          goal: { type: 'string', enum: ['maximize_sales', 'maximize_profit', 'balanced'] }
        }
      },
      handler: this._getBudgetRecommendations.bind(this)
    });

    // Alerts and monitoring
    this.registerTool('get_advertising_alerts', {
      description: 'Get alerts for campaigns needing attention',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info', 'all'] }
        }
      },
      handler: this._getAdvertisingAlerts.bind(this)
    });
  }

  // ==================== CAMPAIGN OVERVIEW ====================

  async _getCampaignsOverview(params = {}) {
    const platform = params.platform || 'all';
    const results = { amazon: null, bolcom: null, combined: {} };

    // Get Amazon campaigns
    if ((platform === 'amazon' || platform === 'all') && this.amazonAdsClient) {
      try {
        results.amazon = await this.amazonAdsClient.getCampaignPerformanceSummary();
      } catch (error) {
        results.amazon = { error: error.message };
      }
    }

    // Get Bol.com campaigns
    if ((platform === 'bolcom' || platform === 'all') && this.bolAdsClient) {
      try {
        results.bolcom = await this.bolAdsClient.getCampaignsSummary();
      } catch (error) {
        results.bolcom = { error: error.message };
      }
    }

    // Combine metrics
    results.combined = {
      totalCampaigns:
        (results.amazon?.totalCampaigns || 0) +
        (results.bolcom?.totalCampaigns || 0),
      activeCampaigns:
        (results.amazon?.activeCampaigns || 0) +
        (results.bolcom?.activeCampaigns || 0),
      totalDailyBudget:
        (results.amazon?.totalDailyBudget || 0) +
        (results.bolcom?.totalDailyBudget || 0),
      platforms: {
        amazon: results.amazon,
        bolcom: results.bolcom
      }
    };

    return results;
  }

  async _getCampaignPerformance(params) {
    const { platform, campaign_id, days = 7 } = params;

    if (platform === 'amazon' && this.amazonAdsClient) {
      const analysis = await this.amazonAdsClient.getKeywordAnalysis(campaign_id);
      return {
        platform: 'amazon',
        campaignId: campaign_id,
        ...analysis
      };
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      const health = await this.bolAdsClient.getCampaignHealth(campaign_id, days);
      return {
        platform: 'bolcom',
        ...health
      };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  // ==================== OPTIMIZATION ====================

  async _getOptimizationRecommendations(params = {}) {
    const platform = params.platform || 'all';
    const goal = params.goal || 'target_acos';
    const targetACoS = goal === 'maximize_sales' ? 35 : goal === 'maximize_profit' ? 15 : this.settings.targetACoS;

    const recommendations = {
      amazon: [],
      bolcom: [],
      combined: [],
      summary: {}
    };

    // Get Amazon recommendations
    if ((platform === 'amazon' || platform === 'all') && this.amazonAdsClient) {
      try {
        if (params.campaign_id) {
          const recs = await this.amazonAdsClient.getBidOptimizationRecommendations(params.campaign_id, targetACoS);
          recommendations.amazon = recs;
        } else {
          const campaigns = await this.amazonAdsClient.listSPCampaigns();
          for (const campaign of campaigns.slice(0, 10)) { // Limit to 10
            const recs = await this.amazonAdsClient.getBidOptimizationRecommendations(campaign.campaignId, targetACoS);
            recommendations.amazon.push(...recs);
          }
        }
        recommendations.combined.push(...recommendations.amazon.map(r => ({ ...r, platform: 'amazon' })));
      } catch (error) {
        recommendations.amazon = { error: error.message };
      }
    }

    // Get Bol.com recommendations
    if ((platform === 'bolcom' || platform === 'all') && this.bolAdsClient) {
      try {
        if (params.campaign_id) {
          const recs = await this.bolAdsClient.getBidRecommendations(params.campaign_id, targetACoS);
          recommendations.bolcom = recs.recommendations || [];
        } else {
          const campaigns = await this.bolAdsClient.listCampaigns();
          for (const campaign of (campaigns.campaigns || []).slice(0, 10)) {
            const recs = await this.bolAdsClient.getBidRecommendations(campaign.campaignId, targetACoS);
            recommendations.bolcom.push(...(recs.recommendations || []));
          }
        }
        recommendations.combined.push(...recommendations.bolcom.map(r => ({ ...r, platform: 'bolcom' })));
      } catch (error) {
        recommendations.bolcom = { error: error.message };
      }
    }

    // Generate AI summary
    recommendations.summary = this._generateRecommendationSummary(recommendations.combined, goal);

    return recommendations;
  }

  _generateRecommendationSummary(recommendations, goal) {
    const summary = {
      totalRecommendations: recommendations.length,
      byAction: {},
      estimatedImpact: {},
      priorityActions: []
    };

    // Group by action
    for (const rec of recommendations) {
      const action = rec.action || 'other';
      summary.byAction[action] = (summary.byAction[action] || 0) + 1;
    }

    // Identify priority actions
    const decreaseBidRecs = recommendations.filter(r => r.action === 'decrease_bid');
    const increaseBidRecs = recommendations.filter(r => r.action === 'increase_bid');

    if (decreaseBidRecs.length > 0) {
      summary.priorityActions.push({
        action: 'Reduce bids on underperforming ads/keywords',
        count: decreaseBidRecs.length,
        reason: 'High ACoS - wasting ad spend',
        urgency: 'high'
      });
    }

    if (increaseBidRecs.length > 0) {
      summary.priorityActions.push({
        action: 'Increase bids on high-performing ads/keywords',
        count: increaseBidRecs.length,
        reason: 'Low ACoS - opportunity for growth',
        urgency: 'medium'
      });
    }

    return summary;
  }

  async _optimizeBids(params) {
    const { platform, campaign_id, apply_recommendations = false } = params;

    // Get recommendations first
    const recommendations = await this._getOptimizationRecommendations({
      platform,
      campaign_id
    });

    const results = {
      campaignId: campaign_id,
      platform,
      recommendations: recommendations[platform] || [],
      applied: [],
      skipped: []
    };

    if (!apply_recommendations) {
      results.message = 'Recommendations generated. Set apply_recommendations=true to apply changes.';
      return results;
    }

    // Apply recommendations
    const recs = Array.isArray(recommendations[platform]) ? recommendations[platform] : [];

    for (const rec of recs) {
      try {
        if (rec.action === 'decrease_bid' || rec.action === 'increase_bid') {
          if (platform === 'amazon' && this.amazonAdsClient && rec.keywordId) {
            await this.amazonAdsClient.updateSPKeywordBid(rec.keywordId, rec.suggestedBid);
            results.applied.push(rec);
          } else if (platform === 'bolcom' && this.bolAdsClient && rec.adId) {
            await this.bolAdsClient.updateAdBid(campaign_id, rec.adId, rec.suggestedBid);
            results.applied.push(rec);
          }
        } else {
          results.skipped.push({ ...rec, reason: 'Action requires manual review' });
        }
      } catch (error) {
        results.skipped.push({ ...rec, reason: error.message });
      }
    }

    results.summary = {
      applied: results.applied.length,
      skipped: results.skipped.length
    };

    return results;
  }

  // ==================== CAMPAIGN MANAGEMENT ====================

  async _createCampaign(params) {
    const { platform, name, daily_budget, targeting_type = 'automatic', products = [] } = params;

    if (platform === 'amazon' && this.amazonAdsClient) {
      const campaign = await this.amazonAdsClient.createSPCampaign({
        name,
        dailyBudget: daily_budget,
        targetingType: targeting_type === 'automatic' ? TARGETING_TYPE.AUTO : TARGETING_TYPE.MANUAL
      });

      // Add products if provided
      if (products.length > 0 && campaign.campaignId) {
        // Would need to create ad group first, then add products
        // Simplified for now
      }

      return { platform: 'amazon', campaign };
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      const campaign = await this.bolAdsClient.createCampaign({
        name,
        dailyBudget: daily_budget,
        targetingType: targeting_type === 'automatic' ? 'AUTOMATIC' : 'MANUAL'
      });

      // Add products as ads
      if (products.length > 0 && campaign.campaignId) {
        await this.bolAdsClient.createAdsBulk(campaign.campaignId, products.map(ean => ({
          ean,
          bid: 0.15 // Default bid
        })));
      }

      return { platform: 'bolcom', campaign };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  async _pauseCampaign(params) {
    const { platform, campaign_id, reason } = params;

    if (platform === 'amazon' && this.amazonAdsClient) {
      await this.amazonAdsClient.pauseSPCampaign(campaign_id);
      return { platform: 'amazon', campaignId: campaign_id, status: 'paused', reason };
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      await this.bolAdsClient.pauseCampaign(campaign_id);
      return { platform: 'bolcom', campaignId: campaign_id, status: 'paused', reason };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  async _updateCampaignBudget(params) {
    const { platform, campaign_id, daily_budget } = params;

    if (daily_budget < this.settings.minDailyBudget) {
      throw new Error(`Minimum daily budget is ${this.settings.minDailyBudget}`);
    }

    if (platform === 'amazon' && this.amazonAdsClient) {
      await this.amazonAdsClient.updateSPCampaign(campaign_id, { dailyBudget: daily_budget });
      return { platform: 'amazon', campaignId: campaign_id, newBudget: daily_budget };
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      await this.bolAdsClient.updateCampaignBudget(campaign_id, daily_budget);
      return { platform: 'bolcom', campaignId: campaign_id, newBudget: daily_budget };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  // ==================== KEYWORD MANAGEMENT ====================

  async _getKeywordAnalysis(params) {
    const { platform, campaign_id } = params;

    if (platform === 'amazon' && this.amazonAdsClient) {
      return this.amazonAdsClient.getKeywordAnalysis(campaign_id);
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      const keywords = await this.bolAdsClient.listTargetingKeywords(campaign_id);
      return {
        platform: 'bolcom',
        campaignId: campaign_id,
        keywords: keywords.keywords || []
      };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  async _addKeywords(params) {
    const { platform, campaign_id, keywords } = params;

    if (platform === 'amazon' && this.amazonAdsClient) {
      // Would need adGroupId - simplified
      return { platform: 'amazon', message: 'Amazon keyword addition requires adGroupId' };
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      const results = [];
      for (const kw of keywords) {
        const result = await this.bolAdsClient.addTargetingKeyword(campaign_id, {
          text: kw.keyword || kw,
          matchType: kw.matchType || 'BROAD',
          bid: kw.bid || 0.15
        });
        results.push(result);
      }
      return { platform: 'bolcom', campaignId: campaign_id, added: results.length };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  async _addNegativeKeywords(params) {
    const { platform, campaign_id, keywords } = params;

    if (platform === 'amazon' && this.amazonAdsClient) {
      // Would need adGroupId - simplified
      return { platform: 'amazon', message: 'Amazon negative keyword addition requires adGroupId' };
    }

    if (platform === 'bolcom' && this.bolAdsClient) {
      const results = [];
      for (const kw of keywords) {
        const keyword = typeof kw === 'string' ? kw : kw.keyword;
        const result = await this.bolAdsClient.addNegativeKeyword(campaign_id, keyword);
        results.push(result);
      }
      return { platform: 'bolcom', campaignId: campaign_id, added: results.length };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  // ==================== CROSS-PLATFORM ANALYSIS ====================

  async _getCrossPlatformAnalysis(params = {}) {
    const days = params.days || 7;
    const analysis = {
      period: `Last ${days} days`,
      platforms: {},
      comparison: {},
      recommendations: []
    };

    // Get Amazon data
    if (this.amazonAdsClient) {
      try {
        const summary = await this.amazonAdsClient.getCampaignPerformanceSummary();
        analysis.platforms.amazon = summary;
      } catch (error) {
        analysis.platforms.amazon = { error: error.message };
      }
    }

    // Get Bol.com data
    if (this.bolAdsClient) {
      try {
        const summary = await this.bolAdsClient.getCampaignsSummary();
        analysis.platforms.bolcom = summary;
      } catch (error) {
        analysis.platforms.bolcom = { error: error.message };
      }
    }

    // Compare platforms
    if (analysis.platforms.amazon && analysis.platforms.bolcom) {
      analysis.comparison = {
        budgetAllocation: {
          amazon: analysis.platforms.amazon.totalDailyBudget || 0,
          bolcom: analysis.platforms.bolcom.totalDailyBudget || 0
        },
        campaignCount: {
          amazon: analysis.platforms.amazon.totalCampaigns || 0,
          bolcom: analysis.platforms.bolcom.totalCampaigns || 0
        }
      };

      // Generate cross-platform recommendations
      const amazonBudget = analysis.comparison.budgetAllocation.amazon;
      const bolcomBudget = analysis.comparison.budgetAllocation.bolcom;
      const totalBudget = amazonBudget + bolcomBudget;

      if (totalBudget > 0) {
        const amazonShare = (amazonBudget / totalBudget) * 100;
        analysis.recommendations.push({
          type: 'budget_balance',
          current: `Amazon ${amazonShare.toFixed(0)}% / Bol.com ${(100 - amazonShare).toFixed(0)}%`,
          suggestion: 'Review platform performance to optimize budget allocation'
        });
      }
    }

    return analysis;
  }

  // ==================== BUDGET RECOMMENDATIONS ====================

  async _getBudgetRecommendations(params = {}) {
    const totalBudget = params.total_budget || 100;
    const goal = params.goal || 'balanced';

    const recommendations = {
      totalBudget,
      goal,
      allocation: {},
      reasoning: []
    };

    // Get current performance
    const overview = await this._getCampaignsOverview({ platform: 'all' });

    // Simple allocation strategy
    if (goal === 'maximize_sales') {
      // Favor platform with more active campaigns/better reach
      recommendations.allocation = {
        amazon: Math.round(totalBudget * 0.6),
        bolcom: Math.round(totalBudget * 0.4)
      };
      recommendations.reasoning.push('Allocated more to Amazon for broader reach');
    } else if (goal === 'maximize_profit') {
      // More conservative, focus on proven performers
      recommendations.allocation = {
        amazon: Math.round(totalBudget * 0.5),
        bolcom: Math.round(totalBudget * 0.5)
      };
      recommendations.reasoning.push('Balanced allocation - monitor and shift to better performer');
    } else {
      // Balanced
      recommendations.allocation = {
        amazon: Math.round(totalBudget * 0.5),
        bolcom: Math.round(totalBudget * 0.5)
      };
    }

    // Per-campaign breakdown suggestion
    const amazonCampaigns = overview.amazon?.activeCampaigns || 1;
    const bolcomCampaigns = overview.bolcom?.activeCampaigns || 1;

    recommendations.perCampaign = {
      amazon: Math.round(recommendations.allocation.amazon / amazonCampaigns),
      bolcom: Math.round(recommendations.allocation.bolcom / bolcomCampaigns)
    };

    return recommendations;
  }

  // ==================== ALERTS ====================

  async _getAdvertisingAlerts(params = {}) {
    const severity = params.severity || 'all';
    const alerts = [];

    // Check Amazon campaigns
    if (this.amazonAdsClient) {
      try {
        const campaigns = await this.amazonAdsClient.listSPCampaigns();
        for (const campaign of campaigns) {
          if (campaign.state === 'enabled' && campaign.dailyBudget < this.settings.minDailyBudget) {
            alerts.push({
              severity: 'warning',
              platform: 'amazon',
              campaignId: campaign.campaignId,
              campaignName: campaign.name,
              type: 'low_budget',
              message: `Campaign budget (${campaign.dailyBudget}) below recommended minimum (${this.settings.minDailyBudget})`
            });
          }
        }
      } catch (error) {
        alerts.push({
          severity: 'error',
          platform: 'amazon',
          type: 'connection_error',
          message: `Failed to check Amazon campaigns: ${error.message}`
        });
      }
    }

    // Check Bol.com campaigns
    if (this.bolAdsClient) {
      try {
        const campaigns = await this.bolAdsClient.listCampaigns();
        for (const campaign of (campaigns.campaigns || [])) {
          if (campaign.status === CAMPAIGN_STATUS.ENABLED && campaign.dailyBudget < this.settings.minDailyBudget) {
            alerts.push({
              severity: 'warning',
              platform: 'bolcom',
              campaignId: campaign.campaignId,
              campaignName: campaign.name,
              type: 'low_budget',
              message: `Campaign budget (${campaign.dailyBudget}) below recommended minimum (${this.settings.minDailyBudget})`
            });
          }
        }
      } catch (error) {
        alerts.push({
          severity: 'error',
          platform: 'bolcom',
          type: 'connection_error',
          message: `Failed to check Bol.com campaigns: ${error.message}`
        });
      }
    }

    // Filter by severity
    let filteredAlerts = alerts;
    if (severity !== 'all') {
      filteredAlerts = alerts.filter(a => a.severity === severity);
    }

    return {
      alerts: filteredAlerts,
      summary: {
        total: filteredAlerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
        error: alerts.filter(a => a.severity === 'error').length,
        info: alerts.filter(a => a.severity === 'info').length
      }
    };
  }
}

module.exports = AdvertisingAgent;
