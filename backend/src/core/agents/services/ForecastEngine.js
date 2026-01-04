/**
 * ForecastEngine Service
 *
 * Provides demand forecasting using multiple algorithms:
 * - Simple Moving Average (baseline)
 * - Exponential Smoothing (Holt-Winters)
 * - Seasonal decomposition
 * - Trend detection
 *
 * Uses INVOICED quantities from Odoo with context adjustments for:
 * - Substitutions (add to original product, subtract from substitute)
 * - One-time orders (exclude from normal demand)
 * - Promotions (adjust for elevated demand periods)
 * - Supply disruptions (understand understated demand)
 */

const { getSeasonalCalendar } = require('./SeasonalCalendar');
const { getPurchasingContext } = require('./PurchasingContext');

class ForecastEngine {
  constructor(config = {}) {
    this.seasonalCalendar = getSeasonalCalendar();
    this.defaultPeriods = config.defaultPeriods || 12; // 12 weeks default
    this.confidenceLevel = config.confidenceLevel || 0.95;
    this.db = config.db || null;
  }

  /**
   * Set database connection for context lookups
   */
  setDb(db) {
    this.db = db;
  }

  /**
   * Generate a demand forecast for a product
   * @param {Array} salesHistory - Array of {date, quantity, revenue} objects
   * @param {Object} options - Forecasting options
   */
  async generateForecast(salesHistory, options = {}) {
    const {
      forecastPeriods = this.defaultPeriods,
      periodType = 'week', // 'day', 'week', 'month'
      productCategory = 'general',
      includeSeasonality = true,
      productId = null, // Required for context adjustments
      applyContextAdjustments = true,
    } = options;

    // Get date range from sales history
    const dates = salesHistory.map(s => new Date(s.date));
    const startDate = dates.length > 0 ? new Date(Math.min(...dates)) : null;
    const endDate = dates.length > 0 ? new Date(Math.max(...dates)) : null;

    // Apply context adjustments (substitutions, one-time orders, etc.)
    let adjustedSalesHistory = salesHistory;
    let contextAdjustments = null;

    if (applyContextAdjustments && productId && this.db) {
      const adjustmentResult = await this.applyContextAdjustments(
        salesHistory,
        productId,
        startDate,
        endDate
      );
      adjustedSalesHistory = adjustmentResult.adjustedSales;
      contextAdjustments = adjustmentResult.adjustments;
    }

    // Aggregate sales by period
    const aggregatedSales = this.aggregateSales(adjustedSalesHistory, periodType);

    if (aggregatedSales.length < 4) {
      return {
        error: 'Insufficient data',
        message: 'Need at least 4 periods of sales data for forecasting',
        dataPoints: aggregatedSales.length,
      };
    }

    // Run multiple forecasting methods
    const forecasts = {};

    // Simple Moving Average
    forecasts.movingAverage = this.simpleMovingAverage(aggregatedSales, forecastPeriods);

    // Exponential Smoothing
    forecasts.exponentialSmoothing = this.exponentialSmoothing(aggregatedSales, forecastPeriods);

    // Holt-Winters (if enough data for seasonality)
    if (aggregatedSales.length >= 12) {
      forecasts.holtWinters = this.holtWinters(aggregatedSales, forecastPeriods, periodType);
    }

    // Apply seasonal adjustments
    if (includeSeasonality) {
      forecasts.seasonallyAdjusted = this.applySeasonalAdjustment(
        forecasts.exponentialSmoothing,
        productCategory,
        periodType
      );
    }

    // Calculate ensemble forecast (weighted average)
    const ensembleForecast = this.calculateEnsemble(forecasts, aggregatedSales);

    // Detect trends
    const trendAnalysis = this.analyzeTrend(aggregatedSales);

    // Calculate confidence intervals
    const confidenceIntervals = this.calculateConfidenceIntervals(
      aggregatedSales,
      ensembleForecast
    );

    return {
      historicalData: aggregatedSales,
      forecasts,
      ensembleForecast,
      trendAnalysis,
      confidenceIntervals,
      contextAdjustments, // Include adjustment details for transparency
      metadata: {
        generatedAt: new Date(),
        periodType,
        forecastPeriods,
        dataPointsUsed: aggregatedSales.length,
        productCategory,
        productId,
        contextApplied: !!contextAdjustments,
      },
    };
  }

