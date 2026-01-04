/**
 * SubstitutionAnalyzer Service
 *
 * Analyzes substitution patterns between products to calculate:
 * - Baseline demand for each product (normal sales when all products in stock)
 * - Stockout periods for products
 * - Excess sales during stockouts (likely substitution sales)
 * - True demand adjustments for forecasting
 *
 * Example: When 18009 is out of stock, customers buy 18010 instead.
 * This service calculates how much of 18010's sales during that period
 * were substitution sales vs organic demand.
 */

const { getPurchasingContext } = require('./PurchasingContext');

class SubstitutionAnalyzer {
  constructor(config = {}) {
    this.db = config.db || null;
    // Threshold: only consider sales increase as substitution if above this %
    this.substitutionThreshold = config.substitutionThreshold || 0.10; // 10%
    // Minimum days of stockout to trigger analysis
    this.minStockoutDays = config.minStockoutDays || 3;
    // Days to use for baseline calculation
    this.baselineDays = config.baselineDays || 90;
  }

  setDb(db) {
    this.db = db;
  }

  /**
   * Analyze substitution patterns for a primary product
   * Returns adjusted demand figures for both primary and substitute products
   *
   * @param {Object} params
   * @param {number} params.primaryProductId - The main product (e.g., 18009)
   * @param {number} params.substituteProductId - The substitute product (e.g., 18010)
   * @param {Array} params.primarySalesHistory - Sales history for primary product
   * @param {Array} params.substituteSalesHistory - Sales history for substitute product
   * @param {Array} params.primaryStockHistory - Stock levels for primary product (optional)
   */
  async analyzeSubstitution(params) {
    const {
      primaryProductId,
      substituteProductId,
      primarySalesHistory,
      substituteSalesHistory,
      primaryStockHistory = null,
      startDate: _startDate = null,
      endDate: _endDate = null,
    } = params;

    // Step 1: Detect stockout periods for primary product
    const stockoutPeriods = this.detectStockoutPeriods(
      primarySalesHistory,
      primaryStockHistory
    );

    if (stockoutPeriods.length === 0) {
      return {
        hasSubstitutionEffect: false,
        message: 'No stockout periods detected for primary product',
        primaryProductId,
        substituteProductId,
        adjustments: null,
      };
    }

    // Step 2: Calculate baseline daily sales for substitute product
    // (using periods when primary was IN stock)
    const substituteBaseline = this.calculateBaseline(
      substituteSalesHistory,
      stockoutPeriods
    );

    // Step 3: Analyze substitute sales during each stockout period
    const periodAnalysis = [];
    let totalSubstitutionSales = 0;
    let totalExcessDays = 0;

    for (const period of stockoutPeriods) {
      const analysis = this.analyzePeriod(
        period,
        substituteSalesHistory,
        substituteBaseline
      );

      periodAnalysis.push(analysis);

      if (analysis.hasSubstitutionEffect) {
        totalSubstitutionSales += analysis.substitutionSales;
        totalExcessDays += analysis.daysWithExcess;
      }
    }

    // Step 4: Calculate adjustments
    const hasSubstitutionEffect = totalSubstitutionSales > 0;

    const result = {
      hasSubstitutionEffect,
      primaryProductId,
      substituteProductId,
      stockoutPeriods: stockoutPeriods.length,
      substituteBaseline: {
        avgDailySales: substituteBaseline.avgDailySales,
        stdDev: substituteBaseline.stdDev,
        dataPoints: substituteBaseline.dataPoints,
      },
      analysis: {
        totalSubstitutionSales: Math.round(totalSubstitutionSales),
        totalExcessDays,
        substitutionThreshold: `${this.substitutionThreshold * 100}%`,
        periodDetails: periodAnalysis,
      },
      adjustments: hasSubstitutionEffect ? {
        primary: {
          productId: primaryProductId,
          adjustment: Math.round(totalSubstitutionSales),
          reason: `Add ${Math.round(totalSubstitutionSales)} units lost to stockouts (customers bought substitute)`,
          adjustedAvgDailySales: null, // To be calculated by caller
        },
        substitute: {
          productId: substituteProductId,
          baselineDailySales: substituteBaseline.avgDailySales,
          inflatedDailySales: null, // To be calculated
          trueOrganicDailySales: substituteBaseline.avgDailySales,
          reason: `Use baseline of ${substituteBaseline.avgDailySales.toFixed(2)} units/day (excess ${Math.round(totalSubstitutionSales)} units were substitution sales)`,
        },
      } : null,
      recommendation: hasSubstitutionEffect
        ? `Primary product (${primaryProductId}) had ${stockoutPeriods.length} stockout period(s). ` +
          `An estimated ${Math.round(totalSubstitutionSales)} units were sold as substitute (${substituteProductId}). ` +
          `Increase ${primaryProductId} order quantity; use baseline for ${substituteProductId}.`
        : `No significant substitution effect detected.`,
    };

    return result;
  }

