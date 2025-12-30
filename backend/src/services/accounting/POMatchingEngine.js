/**
 * POMatchingEngine - Match vendor invoices to Purchase Orders in Odoo
 *
 * Matching strategies (priority order):
 * 1. Exact PO Reference (95-100% confidence)
 * 2. Vendor + Amount Match (80-95%)
 * 3. Vendor + Line Item Match (70-90%)
 * 4. Fuzzy Match (50-70%)
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

class POMatchingEngine {
  constructor(odooClient = null) {
    this.odooClient = odooClient;

    // Matching tolerances
    this.tolerances = {
      amountPercent: 5, // 5% variance allowed
      dateRangeDays: 90, // Invoice within 90 days of PO
      quantityPercent: 10, // Line quantity variance
    };

    // Confidence thresholds
    this.thresholds = {
      autoApprove: 95,
      highConfidence: 80,
      mediumConfidence: 60,
      lowConfidence: 50,
    };
  }

  /**
   * Initialize Odoo client if not provided
   */
  async _ensureClient() {
    if (!this.odooClient) {
      this.odooClient = new OdooDirectClient();
      await this.odooClient.authenticate();
    }
  }

  /**
   * Match an invoice to Purchase Orders
   * @param {Object} invoiceData - Normalized invoice data from InvoiceParser
   * @returns {Object} Match result with confidence and matched POs
   */
  async matchInvoice(invoiceData) {
    await this._ensureClient();

    console.log(`[POMatchingEngine] Matching invoice: ${invoiceData.invoice?.number} from ${invoiceData.vendor?.name}`);

    const result = {
      confidence: 0,
      matchType: 'none',
      matchedPOs: [],
      recommendations: [],
      vendor: null,
    };

    // Step 1: Try exact PO reference match
    if (invoiceData.invoice?.poReference) {
      const poMatch = await this._matchByPOReference(invoiceData.invoice.poReference);
      if (poMatch) {
        console.log(`[POMatchingEngine] Exact PO match found: ${poMatch.name}`);
        result.confidence = 98;
        result.matchType = 'exact_po_reference';
        result.matchedPOs = [poMatch];
        return result;
      }
    }

    // Step 2: Find vendor by VAT number
    const vendor = await this._findVendor(invoiceData.vendor);
    result.vendor = vendor;

    if (!vendor) {
      console.log(`[POMatchingEngine] Vendor not found: ${invoiceData.vendor?.name}`);
      result.recommendations.push({
        type: 'create_vendor',
        message: `Vendor not found: ${invoiceData.vendor?.name} (VAT: ${invoiceData.vendor?.vatNumber})`,
      });
      return result;
    }

    // Step 3: Get pending POs for this vendor
    const pendingPOs = await this._getPendingPOsForVendor(vendor.id);
    console.log(`[POMatchingEngine] Found ${pendingPOs.length} pending POs for vendor`);

    if (pendingPOs.length === 0) {
      result.recommendations.push({
        type: 'no_pending_pos',
        message: `No pending purchase orders found for ${vendor.name}`,
      });
      return result;
    }

    // Step 4: Score each PO
    for (const po of pendingPOs) {
      const score = await this._scorePOMatch(invoiceData, po);

      if (score.confidence >= this.thresholds.lowConfidence) {
        result.matchedPOs.push({
          ...po,
          matchConfidence: score.confidence,
          matchType: score.matchType,
          matchDetails: score.matchDetails,
        });
      }
    }

    // Sort by confidence
    result.matchedPOs.sort((a, b) => b.matchConfidence - a.matchConfidence);

    // Set overall result
    if (result.matchedPOs.length > 0) {
      const best = result.matchedPOs[0];
      result.confidence = best.matchConfidence;
      result.matchType = best.matchType;
    }

    return result;
  }

  /**
   * Match by exact PO reference
   */
  async _matchByPOReference(poReference) {
    // Normalize the reference
    const normalized = String(poReference).trim().toUpperCase();

    // Try exact match
    let pos = await this.odooClient.searchRead('purchase.order', [
      ['name', '=ilike', normalized],
    ], ['id', 'name', 'partner_id', 'amount_total', 'state', 'order_line'], { limit: 1 });

    if (pos.length > 0) {
      return this._formatPO(pos[0]);
    }

    // Try partial match
    pos = await this.odooClient.searchRead('purchase.order', [
      ['name', 'ilike', normalized],
    ], ['id', 'name', 'partner_id', 'amount_total', 'state', 'order_line'], { limit: 5 });

    if (pos.length === 1) {
      return this._formatPO(pos[0]);
    }

    return null;
  }

  /**
   * Find vendor in Odoo by VAT or name
   */
  async _findVendor(vendorData) {
    if (!vendorData) return null;

    // Try by VAT number first
    if (vendorData.vatNumber) {
      const normalized = vendorData.vatNumber.replace(/\s/g, '').toUpperCase();

      const vendors = await this.odooClient.searchRead('res.partner', [
        ['vat', '=ilike', normalized],
        ['supplier_rank', '>', 0],
      ], ['id', 'name', 'vat', 'email', 'phone'], { limit: 1 });

      if (vendors.length > 0) {
        return vendors[0];
      }

      // Try without country prefix
      const vatWithoutCountry = normalized.replace(/^[A-Z]{2}/, '');
      const vendors2 = await this.odooClient.searchRead('res.partner', [
        ['vat', 'ilike', vatWithoutCountry],
        ['supplier_rank', '>', 0],
      ], ['id', 'name', 'vat', 'email', 'phone'], { limit: 1 });

      if (vendors2.length > 0) {
        return vendors2[0];
      }
    }

    // Try by name
    if (vendorData.name) {
      const vendors = await this.odooClient.searchRead('res.partner', [
        ['name', 'ilike', vendorData.name],
        ['supplier_rank', '>', 0],
      ], ['id', 'name', 'vat', 'email', 'phone'], { limit: 5 });

      if (vendors.length === 1) {
        return vendors[0];
      }

      // If multiple matches, try more specific matching
      if (vendors.length > 1) {
        // Return the one with highest supplier rank
        const rankedVendors = await this.odooClient.searchRead('res.partner', [
          ['id', 'in', vendors.map(v => v.id)],
        ], ['id', 'name', 'vat', 'supplier_rank'], { order: 'supplier_rank desc', limit: 1 });

        if (rankedVendors.length > 0) {
          return rankedVendors[0];
        }
      }
    }

    return null;
  }

  /**
   * Get pending POs for a vendor
   */
  async _getPendingPOsForVendor(vendorId) {
    const pos = await this.odooClient.searchRead('purchase.order', [
      ['partner_id', '=', vendorId],
      ['state', 'in', ['purchase', 'done']], // Confirmed orders
      ['invoice_status', 'in', ['to invoice', 'no']], // Not fully invoiced
    ], [
      'id', 'name', 'date_order', 'amount_total', 'amount_untaxed',
      'state', 'invoice_status', 'order_line', 'currency_id',
    ], { order: 'date_order desc', limit: 50 });

    return pos.map(po => this._formatPO(po));
  }

  /**
   * Format PO data
   */
  _formatPO(po) {
    return {
      id: po.id,
      name: po.name,
      vendor: po.partner_id?.[1],
      vendorId: po.partner_id?.[0],
      orderDate: po.date_order,
      total: po.amount_total,
      subtotal: po.amount_untaxed,
      state: po.state,
      invoiceStatus: po.invoice_status,
      currency: po.currency_id?.[1] || 'EUR',
      lineIds: po.order_line || [],
    };
  }

  /**
   * Score how well an invoice matches a PO
   */
  async _scorePOMatch(invoice, po) {
    let score = 0;
    const matchDetails = [];

    // Amount match (40 points max)
    const invoiceAmount = invoice.totals?.totalAmount || 0;
    const poAmount = po.total || 0;

    if (poAmount > 0 && invoiceAmount > 0) {
      const amountVariance = Math.abs(invoiceAmount - poAmount) / poAmount;

      if (amountVariance <= 0.01) {
        score += 40;
        matchDetails.push('Exact amount match');
      } else if (amountVariance <= 0.02) {
        score += 35;
        matchDetails.push(`Amount within 2% (${(amountVariance * 100).toFixed(1)}%)`);
      } else if (amountVariance <= this.tolerances.amountPercent / 100) {
        score += 30;
        matchDetails.push(`Amount within ${this.tolerances.amountPercent}% (${(amountVariance * 100).toFixed(1)}%)`);
      } else if (amountVariance <= 0.10) {
        score += 15;
        matchDetails.push(`Amount differs by ${(amountVariance * 100).toFixed(1)}%`);
      }
    }

    // Line item matching (35 points max)
    if (invoice.lines?.length > 0 && po.lineIds?.length > 0) {
      const lineScore = await this._matchLineItems(invoice.lines, po.lineIds);
      score += lineScore.points;
      matchDetails.push(...lineScore.details);
    }

    // Date proximity (15 points max)
    const invoiceDate = new Date(invoice.invoice?.date);
    const poDate = new Date(po.orderDate);

    if (!isNaN(invoiceDate.getTime()) && !isNaN(poDate.getTime())) {
      const daysDiff = Math.abs((invoiceDate - poDate) / (1000 * 60 * 60 * 24));

      if (daysDiff <= 14) {
        score += 15;
        matchDetails.push('Invoice within 2 weeks of PO');
      } else if (daysDiff <= 30) {
        score += 12;
        matchDetails.push('Invoice within 1 month of PO');
      } else if (daysDiff <= 60) {
        score += 8;
        matchDetails.push('Invoice within 2 months of PO');
      } else if (daysDiff <= this.tolerances.dateRangeDays) {
        score += 5;
        matchDetails.push('Invoice within 3 months of PO');
      }
    }

    // Currency match (10 points)
    const invoiceCurrency = (invoice.invoice?.currency || 'EUR').toUpperCase();
    const poCurrency = (po.currency || 'EUR').toUpperCase();

    if (invoiceCurrency === poCurrency) {
      score += 10;
    } else {
      matchDetails.push(`Currency mismatch: ${invoiceCurrency} vs ${poCurrency}`);
    }

    // Determine match type
    let matchType = 'none';
    if (score >= 95) matchType = 'exact';
    else if (score >= 80) matchType = 'high_confidence';
    else if (score >= 60) matchType = 'medium_confidence';
    else if (score >= 50) matchType = 'low_confidence';

    return {
      confidence: Math.min(score, 100),
      matchType,
      matchDetails,
    };
  }

  /**
   * Match invoice lines to PO lines
   */
  async _matchLineItems(invoiceLines, poLineIds) {
    let matchedCount = 0;
    const details = [];

    // Get PO line details
    const poLines = await this.odooClient.read('purchase.order.line', poLineIds, [
      'name', 'product_id', 'product_qty', 'price_unit', 'price_subtotal',
    ]);

    for (const invLine of invoiceLines) {
      for (const poLine of poLines) {
        // Try SKU match
        if (invLine.sku && poLine.product_id) {
          const productName = poLine.product_id[1] || '';
          if (this._normalizeSku(invLine.sku) === this._normalizeSku(productName)) {
            matchedCount++;
            details.push(`SKU match: ${invLine.sku}`);
            break;
          }
        }

        // Try description fuzzy match
        if (this._fuzzyMatch(invLine.description, poLine.name) > 0.6) {
          matchedCount++;
          details.push(`Description match: "${invLine.description?.substring(0, 30)}..."`);
          break;
        }

        // Try amount match (unit price)
        if (invLine.unitPrice && poLine.price_unit) {
          const priceVariance = Math.abs(invLine.unitPrice - poLine.price_unit) / poLine.price_unit;
          if (priceVariance < 0.01) {
            matchedCount++;
            details.push(`Price match: ${invLine.unitPrice}`);
            break;
          }
        }
      }
    }

    const matchRatio = matchedCount / Math.max(invoiceLines.length, 1);

    return {
      points: Math.round(matchRatio * 35),
      details,
    };
  }

  /**
   * Normalize SKU for comparison
   */
  _normalizeSku(sku) {
    if (!sku) return '';
    return String(sku).toUpperCase().replace(/[-\s_.]/g, '');
  }

  /**
   * Simple fuzzy string matching
   */
  _fuzzyMatch(str1, str2) {
    if (!str1 || !str2) return 0;

    const s1 = String(str1).toLowerCase().trim();
    const s2 = String(str2).toLowerCase().trim();

    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Simple word overlap
    const words1 = new Set(s1.split(/\s+/));
    const words2 = new Set(s2.split(/\s+/));
    const intersection = [...words1].filter(w => words2.has(w));
    const union = new Set([...words1, ...words2]);

    return intersection.length / union.size;
  }
}

module.exports = POMatchingEngine;
