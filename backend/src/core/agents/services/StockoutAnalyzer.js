/**
 * StockoutAnalyzer Service
 *
 * Analyzes the impact of historical stockouts:
 * - Identifies stockout periods
 * - Estimates lost sales during stockouts
 * - Calculates recovery patterns after restock
 * - Provides insights for inventory optimization
 */

class StockoutAnalyzer {
  constructor(config = {}) {
    this.stockoutThreshold = config.stockoutThreshold || 0; // Units below which considered out of stock
    this.minimumStockoutDays = config.minimumStockoutDays || 1; // Minimum days to count as stockout
  }

  /**
   * Identify stockout periods from inventory history
   * @param {Array} inventoryHistory - Array of {date, stockLevel} objects
   */
  identifyStockoutPeriods(inventoryHistory) {
    if (!inventoryHistory || inventoryHistory.length === 0) {
      return { stockouts: [], message: 'No inventory history provided' };
    }

    // Sort by date
    const sorted = [...inventoryHistory].sort((a, b) => new Date(a.date) - new Date(b.date));

    const stockouts = [];
    let currentStockout = null;

    for (const record of sorted) {
      const isOutOfStock = (record.stockLevel || 0) <= this.stockoutThreshold;

      if (isOutOfStock && !currentStockout) {
        // Start of stockout
        currentStockout = {
          startDate: new Date(record.date),
          startLevel: record.stockLevel,
          dailyLevels: [record],
        };
      } else if (isOutOfStock && currentStockout) {
        // Continue stockout
        currentStockout.dailyLevels.push(record);
      } else if (!isOutOfStock && currentStockout) {
        // End of stockout
        currentStockout.endDate = new Date(record.date);
        currentStockout.endLevel = record.stockLevel;
        currentStockout.durationDays = Math.ceil(
          (currentStockout.endDate - currentStockout.startDate) / (1000 * 60 * 60 * 24)
        );

        // Only count if meets minimum duration
        if (currentStockout.durationDays >= this.minimumStockoutDays) {
          stockouts.push(currentStockout);
        }

        currentStockout = null;
      }
    }

    // Handle ongoing stockout
    if (currentStockout) {
      currentStockout.endDate = null;
      currentStockout.ongoing = true;
      currentStockout.durationDays = Math.ceil(
        (new Date() - currentStockout.startDate) / (1000 * 60 * 60 * 24)
      );
      stockouts.push(currentStockout);
    }

    return {
      stockouts,
      totalStockoutPeriods: stockouts.length,
      totalStockoutDays: stockouts.reduce((sum, s) => sum + s.durationDays, 0),
    };
  }

  /**
   * Estimate lost sales during stockout periods
   * Uses surrounding sales data to estimate what would have been sold
   */
  estimateLostSales(stockoutPeriods, salesHistory, _inventoryHistory) {
    if (!stockoutPeriods || stockoutPeriods.length === 0) {
      return { lostSales: [], totalLostUnits: 0, totalLostRevenue: 0 };
    }

    // Build a map of daily sales before/after stockout periods
    const salesByDate = new Map();
    for (const sale of salesHistory) {
      const dateKey = new Date(sale.date).toISOString().split('T')[0];
      if (!salesByDate.has(dateKey)) {
        salesByDate.set(dateKey, { quantity: 0, revenue: 0 });
      }
      const day = salesByDate.get(dateKey);
      day.quantity += sale.quantity || 0;
      day.revenue += sale.revenue || 0;
    }

    const lostSalesAnalysis = stockoutPeriods.map(stockout => {
      // Get sales data from 14 days before the stockout
      const lookbackDays = 14;
      const beforeStart = new Date(stockout.startDate);
      beforeStart.setDate(beforeStart.getDate() - lookbackDays);

      let totalBeforeSales = 0;
      let totalBeforeRevenue = 0;
      let beforeDays = 0;

      for (let d = new Date(beforeStart); d < stockout.startDate; d.setDate(d.getDate() + 1)) {
        const dateKey = d.toISOString().split('T')[0];
        const dayData = salesByDate.get(dateKey);
        if (dayData) {
          totalBeforeSales += dayData.quantity;
          totalBeforeRevenue += dayData.revenue;
        }
        beforeDays++;
      }

      // Calculate average daily sales before stockout
      const avgDailySales = beforeDays > 0 ? totalBeforeSales / beforeDays : 0;
      const avgDailyRevenue = beforeDays > 0 ? totalBeforeRevenue / beforeDays : 0;

      // Estimate lost sales during stockout
      const estimatedLostUnits = Math.round(avgDailySales * stockout.durationDays);
      const estimatedLostRevenue = Math.round(avgDailyRevenue * stockout.durationDays * 100) / 100;

      return {
        stockoutStart: stockout.startDate,
        stockoutEnd: stockout.endDate,
        durationDays: stockout.durationDays,
        ongoing: stockout.ongoing || false,
        avgDailySalesBeforeStockout: Math.round(avgDailySales * 10) / 10,
        avgDailyRevenueBeforeStockout: Math.round(avgDailyRevenue * 100) / 100,
        estimatedLostUnits,
        estimatedLostRevenue,
      };
    });

    const totalLostUnits = lostSalesAnalysis.reduce((sum, ls) => sum + ls.estimatedLostUnits, 0);
    const totalLostRevenue = lostSalesAnalysis.reduce((sum, ls) => sum + ls.estimatedLostRevenue, 0);

    return {
      lostSales: lostSalesAnalysis,
      totalLostUnits,
      totalLostRevenue: Math.round(totalLostRevenue * 100) / 100,
      totalStockoutDays: stockoutPeriods.reduce((sum, s) => sum + s.durationDays, 0),
    };
  }

