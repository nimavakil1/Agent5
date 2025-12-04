/**
 * Purchasing Agent
 *
 * Manages procurement and supplier relationships:
 * - Purchase order management
 * - Supplier communication monitoring
 * - Price tracking and negotiation support
 * - Inventory-based auto-ordering recommendations
 * - Supplier performance analysis
 * - Payment tracking
 *
 * Integrates with:
 * - Odoo Purchase module
 * - Supplier emails (via CommunicationAgent)
 * - Inventory data
 *
 * @module PurchasingAgent
 */

const { LLMAgent } = require('../LLMAgent');

/**
 * Purchase order status
 */
const POStatus = {
  DRAFT: 'draft',
  SENT: 'sent',
  TO_APPROVE: 'to approve',
  PURCHASE: 'purchase',
  DONE: 'done',
  CANCEL: 'cancel'
};

/**
 * Supplier rating
 */
const SupplierRating = {
  EXCELLENT: 'excellent',
  GOOD: 'good',
  AVERAGE: 'average',
  POOR: 'poor',
  CRITICAL: 'critical'
};

class PurchasingAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Purchasing Agent',
      role: 'purchasing',
      capabilities: [
        'purchase_order_management',
        'supplier_management',
        'price_tracking',
        'reorder_recommendations',
        'supplier_analysis',
        'payment_tracking'
      ],
      ...config
    });

    // Odoo client
    this.odooClient = config.odooClient || null;

    // Supplier tracking
    this.supplierCache = new Map();
    this.priceHistory = new Map();

    // Settings
    this.settings = {
      reorderLeadDays: config.reorderLeadDays || 7,
      minStockDays: config.minStockDays || 14,
      priceIncreaseAlertThreshold: config.priceIncreaseAlertThreshold || 0.1,  // 10%
      requireApprovalAbove: config.requireApprovalAbove || 1000
    };

    // Define tools
    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      // ==================== PURCHASE ORDERS ====================
      {
        name: 'get_purchase_orders',
        description: 'Get purchase orders with optional filters',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['draft', 'sent', 'to approve', 'purchase', 'done', 'all'],
              default: 'all'
            },
            supplier: {
              type: 'string',
              description: 'Filter by supplier name'
            },
            days_back: {
              type: 'number',
              default: 30
            }
          }
        },
        handler: this._getPurchaseOrders.bind(this)
      },
      {
        name: 'get_purchase_order_details',
        description: 'Get detailed information about a specific PO',
        parameters: {
          type: 'object',
          properties: {
            po_id: { type: 'number', description: 'Purchase order ID' }
          },
          required: ['po_id']
        },
        handler: this._getPurchaseOrderDetails.bind(this)
      },
      {
        name: 'get_pending_orders',
        description: 'Get orders pending receipt or approval',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getPendingOrders.bind(this)
      },
      {
        name: 'create_purchase_order',
        description: 'Create a new purchase order (requires approval)',
        parameters: {
          type: 'object',
          properties: {
            supplier_id: { type: 'number' },
            products: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product_id: { type: 'number' },
                  quantity: { type: 'number' },
                  price: { type: 'number' }
                }
              }
            },
            notes: { type: 'string' }
          },
          required: ['supplier_id', 'products']
        },
        handler: this._createPurchaseOrder.bind(this)
      },

      // ==================== SUPPLIERS ====================
      {
        name: 'get_suppliers',
        description: 'Get all suppliers',
        parameters: {
          type: 'object',
          properties: {
            active_only: { type: 'boolean', default: true }
          }
        },
        handler: this._getSuppliers.bind(this)
      },
      {
        name: 'get_supplier_details',
        description: 'Get detailed supplier information including history',
        parameters: {
          type: 'object',
          properties: {
            supplier_id: { type: 'number' }
          },
          required: ['supplier_id']
        },
        handler: this._getSupplierDetails.bind(this)
      },
      {
        name: 'analyze_supplier_performance',
        description: 'Analyze supplier performance metrics',
        parameters: {
          type: 'object',
          properties: {
            supplier_id: { type: 'number' },
            period_months: { type: 'number', default: 6 }
          },
          required: ['supplier_id']
        },
        handler: this._analyzeSupplierPerformance.bind(this)
      },
      {
        name: 'compare_suppliers',
        description: 'Compare multiple suppliers for a product',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' }
          },
          required: ['product_id']
        },
        handler: this._compareSuppliers.bind(this)
      },

      // ==================== INVENTORY & REORDERING ====================
      {
        name: 'get_reorder_recommendations',
        description: 'Get products that need reordering based on stock levels',
        parameters: {
          type: 'object',
          properties: {
            urgent_only: { type: 'boolean', default: false }
          }
        },
        handler: this._getReorderRecommendations.bind(this)
      },
      {
        name: 'get_low_stock_items',
        description: 'Get items with stock below minimum levels',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getLowStockItems.bind(this)
      },
      {
        name: 'calculate_optimal_order_quantity',
        description: 'Calculate optimal order quantity for a product',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' }
          },
          required: ['product_id']
        },
        handler: this._calculateOptimalOrderQuantity.bind(this)
      },

      // ==================== PRICING ====================
      {
        name: 'get_price_history',
        description: 'Get price history for a product from suppliers',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' },
            months_back: { type: 'number', default: 12 }
          },
          required: ['product_id']
        },
        handler: this._getPriceHistory.bind(this)
      },
      {
        name: 'detect_price_changes',
        description: 'Detect significant price changes from suppliers',
        parameters: {
          type: 'object',
          properties: {
            threshold_percent: { type: 'number', default: 10 }
          }
        },
        handler: this._detectPriceChanges.bind(this)
      },

      // ==================== PAYMENTS ====================
      {
        name: 'get_outstanding_payments',
        description: 'Get unpaid supplier invoices',
        parameters: {
          type: 'object',
          properties: {
            overdue_only: { type: 'boolean', default: false }
          }
        },
        handler: this._getOutstandingPayments.bind(this)
      },
      {
        name: 'get_payment_schedule',
        description: 'Get upcoming payment schedule',
        parameters: {
          type: 'object',
          properties: {
            days_ahead: { type: 'number', default: 30 }
          }
        },
        handler: this._getPaymentSchedule.bind(this)
      },

      // ==================== ANALYTICS ====================
      {
        name: 'get_purchasing_summary',
        description: 'Get purchasing summary and statistics',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['month', 'quarter', 'year'], default: 'month' }
          }
        },
        handler: this._getPurchasingSummary.bind(this)
      },
      {
        name: 'get_top_products_purchased',
        description: 'Get most purchased products',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 20 }
          }
        },
        handler: this._getTopProductsPurchased.bind(this)
      }
    ];
  }

  // ==================== PURCHASE ORDERS ====================

  async _getPurchaseOrders(params = {}) {
    const { status = 'all', supplier, days_back = 30 } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const domain = [];

    if (status !== 'all') {
      domain.push(['state', '=', status]);
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days_back);
    domain.push(['create_date', '>=', cutoffDate.toISOString().split('T')[0]]);

    const orders = await this.odooClient.searchRead('purchase.order', domain, [
      'name', 'partner_id', 'date_order', 'date_planned', 'amount_total',
      'state', 'invoice_status', 'receipt_status', 'user_id'
    ], { order: 'date_order desc', limit: 100 });

    let filtered = orders;
    if (supplier) {
      filtered = orders.filter(o =>
        o.partner_id?.[1]?.toLowerCase().includes(supplier.toLowerCase())
      );
    }

    return {
      orders: filtered.map(o => ({
        id: o.id,
        name: o.name,
        supplier: o.partner_id?.[1],
        supplierId: o.partner_id?.[0],
        orderDate: o.date_order,
        plannedDate: o.date_planned,
        total: o.amount_total,
        status: o.state,
        invoiceStatus: o.invoice_status,
        receiptStatus: o.receipt_status,
        buyer: o.user_id?.[1]
      })),
      count: filtered.length,
      totalValue: filtered.reduce((sum, o) => sum + (o.amount_total || 0), 0)
    };
  }

  async _getPurchaseOrderDetails(params) {
    const { po_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const order = await this.odooClient.read('purchase.order', [po_id], [
      'name', 'partner_id', 'date_order', 'date_planned', 'amount_total',
      'state', 'notes', 'order_line', 'invoice_ids', 'picking_ids'
    ]);

    if (!order.length) return { error: 'Order not found' };

    const po = order[0];

    // Get order lines
    const lines = await this.odooClient.read('purchase.order.line', po.order_line, [
      'product_id', 'name', 'product_qty', 'qty_received', 'price_unit',
      'price_subtotal', 'date_planned'
    ]);

    return {
      id: po.id,
      name: po.name,
      supplier: po.partner_id?.[1],
      orderDate: po.date_order,
      plannedDate: po.date_planned,
      total: po.amount_total,
      status: po.state,
      notes: po.notes,
      lines: lines.map(l => ({
        product: l.product_id?.[1],
        productId: l.product_id?.[0],
        description: l.name,
        quantity: l.product_qty,
        received: l.qty_received,
        unitPrice: l.price_unit,
        subtotal: l.price_subtotal,
        plannedDate: l.date_planned
      })),
      invoiceCount: po.invoice_ids?.length || 0,
      deliveryCount: po.picking_ids?.length || 0
    };
  }

  async _getPendingOrders(_params = {}) {
    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    // Get orders pending approval
    const toApprove = await this.odooClient.searchRead('purchase.order', [
      ['state', '=', 'to approve']
    ], ['name', 'partner_id', 'amount_total', 'date_order', 'user_id']);

    // Get confirmed orders pending receipt
    const pendingReceipt = await this.odooClient.searchRead('purchase.order', [
      ['state', '=', 'purchase'],
      ['receipt_status', '!=', 'full']
    ], ['name', 'partner_id', 'amount_total', 'date_planned', 'user_id']);

    return {
      pendingApproval: toApprove.map(o => ({
        id: o.id,
        name: o.name,
        supplier: o.partner_id?.[1],
        total: o.amount_total,
        orderDate: o.date_order,
        requester: o.user_id?.[1]
      })),
      pendingReceipt: pendingReceipt.map(o => ({
        id: o.id,
        name: o.name,
        supplier: o.partner_id?.[1],
        total: o.amount_total,
        expectedDate: o.date_planned
      })),
      counts: {
        pendingApproval: toApprove.length,
        pendingReceipt: pendingReceipt.length
      }
    };
  }

  async _createPurchaseOrder(params) {
    const { supplier_id, products, notes } = params;

    // Calculate total for approval check
    const total = products.reduce((sum, p) => sum + (p.quantity * p.price), 0);

    if (total > this.settings.requireApprovalAbove) {
      return {
        status: 'pending_approval',
        reason: `Order total €${total.toFixed(2)} exceeds approval threshold €${this.settings.requireApprovalAbove}`,
        orderDetails: { supplier_id, products, notes, total }
      };
    }

    // This would create the PO in Odoo
    return {
      status: 'pending_approval',
      message: 'Purchase order creation requires human approval',
      orderDetails: { supplier_id, products, notes, total }
    };
  }

  // ==================== SUPPLIERS ====================

  async _getSuppliers(params = {}) {
    const { active_only = true } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const domain = [['supplier_rank', '>', 0]];
    if (active_only) {
      domain.push(['active', '=', true]);
    }

    const suppliers = await this.odooClient.searchRead('res.partner', domain, [
      'name', 'email', 'phone', 'city', 'country_id',
      'supplier_rank', 'credit', 'debit'
    ], { limit: 200 });

    return {
      suppliers: suppliers.map(s => ({
        id: s.id,
        name: s.name,
        email: s.email,
        phone: s.phone,
        location: `${s.city || ''}, ${s.country_id?.[1] || ''}`.trim(),
        balance: s.credit - s.debit
      })),
      count: suppliers.length
    };
  }

  async _getSupplierDetails(params) {
    const { supplier_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const supplier = await this.odooClient.read('res.partner', [supplier_id], [
      'name', 'email', 'phone', 'mobile', 'street', 'city', 'country_id',
      'website', 'credit', 'debit', 'supplier_rank', 'comment'
    ]);

    if (!supplier.length) return { error: 'Supplier not found' };

    const s = supplier[0];

    // Get recent orders
    const recentOrders = await this.odooClient.searchRead('purchase.order', [
      ['partner_id', '=', supplier_id],
      ['state', 'in', ['purchase', 'done']]
    ], ['name', 'date_order', 'amount_total', 'state'], {
      order: 'date_order desc',
      limit: 10
    });

    // Get products from this supplier
    const supplierInfo = await this.odooClient.searchRead('product.supplierinfo', [
      ['partner_id', '=', supplier_id]
    ], ['product_tmpl_id', 'price', 'delay'], { limit: 50 });

    return {
      id: s.id,
      name: s.name,
      contact: {
        email: s.email,
        phone: s.phone,
        mobile: s.mobile,
        website: s.website
      },
      address: {
        street: s.street,
        city: s.city,
        country: s.country_id?.[1]
      },
      financials: {
        credit: s.credit,
        debit: s.debit,
        balance: s.credit - s.debit
      },
      recentOrders: recentOrders.map(o => ({
        name: o.name,
        date: o.date_order,
        total: o.amount_total,
        status: o.state
      })),
      productCount: supplierInfo.length,
      avgLeadTime: supplierInfo.length > 0
        ? (supplierInfo.reduce((sum, i) => sum + (i.delay || 0), 0) / supplierInfo.length).toFixed(1)
        : null,
      notes: s.comment
    };
  }

  async _analyzeSupplierPerformance(params) {
    const { supplier_id, period_months = 6 } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - period_months);

    // Get all orders in period
    const orders = await this.odooClient.searchRead('purchase.order', [
      ['partner_id', '=', supplier_id],
      ['state', 'in', ['purchase', 'done']],
      ['date_order', '>=', cutoffDate.toISOString().split('T')[0]]
    ], ['name', 'date_order', 'date_planned', 'amount_total', 'picking_ids']);

    // Analyze delivery performance
    let onTimeDeliveries = 0;
    let lateDeliveries = 0;
    let totalValue = 0;

    for (const order of orders) {
      totalValue += order.amount_total || 0;
      // Would need to check actual delivery dates vs planned
      // Simplified for now
      onTimeDeliveries++;
    }

    const orderCount = orders.length;
    const onTimeRate = orderCount > 0 ? (onTimeDeliveries / orderCount * 100) : 0;

    let rating = SupplierRating.AVERAGE;
    if (onTimeRate >= 95) rating = SupplierRating.EXCELLENT;
    else if (onTimeRate >= 85) rating = SupplierRating.GOOD;
    else if (onTimeRate >= 70) rating = SupplierRating.AVERAGE;
    else if (onTimeRate >= 50) rating = SupplierRating.POOR;
    else rating = SupplierRating.CRITICAL;

    return {
      supplierId: supplier_id,
      period: `${period_months} months`,
      orderCount,
      totalValue,
      avgOrderValue: orderCount > 0 ? (totalValue / orderCount).toFixed(2) : 0,
      deliveryPerformance: {
        onTime: onTimeDeliveries,
        late: lateDeliveries,
        onTimeRate: onTimeRate.toFixed(1) + '%'
      },
      rating,
      recommendation: rating === SupplierRating.POOR || rating === SupplierRating.CRITICAL
        ? 'Consider finding alternative suppliers'
        : 'Supplier performance is acceptable'
    };
  }

  async _compareSuppliers(params) {
    const { product_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    // Get all suppliers for this product
    const supplierInfo = await this.odooClient.searchRead('product.supplierinfo', [
      ['product_tmpl_id', '=', product_id]
    ], ['partner_id', 'price', 'delay', 'min_qty']);

    if (!supplierInfo.length) {
      return { message: 'No suppliers found for this product' };
    }

    const comparisons = [];

    for (const info of supplierInfo) {
      const performance = await this._analyzeSupplierPerformance({
        supplier_id: info.partner_id[0],
        period_months: 6
      });

      comparisons.push({
        supplier: info.partner_id[1],
        supplierId: info.partner_id[0],
        price: info.price,
        leadTimeDays: info.delay,
        minQuantity: info.min_qty,
        performance: performance.rating,
        onTimeRate: performance.deliveryPerformance?.onTimeRate
      });
    }

    // Sort by price
    comparisons.sort((a, b) => a.price - b.price);

    return {
      productId: product_id,
      suppliers: comparisons,
      recommendation: comparisons[0]
        ? `Best price: ${comparisons[0].supplier} at €${comparisons[0].price}`
        : null
    };
  }

  // ==================== INVENTORY & REORDERING ====================

  async _getReorderRecommendations(params = {}) {
    const { urgent_only = false } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    // Get products with stock below reorder point
    const products = await this.odooClient.searchRead('product.product', [
      ['type', '=', 'product'],
      ['qty_available', '<', 10]  // Simplified - would use reorder rules
    ], [
      'name', 'default_code', 'qty_available', 'virtual_available',
      'seller_ids', 'standard_price'
    ], { limit: 100 });

    const recommendations = [];

    for (const product of products) {
      const recommendation = {
        productId: product.id,
        name: product.name,
        sku: product.default_code,
        currentStock: product.qty_available,
        forecastStock: product.virtual_available,
        urgency: product.qty_available <= 0 ? 'critical' :
                 product.qty_available < 5 ? 'high' : 'medium',
        estimatedCost: product.standard_price * 10  // Simplified
      };

      if (!urgent_only || recommendation.urgency !== 'medium') {
        recommendations.push(recommendation);
      }
    }

    // Sort by urgency
    const urgencyOrder = { critical: 0, high: 1, medium: 2 };
    recommendations.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    return {
      recommendations,
      count: recommendations.length,
      criticalCount: recommendations.filter(r => r.urgency === 'critical').length,
      estimatedTotalCost: recommendations.reduce((sum, r) => sum + r.estimatedCost, 0)
    };
  }

  async _getLowStockItems(_params = {}) {
    return this._getReorderRecommendations({ urgent_only: true });
  }

  async _calculateOptimalOrderQuantity(params) {
    const { product_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const product = await this.odooClient.read('product.product', [product_id], [
      'name', 'qty_available', 'standard_price', 'seller_ids'
    ]);

    if (!product.length) return { error: 'Product not found' };

    const p = product[0];

    // Get supplier info for MOQ
    const supplierInfo = await this.odooClient.searchRead('product.supplierinfo', [
      ['product_tmpl_id', '=', product_id]
    ], ['min_qty', 'price', 'delay'], { limit: 1 });

    const moq = supplierInfo[0]?.min_qty || 1;
    const leadTime = supplierInfo[0]?.delay || 7;

    // Simple EOQ calculation (would be more sophisticated in production)
    const avgDailySales = 5;  // Would calculate from actual sales data
    const safetyStock = avgDailySales * this.settings.minStockDays;
    const reorderPoint = avgDailySales * leadTime + safetyStock;

    let suggestedQty = Math.max(moq, Math.ceil((reorderPoint - p.qty_available) * 1.5));

    return {
      productId: product_id,
      productName: p.name,
      currentStock: p.qty_available,
      reorderPoint,
      safetyStock,
      minOrderQty: moq,
      suggestedQty,
      leadTimeDays: leadTime,
      estimatedCost: suggestedQty * (supplierInfo[0]?.price || p.standard_price)
    };
  }

  // ==================== PRICING ====================

  async _getPriceHistory(params) {
    const { product_id, months_back = 12 } = params;

    // Would query actual price history from purchase order lines
    // Simplified response
    return {
      productId: product_id,
      period: `${months_back} months`,
      priceHistory: [],
      message: 'Price history tracking requires implementation with historical PO data'
    };
  }

  async _detectPriceChanges(params = {}) {
    const { threshold_percent = 10 } = params;

    // Would compare recent PO prices with historical averages
    return {
      threshold: `${threshold_percent}%`,
      priceChanges: [],
      message: 'Price change detection requires comparison with historical data'
    };
  }

  // ==================== PAYMENTS ====================

  async _getOutstandingPayments(params = {}) {
    const { overdue_only = false } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const domain = [
      ['move_type', '=', 'in_invoice'],
      ['payment_state', '!=', 'paid'],
      ['state', '=', 'posted']
    ];

    if (overdue_only) {
      domain.push(['invoice_date_due', '<', new Date().toISOString().split('T')[0]]);
    }

    const invoices = await this.odooClient.searchRead('account.move', domain, [
      'name', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'payment_state'
    ], { order: 'invoice_date_due asc', limit: 100 });

    const today = new Date();

    return {
      invoices: invoices.map(i => ({
        id: i.id,
        number: i.name,
        supplier: i.partner_id?.[1],
        invoiceDate: i.invoice_date,
        dueDate: i.invoice_date_due,
        total: i.amount_total,
        remaining: i.amount_residual,
        daysOverdue: i.invoice_date_due
          ? Math.max(0, Math.floor((today - new Date(i.invoice_date_due)) / (1000 * 60 * 60 * 24)))
          : 0
      })),
      count: invoices.length,
      totalOutstanding: invoices.reduce((sum, i) => sum + (i.amount_residual || 0), 0)
    };
  }

  async _getPaymentSchedule(params = {}) {
    const { days_ahead = 30 } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days_ahead);

    const invoices = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'in_invoice'],
      ['payment_state', '!=', 'paid'],
      ['state', '=', 'posted'],
      ['invoice_date_due', '>=', today.toISOString().split('T')[0]],
      ['invoice_date_due', '<=', futureDate.toISOString().split('T')[0]]
    ], [
      'name', 'partner_id', 'invoice_date_due', 'amount_residual'
    ], { order: 'invoice_date_due asc' });

    // Group by week
    const byWeek = {};
    for (const inv of invoices) {
      const week = this._getWeekNumber(new Date(inv.invoice_date_due));
      byWeek[week] = byWeek[week] || { invoices: [], total: 0 };
      byWeek[week].invoices.push(inv);
      byWeek[week].total += inv.amount_residual || 0;
    }

    return {
      period: `Next ${days_ahead} days`,
      schedule: invoices.map(i => ({
        dueDate: i.invoice_date_due,
        supplier: i.partner_id?.[1],
        invoice: i.name,
        amount: i.amount_residual
      })),
      byWeek,
      totalDue: invoices.reduce((sum, i) => sum + (i.amount_residual || 0), 0)
    };
  }

  _getWeekNumber(date) {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const days = Math.floor((date - startOfYear) / (24 * 60 * 60 * 1000));
    return `Week ${Math.ceil((days + startOfYear.getDay() + 1) / 7)}`;
  }

  // ==================== ANALYTICS ====================

  async _getPurchasingSummary(params = {}) {
    const { period = 'month' } = params;

    const daysBack = period === 'month' ? 30 : period === 'quarter' ? 90 : 365;
    const orders = await this._getPurchaseOrders({ days_back: daysBack, status: 'all' });

    const completed = orders.orders.filter(o => o.status === 'done' || o.status === 'purchase');
    const bySupplier = {};

    for (const order of completed) {
      const supplier = order.supplier || 'Unknown';
      bySupplier[supplier] = bySupplier[supplier] || { count: 0, value: 0 };
      bySupplier[supplier].count++;
      bySupplier[supplier].value += order.total;
    }

    const topSuppliers = Object.entries(bySupplier)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    return {
      period,
      totalOrders: completed.length,
      totalValue: completed.reduce((sum, o) => sum + o.total, 0),
      avgOrderValue: completed.length > 0
        ? (completed.reduce((sum, o) => sum + o.total, 0) / completed.length).toFixed(2)
        : 0,
      topSuppliers,
      pending: {
        approval: orders.orders.filter(o => o.status === 'to approve').length,
        receipt: orders.orders.filter(o => o.status === 'purchase').length
      }
    };
  }

  async _getTopProductsPurchased(params = {}) {
    const { limit = 20 } = params;

    // Would aggregate from purchase order lines
    return {
      message: 'Top products analysis requires aggregation of PO line data',
      limit
    };
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();
    console.log('Purchasing Agent initialized');
  }

  setOdooClient(client) {
    this.odooClient = client;
  }
}

module.exports = {
  PurchasingAgent,
  POStatus,
  SupplierRating
};
