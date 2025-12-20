/**
 * SupplyChainManager Service
 *
 * Manages supply chain logistics for purchasing decisions:
 * - Supplier lead times
 * - Shipping calculations (sea freight from China)
 * - Reorder point calculations
 * - Economic Order Quantity (EOQ)
 * - Safety stock calculations
 * - MOQ (Minimum Order Quantity) handling
 * - Container volume optimization
 */

const { getSeasonalCalendar } = require('./SeasonalCalendar');

class SupplyChainManager {
  constructor(config = {}) {
    this.seasonalCalendar = getSeasonalCalendar();

    // Default lead times (in days) - used when supplier-specific data not available
    // These are FALLBACK defaults only - actual values should come from supplier data
    this.defaults = {
      orderProcessingTime: 5,     // Time from PO to production start (confirm, payment, scheduling)
      supplierLeadTime: 60,       // Default supplier production time (China suppliers)
      seaFreightTime: 42,         // China to Belgium via sea (~6 weeks)
      airFreightTime: 5,          // China to Belgium via air
      railFreightTime: 18,        // China to Belgium via rail
      portAndCustoms: 5,          // Port handling + Belgian customs processing
      internalProcessing: 2,      // Warehouse receiving
      bufferDays: 7,              // Safety buffer for delays
    };

    // Database reference for supplier data lookup
    this.db = config.db || null;

    // Shipping cost multipliers (relative to sea freight)
    this.shippingCostMultipliers = {
      sea: 1.0,
      rail: 2.5,
      air: 8.0,
    };

    // Service level Z-scores for safety stock
    this.serviceLevelZScores = {
      0.90: 1.28,
      0.95: 1.65,
      0.98: 2.05,
      0.99: 2.33,
    };

    // Standard container specifications (internal dimensions in cm, volume in m³)
    this.containerSpecs = {
      '20ft': {
        name: '20ft Standard',
        lengthCm: 589,
        widthCm: 235,
        heightCm: 238,
        volumeM3: 33.0,
        maxWeightKg: 21770,
        usableVolumePercent: 0.85, // Account for stacking/packing inefficiency
      },
      '40ft': {
        name: '40ft Standard',
        lengthCm: 1203,
        widthCm: 235,
        heightCm: 238,
        volumeM3: 67.5,
        maxWeightKg: 26680,
        usableVolumePercent: 0.85,
      },
      '40ft_hc': {
        name: '40ft High Cube',
        lengthCm: 1203,
        widthCm: 235,
        heightCm: 269,
        volumeM3: 76.0,
        maxWeightKg: 26460,
        usableVolumePercent: 0.85,
      },
    };

    // Custom supplier configurations
    this.suppliers = new Map();

    // Product MOQ and dimension cache
    this.productMOQs = new Map();
    this.productDimensions = new Map();
  }

  /**
   * Register a supplier with their lead times
   */
  registerSupplier(supplierId, config) {
    this.suppliers.set(supplierId, {
      id: supplierId,
      name: config.name || supplierId,
      leadTimeDays: config.leadTimeDays || this.defaults.supplierLeadTime,
      minimumOrderQuantity: config.moq || 1,
      minimumOrderValue: config.mov || 0,
      currency: config.currency || 'USD',
      location: config.location || 'China',
      preferredShipping: config.preferredShipping || 'sea',
      paymentTerms: config.paymentTerms || 'T/T',
      reliability: config.reliability || 0.95, // On-time delivery rate
    });
    return this.suppliers.get(supplierId);
  }

  /**
   * Set database reference for supplier lookups
   */
  setDatabase(db) {
    this.db = db;
  }

  /**
   * Get supplier lead time from synced data or registered suppliers
   */
  async getSupplierLeadTime(supplierId) {
    // First check registered suppliers (in-memory)
    const registered = supplierId ? this.suppliers.get(supplierId) : null;
    if (registered?.leadTimeDays) {
      return registered.leadTimeDays;
    }

    // Then check synced supplier data from MongoDB
    if (this.db && supplierId) {
      try {
        const supplier = await this.db.collection('odoo_suppliers').findOne({ odooId: supplierId });
        if (supplier?.leadTime) {
          return supplier.leadTime;
        }
      } catch (e) {
        // Fall through to default
      }
    }

    return this.defaults.supplierLeadTime;
  }