  /**
   * Detect stockout periods from sales and/or stock history
   * Returns array of {startDate, endDate, days, reason}
   */
  detectStockoutPeriods(salesHistory, stockHistory = null) {
    const stockoutPeriods = [];

    // Method 1: Use stock history if available
    if (stockHistory && stockHistory.length > 0) {
      let currentStockout = null;

      for (const record of stockHistory) {
        const date = new Date(record.date);
        const stock = record.quantity || record.stock || 0;

        if (stock <= 0) {
          if (!currentStockout) {
            currentStockout = { startDate: date, endDate: date };
          } else {
            currentStockout.endDate = date;
          }
        } else if (currentStockout) {
          // Stockout ended
          const days = Math.ceil(
            (currentStockout.endDate - currentStockout.startDate) / (1000 * 60 * 60 * 24)
          ) + 1;

          if (days >= this.minStockoutDays) {
            stockoutPeriods.push({
              ...currentStockout,
              days,
              reason: 'stock_level_zero',
            });
          }
          currentStockout = null;
        }
      }

      // Handle ongoing stockout
      if (currentStockout) {
        const days = Math.ceil(
          (currentStockout.endDate - currentStockout.startDate) / (1000 * 60 * 60 * 24)
        ) + 1;
        if (days >= this.minStockoutDays) {
          stockoutPeriods.push({
            ...currentStockout,
            days,
            reason: 'stock_level_zero',
            ongoing: true,
          });
        }
      }
    }

    // Method 2: Detect from sales gaps (if no stock history or as supplement)
    if (salesHistory && salesHistory.length > 0) {
      const salesByDate = new Map();
      for (const sale of salesHistory) {
        const dateKey = new Date(sale.date).toISOString().split('T')[0];
        salesByDate.set(dateKey, (salesByDate.get(dateKey) || 0) + (sale.quantity || 0));
      }

      // Calculate normal sales frequency
      const dates = Array.from(salesByDate.keys()).sort();
      if (dates.length > 10) {
        // Calculate average days between sales
        const totalDays = dates.map(d => new Date(d)).reduce((acc, d, i, arr) => {
          if (i === 0) return 0;
          return acc + (d - arr[i - 1]) / (1000 * 60 * 60 * 24);
        }, 0);
        const avgGap = totalDays / (dates.length - 1);

        // Detect gaps that are significantly longer than average
        const gapThreshold = Math.max(avgGap * 3, this.minStockoutDays);

        for (let i = 1; i < dates.length; i++) {
          const gap = (new Date(dates[i]) - new Date(dates[i - 1])) / (1000 * 60 * 60 * 24);
          if (gap >= gapThreshold) {
            // Potential stockout
            const startDate = new Date(dates[i - 1]);
            startDate.setDate(startDate.getDate() + 1);
            const endDate = new Date(dates[i]);
            endDate.setDate(endDate.getDate() - 1);

            // Check if this overlaps with already detected periods
            const overlaps = stockoutPeriods.some(p =>
              (startDate <= p.endDate && endDate >= p.startDate)
            );

            if (!overlaps && gap >= this.minStockoutDays) {
              stockoutPeriods.push({
                startDate,
                endDate,
                days: Math.round(gap),
                reason: 'sales_gap_detected',
              });
            }
          }
        }
      }
    }

    return stockoutPeriods.sort((a, b) => a.startDate - b.startDate);
  }