  /**
   * Analyze recovery pattern after stockout
   * How quickly do sales return to normal after restocking?
   */
  analyzeRecoveryPattern(stockoutPeriod, salesHistory) {
    if (!stockoutPeriod.endDate) {
      return { message: 'Stockout ongoing, cannot analyze recovery' };
    }

    const salesByDate = new Map();
    for (const sale of salesHistory) {
      const dateKey = new Date(sale.date).toISOString().split('T')[0];
      if (!salesByDate.has(dateKey)) {
        salesByDate.set(dateKey, { quantity: 0, revenue: 0 });
      }
      const day = salesByDate.get(dateKey);
      day.quantity += sale.quantity || 0;
      day.revenue += sale.revenue || 0;
    }

    // Calculate baseline (14 days before stockout)
    const lookbackDays = 14;
    const beforeStart = new Date(stockoutPeriod.startDate);
    beforeStart.setDate(beforeStart.getDate() - lookbackDays);

    let baselineSales = 0;
    let baselineDays = 0;

    for (let d = new Date(beforeStart); d < stockoutPeriod.startDate; d.setDate(d.getDate() + 1)) {
      const dateKey = d.toISOString().split('T')[0];
      const dayData = salesByDate.get(dateKey);
      if (dayData) {
        baselineSales += dayData.quantity;
        baselineDays++;
      }
    }

    const avgDailyBaseline = baselineDays > 0 ? baselineSales / baselineDays : 0;

    // Analyze post-restock sales (up to 30 days)
    const recoveryDays = 30;
    const dailyRecovery = [];
    let cumulativeRecoverySales = 0;
    let peakDay = null;
    let peakSales = 0;

    for (let i = 0; i < recoveryDays; i++) {
      const checkDate = new Date(stockoutPeriod.endDate);
      checkDate.setDate(checkDate.getDate() + i);
      const dateKey = checkDate.toISOString().split('T')[0];
      const dayData = salesByDate.get(dateKey);

      const dailySales = dayData?.quantity || 0;
      cumulativeRecoverySales += dailySales;

      const percentOfBaseline = avgDailyBaseline > 0 ? (dailySales / avgDailyBaseline) * 100 : 0;

      dailyRecovery.push({
        day: i + 1,
        date: checkDate.toISOString().split('T')[0],
        sales: dailySales,
        percentOfBaseline: Math.round(percentOfBaseline),
      });

      if (dailySales > peakSales) {
        peakSales = dailySales;
        peakDay = i + 1;
      }
    }

    // Find day when sales return to baseline
    let daysToRecover = null;
    for (let i = 0; i < dailyRecovery.length; i++) {
      if (dailyRecovery[i].percentOfBaseline >= 95) {
        daysToRecover = i + 1;
        break;
      }
    }

    // Calculate total recovery vs lost sales
    const estimatedLostDuringStockout = avgDailyBaseline * stockoutPeriod.durationDays;
    const excessRecoverySales = Math.max(0, cumulativeRecoverySales - (avgDailyBaseline * recoveryDays));
    const compensationPercent = estimatedLostDuringStockout > 0
      ? (excessRecoverySales / estimatedLostDuringStockout) * 100
      : 0;

    return {
      stockoutDuration: stockoutPeriod.durationDays,
      baselineDailySales: Math.round(avgDailyBaseline * 10) / 10,
      recovery: {
        dailyRecovery: dailyRecovery.slice(0, 14), // First 14 days
        daysToRecover,
        peakDay,
        peakSales,
        peakMultiplier: avgDailyBaseline > 0 ? (peakSales / avgDailyBaseline).toFixed(2) : 0,
      },
      compensation: {
        estimatedLostUnits: Math.round(estimatedLostDuringStockout),
        recoveryPeriodSales: cumulativeRecoverySales,
        excessSales: Math.round(excessRecoverySales),
        compensationPercent: Math.round(compensationPercent),
        fullyCompensated: compensationPercent >= 100,
      },
      insight: this.generateRecoveryInsight(daysToRecover, compensationPercent, peakSales, avgDailyBaseline),
    };
  }