  /**
   * Get total lead time for a supplier
   * @param {number} supplierId - Supplier ID (looks up lead time from supplier data)
   * @param {string} shippingMethod - 'sea', 'air', or 'rail'
   * @param {number} supplierLeadTimeOverride - Override supplier lead time if known
   */
  getTotalLeadTime(supplierId = null, shippingMethod = 'sea', supplierLeadTimeOverride = null) {
    // Use override if provided, otherwise check registered suppliers
    let supplierLead;
    if (supplierLeadTimeOverride !== null) {
      supplierLead = supplierLeadTimeOverride;
    } else {
      const supplier = supplierId ? this.suppliers.get(supplierId) : null;
      supplierLead = supplier?.leadTimeDays || this.defaults.supplierLeadTime;
    }

    let shippingTime;
    switch (shippingMethod) {
      case 'air':
        shippingTime = this.defaults.airFreightTime;
        break;
      case 'rail':
        shippingTime = this.defaults.railFreightTime;
        break;
      case 'sea':
      default:
        shippingTime = this.defaults.seaFreightTime;
    }

    const totalLeadTime =
      this.defaults.orderProcessingTime +
      supplierLead +
      shippingTime +
      this.defaults.portAndCustoms +
      this.defaults.internalProcessing +
      this.defaults.bufferDays;

    return {
      orderProcessingTime: this.defaults.orderProcessingTime,
      supplierLeadTime: supplierLead,
      shippingTime,
      shippingMethod,
      portAndCustoms: this.defaults.portAndCustoms,
      internalProcessing: this.defaults.internalProcessing,
      buffer: this.defaults.bufferDays,
      totalDays: totalLeadTime,
      description: `${totalLeadTime} days total (${this.defaults.orderProcessingTime}d order processing + ${supplierLead}d production + ${shippingTime}d ${shippingMethod} + ${this.defaults.portAndCustoms}d port/customs + ${this.defaults.internalProcessing}d receiving + ${this.defaults.bufferDays}d buffer)`,
      source: supplierLeadTimeOverride !== null ? 'override' : (supplierId ? 'supplier_data' : 'default'),
    };
  }

  /**
   * Get total lead time async (fetches supplier data from DB)
   */
  async getTotalLeadTimeAsync(supplierId = null, shippingMethod = 'sea') {
    const supplierLead = await this.getSupplierLeadTime(supplierId);
    return this.getTotalLeadTime(supplierId, shippingMethod, supplierLead);
  }

  /**
   * Calculate expected arrival date for an order placed today
   */
  calculateArrivalDate(orderDate = new Date(), supplierId = null, shippingMethod = 'sea') {
    const leadTime = this.getTotalLeadTime(supplierId, shippingMethod);
    const arrivalDate = new Date(orderDate);
    arrivalDate.setDate(arrivalDate.getDate() + leadTime.totalDays);

    return {
      orderDate,
      arrivalDate,
      leadTime,
    };
  }

  /**
   * Calculate reorder point based on demand and lead time
   * Reorder Point = (Average Daily Demand × Lead Time) + Safety Stock
   */
  calculateReorderPoint(params) {
    const {
      avgDailyDemand,
      demandStdDev = avgDailyDemand * 0.3, // Assume 30% variation if not provided
      supplierId = null,
      shippingMethod = 'sea',
      serviceLevel = 0.95,
    } = params;

    const leadTime = this.getTotalLeadTime(supplierId, shippingMethod);
    const zScore = this.serviceLevelZScores[serviceLevel] || 1.65;

    // Safety Stock = Z × σ × √L
    // where Z = service level Z-score, σ = demand std dev, L = lead time
    const safetyStock = Math.ceil(zScore * demandStdDev * Math.sqrt(leadTime.totalDays));

    // Reorder Point = Average demand during lead time + Safety Stock
    const demandDuringLeadTime = Math.ceil(avgDailyDemand * leadTime.totalDays);
    const reorderPoint = demandDuringLeadTime + safetyStock;

    return {
      reorderPoint,
      demandDuringLeadTime,
      safetyStock,
      leadTime,
      serviceLevel,
      components: {
        avgDailyDemand,
        demandStdDev,
        zScore,
        leadTimeDays: leadTime.totalDays,
      },
      description: `Reorder when stock reaches ${reorderPoint} units (${demandDuringLeadTime} expected demand + ${safetyStock} safety stock)`,
    };
  }

  /**
   * Calculate Economic Order Quantity (EOQ)
   * EOQ = √(2DS/H)
   * where D = annual demand, S = ordering cost, H = holding cost per unit per year
   */
  calculateEOQ(params) {
    const {
      annualDemand,
      orderingCost = 100, // Cost per order (shipping, admin, etc.)
      unitCost,
      holdingCostRate = 0.25, // 25% of unit cost per year
      minimumOrderQuantity = 1,
    } = params;

    const holdingCost = unitCost * holdingCostRate;
    const eoq = Math.sqrt((2 * annualDemand * orderingCost) / holdingCost);
    const roundedEOQ = Math.max(minimumOrderQuantity, Math.ceil(eoq));

    // Calculate total annual cost at EOQ
    const ordersPerYear = annualDemand / roundedEOQ;
    const annualOrderingCost = ordersPerYear * orderingCost;
    const annualHoldingCost = (roundedEOQ / 2) * holdingCost;
    const totalAnnualCost = annualOrderingCost + annualHoldingCost;

    return {
      eoq: roundedEOQ,
      rawEOQ: eoq,
      ordersPerYear: Math.ceil(ordersPerYear),
      annualOrderingCost,
      annualHoldingCost,
      totalAnnualCost,
      inputs: {
        annualDemand,
        orderingCost,
        unitCost,
        holdingCostRate,
        minimumOrderQuantity,
      },
      description: `Order ${roundedEOQ} units ${Math.ceil(ordersPerYear)} times per year for optimal cost`,
    };
  }