  /**
   * Apply context adjustments to sales history
   * Handles substitutions, one-time orders, recurring orders, and substitute relationships
   */
  async applyContextAdjustments(salesHistory, productId, startDate, endDate) {
    const context = getPurchasingContext(this.db);

    // Get standard adjustments (substitution events, one-time orders, etc.)
    const adjustmentsData = await context.getProductAdjustments(productId, startDate, endDate);

    // Get substitute relationship data for interpretation
    const substituteRels = await context.getSubstituteRelationships(productId);

    // Get recurring customer order patterns
    const recurringOrders = await context.getRecurringCustomerOrders(productId);

    // Build context summary for AI reasoning
    const contextSummary = {
      hasSubstituteRelationships: substituteRels.substitutes.length > 0 || substituteRels.substituteFor.length > 0,
      isSubstituteFor: substituteRels.substituteFor.length > 0 ? substituteRels.substituteFor : null,
      hasSubstitutes: substituteRels.substitutes.length > 0 ? substituteRels.substitutes : null,
      recurringOrderPatterns: recurringOrders.length > 0 ? recurringOrders.map(r => ({
        customer: r.customer?.name || r.customer?.id,
        frequency: r.pattern?.frequency,
        typicalQuantity: r.pattern?.typicalQuantity,
        typicalMonth: r.pattern?.typicalMonth,
      })) : null,
    };

    if (!adjustmentsData.adjustments || adjustmentsData.adjustments.length === 0) {
      // Even with no adjustments, we still want to include context info
      if (contextSummary.hasSubstituteRelationships || recurringOrders.length > 0) {
        return {
          adjustedSales: salesHistory,
          adjustments: {
            totalAdjustment: 0,
            adjustmentDetails: [],
            summary: 'No quantity adjustments, but context information available.',
          },
          substituteRelationships: contextSummary.isSubstituteFor || contextSummary.hasSubstitutes ? substituteRels : null,
          recurringOrders: recurringOrders.length > 0 ? recurringOrders : null,
          interpretationNotes: this._generateInterpretationNotes(contextSummary),
        };
      }
      return {
        adjustedSales: salesHistory,
        adjustments: null,
      };
    }

    // Create a map of date -> adjustment
    const dateAdjustments = new Map();
    for (const adj of adjustmentsData.adjustments) {
      const dateKey = adj.date ? new Date(adj.date).toISOString().split('T')[0] : 'global';
      if (!dateAdjustments.has(dateKey)) {
        dateAdjustments.set(dateKey, {
          adjustment: 0,
          reasons: [],
        });
      }
      const entry = dateAdjustments.get(dateKey);
      entry.adjustment += adj.adjustment;
      entry.reasons.push({
        type: adj.type,
        adjustment: adj.adjustment,
        reason: adj.reason,
      });
    }

    // Apply adjustments to sales history
    const adjustedSales = salesHistory.map(sale => {
      const saleDate = new Date(sale.date).toISOString().split('T')[0];

      // Check for date-specific adjustment
      const dateAdj = dateAdjustments.get(saleDate);

      // Check for global adjustment (spread across all periods)
      const globalAdj = dateAdjustments.get('global');
      const globalPerPeriod = globalAdj
        ? globalAdj.adjustment / salesHistory.length
        : 0;

      const totalAdjustment = (dateAdj?.adjustment || 0) + globalPerPeriod;

      if (totalAdjustment !== 0) {
        return {
          ...sale,
          originalQuantity: sale.quantity,
          quantity: Math.max(0, sale.quantity + totalAdjustment),
          adjustmentApplied: totalAdjustment,
          adjustmentReasons: dateAdj?.reasons || [],
        };
      }

      return sale;
    });

    // Get context for additional info
    const contextInfo = await context.getSubstituteRelationships(productId);
    const recurringInfo = await context.getRecurringCustomerOrders(productId);

    return {
      adjustedSales,
      adjustments: {
        totalAdjustment: adjustmentsData.netAdjustment,
        adjustmentDetails: adjustmentsData.adjustments,
        summary: this._generateAdjustmentSummary(adjustmentsData),
      },
      substituteRelationships: (contextInfo.substitutes.length > 0 || contextInfo.substituteFor.length > 0) ? contextInfo : null,
      recurringOrders: recurringInfo.length > 0 ? recurringInfo : null,
      interpretationNotes: this._generateInterpretationNotes({
        hasSubstituteRelationships: contextInfo.substitutes.length > 0 || contextInfo.substituteFor.length > 0,
        isSubstituteFor: contextInfo.substituteFor.length > 0 ? contextInfo.substituteFor : null,
        hasSubstitutes: contextInfo.substitutes.length > 0 ? contextInfo.substitutes : null,
        recurringOrderPatterns: recurringInfo.length > 0 ? recurringInfo.map(r => ({
          customer: r.customer?.name || r.customer?.id,
          frequency: r.pattern?.frequency,
          typicalQuantity: r.pattern?.typicalQuantity,
        })) : null,
      }),
    };
  }

