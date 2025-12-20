/**
 * PurchasingContext Service
 *
 * Manages business context and exceptions that affect forecasting:
 * - Substitution events (Product A delivered instead of B)
 * - One-time large orders (not representative of normal demand)
 * - Promotions and campaigns
 * - Supply disruptions
 * - Customer-specific adjustments
 *
 * The agent uses this context to adjust forecasts and explain reasoning.
 */

class PurchasingContext {
  constructor(db = null) {
    this.db = db;
    this.collectionName = 'purchasing_contexts';
  }

  /**
   * Set database connection
   */
  setDb(db) {
    this.db = db;
  }

  /**
   * Add a substitution event
   * Example: Delivered 800 units of B instead of A
   * - Adds 800 to A's "true demand"
   * - Subtracts 800 from B's "true demand"
   */
  async addSubstitution(params) {
    const {
      date,
      originalProductId,
      originalProductName,
      substitutedProductId,
      substitutedProductName,
      quantity,
      reason,
      customerId = null,
      customerName = null,
      invoiceId = null,
      createdBy = 'user',
    } = params;

    const context = {
      type: 'substitution',
      date: new Date(date),
      originalProduct: {
        id: originalProductId,
        name: originalProductName,
      },
      substitutedProduct: {
        id: substitutedProductId,
        name: substitutedProductName,
      },
      quantity,
      reason,
      customer: customerId ? { id: customerId, name: customerName } : null,
      invoiceId,
      adjustments: [
        {
          productId: originalProductId,
          adjustment: +quantity, // Add to original product's true demand
          reason: `Substituted with ${substitutedProductName} - actual demand was for this product`,
        },
        {
          productId: substitutedProductId,
          adjustment: -quantity, // Subtract from substitute's demand
          reason: `Used as substitute for ${originalProductName} - not organic demand`,
        },
      ],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Add a one-time order that shouldn't affect forecasts
   * Example: Customer made a one-time bulk purchase for an event
   */
  async addOneTimeOrder(params) {
    const {
      date,
      productId,
      productName,
      quantity,
      reason,
      customerId = null,
      customerName = null,
      invoiceId = null,
      excludeFromForecast = true,
      createdBy = 'user',
    } = params;

    const context = {
      type: 'one_time_order',
      date: new Date(date),
      product: {
        id: productId,
        name: productName,
      },
      quantity,
      reason,
      customer: customerId ? { id: customerId, name: customerName } : null,
      invoiceId,
      excludeFromForecast,
      adjustments: excludeFromForecast ? [
        {
          productId,
          adjustment: -quantity,
          reason: `One-time order: ${reason}`,
        },
      ] : [],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Add a promotion/campaign context
   * Example: Black Friday promotion increased sales 3x
   */
  async addPromotion(params) {
    const {
      startDate,
      endDate,
      productIds,
      productNames,
      promotionName,
      expectedMultiplier = 1.0,
      actualMultiplier = null,
      notes = '',
      createdBy = 'user',
    } = params;

    const context = {
      type: 'promotion',
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      products: productIds.map((id, i) => ({
        id,
        name: productNames[i] || `Product ${id}`,
      })),
      promotionName,
      expectedMultiplier,
      actualMultiplier,
      notes,
      // Promotions don't directly adjust, but inform forecast interpretation
      adjustments: [],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Add a supply disruption event
   * Example: Supplier couldn't deliver, causing stockout
   */
  async addSupplyDisruption(params) {
    const {
      startDate,
      endDate,
      productIds,
      productNames,
      supplierId = null,
      supplierName = null,
      reason,
      estimatedLostSalesPerDay = {},
      createdBy = 'user',
    } = params;

    const context = {
      type: 'supply_disruption',
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : null,
      products: productIds.map((id, i) => ({
        id,
        name: productNames[i] || `Product ${id}`,
        estimatedLostSalesPerDay: estimatedLostSalesPerDay[id] || 0,
      })),
      supplier: supplierId ? { id: supplierId, name: supplierName } : null,
      reason,
      // Disruptions inform stockout analysis
      adjustments: [],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Add a recurring customer order pattern
   * Example: Customer buys product P0222 once a year
   * This tells the forecast to expect this demand on a schedule
   */
  async addRecurringCustomerOrder(params) {
    const {
      productId,
      productName,
      customerId,
      customerName,
      frequency, // 'annual', 'semi-annual', 'quarterly', 'monthly'
      typicalQuantity,
      typicalMonth = null, // For annual orders, which month (1-12)
      notes = '',
      createdBy = 'user',
    } = params;

    const context = {
      type: 'recurring_customer_order',
      product: {
        id: productId,
        name: productName,
      },
      customer: {
        id: customerId,
        name: customerName,
      },
      pattern: {
        frequency,
        typicalQuantity,
        typicalMonth,
        // Calculate expected orders per year
        ordersPerYear: frequency === 'annual' ? 1
          : frequency === 'semi-annual' ? 2
          : frequency === 'quarterly' ? 4
          : frequency === 'monthly' ? 12 : 1,
      },
      notes,
      // No adjustments - this informs forecasting logic
      adjustments: [],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Add a substitute product relationship
   * Example: Product 18010 can substitute for 18009 when 18009 is out of stock
   * This is a permanent relationship, not a one-time event
   */
  async addSubstituteRelationship(params) {
    const {
      primaryProductId,
      primaryProductName,
      substituteProductId,
      substituteProductName,
      direction = 'one-way', // 'one-way' (substitute for primary only) or 'bidirectional'
      notes = '',
      createdBy = 'user',
    } = params;

    const context = {
      type: 'substitute_relationship',
      primaryProduct: {
        id: primaryProductId,
        name: primaryProductName,
      },
      substituteProduct: {
        id: substituteProductId,
        name: substituteProductName,
      },
      direction,
      notes,
      // No adjustments - relationships inform how to interpret sales data
      adjustments: [],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Get substitute relationships for a product
   * Returns products that can substitute for this one, or that this product substitutes for
   */
  async getSubstituteRelationships(productId) {
    if (!this.db) {
      return { substitutes: [], substituteFor: [] };
    }

    const contexts = await this.db.collection(this.collectionName)
      .find({
        active: true,
        type: 'substitute_relationship',
        $or: [
          { 'primaryProduct.id': productId },
          { 'substituteProduct.id': productId },
        ],
      })
      .toArray();

    const substitutes = []; // Products that can substitute for productId
    const substituteFor = []; // Products that productId can substitute for

    for (const ctx of contexts) {
      if (ctx.primaryProduct.id === productId) {
        // This product has substitutes
        substitutes.push({
          productId: ctx.substituteProduct.id,
          productName: ctx.substituteProduct.name,
          direction: ctx.direction,
        });
      }
      if (ctx.substituteProduct.id === productId) {
        // This product can substitute for another
        substituteFor.push({
          productId: ctx.primaryProduct.id,
          productName: ctx.primaryProduct.name,
          direction: ctx.direction,
        });
        // If bidirectional, also add reverse
        if (ctx.direction === 'bidirectional') {
          substitutes.push({
            productId: ctx.primaryProduct.id,
            productName: ctx.primaryProduct.name,
            direction: ctx.direction,
          });
        }
      }
    }

    return { substitutes, substituteFor };
  }

  /**
   * Get recurring customer order patterns for a product
   */
  async getRecurringCustomerOrders(productId) {
    if (!this.db) {
      return [];
    }

    return this.db.collection(this.collectionName)
      .find({
        active: true,
        type: 'recurring_customer_order',
        'product.id': productId,
      })
      .toArray();
  }

  /**
   * Add a general note/context for a product
   */
  async addProductNote(params) {
    const {
      productId,
      productName,
      note,
      impactType = 'info', // 'info', 'increase_demand', 'decrease_demand', 'seasonal'
      quantityAdjustment = 0,
      startDate = null,
      endDate = null,
      createdBy = 'user',
    } = params;

    const context = {
      type: 'product_note',
      product: {
        id: productId,
        name: productName,
      },
      note,
      impactType,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      adjustments: quantityAdjustment !== 0 ? [
        {
          productId,
          adjustment: quantityAdjustment,
          reason: note,
        },
      ] : [],
      createdBy,
      createdAt: new Date(),
      active: true,
    };

    if (this.db) {
      const result = await this.db.collection(this.collectionName).insertOne(context);
      return { ...context, _id: result.insertedId };
    }

    return context;
  }

  /**
   * Get all adjustments for a product within a date range
   * Returns the net adjustment to apply to invoiced quantities
   */
  async getProductAdjustments(productId, startDate = null, endDate = null) {
    if (!this.db) {
      return { adjustments: [], netAdjustment: 0, contexts: [] };
    }

    const query = {
      active: true,
      'adjustments.productId': productId,
    };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const contexts = await this.db.collection(this.collectionName)
      .find(query)
      .sort({ date: -1 })
      .toArray();

    // Calculate net adjustment
    let netAdjustment = 0;
    const adjustmentDetails = [];

    for (const ctx of contexts) {
      for (const adj of ctx.adjustments) {
        if (adj.productId === productId) {
          netAdjustment += adj.adjustment;
          adjustmentDetails.push({
            date: ctx.date,
            type: ctx.type,
            adjustment: adj.adjustment,
            reason: adj.reason,
            contextId: ctx._id,
          });
        }
      }
    }

    return {
      productId,
      adjustments: adjustmentDetails,
      netAdjustment,
      contexts,
    };
  }

  /**
   * Get all context for a product (for AI reasoning)
   */
  async getProductContext(productId) {
    if (!this.db) {
      return { contexts: [], summary: 'No database connected' };
    }

    const contexts = await this.db.collection(this.collectionName)
      .find({
        active: true,
        $or: [
          { 'product.id': productId },
          { 'originalProduct.id': productId },
          { 'substitutedProduct.id': productId },
          { 'products.id': productId },
          { 'adjustments.productId': productId },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    // Generate summary for AI
    const summary = this._generateContextSummary(productId, contexts);

    return {
      productId,
      contexts,
      summary,
      contextCount: contexts.length,
    };
  }

  /**
   * Generate a human-readable summary for AI reasoning
   */
  _generateContextSummary(productId, contexts) {
    if (contexts.length === 0) {
      return 'No special context recorded for this product.';
    }

    const summaryParts = [];

    // Group by type
    const substitutions = contexts.filter(c => c.type === 'substitution');
    const oneTimeOrders = contexts.filter(c => c.type === 'one_time_order');
    const promotions = contexts.filter(c => c.type === 'promotion');
    const disruptions = contexts.filter(c => c.type === 'supply_disruption');
    const notes = contexts.filter(c => c.type === 'product_note');

    if (substitutions.length > 0) {
      const asOriginal = substitutions.filter(s => s.originalProduct?.id === productId);
      const asSubstitute = substitutions.filter(s => s.substitutedProduct?.id === productId);

      if (asOriginal.length > 0) {
        const totalQty = asOriginal.reduce((sum, s) => sum + s.quantity, 0);
        summaryParts.push(
          `SUBSTITUTION HISTORY: This product was out of stock ${asOriginal.length} time(s), ` +
          `with ${totalQty} units delivered as substitutes. TRUE DEMAND is HIGHER than invoiced.`
        );
      }

      if (asSubstitute.length > 0) {
        const totalQty = asSubstitute.reduce((sum, s) => sum + s.quantity, 0);
        summaryParts.push(
          `USED AS SUBSTITUTE: This product was used ${asSubstitute.length} time(s) ` +
          `(${totalQty} units) as substitute for other products. ORGANIC DEMAND is LOWER than invoiced.`
        );
      }
    }

    if (oneTimeOrders.length > 0) {
      const totalQty = oneTimeOrders.reduce((sum, o) => sum + o.quantity, 0);
      summaryParts.push(
        `ONE-TIME ORDERS: ${oneTimeOrders.length} non-recurring order(s) totaling ${totalQty} units ` +
        `should be EXCLUDED from regular demand calculation.`
      );
    }

    if (promotions.length > 0) {
      summaryParts.push(
        `PROMOTIONS: ${promotions.length} promotion(s) affected this product. ` +
        `Sales during promotions may be elevated compared to baseline.`
      );
    }

    if (disruptions.length > 0) {
      summaryParts.push(
        `SUPPLY DISRUPTIONS: ${disruptions.length} disruption(s) caused stockouts. ` +
        `Invoiced quantities during these periods UNDERSTATE true demand.`
      );
    }

    if (notes.length > 0) {
      summaryParts.push(`NOTES: ${notes.map(n => n.note).join('; ')}`);
    }

    // Recurring customer orders
    const recurringOrders = contexts.filter(c => c.type === 'recurring_customer_order');
    if (recurringOrders.length > 0) {
      const orderDetails = recurringOrders.map(o =>
        `${o.customer?.name || 'Unknown customer'}: ${o.pattern?.typicalQuantity} units ${o.pattern?.frequency}` +
        (o.pattern?.typicalMonth ? ` (typically month ${o.pattern.typicalMonth})` : '')
      );
      summaryParts.push(
        `RECURRING CUSTOMER ORDERS: This product has ${recurringOrders.length} recurring buyer(s). ` +
        `${orderDetails.join('; ')}. ` +
        `These are PREDICTABLE orders that should be INCLUDED in forecasts but NOT treated as trends.`
      );
    }

    // Substitute relationships
    const substituteRels = contexts.filter(c => c.type === 'substitute_relationship');
    if (substituteRels.length > 0) {
      const asSubstitute = substituteRels.filter(s => s.substituteProduct?.id === productId);
      const hasSubs = substituteRels.filter(s => s.primaryProduct?.id === productId);

      if (asSubstitute.length > 0) {
        const primaryProducts = asSubstitute.map(s => s.primaryProduct?.name || `Product ${s.primaryProduct?.id}`);
        summaryParts.push(
          `SUBSTITUTE PRODUCT: This product is used as SUBSTITUTE for: ${primaryProducts.join(', ')}. ` +
          `When those products are out of stock, sales of THIS product may spike. ` +
          `These substitute sales should NOT increase this product's base forecast.`
        );
      }

      if (hasSubs.length > 0) {
        const subProducts = hasSubs.map(s => s.substituteProduct?.name || `Product ${s.substituteProduct?.id}`);
        summaryParts.push(
          `HAS SUBSTITUTES: This product can be substituted with: ${subProducts.join(', ')}. ` +
          `During stockouts, customers may buy substitutes. TRUE DEMAND may be HIGHER than invoiced.`
        );
      }
    }

    return summaryParts.join('\n\n');
  }

  /**
   * Get all recent contexts (for dashboard)
   */
  async getRecentContexts(limit = 20) {
    if (!this.db) {
      return [];
    }

    return this.db.collection(this.collectionName)
      .find({ active: true })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Deactivate a context
   */
  async deactivateContext(contextId) {
    if (!this.db) {
      return { error: 'No database connected' };
    }

    const { ObjectId } = require('mongodb');
    const result = await this.db.collection(this.collectionName).updateOne(
      { _id: new ObjectId(contextId) },
      { $set: { active: false, deactivatedAt: new Date() } }
    );

    return { success: result.modifiedCount > 0 };
  }

  /**
   * Get adjustments summary for forecast engine
   * Returns a map of productId -> totalAdjustment
   */
  async getAdjustmentsForForecasting(productIds, startDate, endDate) {
    if (!this.db) {
      return new Map();
    }

    const contexts = await this.db.collection(this.collectionName)
      .find({
        active: true,
        'adjustments.productId': { $in: productIds },
        $or: [
          { date: { $gte: new Date(startDate), $lte: new Date(endDate) } },
          { date: null }, // Global adjustments
        ],
      })
      .toArray();

    const adjustmentsMap = new Map();

    for (const ctx of contexts) {
      for (const adj of ctx.adjustments) {
        if (productIds.includes(adj.productId)) {
          const current = adjustmentsMap.get(adj.productId) || {
            totalAdjustment: 0,
            reasons: [],
          };
          current.totalAdjustment += adj.adjustment;
          current.reasons.push({
            adjustment: adj.adjustment,
            reason: adj.reason,
            date: ctx.date,
            type: ctx.type,
          });
          adjustmentsMap.set(adj.productId, current);
        }
      }
    }

    return adjustmentsMap;
  }
}

// Singleton instance
let purchasingContextInstance = null;

function getPurchasingContext(db = null) {
  if (!purchasingContextInstance) {
    purchasingContextInstance = new PurchasingContext(db);
  } else if (db && !purchasingContextInstance.db) {
    purchasingContextInstance.setDb(db);
  }
  return purchasingContextInstance;
}

module.exports = {
  PurchasingContext,
  getPurchasingContext,
};
