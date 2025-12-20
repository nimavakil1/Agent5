/**
 * Slow-Mover Detection Service
 *
 * Analyzes inventory to detect:
 * - Products with >6 months of stock (slow-movers)
 * - Products with no sales in 1 month (red flags)
 * - New listings that shouldn't be flagged
 * - Products awaiting incoming stock
 *
 * Auto-detects product status from Odoo data instead of manual flags.
 *
 * @module SlowMoverDetector
 */

class SlowMoverDetector {
  constructor(config = {}) {
    this.odooClient = config.odooClient || null;
    this.db = config.db || null;

    // Thresholds (configurable via UI later)
    this.thresholds = {
      slowMoverDays: config.slowMoverDays || 180, // >6 months = slow-mover
      redFlagDays: config.redFlagDays || 30, // No sales in 1 month = red flag
      newListingDays: config.newListingDays || 30, // Product created < 30 days ago
      costOfCapital: config.costOfCapital || 0.05, // 5% per year
    };
  }

  setOdooClient(client) {
    this.odooClient = client;
  }

  setDb(db) {
    this.db = db;
  }

  /**
   * Analyze all products for slow-moving inventory
   * Returns prioritized list of products needing attention
   */
  async analyzeInventory() {
    if (!this.odooClient) {
      throw new Error('Odoo client not configured');
    }

    // Get all purchasable products with stock
    const products = await this._getProductsWithStock();

    // Get sales history for all products
    const salesHistory = await this._getSalesHistory();

    // Get incoming purchase orders
    const incomingPOs = await this._getIncomingPurchaseOrders();

    // Analyze each product
    const analysis = [];

    for (const product of products) {
      const productAnalysis = await this._analyzeProduct(
        product,
        salesHistory[product.id] || [],
        incomingPOs[product.id] || []
      );

      if (productAnalysis.needsAttention) {
        analysis.push(productAnalysis);
      }
    }

    // Sort by priority (holding cost * days overstocked)
    analysis.sort((a, b) => b.priority - a.priority);

    return {
      timestamp: new Date(),
      totalProducts: products.length,
      slowMovers: analysis.filter(p => p.status === 'slow_mover').length,
      redFlags: analysis.filter(p => p.status === 'red_flag').length,
      newListings: analysis.filter(p => p.status === 'new_listing').length,
      awaitingStock: analysis.filter(p => p.status === 'awaiting_stock').length,
      products: analysis
    };
  }

  /**
   * Analyze a single product
   */
  async _analyzeProduct(product, salesHistory, incomingPOs) {
    const now = new Date();

    // Calculate days of stock on hand
    const avgDailySales = this._calculateAvgDailySales(salesHistory);
    const daysOfStock = avgDailySales > 0
      ? Math.round(product.qtyOnHand / avgDailySales)
      : product.qtyOnHand > 0 ? 9999 : 0;

    // Calculate days since last sale
    const lastSaleDate = this._getLastSaleDate(salesHistory);
    const daysSinceLastSale = lastSaleDate
      ? Math.round((now - lastSaleDate) / (1000 * 60 * 60 * 24))
      : 9999;

    // Check if new listing
    const productCreatedDate = new Date(product.createDate);
    const daysSinceCreated = Math.round((now - productCreatedDate) / (1000 * 60 * 60 * 24));
    const isNewListing = daysSinceCreated < this.thresholds.newListingDays;

    // Check if awaiting stock
    const hasIncomingStock = incomingPOs.length > 0;
    const nextDeliveryDate = hasIncomingStock
      ? new Date(Math.min(...incomingPOs.map(po => new Date(po.expectedDate))))
      : null;

    // Determine status
    let status = 'normal';
    let needsAttention = false;

    if (isNewListing) {
      status = 'new_listing';
      // Don't flag new listings unless they have significant stock
    } else if (daysSinceLastSale >= this.thresholds.redFlagDays && product.qtyOnHand > 0) {
      status = 'red_flag';
      needsAttention = true;
    } else if (daysOfStock >= this.thresholds.slowMoverDays) {
      status = 'slow_mover';
      needsAttention = true;
    } else if (product.qtyOnHand <= 0 && hasIncomingStock) {
      status = 'awaiting_stock';
    }

    // Calculate holding cost
    const stockValue = product.qtyOnHand * product.standardPrice;
    const monthlyHoldingCost = (stockValue * this.thresholds.costOfCapital) / 12;

    // Calculate priority (higher = more urgent)
    const priority = needsAttention
      ? (monthlyHoldingCost * (daysOfStock / 30)) // Cost * months overstocked
      : 0;

    return {
      productId: product.id,
      productSku: product.defaultCode,
      productName: product.name,
      status,
      needsAttention,
      priority: Math.round(priority * 100) / 100,
      metrics: {
        qtyOnHand: product.qtyOnHand,
        avgDailySales: Math.round(avgDailySales * 100) / 100,
        daysOfStock,
        daysSinceLastSale,
        daysSinceCreated,
        stockValue: Math.round(stockValue * 100) / 100,
        monthlyHoldingCost: Math.round(monthlyHoldingCost * 100) / 100
      },
      incomingStock: hasIncomingStock ? {
        totalQty: incomingPOs.reduce((sum, po) => sum + po.qty, 0),
        nextDeliveryDate,
        poCount: incomingPOs.length
      } : null,
      recommendations: this._generateRecommendations(status, daysOfStock, daysSinceLastSale, product)
    };
  }