  /**
   * Generate interpretation notes for AI reasoning
   * Helps the agent understand how to interpret the sales data
   */
  _generateInterpretationNotes(contextSummary) {
    const notes = [];

    if (contextSummary.isSubstituteFor && contextSummary.isSubstituteFor.length > 0) {
      const primaryProducts = contextSummary.isSubstituteFor.map(p => p.productName || `#${p.productId}`).join(', ');
      notes.push(
        `CAUTION - SUBSTITUTE PRODUCT: This product serves as a substitute for: ${primaryProducts}. ` +
        `Sales spikes may NOT represent organic demand, but customers buying this when the primary product is out of stock. ` +
        `Base forecast should be LOWER than raw invoiced quantities suggest.`
      );
    }

    if (contextSummary.hasSubstitutes && contextSummary.hasSubstitutes.length > 0) {
      const subProducts = contextSummary.hasSubstitutes.map(p => p.productName || `#${p.productId}`).join(', ');
      notes.push(
        `HAS SUBSTITUTES: When this product is out of stock, customers may buy: ${subProducts}. ` +
        `True demand for this product may be HIGHER than invoiced quantities during stockout periods.`
      );
    }

    if (contextSummary.recurringOrderPatterns && contextSummary.recurringOrderPatterns.length > 0) {
      const patterns = contextSummary.recurringOrderPatterns.map(p =>
        `${p.customer}: ${p.typicalQuantity} units ${p.frequency}` +
        (p.typicalMonth ? ` (month ${p.typicalMonth})` : '')
      ).join('; ');
      notes.push(
        `RECURRING CUSTOMER ORDERS: ${patterns}. ` +
        `These are predictable, scheduled orders that should be INCLUDED in forecasts as expected demand, ` +
        `but should NOT be treated as trend indicators.`
      );
    }

    return notes.length > 0 ? notes : null;
  }

  /**
   * Generate human-readable summary of adjustments
   */
  _generateAdjustmentSummary(adjustmentsData) {
    if (!adjustmentsData.adjustments || adjustmentsData.adjustments.length === 0) {
      return 'No context adjustments applied.';
    }

    const parts = [];
    const byType = {};

    for (const adj of adjustmentsData.adjustments) {
      if (!byType[adj.type]) {
        byType[adj.type] = { count: 0, totalAdj: 0 };
      }
      byType[adj.type].count++;
      byType[adj.type].totalAdj += adj.adjustment;
    }

    if (byType.substitution) {
      const sign = byType.substitution.totalAdj >= 0 ? '+' : '';
      parts.push(
        `${byType.substitution.count} substitution(s): ${sign}${byType.substitution.totalAdj} units`
      );
    }

    if (byType.one_time_order) {
      const sign = byType.one_time_order.totalAdj >= 0 ? '+' : '';
      parts.push(
        `${byType.one_time_order.count} one-time order(s): ${sign}${byType.one_time_order.totalAdj} units`
      );
    }

    if (byType.product_note) {
      const sign = byType.product_note.totalAdj >= 0 ? '+' : '';
      parts.push(
        `${byType.product_note.count} manual adjustment(s): ${sign}${byType.product_note.totalAdj} units`
      );
    }

    const netSign = adjustmentsData.netAdjustment >= 0 ? '+' : '';
    parts.push(`Net adjustment: ${netSign}${adjustmentsData.netAdjustment} units`);

    return parts.join('. ');
  }

