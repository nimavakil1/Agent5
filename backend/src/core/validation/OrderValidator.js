/**
 * OrderValidator - Centralized validation for Amazon Seller orders
 *
 * Validates order data before storage/processing to prevent data quality issues.
 * Part of Phase 1 reliability improvements.
 *
 * @module OrderValidator
 */

const { getMarketplaceIdByCountry, MARKETPLACE_IDS } = require('../../services/amazon/seller/SellerMarketplaceConfig');

/**
 * Required fields for FBM orders to enable tracking push
 */
const FBM_REQUIRED_FIELDS = {
  'sourceIds.amazonOrderId': 'Amazon Order ID',
  'marketplace.code': 'Marketplace code',
  'items': 'Order items'
};

/**
 * Required fields for each order item
 */
const ITEM_REQUIRED_FIELDS = {
  'sku': 'SKU',
  'quantity': 'Quantity'
};

/**
 * Fields required for tracking push specifically
 */
const TRACKING_PUSH_REQUIRED = {
  marketplaceId: 'Marketplace ID (can be derived from code)',
  orderItemIds: 'Order Item IDs (can be fetched from Amazon)'
};

/**
 * Validation result structure
 */
class ValidationResult {
  constructor() {
    this.valid = true;
    this.errors = [];
    this.warnings = [];
    this.fixes = [];
  }

  addError(field, message) {
    this.valid = false;
    this.errors.push({ field, message });
  }

  addWarning(field, message) {
    this.warnings.push({ field, message });
  }

  addFix(field, message, value) {
    this.fixes.push({ field, message, value });
  }
}

/**
 * Validate an Amazon Seller order
 *
 * @param {Object} order - The order to validate
 * @param {Object} options - Validation options
 * @param {boolean} options.strict - If true, warnings become errors
 * @param {boolean} options.autoFix - If true, attempt to fix issues
 * @returns {ValidationResult}
 */
function validateOrder(order, options = {}) {
  const result = new ValidationResult();
  const { strict = false, autoFix = true } = options;

  // Check required fields
  for (const [path, name] of Object.entries(FBM_REQUIRED_FIELDS)) {
    const value = getNestedValue(order, path);
    if (value === undefined || value === null || value === '') {
      result.addError(path, `Missing required field: ${name}`);
    }
  }

  // Validate marketplace
  const marketplaceId = order.amazonSeller?.marketplaceId || order.marketplace?.id;
  const marketplaceCode = order.marketplace?.code;

  if (!marketplaceId && marketplaceCode) {
    const derivedId = getMarketplaceIdByCountry(marketplaceCode);
    if (derivedId) {
      if (autoFix) {
        result.addFix('marketplace.id', `Derived from code ${marketplaceCode}`, derivedId);
      } else {
        result.addWarning('marketplace.id', `Missing but can be derived from code ${marketplaceCode}`);
      }
    } else {
      result.addError('marketplace.id', `Unknown marketplace code: ${marketplaceCode}`);
    }
  } else if (!marketplaceId && !marketplaceCode) {
    result.addError('marketplace', 'Missing marketplace ID and code');
  }

  // Validate items
  if (order.items && Array.isArray(order.items)) {
    order.items.forEach((item, index) => {
      for (const [field, name] of Object.entries(ITEM_REQUIRED_FIELDS)) {
        if (item[field] === undefined || item[field] === null || item[field] === '') {
          result.addError(`items[${index}].${field}`, `Missing required field: ${name}`);
        }
      }

      // Check orderItemId (warning, can be fetched)
      if (!item.orderItemId) {
        if (strict) {
          result.addError(`items[${index}].orderItemId`, 'Missing orderItemId - required for tracking push');
        } else {
          result.addWarning(`items[${index}].orderItemId`, 'Missing orderItemId - will be fetched from Amazon when needed');
        }
      }
    });
  }

  // Validate fulfillment channel
  const fulfillmentChannel = order.amazonSeller?.fulfillmentChannel;
  if (fulfillmentChannel && !['AFN', 'MFN'].includes(fulfillmentChannel)) {
    result.addError('amazonSeller.fulfillmentChannel', `Invalid fulfillment channel: ${fulfillmentChannel}`);
  }

  return result;
}

/**
 * Validate order for tracking push specifically
 *
 * @param {Object} order - The order to validate
 * @returns {ValidationResult}
 */
function validateForTrackingPush(order) {
  const result = new ValidationResult();

  // Must be FBM
  if (order.amazonSeller?.fulfillmentChannel !== 'MFN') {
    result.addError('fulfillmentChannel', 'Only FBM (MFN) orders support tracking push');
    return result;
  }

  // Check marketplaceId
  const marketplaceId = order.amazonSeller?.marketplaceId || order.marketplace?.id;
  if (!marketplaceId) {
    const code = order.marketplace?.code;
    if (code) {
      const derivedId = getMarketplaceIdByCountry(code);
      if (derivedId) {
        result.addFix('marketplaceId', `Can derive from code ${code}`, derivedId);
      } else {
        result.addError('marketplaceId', `Cannot derive from unknown code: ${code}`);
      }
    } else {
      result.addError('marketplaceId', 'Missing marketplace ID and code');
    }
  }

  // Check orderItemIds
  const hasOrderItemIds = order.items?.some(item => item.orderItemId);
  if (!hasOrderItemIds) {
    result.addWarning('orderItemIds', 'Missing orderItemIds - will need to fetch from Amazon API');
  }

  // Check amazonOrderId
  if (!order.sourceIds?.amazonOrderId) {
    result.addError('amazonOrderId', 'Missing Amazon Order ID');
  }

  return result;
}

/**
 * Apply fixes from validation result to an order
 *
 * @param {Object} order - The order to fix
 * @param {ValidationResult} result - The validation result with fixes
 * @returns {Object} The fixed order (modified in place)
 */
function applyFixes(order, result) {
  for (const fix of result.fixes) {
    setNestedValue(order, fix.field, fix.value);
  }
  return order;
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : undefined;
  }, obj);
}

/**
 * Set nested value in object using dot notation
 */
function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  const target = keys.reduce((current, key) => {
    if (current[key] === undefined) {
      current[key] = {};
    }
    return current[key];
  }, obj);
  target[lastKey] = value;
  return obj;
}

/**
 * Batch validate multiple orders
 *
 * @param {Array} orders - Orders to validate
 * @param {Object} options - Validation options
 * @returns {Object} Summary of validation results
 */
function validateOrders(orders, options = {}) {
  const summary = {
    total: orders.length,
    valid: 0,
    invalid: 0,
    withWarnings: 0,
    withFixes: 0,
    errors: [],
    results: []
  };

  for (const order of orders) {
    const result = validateOrder(order, options);
    summary.results.push({
      orderId: order.sourceIds?.amazonOrderId || 'unknown',
      result
    });

    if (result.valid) {
      summary.valid++;
    } else {
      summary.invalid++;
      summary.errors.push({
        orderId: order.sourceIds?.amazonOrderId || 'unknown',
        errors: result.errors
      });
    }

    if (result.warnings.length > 0) {
      summary.withWarnings++;
    }

    if (result.fixes.length > 0) {
      summary.withFixes++;
    }
  }

  return summary;
}

module.exports = {
  ValidationResult,
  validateOrder,
  validateForTrackingPush,
  applyFixes,
  validateOrders,
  FBM_REQUIRED_FIELDS,
  ITEM_REQUIRED_FIELDS,
  TRACKING_PUSH_REQUIRED
};
