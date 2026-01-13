/**
 * SkuTransformer - Centralized SKU transformation utilities
 *
 * Single source of truth for transforming Amazon SKUs to Odoo SKUs.
 * Handles return SKUs (amzn.gr.*), suffix variations (-FBM, -stickerless, etc.)
 *
 * Previously this logic was duplicated in:
 * - VcsOdooInvoicer.js
 * - ItalyFbaInvoicer.js
 * - SellerOrderCreator.js
 *
 * @module SkuTransformer
 */

/**
 * SKU transformation patterns
 * Applied in order after return SKU extraction
 */
const SKU_TRANSFORMATIONS = [
  // Strip fulfillment suffixes
  { pattern: /-FBM$/, replacement: '', description: 'Fulfilled by Merchant suffix' },
  { pattern: /-FBMA$/, replacement: '', description: 'FBM Amazon suffix' },
  { pattern: /-FBA$/, replacement: '', description: 'Fulfilled by Amazon suffix' },
  // Strip variant suffixes
  { pattern: /-stickerless$/, replacement: '', description: 'Stickerless variant' },
  { pattern: /-stickerles$/, replacement: '', description: 'Stickerless typo variant' },
  // Strip color/size codes (if needed)
  // { pattern: /-[A-Z]{2}$/, replacement: '', description: 'Color code' },
];

/**
 * Return SKU pattern
 * Format: amzn.gr.[base-sku]-[random-string]
 * The random string can contain alphanumeric, underscores, and dashes
 *
 * Examples:
 * - amzn.gr.10050K-FBM-6sC9nyZuQGExqXIpf9-VG → 10050K-FBM → 10050K
 * - amzn.gr.B42056R4-h3lB_uOM6o2MKLVE45Y--VG → B42056R4
 */
const RETURN_SKU_PATTERN = /^amzn\.gr\.(.+?)-[A-Za-z0-9_-]{8,}/;

/**
 * Transform an Amazon SKU to a base Odoo SKU
 *
 * @param {string} amazonSku - The SKU from Amazon
 * @param {Object} options - Transformation options
 * @param {boolean} options.stripFulfillmentSuffix - Strip -FBM/-FBA suffixes (default: true)
 * @param {boolean} options.handleReturns - Handle amzn.gr.* return SKUs (default: true)
 * @returns {string} The transformed SKU
 */
function transformSku(amazonSku, options = {}) {
  if (!amazonSku) return amazonSku;

  const {
    stripFulfillmentSuffix = true,
    handleReturns = true
  } = options;

  let sku = amazonSku.trim();

  // Step 1: Handle return SKUs (amzn.gr.*)
  if (handleReturns) {
    const returnMatch = sku.match(RETURN_SKU_PATTERN);
    if (returnMatch) {
      sku = returnMatch[1];
    }
  }

  // Step 2: Apply transformation patterns
  if (stripFulfillmentSuffix) {
    for (const transform of SKU_TRANSFORMATIONS) {
      sku = sku.replace(transform.pattern, transform.replacement);
    }
  }

  return sku;
}

/**
 * Check if a SKU is a return/replacement SKU
 *
 * @param {string} sku - The SKU to check
 * @returns {boolean} True if this is a return SKU
 */
function isReturnSku(sku) {
  if (!sku) return false;
  return RETURN_SKU_PATTERN.test(sku);
}

/**
 * Extract base SKU from a return SKU
 *
 * @param {string} returnSku - The return SKU (amzn.gr.*)
 * @returns {string|null} The base SKU or null if not a return SKU
 */
function extractBaseSkuFromReturn(returnSku) {
  if (!returnSku) return null;
  const match = returnSku.match(RETURN_SKU_PATTERN);
  return match ? match[1] : null;
}

/**
 * Generate all possible SKU variants for matching
 *
 * @param {string} sku - The original SKU
 * @returns {string[]} Array of SKU variants to try
 */
function getSkuVariants(sku) {
  if (!sku) return [];

  const variants = new Set();
  const baseSku = transformSku(sku);

  // Original SKU
  variants.add(sku);

  // Transformed SKU
  variants.add(baseSku);

  // Without fulfillment suffix
  variants.add(sku.replace(/-FBM$/, ''));
  variants.add(sku.replace(/-FBMA$/, ''));
  variants.add(sku.replace(/-FBA$/, ''));

  // If return SKU, add base
  if (isReturnSku(sku)) {
    const base = extractBaseSkuFromReturn(sku);
    if (base) {
      variants.add(base);
      // Also add base without suffixes
      variants.add(base.replace(/-FBM$/, ''));
      variants.add(base.replace(/-FBMA$/, ''));
      variants.add(base.replace(/-FBA$/, ''));
    }
  }

  return Array.from(variants).filter(v => v && v.length > 0);
}

/**
 * Match an Amazon SKU to Odoo products
 *
 * @param {string} amazonSku - The SKU from Amazon
 * @param {Function} searchFn - Function to search for products (async, takes SKU, returns array)
 * @returns {Promise<Object|null>} Matching product or null
 */
async function findMatchingProduct(amazonSku, searchFn) {
  const variants = getSkuVariants(amazonSku);

  for (const variant of variants) {
    const results = await searchFn(variant);
    if (results && results.length > 0) {
      return results[0];
    }
  }

  return null;
}

module.exports = {
  transformSku,
  isReturnSku,
  extractBaseSkuFromReturn,
  getSkuVariants,
  findMatchingProduct,
  SKU_TRANSFORMATIONS,
  RETURN_SKU_PATTERN
};