  /**
   * Generate insight message about recovery
   */
  generateRecoveryInsight(daysToRecover, compensationPercent, peakSales, baseline) {
    const messages = [];

    if (daysToRecover) {
      messages.push(`Sales recovered to baseline in ${daysToRecover} days.`);
    } else {
      messages.push('Sales did not fully recover within 30 days.');
    }

    if (peakSales > baseline * 1.5) {
      messages.push(`Post-restock peak was ${(peakSales / baseline).toFixed(1)}x baseline - customers were waiting!`);
    }

    if (compensationPercent < 50) {
      messages.push(`Only ${compensationPercent}% of lost sales were recovered. Stockouts cause permanent revenue loss!`);
    } else if (compensationPercent < 100) {
      messages.push(`${compensationPercent}% compensation suggests significant permanent loss.`);
    }

    return messages.join(' ');
  }

  /**
   * Calculate stockout cost for a product
   */
  calculateStockoutCost(params) {
    const {
      stockoutDays,
      avgDailySales,
      avgSellingPrice,
      profitMargin = 0.3, // 30% default
      customerLifetimeValue = null,
      customerChurnRate = 0.1, // 10% of customers lost during stockout
    } = params;

    // Direct lost sales
    const lostUnits = stockoutDays * avgDailySales;
    const lostRevenue = lostUnits * avgSellingPrice;
    const lostProfit = lostRevenue * profitMargin;

    // Long-term customer impact (if CLV provided)
    let customerImpact = null;
    if (customerLifetimeValue) {
      const estimatedCustomersAffected = lostUnits; // Assume 1 customer per unit
      const customersLost = estimatedCustomersAffected * customerChurnRate;
      const lifetimeValueLost = customersLost * customerLifetimeValue;

      customerImpact = {
        estimatedCustomersAffected,
        estimatedCustomersLost: Math.round(customersLost),
        lifetimeValueLost: Math.round(lifetimeValueLost),
      };
    }

    return {
      stockoutDays,
      directImpact: {
        lostUnits: Math.round(lostUnits),
        lostRevenue: Math.round(lostRevenue * 100) / 100,
        lostProfit: Math.round(lostProfit * 100) / 100,
      },
      customerImpact,
      totalEstimatedCost: Math.round((lostProfit + (customerImpact?.lifetimeValueLost || 0)) * 100) / 100,
      dailyCost: Math.round((lostProfit / stockoutDays) * 100) / 100,
    };
  }

  /**
   * Generate comprehensive stockout report for a product
   */
  generateStockoutReport(params) {
    const {
      productId,
      productName,
      inventoryHistory,
      salesHistory,
      avgSellingPrice,
      profitMargin = 0.3,
    } = params;

    // Identify stockout periods
    const stockoutPeriods = this.identifyStockoutPeriods(inventoryHistory);

    // Estimate lost sales
    const lostSalesAnalysis = this.estimateLostSales(
      stockoutPeriods.stockouts,
      salesHistory,
      inventoryHistory
    );

    // Analyze recovery for each stockout
    const recoveryAnalyses = stockoutPeriods.stockouts
      .filter(s => !s.ongoing)
      .map(stockout => ({
        period: `${stockout.startDate.toISOString().split('T')[0]} to ${stockout.endDate.toISOString().split('T')[0]}`,
        recovery: this.analyzeRecoveryPattern(stockout, salesHistory),
      }));

    // Calculate total cost
    const totalCost = this.calculateStockoutCost({
      stockoutDays: stockoutPeriods.totalStockoutDays,
      avgDailySales: lostSalesAnalysis.totalLostUnits / Math.max(1, stockoutPeriods.totalStockoutDays),
      avgSellingPrice,
      profitMargin,
    });

    // Generate recommendations
    const recommendations = this.generateRecommendations(stockoutPeriods, lostSalesAnalysis, recoveryAnalyses);

    return {
      productId,
      productName,
      reportDate: new Date(),
      summary: {
        totalStockoutPeriods: stockoutPeriods.totalStockoutPeriods,
        totalStockoutDays: stockoutPeriods.totalStockoutDays,
        totalLostUnits: lostSalesAnalysis.totalLostUnits,
        totalLostRevenue: lostSalesAnalysis.totalLostRevenue,
        estimatedProfitLoss: totalCost.directImpact.lostProfit,
      },
      stockoutPeriods: stockoutPeriods.stockouts.map(s => ({
        start: s.startDate,
        end: s.endDate,
        duration: s.durationDays,
        ongoing: s.ongoing || false,
      })),
      lostSalesAnalysis,
      recoveryAnalyses,
      costAnalysis: totalCost,
      recommendations,
      riskAssessment: this.assessStockoutRisk(stockoutPeriods),
    };
  }