  /**
   * Calculate order quantity considering CNY closure
   */
  calculateCNYOrder(params) {
    const {
      avgDailyDemand,
      demandStdDev = avgDailyDemand * 0.3,
      currentStock = 0,
      pendingOrders = 0,
      supplierId = null,
      year = new Date().getFullYear(),
      safetyMultiplier = 1.3, // Extra buffer for CNY period
    } = params;

    const leadTime = this.getTotalLeadTime(supplierId, 'sea');
    const cnyInfo = this.seasonalCalendar.getCNYOrderDeadline(year, leadTime.shippingTime, leadTime.supplierLeadTime);

    // Calculate demand from order deadline until full factory recovery
    const orderDate = new Date();
    const daysUntilRecovery = Math.ceil(
      (cnyInfo.closure.fullRecovery - orderDate) / (1000 * 60 * 60 * 24)
    );

    // Total demand during the entire CNY period + lead time for next order
    const coverageDays = daysUntilRecovery + leadTime.totalDays;
    const expectedDemand = avgDailyDemand * coverageDays;

    // Apply safety multiplier for CNY uncertainty
    const targetStock = Math.ceil(expectedDemand * safetyMultiplier);

    // Calculate order quantity
    const availableStock = currentStock + pendingOrders;
    const orderQuantity = Math.max(0, targetStock - availableStock);

    return {
      orderQuantity,
      orderDeadline: cnyInfo.orderDeadline,
      daysUntilDeadline: cnyInfo.daysUntilDeadline,
      targetStock,
      currentAvailable: availableStock,
      coverageDays,
      cnyPeriod: cnyInfo.closure,
      urgency: this.getCNYUrgency(cnyInfo.daysUntilDeadline),
      recommendation: this.getCNYRecommendation(orderQuantity, cnyInfo.daysUntilDeadline, orderDate),
      calculation: {
        avgDailyDemand,
        expectedDemand: Math.round(expectedDemand),
        safetyMultiplier,
        targetStock,
        currentStock,
        pendingOrders,
      },
    };
  }

  /**
   * Get CNY order urgency level
   */
  getCNYUrgency(daysUntilDeadline) {
    if (daysUntilDeadline < 0) return 'MISSED';
    if (daysUntilDeadline <= 7) return 'CRITICAL';
    if (daysUntilDeadline <= 14) return 'HIGH';
    if (daysUntilDeadline <= 30) return 'MODERATE';
    return 'LOW';
  }

  /**
   * Get CNY order recommendation
   */
  getCNYRecommendation(orderQuantity, daysUntilDeadline, orderDate) {
    if (daysUntilDeadline < 0) {
      return {
        action: 'URGENT_AIR_FREIGHT',
        message: 'Order deadline missed! Consider air freight for critical items or accept potential stockout.',
      };
    }

    if (orderQuantity <= 0) {
      return {
        action: 'NO_ORDER_NEEDED',
        message: 'Current stock levels are sufficient for CNY period.',
      };
    }

    if (daysUntilDeadline <= 7) {
      return {
        action: 'ORDER_IMMEDIATELY',
        message: `Place order for ${orderQuantity} units TODAY to avoid CNY stockout!`,
      };
    }

    if (daysUntilDeadline <= 14) {
      return {
        action: 'ORDER_THIS_WEEK',
        message: `Order ${orderQuantity} units within the next 7 days for CNY preparation.`,
      };
    }

    return {
      action: 'SCHEDULE_ORDER',
      message: `Plan to order ${orderQuantity} units before ${new Date(orderDate.getTime() + daysUntilDeadline * 24 * 60 * 60 * 1000).toDateString()}.`,
    };
  }

  /**
   * Check if reorder is needed
   */
  shouldReorder(params) {
    const {
      currentStock,
      pendingOrders = 0,
      avgDailyDemand,
      demandStdDev,
      supplierId = null,
      serviceLevel = 0.95,
    } = params;

    const reorderPointInfo = this.calculateReorderPoint({
      avgDailyDemand,
      demandStdDev,
      supplierId,
      serviceLevel,
    });

    const availableStock = currentStock + pendingOrders;
    const stockCoverDays = availableStock / avgDailyDemand;

    // Check CNY impact
    const cnyImpact = this.seasonalCalendar.isSupplyChainImpacted();

    let urgency = 'none';
    let action = 'none';

    if (availableStock <= reorderPointInfo.safetyStock) {
      urgency = 'critical';
      action = 'order_immediately';
    } else if (availableStock <= reorderPointInfo.reorderPoint) {
      urgency = 'high';
      action = 'order_soon';
    } else if (availableStock <= reorderPointInfo.reorderPoint * 1.2) {
      urgency = 'moderate';
      action = 'monitor';
    }

    // Elevate urgency if CNY is approaching
    if (cnyImpact.impacted && cnyImpact.severity === 'high' && urgency !== 'critical') {
      urgency = 'high';
      action = 'order_for_cny';
    }

    return {
      shouldReorder: urgency !== 'none',
      urgency,
      action,
      currentStock,
      pendingOrders,
      availableStock,
      reorderPoint: reorderPointInfo.reorderPoint,
      safetyStock: reorderPointInfo.safetyStock,
      stockCoverDays: Math.round(stockCoverDays),
      cnyImpact,
      recommendation: this.getReorderRecommendation(urgency, action, availableStock, reorderPointInfo),
    };
  }