  /**
   * Aggregate sales data by period
   */
  aggregateSales(salesHistory, periodType) {
    const periodMap = new Map();

    for (const sale of salesHistory) {
      const date = new Date(sale.date);
      const periodKey = this.getPeriodKey(date, periodType);

      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period: periodKey,
          periodStart: this.getPeriodStart(date, periodType),
          quantity: 0,
          revenue: 0,
          orderCount: 0,
        });
      }

      const period = periodMap.get(periodKey);
      period.quantity += sale.quantity || 0;
      period.revenue += sale.revenue || 0;
      period.orderCount += 1;
    }

    // Convert to sorted array
    return Array.from(periodMap.values())
      .sort((a, b) => a.periodStart - b.periodStart);
  }

  /**
   * Get period key for a date
   */
  getPeriodKey(date, periodType) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();

    switch (periodType) {
      case 'day':
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      case 'week': {
        const weekNum = this.getWeekNumber(date);
        return `${year}-W${String(weekNum).padStart(2, '0')}`;
      }
      case 'month':
        return `${year}-${String(month + 1).padStart(2, '0')}`;
      default:
        return `${year}-W${String(this.getWeekNumber(date)).padStart(2, '0')}`;
    }
  }

  /**
   * Get start of period for a date
   */
  getPeriodStart(date, periodType) {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);

    switch (periodType) {
      case 'day':
        return result;
      case 'week': {
        const dayOfWeek = result.getDay();
        const diff = result.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        result.setDate(diff);
        return result;
      }
      case 'month':
        result.setDate(1);
        return result;
      default:
        return result;
    }
  }

  /**
   * Get ISO week number
   */
  getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  /**
   * Simple Moving Average forecast
   */
  simpleMovingAverage(data, forecastPeriods, windowSize = 4) {
    const quantities = data.map(d => d.quantity);

    // Calculate MA for historical data
    const ma = [];
    for (let i = 0; i < quantities.length; i++) {
      if (i < windowSize - 1) {
        ma.push(null);
      } else {
        const window = quantities.slice(i - windowSize + 1, i + 1);
        ma.push(window.reduce((a, b) => a + b, 0) / windowSize);
      }
    }

    // Forecast future periods
    const forecasted = [];
    const lastMA = ma.filter(v => v !== null);
    const lastValue = lastMA[lastMA.length - 1];

    for (let i = 0; i < forecastPeriods; i++) {
      forecasted.push({
        period: i + 1,
        forecast: Math.round(lastValue),
      });
    }

    return {
      method: 'Simple Moving Average',
      windowSize,
      historicalMA: ma,
      forecast: forecasted,
      avgForecast: Math.round(lastValue),
    };
  }

  /**
   * Exponential Smoothing forecast
   */
  exponentialSmoothing(data, forecastPeriods, alpha = 0.3) {
    const quantities = data.map(d => d.quantity);

    // Initialize with first value
    let smoothed = [quantities[0]];

    // Apply exponential smoothing
    for (let i = 1; i < quantities.length; i++) {
      const newSmoothed = alpha * quantities[i] + (1 - alpha) * smoothed[i - 1];
      smoothed.push(newSmoothed);
    }

    // Forecast future periods
    const lastSmoothed = smoothed[smoothed.length - 1];
    const forecasted = [];

    for (let i = 0; i < forecastPeriods; i++) {
      forecasted.push({
        period: i + 1,
        forecast: Math.round(lastSmoothed),
      });
    }

    return {
      method: 'Exponential Smoothing',
      alpha,
      historicalSmoothed: smoothed,
      forecast: forecasted,
      avgForecast: Math.round(lastSmoothed),
    };
  }

  /**
   * Holt-Winters Triple Exponential Smoothing
   * Handles both trend and seasonality
   */
  holtWinters(data, forecastPeriods, periodType = 'week') {
    const quantities = data.map(d => d.quantity);
    const n = quantities.length;

    // Seasonal period (weeks in a year quarter for weekly data)
    const seasonalPeriod = periodType === 'week' ? 13 : periodType === 'month' ? 12 : 7;

    if (n < seasonalPeriod * 2) {
      // Not enough data for full seasonal analysis, fall back to double exponential
      return this.doubleExponentialSmoothing(data, forecastPeriods);
    }

    // Parameters
    const alpha = 0.3; // Level
    const beta = 0.1;  // Trend
    const gamma = 0.2; // Seasonal

    // Initialize seasonal indices
    const seasonalIndices = [];
    const avgFirst = quantities.slice(0, seasonalPeriod).reduce((a, b) => a + b, 0) / seasonalPeriod;

    for (let i = 0; i < seasonalPeriod; i++) {
      seasonalIndices.push(quantities[i] / avgFirst);
    }

    // Initialize level and trend
    let level = avgFirst;
    let trend = (quantities[seasonalPeriod] - quantities[0]) / seasonalPeriod;

    const smoothed = [];

    // Apply Holt-Winters
    for (let i = 0; i < n; i++) {
      const seasonIdx = i % seasonalPeriod;
      const value = quantities[i];

      const lastLevel = level;
      const lastTrend = trend;

      // Update level
      level = alpha * (value / seasonalIndices[seasonIdx]) + (1 - alpha) * (lastLevel + lastTrend);

      // Update trend
      trend = beta * (level - lastLevel) + (1 - beta) * lastTrend;

      // Update seasonal
      seasonalIndices[seasonIdx] = gamma * (value / level) + (1 - gamma) * seasonalIndices[seasonIdx];

      smoothed.push(level + trend);
    }

    // Forecast future periods
    const forecasted = [];
    for (let i = 0; i < forecastPeriods; i++) {
      const seasonIdx = (n + i) % seasonalPeriod;
      const forecastValue = (level + (i + 1) * trend) * seasonalIndices[seasonIdx];

      forecasted.push({
        period: i + 1,
        forecast: Math.max(0, Math.round(forecastValue)),
        seasonalIndex: seasonalIndices[seasonIdx],
      });
    }

    return {
      method: 'Holt-Winters',
      parameters: { alpha, beta, gamma, seasonalPeriod },
      historicalSmoothed: smoothed,
      seasonalIndices,
      forecast: forecasted,
      avgForecast: Math.round(forecasted.reduce((sum, f) => sum + f.forecast, 0) / forecastPeriods),
    };
  }

  /**
   * Double Exponential Smoothing (for trend without seasonality)
   */
  doubleExponentialSmoothing(data, forecastPeriods, alpha = 0.3, beta = 0.1) {
    const quantities = data.map(d => d.quantity);
    const n = quantities.length;

    // Initialize
    let level = quantities[0];
    let trend = quantities.length > 1 ? quantities[1] - quantities[0] : 0;

    const smoothed = [];

    for (let i = 0; i < n; i++) {
      const lastLevel = level;

      level = alpha * quantities[i] + (1 - alpha) * (level + trend);
      trend = beta * (level - lastLevel) + (1 - beta) * trend;

      smoothed.push(level);
    }

    // Forecast
    const forecasted = [];
    for (let i = 0; i < forecastPeriods; i++) {
      forecasted.push({
        period: i + 1,
        forecast: Math.max(0, Math.round(level + (i + 1) * trend)),
      });
    }

    return {
      method: 'Double Exponential Smoothing',
      parameters: { alpha, beta },
      historicalSmoothed: smoothed,
      trend,
      forecast: forecasted,
      avgForecast: Math.round(forecasted.reduce((sum, f) => sum + f.forecast, 0) / forecastPeriods),
    };
  }

  /**
   * Apply seasonal adjustment from SeasonalCalendar
   */
  applySeasonalAdjustment(baseForecast, productCategory, periodType) {
    const today = new Date();
    const adjusted = [];

    for (const forecast of baseForecast.forecast) {
      const futureDate = new Date(today);

      if (periodType === 'week') {
        futureDate.setDate(futureDate.getDate() + forecast.period * 7);
      } else if (periodType === 'month') {
        futureDate.setMonth(futureDate.getMonth() + forecast.period);
      } else {
        futureDate.setDate(futureDate.getDate() + forecast.period);
      }

      const multiplier = this.seasonalCalendar.getDemandMultiplier(productCategory, futureDate);
      const activeSeasons = this.seasonalCalendar.getActiveSeasons(futureDate);

      adjusted.push({
        ...forecast,
        originalForecast: forecast.forecast,
        forecast: Math.round(forecast.forecast * multiplier),
        seasonalMultiplier: multiplier,
        activeSeasons: activeSeasons.map(s => s.name),
      });
    }

    return {
      method: 'Seasonally Adjusted',
      baseForecast: baseForecast.forecast,
      forecast: adjusted,
      avgForecast: Math.round(adjusted.reduce((sum, f) => sum + f.forecast, 0) / adjusted.length),
    };
  }

  /**
   * Calculate ensemble forecast (weighted average of methods)
   */
  calculateEnsemble(forecasts, _historicalData) {
    // Weight methods based on typical accuracy
    const weights = {
      movingAverage: 0.2,
      exponentialSmoothing: 0.3,
      holtWinters: 0.35,
      seasonallyAdjusted: 0.15,
    };

    const availableMethods = Object.keys(forecasts).filter(
      method => forecasts[method] && forecasts[method].forecast
    );

    // Normalize weights
    const totalWeight = availableMethods.reduce((sum, m) => sum + (weights[m] || 0.25), 0);

    const ensembleForecast = [];
    const forecastLength = forecasts[availableMethods[0]].forecast.length;

    for (let i = 0; i < forecastLength; i++) {
      let weightedSum = 0;

      for (const method of availableMethods) {
        const weight = (weights[method] || 0.25) / totalWeight;
        weightedSum += forecasts[method].forecast[i].forecast * weight;
      }

      ensembleForecast.push({
        period: i + 1,
        forecast: Math.round(weightedSum),
        methods: availableMethods,
      });
    }

    return {
      method: 'Ensemble',
      weights,
      forecast: ensembleForecast,
      avgForecast: Math.round(ensembleForecast.reduce((sum, f) => sum + f.forecast, 0) / ensembleForecast.length),
    };
  }

  /**
   * Analyze trend in historical data
   */
  analyzeTrend(data) {
    const quantities = data.map(d => d.quantity);
    const n = quantities.length;

    if (n < 3) {
      return { trend: 'insufficient_data' };
    }

    // Calculate linear regression
    const xMean = (n - 1) / 2;
    const yMean = quantities.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (quantities[i] - yMean);
      denominator += (i - xMean) ** 2;
    }

    const slope = numerator / denominator;
    const intercept = yMean - slope * xMean;

    // Calculate R-squared
    let ssRes = 0;
    let ssTot = 0;

    for (let i = 0; i < n; i++) {
      const predicted = intercept + slope * i;
      ssRes += (quantities[i] - predicted) ** 2;
      ssTot += (quantities[i] - yMean) ** 2;
    }

    const rSquared = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    // Determine trend direction and strength
    let trend;
    const avgValue = yMean;
    const percentageChange = (slope / avgValue) * 100;

    if (Math.abs(percentageChange) < 1) {
      trend = 'stable';
    } else if (percentageChange > 5) {
      trend = 'strong_growth';
    } else if (percentageChange > 0) {
      trend = 'moderate_growth';
    } else if (percentageChange < -5) {
      trend = 'strong_decline';
    } else {
      trend = 'moderate_decline';
    }

    return {
      trend,
      slope,
      intercept,
      rSquared,
      percentageChangePerPeriod: percentageChange,
      projectedGrowthPercent: percentageChange * 12, // Annual projection
      confidence: rSquared > 0.7 ? 'high' : rSquared > 0.4 ? 'medium' : 'low',
    };
  }

  /**
   * Calculate confidence intervals
   */
  calculateConfidenceIntervals(historicalData, ensembleForecast) {
    const quantities = historicalData.map(d => d.quantity);
    const n = quantities.length;

    // Calculate standard deviation
    const mean = quantities.reduce((a, b) => a + b, 0) / n;
    const variance = quantities.reduce((sum, q) => sum + (q - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    // Calculate coefficient of variation
    const cv = stdDev / mean;

    // Z-score for 95% confidence
    const zScore = 1.96;

    const intervals = ensembleForecast.forecast.map(f => {
      // Increase uncertainty for further-out forecasts
      const uncertaintyMultiplier = 1 + (f.period - 1) * 0.1;
      const margin = zScore * stdDev * uncertaintyMultiplier;

      return {
        period: f.period,
        forecast: f.forecast,
        lower: Math.max(0, Math.round(f.forecast - margin)),
        upper: Math.round(f.forecast + margin),
        margin: Math.round(margin),
      };
    });

    return {
      confidenceLevel: 0.95,
      standardDeviation: stdDev,
      coefficientOfVariation: cv,
      intervals,
    };
  }

  /**
   * Detect anomalies in sales data
   */
  detectAnomalies(data, threshold = 2) {
    const quantities = data.map(d => d.quantity);
    const n = quantities.length;

    if (n < 4) {
      return { anomalies: [], message: 'Insufficient data' };
    }

    const mean = quantities.reduce((a, b) => a + b, 0) / n;
    const stdDev = Math.sqrt(quantities.reduce((sum, q) => sum + (q - mean) ** 2, 0) / n);

    const anomalies = [];

    for (let i = 0; i < n; i++) {
      const zScore = (quantities[i] - mean) / stdDev;

      if (Math.abs(zScore) > threshold) {
        anomalies.push({
          period: data[i].period,
          date: data[i].periodStart,
          value: quantities[i],
          zScore,
          type: zScore > 0 ? 'spike' : 'dip',
          deviation: `${(zScore * 100).toFixed(0)}% from mean`,
        });
      }
    }

    return {
      mean,
      stdDev,
      threshold,
      anomalies,
    };
  }

  /**
   * Compare actual vs forecast for backtesting
   */
  backtest(historicalData, testPeriods = 4) {
    if (historicalData.length <= testPeriods) {
      return { error: 'Insufficient data for backtesting' };
    }

    // Split data
    const trainData = historicalData.slice(0, -testPeriods);
    const testData = historicalData.slice(-testPeriods);

    // Generate forecast on training data
    const forecast = this.simpleMovingAverage(trainData, testPeriods).forecast;

    // Calculate error metrics
    let sumAbsError = 0;
    let sumSquaredError = 0;
    let sumAbsPercentError = 0;

    const comparison = testData.map((actual, i) => {
      const predicted = forecast[i].forecast;
      const error = actual.quantity - predicted;
      const absError = Math.abs(error);
      const percentError = actual.quantity > 0 ? (absError / actual.quantity) * 100 : 0;

      sumAbsError += absError;
      sumSquaredError += error ** 2;
      sumAbsPercentError += percentError;

      return {
        period: actual.period,
        actual: actual.quantity,
        predicted,
        error,
        absError,
        percentError: percentError.toFixed(1) + '%',
      };
    });

    const mae = sumAbsError / testPeriods;
    const rmse = Math.sqrt(sumSquaredError / testPeriods);
    const mape = sumAbsPercentError / testPeriods;

    return {
      comparison,
      metrics: {
        mae,
        rmse,
        mape: mape.toFixed(1) + '%',
        accuracy: (100 - mape).toFixed(1) + '%',
      },
    };
  }
}

// Singleton instance
let forecastEngineInstance = null;

function getForecastEngine(config = {}) {
  if (!forecastEngineInstance) {
    forecastEngineInstance = new ForecastEngine(config);
  }
  return forecastEngineInstance;
}

module.exports = {
  ForecastEngine,
  getForecastEngine,
};