  /**
   * Generate recommendations based on status
   */
  _generateRecommendations(status, daysOfStock, daysSinceLastSale, product) {
    const recommendations = [];

    if (status === 'red_flag') {
      recommendations.push({
        type: 'investigate',
        priority: 'high',
        message: `No sales in ${daysSinceLastSale} days. Investigate immediately.`
      });

      if (daysSinceLastSale > 60) {
        recommendations.push({
          type: 'price_reduction',
          priority: 'high',
          message: 'Consider significant price reduction (15-25%)'
        });
      } else {
        recommendations.push({
          type: 'cpc_increase',
          priority: 'medium',
          message: 'Consider increasing advertising (CPC) first'
        });
      }
    }

    if (status === 'slow_mover') {
      if (daysOfStock > 365) {
        recommendations.push({
          type: 'write_off_review',
          priority: 'high',
          message: `${daysOfStock} days of stock. Consider write-off or liquidation.`
        });
      } else if (daysOfStock > 270) {
        recommendations.push({
          type: 'price_reduction',
          priority: 'high',
          message: 'Consider 15-20% price reduction'
        });
      } else {
        recommendations.push({
          type: 'price_reduction',
          priority: 'medium',
          message: 'Consider 10-15% price reduction'
        });
      }
    }

    return recommendations;
  }

  /**
   * Calculate average daily sales from history
   */
  _calculateAvgDailySales(salesHistory) {
    if (!salesHistory || salesHistory.length === 0) return 0;

    // Use last 90 days of sales
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const recentSales = salesHistory.filter(s => new Date(s.date) >= ninetyDaysAgo);
    const totalQty = recentSales.reduce((sum, s) => sum + s.quantity, 0);

    return totalQty / 90;
  }

  /**
   * Get last sale date from history
   */
  _getLastSaleDate(salesHistory) {
    if (!salesHistory || salesHistory.length === 0) return null;

    const dates = salesHistory.map(s => new Date(s.date));
    return new Date(Math.max(...dates));
  }

  /**
   * Get all purchasable products with stock data
   */
  async _getProductsWithStock() {
    const products = await this.odooClient.executeKw(
      'product.product',
      'search_read',
      [[['purchase_ok', '=', true], ['type', '=', 'product']]],
      {
        fields: [
          'id', 'name', 'default_code', 'qty_available',
          'standard_price', 'create_date', 'categ_id'
        ]
      }
    );

    return products.map(p => ({
      id: p.id,
      name: p.name,
      defaultCode: p.default_code || '',
      qtyOnHand: p.qty_available || 0,
      standardPrice: p.standard_price || 0,
      createDate: p.create_date,
      categoryId: p.categ_id?.[0] || null
    }));
  }

  /**
   * Get sales history for all products
   * Returns object keyed by product ID
   */
  async _getSalesHistory() {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const salesLines = await this.odooClient.executeKw(
      'sale.order.line',
      'search_read',
      [[
        ['order_id.state', 'in', ['sale', 'done']],
        ['order_id.date_order', '>=', oneYearAgo.toISOString().split('T')[0]]
      ]],
      {
        fields: ['product_id', 'product_uom_qty', 'order_id']
      }
    );

    // Get order dates
    const orderIds = [...new Set(salesLines.map(l => l.order_id[0]))];
    const orders = await this.odooClient.executeKw(
      'sale.order',
      'search_read',
      [[['id', 'in', orderIds]]],
      { fields: ['id', 'date_order'] }
    );

    const orderDates = {};
    for (const order of orders) {
      orderDates[order.id] = order.date_order;
    }

    // Group by product
    const salesByProduct = {};
    for (const line of salesLines) {
      const productId = line.product_id[0];
      if (!salesByProduct[productId]) {
        salesByProduct[productId] = [];
      }
      salesByProduct[productId].push({
        date: orderDates[line.order_id[0]],
        quantity: line.product_uom_qty
      });
    }

    return salesByProduct;
  }

  /**
   * Get incoming purchase orders
   * Returns object keyed by product ID
   */
  async _getIncomingPurchaseOrders() {
    const poLines = await this.odooClient.executeKw(
      'purchase.order.line',
      'search_read',
      [[
        ['order_id.state', 'in', ['purchase', 'done']],
        ['qty_received', '<', 'product_qty'] // Not fully received
      ]],
      {
        fields: ['product_id', 'product_qty', 'qty_received', 'date_planned']
      }
    );

    // Group by product
    const poByProduct = {};
    for (const line of poLines) {
      const productId = line.product_id[0];
      const remainingQty = line.product_qty - line.qty_received;

      if (remainingQty > 0) {
        if (!poByProduct[productId]) {
          poByProduct[productId] = [];
        }
        poByProduct[productId].push({
          qty: remainingQty,
          expectedDate: line.date_planned
        });
      }
    }

    return poByProduct;
  }

  /**
   * Quick check for a single product
   */
  async checkProduct(productId) {
    const products = await this.odooClient.executeKw(
      'product.product',
      'search_read',
      [[['id', '=', productId]]],
      {
        fields: [
          'id', 'name', 'default_code', 'qty_available',
          'standard_price', 'create_date', 'categ_id'
        ]
      }
    );

    if (products.length === 0) {
      throw new Error(`Product ${productId} not found`);
    }

    const product = {
      id: products[0].id,
      name: products[0].name,
      defaultCode: products[0].default_code || '',
      qtyOnHand: products[0].qty_available || 0,
      standardPrice: products[0].standard_price || 0,
      createDate: products[0].create_date,
      categoryId: products[0].categ_id?.[0] || null
    };

    const salesHistory = await this._getSalesHistory();
    const incomingPOs = await this._getIncomingPurchaseOrders();

    return this._analyzeProduct(
      product,
      salesHistory[productId] || [],
      incomingPOs[productId] || []
    );
  }
}

module.exports = { SlowMoverDetector };