  /**
   * Get reorder recommendation message
   */
  getReorderRecommendation(urgency, action, availableStock, reorderPointInfo) {
    switch (action) {
      case 'order_immediately':
        return `CRITICAL: Stock (${availableStock}) is below safety stock (${reorderPointInfo.safetyStock}). Order immediately to prevent stockout.`;
      case 'order_soon':
        return `Stock (${availableStock}) has reached reorder point (${reorderPointInfo.reorderPoint}). Place order within 48 hours.`;
      case 'order_for_cny':
        return `CNY approaching. Order now to ensure adequate stock during factory closures.`;
      case 'monitor':
        return `Stock levels adequate but approaching reorder point. Monitor closely.`;
      default:
        return `Stock levels healthy. No action required.`;
    }
  }

  /**
   * Compare shipping options
   */
  compareShippingOptions(params) {
    const {
      orderQuantity,
      unitCost,
      urgencyDays = null, // Days until stock runs out
      supplierId = null,
    } = params;

    const options = ['sea', 'rail', 'air'].map(method => {
      const leadTime = this.getTotalLeadTime(supplierId, method);
      const costMultiplier = this.shippingCostMultipliers[method];

      // Estimate shipping cost (rough calculation)
      const estimatedShippingCost = orderQuantity * unitCost * 0.05 * costMultiplier; // 5% of value for sea

      return {
        method,
        leadTimeDays: leadTime.totalDays,
        estimatedCost: Math.round(estimatedShippingCost),
        canMeetDeadline: urgencyDays ? leadTime.totalDays <= urgencyDays : true,
        leadTimeDetail: leadTime,
      };
    });

    // Sort by cost if no urgency, by speed if urgent
    if (urgencyDays && options.some(o => !o.canMeetDeadline)) {
      options.sort((a, b) => a.leadTimeDays - b.leadTimeDays);
    } else {
      options.sort((a, b) => a.estimatedCost - b.estimatedCost);
    }

    const recommended = urgencyDays
      ? options.find(o => o.canMeetDeadline) || options[0]
      : options[0];

    return {
      options,
      recommended,
      urgencyDays,
      analysis: urgencyDays
        ? `Need delivery in ${urgencyDays} days. ${recommended.canMeetDeadline ? `${recommended.method} freight can deliver in ${recommended.leadTimeDays} days.` : 'No shipping method can meet deadline!'}`
        : `Recommended: ${recommended.method} freight (${recommended.leadTimeDays} days, ~€${recommended.estimatedCost} shipping)`,
    };
  }

  /**
   * Get supply chain overview for a product
   */
  getSupplyChainOverview(params) {
    const {
      productId,
      currentStock,
      pendingOrders = 0,
      avgDailyDemand,
      demandStdDev,
      unitCost,
      annualDemand,
      supplierId = null,
    } = params;

    const reorderStatus = this.shouldReorder({
      currentStock,
      pendingOrders,
      avgDailyDemand,
      demandStdDev,
      supplierId,
    });

    const eoq = this.calculateEOQ({
      annualDemand,
      unitCost,
    });

    const cnyOrder = this.calculateCNYOrder({
      avgDailyDemand,
      demandStdDev,
      currentStock,
      pendingOrders,
      supplierId,
    });

    const shippingOptions = this.compareShippingOptions({
      orderQuantity: eoq.eoq,
      unitCost,
      supplierId,
    });

    return {
      productId,
      inventory: {
        current: currentStock,
        pending: pendingOrders,
        available: currentStock + pendingOrders,
        coverageDays: Math.round((currentStock + pendingOrders) / avgDailyDemand),
      },
      demand: {
        dailyAverage: avgDailyDemand,
        dailyStdDev: demandStdDev,
        annual: annualDemand,
      },
      reorder: reorderStatus,
      optimalOrderQuantity: eoq,
      cnyPreparation: cnyOrder,
      shipping: shippingOptions,
      generatedAt: new Date(),
    };
  }

  // ==================== MOQ HANDLING ====================

  /**
   * Set MOQ for a product
   * @param {number} productId - Odoo product ID
   * @param {Object} moqConfig - MOQ configuration
   */
  setProductMOQ(productId, moqConfig) {
    this.productMOQs.set(productId, {
      productId,
      moq: moqConfig.moq || 1,
      moqUnit: moqConfig.moqUnit || 'units', // 'units', 'cartons', 'pallets'
      unitsPerCarton: moqConfig.unitsPerCarton || 1,
      cartonsPerPallet: moqConfig.cartonsPerPallet || null,
      orderMultiple: moqConfig.orderMultiple || 1, // Must order in multiples of this
      supplierId: moqConfig.supplierId || null,
      lastUpdated: new Date(),
    });
    return this.productMOQs.get(productId);
  }

