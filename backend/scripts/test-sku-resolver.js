/**
 * Test SKU Resolver Logic
 *
 * Tests the SkuResolver patterns without needing MongoDB
 */

// Simulate the resolve logic
function resolve(amazonSku, customMappings = new Map(), returnPatterns = []) {
  if (!amazonSku) {
    return { odooSku: null, fulfillmentType: 'unknown', isReturn: false, originalSku: amazonSku };
  }

  const original = amazonSku.trim();
  const upper = original.toUpperCase();

  // Step 1: Check custom mapping first
  if (customMappings.has(upper)) {
    return {
      odooSku: customMappings.get(upper),
      fulfillmentType: upper.includes('-FBM') ? 'FBM' : 'FBA',
      isReturn: false,
      originalSku: original,
      matchType: 'custom_mapping'
    };
  }

  // Step 2: Check return patterns
  for (const pattern of returnPatterns) {
    const match = original.match(pattern.regex);
    if (match) {
      const extractedSku = match[pattern.extractGroup] || match[1];
      // Recursively resolve the extracted SKU
      const resolved = resolve(extractedSku, customMappings, returnPatterns);
      return {
        ...resolved,
        isReturn: true,
        originalSku: original,
        matchType: 'return_pattern'
      };
    }
  }

  // Step 3: Strip known suffixes
  let sku = original;
  let fulfillmentType = 'FBA';

  // FBM suffixes
  if (upper.endsWith('-FBMA')) {
    sku = original.slice(0, -5);
    fulfillmentType = 'FBM';
  } else if (upper.endsWith('-FBM')) {
    sku = original.slice(0, -4);
    fulfillmentType = 'FBM';
  }

  // Other common suffixes
  const suffixesToStrip = ['-stickerless', '-stickered', '-bundle', '-new', '-refurb'];
  for (const suffix of suffixesToStrip) {
    if (sku.toLowerCase().endsWith(suffix)) {
      sku = sku.slice(0, -suffix.length);
      break;
    }
  }

  // Step 4: Strip trailing "A" suffix only (for 5-digit SKUs)
  if (/^[0-9]{5}A$/i.test(sku)) {
    sku = sku.slice(0, -1);
  }

  // Step 5: Pad with leading zeros
  if (/^[0-9]{1,4}$/.test(sku)) {
    sku = sku.padStart(5, '0');
  }

  // Step 6: Check if cleaned SKU needs custom mapping
  if (customMappings.has(sku.toUpperCase())) {
    return {
      odooSku: customMappings.get(sku.toUpperCase()),
      fulfillmentType,
      isReturn: false,
      originalSku: original,
      matchType: 'custom_mapping_after_strip'
    };
  }

  return {
    odooSku: sku,
    fulfillmentType,
    isReturn: false,
    originalSku: original,
    matchType: 'direct'
  };
}

// Custom mappings
const customMappings = new Map([
  ['09019.A', '09019'],
  ['18011A', '18010'],
  ['42035-STICKERLES', '42035'],
  ['B42032A', 'B42032'],
  ['B42030.B40', 'P0181'],
  ['B42030.B40.BLACK', 'P0182'],
  ['B42030.BLACK', 'P0183'],
]);

// Return patterns
const returnPatterns = [
  { regex: /amzn\.gr\.([A-Z0-9.]+)-/i, extractGroup: 1 }
];

// Test cases
const testCases = [
  // Direct matches
  { input: '18011', expected: '18011', type: 'direct' },
  { input: '01006', expected: '01006', type: 'direct' },

  // FBM suffix stripping
  { input: '18011-FBM', expected: '18011', type: 'FBM suffix' },
  { input: '18011-FBMA', expected: '18011', type: 'FBMA suffix' },

  // Stickerless suffix
  { input: '41010-stickerless', expected: '41010', type: 'stickerless suffix' },

  // Leading zeros
  { input: '1006', expected: '01006', type: 'leading zeros' },
  { input: '9002', expected: '09002', type: 'leading zeros' },

  // Trailing A on 5-digit
  { input: '01023A', expected: '01023', type: 'trailing A' },
  { input: '09002A', expected: '09002', type: 'trailing A' },

  // Color codes (should NOT strip)
  { input: '10005B-FBM', expected: '10005B', type: 'color code B' },
  { input: '10005K-FBM', expected: '10005K', type: 'color code K' },
  { input: '10005S-FBM', expected: '10005S', type: 'color code S' },
  { input: '10005W-FBM', expected: '10005W', type: 'color code W' },

  // Custom mappings
  { input: '09019.A', expected: '09019', type: 'custom: dot suffix' },
  { input: '18011A', expected: '18010', type: 'custom: wrong base SKU' },
  { input: 'B42030.B40', expected: 'P0181', type: 'custom: variant mapping' },
  { input: 'B42030.B40.BLACK', expected: 'P0182', type: 'custom: variant mapping' },
  { input: 'B42030.BLACK', expected: 'P0183', type: 'custom: variant mapping' },

  // Return patterns
  { input: 'amzn.gr.P0213-dXLWA2YIkQCrzwiGmHysjjq-PO', expected: 'P0213', type: 'return pattern', isReturn: true },
  { input: 'amzn.gr.B42030.A-CU4GOcZsZ4mdVWesmjLo-LN', expected: 'B42030.A', type: 'return pattern', isReturn: true },

  // Complex cases
  { input: 'P0256-FBMA', expected: 'P0256', type: 'alphanumeric + FBMA' },
  { input: 'P0256-FBM', expected: 'P0256', type: 'alphanumeric + FBM' },
  { input: '83001W-FBM', expected: '83001W', type: 'numeric + color + FBM' },
  { input: 'B42012B-stickerless', expected: 'B42012B', type: 'alphanumeric + stickerless' },
];

console.log('=== SKU Resolver Tests ===\n');

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const result = resolve(test.input, customMappings, returnPatterns);
  const success = result.odooSku === test.expected;
  const returnCheck = test.isReturn ? result.isReturn === true : true;

  if (success && returnCheck) {
    console.log(`✓ ${test.type}: "${test.input}" → "${result.odooSku}"`);
    passed++;
  } else {
    console.log(`✗ ${test.type}: "${test.input}"`);
    console.log(`  Expected: "${test.expected}", Got: "${result.odooSku}"`);
    if (test.isReturn) {
      console.log(`  Expected isReturn: true, Got: ${result.isReturn}`);
    }
    failed++;
  }
}

console.log(`\n=== Results ===`);
console.log(`Passed: ${passed}/${testCases.length}`);
console.log(`Failed: ${failed}/${testCases.length}`);

if (failed > 0) {
  process.exit(1);
}