  /**
   * Calculate baseline daily sales for a product
   * Excludes periods when the primary product was out of stock
   */
  calculateBaseline(salesHistory, excludePeriods = []) {
    // Filter out sales during excluded periods
    const normalSales = salesHistory.filter(sale => {
      const saleDate = new Date(sale.date);
      return !excludePeriods.some(period =>
        saleDate >= period.startDate && saleDate <= period.endDate
      );
    });

    if (normalSales.length === 0) {
      return {
        avgDailySales: 0,
        stdDev: 0,
        dataPoints: 0,
        periods: [],
      };
    }

    // Aggregate by day
    const salesByDay = new Map();
    for (const sale of normalSales) {
      const dateKey = new Date(sale.date).toISOString().split('T')[0];
      salesByDay.set(dateKey, (salesByDay.get(dateKey) || 0) + (sale.quantity || 0));
    }

    // Calculate statistics
    const dailyQuantities = Array.from(salesByDay.values());
    const sum = dailyQuantities.reduce((a, b) => a + b, 0);
    const avg = sum / dailyQuantities.length;

    // Standard deviation
    const squaredDiffs = dailyQuantities.map(q => Math.pow(q - avg, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / dailyQuantities.length;
    const stdDev = Math.sqrt(avgSquaredDiff);

    return {
      avgDailySales: avg,
      stdDev,
      dataPoints: dailyQuantities.length,
      totalQuantity: sum,
      minDaily: Math.min(...dailyQuantities),
      maxDaily: Math.max(...dailyQuantities),
    };
  }

  /**
   * Analyze substitute product sales during a specific stockout period
   */
  analyzePeriod(stockoutPeriod, substituteSalesHistory, baseline) {
    // Get substitute sales during the stockout period
    const periodSales = substituteSalesHistory.filter(sale => {
      const saleDate = new Date(sale.date);
      return saleDate >= stockoutPeriod.startDate && saleDate <= stockoutPeriod.endDate;
    });

    // Aggregate by day
    const salesByDay = new Map();
    for (const sale of periodSales) {
      const dateKey = new Date(sale.date).toISOString().split('T')[0];
      salesByDay.set(dateKey, (salesByDay.get(dateKey) || 0) + (sale.quantity || 0));
    }

    const dailyQuantities = Array.from(salesByDay.values());
    const totalDays = stockoutPeriod.days;
    const daysWithSales = dailyQuantities.length;

    if (daysWithSales === 0) {
      return {
        period: {
          start: stockoutPeriod.startDate,
          end: stockoutPeriod.endDate,
          days: totalDays,
        },
        hasSubstitutionEffect: false,
        substituteSales: 0,
        baselineExpected: Math.round(baseline.avgDailySales * totalDays),
        excessSales: 0,
        substitutionSales: 0,
        daysWithExcess: 0,
      };
    }

    const totalSales = dailyQuantities.reduce((a, b) => a + b, 0);
    const avgDailySales = totalSales / daysWithSales;

    // Calculate expected baseline sales for this period
    const baselineExpected = baseline.avgDailySales * totalDays;

    // Calculate excess above baseline
    const excessSales = Math.max(0, totalSales - baselineExpected);

    // Apply threshold - only count as substitution if excess > threshold
    const thresholdAmount = baselineExpected * this.substitutionThreshold;
    const hasSubstitutionEffect = excessSales > thresholdAmount;
    const substitutionSales = hasSubstitutionEffect ? excessSales : 0;

    // Count days where sales exceeded baseline + 1 stdDev
    const excessThreshold = baseline.avgDailySales + baseline.stdDev;
    const daysWithExcess = dailyQuantities.filter(q => q > excessThreshold).length;

    return {
      period: {
        start: stockoutPeriod.startDate,
        end: stockoutPeriod.endDate,
        days: totalDays,
      },
      hasSubstitutionEffect,
      substituteTotalSales: totalSales,
      substituteAvgDailySales: avgDailySales,
      baselineExpected: Math.round(baselineExpected),
      excessSales: Math.round(excessSales),
      excessPercent: baselineExpected > 0 ? ((excessSales / baselineExpected) * 100).toFixed(1) + '%' : '0%',
      substitutionSales: Math.round(substitutionSales),
      daysWithExcess,
      analysis: hasSubstitutionEffect
        ? `Sales were ${((avgDailySales / baseline.avgDailySales - 1) * 100).toFixed(0)}% above baseline`
        : excessSales > 0
          ? `Excess ${((excessSales / baselineExpected) * 100).toFixed(0)}% below threshold of ${this.substitutionThreshold * 100}%`
          : 'Sales at or below baseline',
    };
  }

  /**
   * Analyze all substitute relationships for a product
   * Uses relationships defined in PurchasingContext
   */
  async analyzeAllSubstitutions(productId, salesData = {}) {
    if (!this.db) {
      return { error: 'Database not connected' };
    }

    const context = getPurchasingContext(this.db);
    const relationships = await context.getSubstituteRelationships(productId);

    const results = {
      productId,
      asMainProduct: [],
      asSubstituteProduct: [],
    };

    // Analyze cases where this product has substitutes
    for (const sub of relationships.substitutes) {
      if (salesData[productId] && salesData[sub.productId]) {
        const analysis = await this.analyzeSubstitution({
          primaryProductId: productId,
          substituteProductId: sub.productId,
          primarySalesHistory: salesData[productId],
          substituteSalesHistory: salesData[sub.productId],
        });
        results.asMainProduct.push(analysis);
      }
    }

    // Analyze cases where this product is a substitute for another
    for (const primary of relationships.substituteFor) {
      if (salesData[primary.productId] && salesData[productId]) {
        const analysis = await this.analyzeSubstitution({
          primaryProductId: primary.productId,
          substituteProductId: productId,
          primarySalesHistory: salesData[primary.productId],
          substituteSalesHistory: salesData[productId],
        });
        results.asSubstituteProduct.push(analysis);
      }
    }

    // Calculate net adjustments
    let netAdjustmentForThisProduct = 0;
    let adjustmentReasons = [];

    // Add demand from stockouts (when this product was out of stock and customers bought substitutes)
    for (const analysis of results.asMainProduct) {
      if (analysis.hasSubstitutionEffect) {
        netAdjustmentForThisProduct += analysis.adjustments.primary.adjustment;
        adjustmentReasons.push(
          `+${analysis.adjustments.primary.adjustment} (lost to ${analysis.substituteProductId} during stockout)`
        );
      }
    }

    // Subtract substitution sales (when this product was bought as substitute)
    for (const analysis of results.asSubstituteProduct) {
      if (analysis.hasSubstitutionEffect) {
        netAdjustmentForThisProduct -= analysis.analysis.totalSubstitutionSales;
        adjustmentReasons.push(
          `-${analysis.analysis.totalSubstitutionSales} (substitution sales for ${analysis.primaryProductId})`
        );
      }
    }

    results.summary = {
      netAdjustment: Math.round(netAdjustmentForThisProduct),
      adjustmentReasons,
      recommendation: netAdjustmentForThisProduct !== 0
        ? `Adjust forecast by ${netAdjustmentForThisProduct > 0 ? '+' : ''}${Math.round(netAdjustmentForThisProduct)} units to reflect true demand`
        : 'No significant substitution effects detected',
    };

    return results;
  }

  /**
   * Get recommended forecast adjustments for a product pair
   */
  getRecommendedAdjustments(analysisResult) {
    if (!analysisResult.hasSubstitutionEffect) {
      return {
        primary: { adjustment: 0, useBaseline: false },
        substitute: { adjustment: 0, useBaseline: false },
      };
    }

    return {
      primary: {
        productId: analysisResult.primaryProductId,
        adjustment: analysisResult.adjustments.primary.adjustment,
        reason: analysisResult.adjustments.primary.reason,
        action: 'increase_order_quantity',
      },
      substitute: {
        productId: analysisResult.substituteProductId,
        baselineDailySales: analysisResult.adjustments.substitute.baselineDailySales,
        useBaseline: true,
        reason: analysisResult.adjustments.substitute.reason,
        action: 'use_baseline_not_recent_average',
      },
    };
  }
}

// Singleton instance
let substitutionAnalyzerInstance = null;

function getSubstitutionAnalyzer(config = {}) {
  if (!substitutionAnalyzerInstance) {
    substitutionAnalyzerInstance = new SubstitutionAnalyzer(config);
  } else if (config.db && !substitutionAnalyzerInstance.db) {
    substitutionAnalyzerInstance.setDb(config.db);
  }
  return substitutionAnalyzerInstance;
}

module.exports = {
  SubstitutionAnalyzer,
  getSubstitutionAnalyzer,
};