  /**
   * Get MOQ for a product
   */
  getProductMOQ(productId) {
    return this.productMOQs.get(productId) || {
      productId,
      moq: 1,
      moqUnit: 'units',
      unitsPerCarton: 1,
      orderMultiple: 1,
      supplierId: null,
    };
  }

  /**
   * Apply MOQ constraints to an order quantity
   * Returns the adjusted quantity that satisfies MOQ rules
   */
  applyMOQConstraints(params) {
    const {
      productId,
      desiredQuantity,
      moqConfig = null, // Override product MOQ if provided
    } = params;

    const moq = moqConfig || this.getProductMOQ(productId);

    // Convert MOQ to units if needed
    let moqInUnits = moq.moq;
    if (moq.moqUnit === 'cartons') {
      moqInUnits = moq.moq * moq.unitsPerCarton;
    } else if (moq.moqUnit === 'pallets' && moq.cartonsPerPallet) {
      moqInUnits = moq.moq * moq.cartonsPerPallet * moq.unitsPerCarton;
    }

    // Calculate adjusted quantity
    let adjustedQuantity = desiredQuantity;

    // Ensure meets minimum
    if (adjustedQuantity < moqInUnits) {
      adjustedQuantity = moqInUnits;
    }

    // Round up to order multiple
    if (moq.orderMultiple > 1) {
      const remainder = adjustedQuantity % moq.orderMultiple;
      if (remainder > 0) {
        adjustedQuantity = adjustedQuantity + (moq.orderMultiple - remainder);
      }
    }

    // Calculate in different units
    const inCartons = moq.unitsPerCarton > 1
      ? Math.ceil(adjustedQuantity / moq.unitsPerCarton)
      : adjustedQuantity;

    const inPallets = moq.cartonsPerPallet
      ? Math.ceil(inCartons / moq.cartonsPerPallet)
      : null;

    return {
      originalQuantity: desiredQuantity,
      adjustedQuantity,
      moqApplied: adjustedQuantity !== desiredQuantity,
      moqConfig: moq,
      breakdown: {
        units: adjustedQuantity,
        cartons: inCartons,
        pallets: inPallets,
        unitsPerCarton: moq.unitsPerCarton,
        cartonsPerPallet: moq.cartonsPerPallet,
      },
      reasoning: this._getMOQReasoning(desiredQuantity, adjustedQuantity, moq),
    };
  }

  /**
   * Generate MOQ reasoning explanation
   */
  _getMOQReasoning(desired, adjusted, moq) {
    const parts = [];

    if (adjusted === desired) {
      parts.push(`Desired quantity of ${desired} units meets all MOQ requirements.`);
    } else {
      if (desired < moq.moq * (moq.moqUnit === 'cartons' ? moq.unitsPerCarton : 1)) {
        parts.push(`Desired quantity of ${desired} units is below MOQ of ${moq.moq} ${moq.moqUnit}.`);
      }
      if (moq.orderMultiple > 1) {
        parts.push(`Orders must be in multiples of ${moq.orderMultiple} units.`);
      }
      parts.push(`Adjusted to ${adjusted} units to meet supplier requirements.`);
    }

    return parts.join(' ');
  }

  // ==================== PRODUCT DIMENSIONS ====================

  /**
   * Set product dimensions for container calculations
   * Dimensions should be in cm, weight in kg
   */
  setProductDimensions(productId, dimensions) {
    const volumeCm3 = dimensions.lengthCm * dimensions.widthCm * dimensions.heightCm;
    const volumeM3 = volumeCm3 / 1000000; // Convert cm³ to m³

    this.productDimensions.set(productId, {
      productId,
      lengthCm: dimensions.lengthCm,
      widthCm: dimensions.widthCm,
      heightCm: dimensions.heightCm,
      weightKg: dimensions.weightKg || 0,
      volumeCm3,
      volumeM3,
      // Packaging dimensions (if different from product)
      packageLengthCm: dimensions.packageLengthCm || dimensions.lengthCm,
      packageWidthCm: dimensions.packageWidthCm || dimensions.widthCm,
      packageHeightCm: dimensions.packageHeightCm || dimensions.heightCm,
      packageWeightKg: dimensions.packageWeightKg || dimensions.weightKg || 0,
      unitsPerCarton: dimensions.unitsPerCarton || 1,
      cartonLengthCm: dimensions.cartonLengthCm || null,
      cartonWidthCm: dimensions.cartonWidthCm || null,
      cartonHeightCm: dimensions.cartonHeightCm || null,
      cartonWeightKg: dimensions.cartonWeightKg || null,
      lastUpdated: new Date(),
    });

    return this.productDimensions.get(productId);
  }

  /**
   * Get product dimensions
   */
  getProductDimensions(productId) {
    return this.productDimensions.get(productId);
  }