  /**
   * Generate recommendations based on stockout analysis
   */
  generateRecommendations(stockoutPeriods, lostSalesAnalysis, recoveryAnalyses) {
    const recommendations = [];

    if (stockoutPeriods.totalStockoutPeriods > 3) {
      recommendations.push({
        priority: 'HIGH',
        category: 'inventory_management',
        recommendation: 'Frequent stockouts detected. Increase safety stock levels by 20-30%.',
      });
    }

    if (stockoutPeriods.totalStockoutDays > 30) {
      recommendations.push({
        priority: 'HIGH',
        category: 'supplier_management',
        recommendation: 'Extended stockout periods suggest supply chain issues. Consider backup suppliers or increased order frequency.',
      });
    }

    const avgRecoveryCompensation = recoveryAnalyses.length > 0
      ? recoveryAnalyses.reduce((sum, r) => sum + (r.recovery.compensation?.compensationPercent || 0), 0) / recoveryAnalyses.length
      : 100;

    if (avgRecoveryCompensation < 80) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'revenue_protection',
        recommendation: `Stockout recovery is only ${Math.round(avgRecoveryCompensation)}%. Lost sales are permanent - prioritize stock availability over cost optimization.`,
      });
    }

    if (lostSalesAnalysis.totalLostRevenue > 10000) {
      recommendations.push({
        priority: 'HIGH',
        category: 'financial_impact',
        recommendation: `Significant revenue loss (€${lostSalesAnalysis.totalLostRevenue.toLocaleString()}) from stockouts. Consider expedited shipping for critical restocks.`,
      });
    }

    if (stockoutPeriods.stockouts.some(s => s.ongoing)) {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'immediate_action',
        recommendation: 'Product currently out of stock! Take immediate action to restock.',
      });
    }

    return recommendations;
  }

  /**
   * Assess overall stockout risk
   */
  assessStockoutRisk(stockoutPeriods) {
    const riskFactors = [];
    let riskScore = 0;

    if (stockoutPeriods.totalStockoutPeriods >= 5) {
      riskFactors.push('High frequency of stockouts');
      riskScore += 30;
    } else if (stockoutPeriods.totalStockoutPeriods >= 2) {
      riskFactors.push('Moderate frequency of stockouts');
      riskScore += 15;
    }

    if (stockoutPeriods.totalStockoutDays >= 60) {
      riskFactors.push('Extended total stockout duration');
      riskScore += 30;
    } else if (stockoutPeriods.totalStockoutDays >= 20) {
      riskFactors.push('Significant stockout duration');
      riskScore += 15;
    }

    if (stockoutPeriods.stockouts.some(s => s.ongoing)) {
      riskFactors.push('Currently out of stock');
      riskScore += 40;
    }

    let riskLevel;
    if (riskScore >= 60) {
      riskLevel = 'HIGH';
    } else if (riskScore >= 30) {
      riskLevel = 'MEDIUM';
    } else {
      riskLevel = 'LOW';
    }

    return {
      riskLevel,
      riskScore,
      riskFactors,
    };
  }
}

// Singleton instance
let stockoutAnalyzerInstance = null;

function getStockoutAnalyzer(config = {}) {
  if (!stockoutAnalyzerInstance) {
    stockoutAnalyzerInstance = new StockoutAnalyzer(config);
  }
  return stockoutAnalyzerInstance;
}

module.exports = {
  StockoutAnalyzer,
  getStockoutAnalyzer,
};
