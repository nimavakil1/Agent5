/**
 * Purchasing Intelligence Services
 *
 * Export all services for the Purchasing Intelligence Agent
 */

const { SeasonalCalendar, getSeasonalCalendar } = require('./SeasonalCalendar');
const { ForecastEngine, getForecastEngine } = require('./ForecastEngine');
const { SupplyChainManager, getSupplyChainManager } = require('./SupplyChainManager');
const { StockoutAnalyzer, getStockoutAnalyzer } = require('./StockoutAnalyzer');
const { PurchasingContext, getPurchasingContext } = require('./PurchasingContext');

module.exports = {
  // Classes
  SeasonalCalendar,
  ForecastEngine,
  SupplyChainManager,
  StockoutAnalyzer,
  PurchasingContext,

  // Singleton getters
  getSeasonalCalendar,
  getForecastEngine,
  getSupplyChainManager,
  getStockoutAnalyzer,
  getPurchasingContext,
};