  /**
   * Calculate volume for a quantity of products
   */
  calculateProductVolume(productId, quantity) {
    const dims = this.productDimensions.get(productId);

    if (!dims) {
      return {
        error: 'No dimensions found for product',
        productId,
        quantity,
      };
    }

    // Calculate based on carton dimensions if available
    let totalVolumeM3;
    let totalWeightKg;
    let cartonCount = null;

    if (dims.cartonLengthCm && dims.unitsPerCarton > 0) {
      // Use carton-based calculation
      cartonCount = Math.ceil(quantity / dims.unitsPerCarton);
      const cartonVolumeCm3 = dims.cartonLengthCm * dims.cartonWidthCm * dims.cartonHeightCm;
      totalVolumeM3 = (cartonCount * cartonVolumeCm3) / 1000000;
      totalWeightKg = cartonCount * (dims.cartonWeightKg || (dims.packageWeightKg * dims.unitsPerCarton));
    } else {
      // Use individual product dimensions
      totalVolumeM3 = quantity * dims.volumeM3;
      totalWeightKg = quantity * dims.weightKg;
    }

    return {
      productId,
      quantity,
      cartonCount,
      unitsPerCarton: dims.unitsPerCarton,
      totalVolumeM3: Math.round(totalVolumeM3 * 1000) / 1000,
      totalWeightKg: Math.round(totalWeightKg * 100) / 100,
      dimensions: dims,
    };
  }

  // ==================== CONTAINER OPTIMIZATION ====================

  /**
   * Calculate how many units fit in a container
   */
  calculateContainerCapacity(productId, containerType = '40ft') {
    const dims = this.productDimensions.get(productId);
    const container = this.containerSpecs[containerType];

    if (!dims) {
      return { error: 'No dimensions found for product', productId };
    }

    if (!container) {
      return { error: 'Unknown container type', containerType };
    }

    const usableVolumeM3 = container.volumeM3 * container.usableVolumePercent;

    // Calculate based on cartons if available
    let unitsPerContainer;
    let cartonsPerContainer = null;
    let limitingFactor;

    if (dims.cartonLengthCm && dims.unitsPerCarton > 0) {
      const cartonVolumeCm3 = dims.cartonLengthCm * dims.cartonWidthCm * dims.cartonHeightCm;
      const cartonVolumeM3 = cartonVolumeCm3 / 1000000;
      const cartonWeightKg = dims.cartonWeightKg || (dims.packageWeightKg * dims.unitsPerCarton);

      // Volume-based capacity
      const cartonsbyVolume = Math.floor(usableVolumeM3 / cartonVolumeM3);

      // Weight-based capacity
      const cartonsByWeight = cartonWeightKg > 0
        ? Math.floor(container.maxWeightKg / cartonWeightKg)
        : Infinity;

      // Take the lower of the two
      if (cartonsByWeight < cartonsbyVolume) {
        cartonsPerContainer = cartonsByWeight;
        limitingFactor = 'weight';
      } else {
        cartonsPerContainer = cartonsbyVolume;
        limitingFactor = 'volume';
      }

      unitsPerContainer = cartonsPerContainer * dims.unitsPerCarton;
    } else {
      // Calculate based on individual product volume
      const unitsByVolume = Math.floor(usableVolumeM3 / dims.volumeM3);
      const unitsByWeight = dims.weightKg > 0
        ? Math.floor(container.maxWeightKg / dims.weightKg)
        : Infinity;

      if (unitsByWeight < unitsByVolume) {
        unitsPerContainer = unitsByWeight;
        limitingFactor = 'weight';
      } else {
        unitsPerContainer = unitsByVolume;
        limitingFactor = 'volume';
      }
    }

    return {
      containerType,
      containerSpec: container,
      productId,
      unitsPerContainer,
      cartonsPerContainer,
      unitsPerCarton: dims.unitsPerCarton,
      limitingFactor,
      utilizationPercent: Math.round(
        (cartonsPerContainer
          ? (cartonsPerContainer * dims.cartonLengthCm * dims.cartonWidthCm * dims.cartonHeightCm / 1000000)
          : (unitsPerContainer * dims.volumeM3)
        ) / container.volumeM3 * 100
      ),
    };
  }

  /**
   * Optimize order quantity for container utilization
   * Returns recommended quantities for optimal container fill
   */
  optimizeForContainer(params) {
    const {
      productId,
      desiredQuantity,
      preferredContainer = '40ft',
      maxContainers = 5,
      minFillPercent = 70, // Minimum container utilization
    } = params;

    const dims = this.productDimensions.get(productId);

    if (!dims) {
      return {
        error: 'No dimensions found for product',
        productId,
        recommendation: {
          quantity: desiredQuantity,
          reasoning: 'Cannot optimize without product dimensions.',
        },
      };
    }

    // Calculate capacity for each container type
    const containerOptions = Object.keys(this.containerSpecs).map(type => {
      const capacity = this.calculateContainerCapacity(productId, type);
      return {
        type,
        ...capacity,
        costMultiplier: type === '20ft' ? 0.65 : type === '40ft' ? 1.0 : 1.1,
      };
    });

    // Find optimal configuration
    const options = [];

    for (const container of containerOptions) {
      if (container.error) continue;

      for (let numContainers = 1; numContainers <= maxContainers; numContainers++) {
        const maxUnits = container.unitsPerContainer * numContainers;

        // Full containers
        if (desiredQuantity <= maxUnits) {
          const fillPercent = (desiredQuantity / maxUnits) * 100;
          if (fillPercent >= minFillPercent || numContainers === 1) {
            options.push({
              containerType: container.type,
              numContainers,
              quantity: desiredQuantity,
              maxCapacity: maxUnits,
              fillPercent: Math.round(fillPercent),
              relativeCost: container.costMultiplier * numContainers,
              costPerUnit: (container.costMultiplier * numContainers) / desiredQuantity,
              wastedSpace: maxUnits - desiredQuantity,
              recommendation: 'exact_fit',
            });
          }
        }

        // Fill to container capacity
        options.push({
          containerType: container.type,
          numContainers,
          quantity: maxUnits,
          maxCapacity: maxUnits,
          fillPercent: 100,
          relativeCost: container.costMultiplier * numContainers,
          costPerUnit: (container.costMultiplier * numContainers) / maxUnits,
          wastedSpace: 0,
          extraUnits: maxUnits - desiredQuantity,
          recommendation: 'full_container',
        });
      }
    }

    // Sort by cost efficiency
    options.sort((a, b) => {
      // Prioritize options that meet desired quantity
      const aMeetsDesired = a.quantity >= desiredQuantity ? 0 : 1;
      const bMeetsDesired = b.quantity >= desiredQuantity ? 0 : 1;
      if (aMeetsDesired !== bMeetsDesired) return aMeetsDesired - bMeetsDesired;

      // Then by cost per unit
      return a.costPerUnit - b.costPerUnit;
    });

    // Get MOQ constraints
    const moqResult = this.applyMOQConstraints({ productId, desiredQuantity });

    // Best option that also meets MOQ
    const bestOption = options.find(o => o.quantity >= moqResult.adjustedQuantity) || options[0];

    return {
      desiredQuantity,
      moqAdjustedQuantity: moqResult.adjustedQuantity,
      moqApplied: moqResult.moqApplied,
      recommendation: {
        quantity: bestOption.quantity,
        containerType: bestOption.containerType,
        numContainers: bestOption.numContainers,
        fillPercent: bestOption.fillPercent,
        extraUnits: bestOption.extraUnits || 0,
        reasoning: this._getContainerReasoning(desiredQuantity, bestOption, moqResult),
      },
      alternatives: options.slice(0, 5), // Top 5 alternatives
      moqDetails: moqResult,
    };
  }

  /**
   * Generate container optimization reasoning
   */
  _getContainerReasoning(desired, option, moqResult) {
    const parts = [];

    if (moqResult.moqApplied) {
      parts.push(`MOQ adjusted from ${desired} to ${moqResult.adjustedQuantity} units.`);
    }

    if (option.extraUnits > 0) {
      parts.push(
        `Recommended ${option.quantity} units (${option.extraUnits} extra) to fill ` +
        `${option.numContainers}x ${option.containerType} container(s) at ${option.fillPercent}% capacity.`
      );
      parts.push(
        `This reduces shipping cost per unit and avoids paying for empty container space.`
      );
    } else if (option.fillPercent < 100) {
      parts.push(
        `${option.quantity} units will fill ${option.numContainers}x ${option.containerType} ` +
        `container(s) to ${option.fillPercent}% capacity.`
      );
      if (option.fillPercent < 70) {
        parts.push(
          `Consider increasing order to improve container utilization and reduce per-unit shipping cost.`
        );
      }
    } else {
      parts.push(
        `${option.quantity} units perfectly fills ${option.numContainers}x ${option.containerType} container(s).`
      );
    }

    return parts.join(' ');
  }

  /**
   * Calculate optimal order for multiple products in one shipment
   * Useful for filling a container with multiple SKUs
   */
  optimizeMultiProductContainer(params) {
    const {
      products, // Array of { productId, desiredQuantity, priority }
      containerType = '40ft',
      maxContainers = 1,
    } = params;

    const container = this.containerSpecs[containerType];
    if (!container) {
      return { error: 'Unknown container type', containerType };
    }

    const usableVolumeM3 = container.volumeM3 * container.usableVolumePercent * maxContainers;
    const maxWeightKg = container.maxWeightKg * maxContainers;

    // Sort by priority (higher = more important)
    const sortedProducts = [...products].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    let remainingVolumeM3 = usableVolumeM3;
    let remainingWeightKg = maxWeightKg;
    const allocations = [];

    for (const product of sortedProducts) {
      const dims = this.productDimensions.get(product.productId);
      const moq = this.getProductMOQ(product.productId);

      if (!dims) {
        allocations.push({
          productId: product.productId,
          desiredQuantity: product.desiredQuantity,
          allocatedQuantity: 0,
          error: 'No dimensions available',
        });
        continue;
      }

      // Calculate how much fits
      const volumePerUnit = dims.cartonLengthCm
        ? (dims.cartonLengthCm * dims.cartonWidthCm * dims.cartonHeightCm / 1000000) / dims.unitsPerCarton
        : dims.volumeM3;
      const weightPerUnit = dims.cartonWeightKg
        ? dims.cartonWeightKg / dims.unitsPerCarton
        : dims.weightKg;

      const maxByVolume = Math.floor(remainingVolumeM3 / volumePerUnit);
      const maxByWeight = weightPerUnit > 0 ? Math.floor(remainingWeightKg / weightPerUnit) : Infinity;
      const maxFit = Math.min(maxByVolume, maxByWeight);

      // Apply desired quantity and MOQ
      let allocated = Math.min(product.desiredQuantity, maxFit);

      // Ensure meets MOQ or is 0
      if (allocated > 0 && allocated < moq.moq) {
        if (moq.moq <= maxFit) {
          allocated = moq.moq;
        } else {
          allocated = 0; // Can't fit MOQ
        }
      }

      // Round to order multiple
      if (allocated > 0 && moq.orderMultiple > 1) {
        allocated = Math.floor(allocated / moq.orderMultiple) * moq.orderMultiple;
      }

      const allocatedVolumeM3 = allocated * volumePerUnit;
      const allocatedWeightKg = allocated * weightPerUnit;

      remainingVolumeM3 -= allocatedVolumeM3;
      remainingWeightKg -= allocatedWeightKg;

      allocations.push({
        productId: product.productId,
        desiredQuantity: product.desiredQuantity,
        allocatedQuantity: allocated,
        volumeM3: Math.round(allocatedVolumeM3 * 1000) / 1000,
        weightKg: Math.round(allocatedWeightKg * 100) / 100,
        fulfillmentPercent: Math.round((allocated / product.desiredQuantity) * 100),
        moqMet: allocated >= moq.moq || allocated === 0,
      });
    }

    const totalVolumeUsed = usableVolumeM3 - remainingVolumeM3;
    const totalWeightUsed = maxWeightKg - remainingWeightKg;

    return {
      containerType,
      maxContainers,
      allocations,
      summary: {
        volumeUsedM3: Math.round(totalVolumeUsed * 1000) / 1000,
        volumeAvailableM3: Math.round(remainingVolumeM3 * 1000) / 1000,
        volumeUtilizationPercent: Math.round((totalVolumeUsed / usableVolumeM3) * 100),
        weightUsedKg: Math.round(totalWeightUsed * 100) / 100,
        weightAvailableKg: Math.round(remainingWeightKg * 100) / 100,
        weightUtilizationPercent: Math.round((totalWeightUsed / maxWeightKg) * 100),
        limitingFactor: remainingVolumeM3 < remainingWeightKg / 1000 ? 'volume' : 'weight',
      },
      productsFullyAllocated: allocations.filter(a => a.allocatedQuantity >= a.desiredQuantity).length,
      productsPartiallyAllocated: allocations.filter(
        a => a.allocatedQuantity > 0 && a.allocatedQuantity < a.desiredQuantity
      ).length,
      productsNotAllocated: allocations.filter(a => a.allocatedQuantity === 0).length,
    };
  }

  /**
   * Get container recommendations for an order
   */
  getContainerRecommendation(totalVolumeM3, totalWeightKg) {
    const options = [];

    for (const [type, spec] of Object.entries(this.containerSpecs)) {
      const usableVolume = spec.volumeM3 * spec.usableVolumePercent;

      // Calculate how many containers needed
      const byVolume = Math.ceil(totalVolumeM3 / usableVolume);
      const byWeight = Math.ceil(totalWeightKg / spec.maxWeightKg);
      const containersNeeded = Math.max(byVolume, byWeight);

      const totalCapacityVolume = containersNeeded * usableVolume;
      const totalCapacityWeight = containersNeeded * spec.maxWeightKg;

      options.push({
        containerType: type,
        containerName: spec.name,
        containersNeeded,
        volumeUtilization: Math.round((totalVolumeM3 / totalCapacityVolume) * 100),
        weightUtilization: Math.round((totalWeightKg / totalCapacityWeight) * 100),
        limitingFactor: byVolume >= byWeight ? 'volume' : 'weight',
        wastedVolumeM3: Math.round((totalCapacityVolume - totalVolumeM3) * 1000) / 1000,
        relativeCost: type === '20ft' ? containersNeeded * 0.65 : type === '40ft' ? containersNeeded : containersNeeded * 1.1,
      });
    }

    // Sort by cost
    options.sort((a, b) => a.relativeCost - b.relativeCost);

    return {
      totalVolumeM3,
      totalWeightKg,
      recommended: options[0],
      alternatives: options.slice(1),
    };
  }
}

// Singleton instance
let supplyChainManagerInstance = null;

function getSupplyChainManager(config = {}) {
  if (!supplyChainManagerInstance) {
    supplyChainManagerInstance = new SupplyChainManager(config);
  }
  return supplyChainManagerInstance;
}

module.exports = {
  SupplyChainManager,
  getSupplyChainManager,
};
