/**
 * BolFulfillmentSwapper - Automatically swap between FBB and FBR fulfillment
 *
 * Logic (from Emipro bol_extended_ept):
 * - For FBB offers: if FBB stock <= 0 AND local warehouse has stock → swap to FBR
 * - For FBR offers: if FBB stock > 0 → swap to FBB
 *
 * This ensures customers always get fast delivery by:
 * - Using FBB (Bol warehouse) when stock is available there
 * - Falling back to FBR (merchant warehouse) when FBB is out of stock
 *
 * Rate Limiting:
 * - Bol.com: 25 requests/second max
 * - We use 100ms delay between calls for safety
 */

const ExcelJS = require('exceljs');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { TeamsNotificationService } = require('../../core/agents/services/TeamsNotificationService');
const Product = require('../../models/Product');
const oneDriveService = require('../onedriveService');

// Report folder
const REPORTS_FOLDER = 'Bol_Fulfillment_Swaps';

// Central Warehouse ID in Odoo
const CENTRAL_WAREHOUSE_ID = 1;

// Default safety stock if not configured
const DEFAULT_SAFETY_STOCK = 10;

// Rate limiting configuration
const REQUEST_DELAY_MS = 100;   // 100ms between API calls
const MAX_RETRIES = 3;

// Token cache (shared with BolStockSync)
let accessToken = null;
let tokenExpiry = null;

class BolFulfillmentSwapper {
  constructor() {
    this.odoo = null;
    this.cwLocationId = null;
    this.isRunning = false;
    this.lastRun = null;
    this.lastResult = null;
  }

  /**
   * Initialize the service
   */
  async init() {
    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    // Find Central Warehouse stock location
    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['id', '=', CENTRAL_WAREHOUSE_ID]],
      ['id', 'name', 'lot_stock_id']
    );

    if (warehouses.length > 0 && warehouses[0].lot_stock_id) {
      this.cwLocationId = warehouses[0].lot_stock_id[0];
      console.log(`[BolFulfillmentSwapper] Central Warehouse location ID: ${this.cwLocationId}`);
    } else {
      throw new Error('Could not find Central Warehouse stock location');
    }

    return this;
  }

  /**
   * Get Bol.com access token
   */
  async getAccessToken() {
    const clientId = process.env.BOL_CLIENT_ID;
    const clientSecret = process.env.BOL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Bol.com credentials not configured');
    }

    // Check cached token
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
      return accessToken;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://login.bol.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    return accessToken;
  }

  /**
   * Make a Bol.com API request with retry logic
   */
  async bolRequest(endpoint, method = 'GET', body = null, retries = MAX_RETRIES) {
    const token = await this.getAccessToken();

    const options = {
      method,
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/vnd.retailer.v10+json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`https://api.bol.com/retailer${endpoint}`, options);

    // Handle rate limiting
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.log(`[BolFulfillmentSwapper] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, method, body, retries - 1);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Bol.com API error: ${response.status}`);
    }

    if (response.status === 202 || response.status === 204) {
      // 202 Accepted for async operations, 204 No Content
      return { success: true, status: response.status };
    }

    return response.json();
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get FBB inventory from Bol.com (paginated)
   * Returns map of EAN -> stock info
   */
  async getFbbInventory() {
    console.log('[BolFulfillmentSwapper] Fetching FBB inventory...');

    const inventory = {};
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.bolRequest(`/inventory?page=${page}`);
        const items = response.inventory || [];

        for (const item of items) {
          inventory[item.ean] = {
            bsku: item.bsku,
            title: item.title,
            stock: item.stock || 0,
            regularStock: item.regularStock || 0,
            gradedStock: item.gradedStock || 0,
            nckStock: item.nckStock || 0
          };
        }

        console.log(`[BolFulfillmentSwapper] Page ${page}: ${items.length} items`);

        // Check if there are more pages
        if (items.length < 50) {
          hasMore = false;
        } else {
          page++;
          await this.sleep(REQUEST_DELAY_MS);
        }
      } catch (error) {
        if (error.message.includes('404')) {
          // No inventory endpoint or no FBB inventory
          hasMore = false;
        } else {
          throw error;
        }
      }
    }

    console.log(`[BolFulfillmentSwapper] Total FBB inventory: ${Object.keys(inventory).length} items`);
    return inventory;
  }

  /**
   * Request an offer export from Bol.com
   * This is an async operation - returns a process status ID
   */
  async requestOfferExport() {
    console.log('[BolFulfillmentSwapper] Requesting offer export...');

    const token = await this.getAccessToken();
    const response = await fetch('https://api.bol.com/retailer/offers/export', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Content-Type': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ format: 'CSV' })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Failed to request offer export: ${response.status}`);
    }

    const result = await response.json();
    return result.processStatusId;
  }

  /**
   * Check process status
   * Note: Uses shared/process-status endpoint, not retailer endpoint
   */
  async getProcessStatus(processStatusId) {
    const token = await this.getAccessToken();
    const response = await fetch(`https://api.bol.com/shared/process-status/${processStatusId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Failed to get process status: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Wait for offer export to complete and get the report ID
   */
  async waitForOfferExport(processStatusId, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000; // Check every 5 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getProcessStatus(processStatusId);
      console.log(`[BolFulfillmentSwapper] Export status: ${status.status}`);

      if (status.status === 'SUCCESS') {
        // Find the entityId (report ID) in the links
        const reportLink = status.links?.find(l => l.rel === 'self' || l.href?.includes('export'));
        if (reportLink) {
          // Extract report ID from href like /offers/export/12345
          const match = reportLink.href?.match(/export\/(\d+)/);
          if (match) return match[1];
        }
        // Fallback: return the entityId if available
        return status.entityId;
      }

      if (status.status === 'FAILURE' || status.status === 'TIMEOUT') {
        throw new Error(`Offer export failed: ${status.errorMessage || status.status}`);
      }

      await this.sleep(pollInterval);
    }

    throw new Error('Offer export timed out');
  }

  /**
   * Download and parse the offer export CSV
   */
  async getOfferExportCsv(reportId) {
    console.log(`[BolFulfillmentSwapper] Downloading offer export ${reportId}...`);

    const token = await this.getAccessToken();
    const response = await fetch(`https://api.bol.com/retailer/offers/export/${reportId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+csv',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download offer export: ${response.status}`);
    }

    const csv = await response.text();
    return this.parseOfferCsv(csv);
  }

  /**
   * Parse offer export CSV
   * CSV columns: offerId,ean,conditionName,conditionCategory,conditionComment,bundlePricesPrice,
   *              fulfilmentDeliveryCode,stockAmount,onHoldByRetailer,fulfilmentType,...
   * IMPORTANT: Use 'fulfilmentType' column (contains FBB/FBR), NOT 'fulfilmentDeliveryCode' (contains delivery speed)
   */
  parseOfferCsv(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const offers = [];

    // Find column indices - be specific about column names!
    const offerIdIdx = headers.indexOf('offerId');
    const eanIdx = headers.indexOf('ean');
    const refIdx = headers.indexOf('referenceCode');
    // BUGFIX: Use exact column name 'fulfilmentType', not partial match
    // The CSV has both 'fulfilmentDeliveryCode' (e.g. "3-5d") and 'fulfilmentType' (FBB/FBR)
    const fulfillmentIdx = headers.indexOf('fulfilmentType');

    console.log(`[BolFulfillmentSwapper] CSV columns: offerId=${offerIdIdx}, ean=${eanIdx}, ref=${refIdx}, fulfilmentType=${fulfillmentIdx}`);

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      if (values.length < headers.length) continue;

      const fulfillmentMethod = values[fulfillmentIdx] || '';
      // Only include offers with valid fulfillment type
      if (fulfillmentMethod !== 'FBB' && fulfillmentMethod !== 'FBR') {
        console.warn(`[BolFulfillmentSwapper] Skipping offer with invalid fulfillment type: ${values[offerIdIdx]} = "${fulfillmentMethod}"`);
        continue;
      }

      offers.push({
        offerId: values[offerIdIdx] || '',
        ean: values[eanIdx] || '',
        reference: values[refIdx] || '',
        fulfillmentMethod
      });
    }

    console.log(`[BolFulfillmentSwapper] Parsed ${offers.length} offers from CSV`);
    return offers;
  }

  /**
   * Get all offers using the export feature
   */
  async getAllOffers() {
    try {
      // Step 1: Request export
      const processStatusId = await this.requestOfferExport();
      console.log(`[BolFulfillmentSwapper] Export requested, process ID: ${processStatusId}`);

      // Step 2: Wait for export to complete
      const reportId = await this.waitForOfferExport(processStatusId);
      console.log(`[BolFulfillmentSwapper] Export ready, report ID: ${reportId}`);

      // Step 3: Download and parse CSV
      const offers = await this.getOfferExportCsv(reportId);
      return offers;

    } catch (error) {
      console.error('[BolFulfillmentSwapper] Failed to get offers:', error.message);
      return [];
    }
  }

  /**
   * Get local warehouse stock for multiple EANs
   */
  async getLocalStock(eans) {
    if (!eans || eans.length === 0) return {};

    // Find products by barcode (EAN)
    const products = await this.odoo.searchRead('product.product',
      [['barcode', 'in', eans]],
      ['id', 'barcode']
    );

    if (products.length === 0) return {};

    const productIds = products.map(p => p.id);
    const eanToProductId = {};
    products.forEach(p => {
      if (p.barcode) eanToProductId[p.barcode] = p.id;
    });

    // Get stock.quants for these products
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id', '=', this.cwLocationId]
      ],
      ['product_id', 'quantity', 'reserved_quantity']
    );

    // Calculate free stock per product
    const productStock = {};
    for (const q of quants) {
      const productId = q.product_id[0];
      if (!productStock[productId]) {
        productStock[productId] = { quantity: 0, reserved: 0 };
      }
      productStock[productId].quantity += q.quantity || 0;
      productStock[productId].reserved += q.reserved_quantity || 0;
    }

    // Map to EAN -> free_qty
    const stockByEan = {};
    for (const ean of eans) {
      const productId = eanToProductId[ean];
      if (productId && productStock[productId]) {
        const freeQty = productStock[productId].quantity - productStock[productId].reserved;
        stockByEan[ean] = Math.max(0, Math.floor(freeQty));
      } else if (productId) {
        stockByEan[ean] = 0;
      }
    }

    return stockByEan;
  }

  /**
   * Get safety stock values from MongoDB for multiple EANs
   * @param {string[]} eans - Array of EANs to lookup
   * @returns {Object} Map of EAN -> safety stock value
   */
  async getSafetyStock(eans) {
    const safetyStockMap = {};

    // Initialize all with default
    for (const ean of eans) {
      safetyStockMap[ean] = DEFAULT_SAFETY_STOCK;
    }

    try {
      // Find products by barcode (EAN) in MongoDB
      const products = await Product.find({ barcode: { $in: eans } })
        .select('barcode safetyStock')
        .lean();

      for (const p of products) {
        if (p.barcode) {
          safetyStockMap[p.barcode] = p.safetyStock ?? DEFAULT_SAFETY_STOCK;
        }
      }

      console.log(`[BolFulfillmentSwapper] Got safety stock for ${products.length} of ${eans.length} EANs`);
    } catch (err) {
      console.error('[BolFulfillmentSwapper] Error getting safety stock:', err.message);
    }

    return safetyStockMap;
  }

  /**
   * Update stock for a single offer on Bol.com
   * @param {string} offerId - Bol.com offer ID
   * @param {number} amount - Stock quantity to set
   */
  async updateOfferStock(offerId, amount) {
    try {
      // Bol.com API limit: stock must be between 0 and 999
      const cappedAmount = Math.min(999, Math.max(0, Math.floor(amount)));
      await this.bolRequest(`/offers/${offerId}/stock`, 'PUT', {
        amount: cappedAmount,
        managedByRetailer: true
      });
      return { success: true, amount: cappedAmount };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Swap offer fulfillment method
   */
  async swapFulfillment(offerId, newMethod) {
    const payload = {
      fulfilment: {
        method: newMethod
      }
    };

    // FBR requires delivery code
    if (newMethod === 'FBR') {
      payload.fulfilment.deliveryCode = '3-5d';
    }

    try {
      const result = await this.bolRequest(`/offers/${offerId}`, 'PUT', payload);
      return {
        success: true,
        processStatusId: result.processStatusId,
        status: result.status
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Run the fulfillment swap check
   */
  async run() {
    if (this.isRunning) {
      console.log('[BolFulfillmentSwapper] Already running, skipping');
      return { success: false, message: 'Already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    const results = {
      checked: 0,
      swappedToFbr: 0,
      swappedToFbb: 0,
      failed: 0,
      blockedBySafetyStock: 0,  // FBB offers that could swap but CW free < safety stock
      swaps: [],
      blockedOffers: []  // Details of offers blocked by safety stock
    };

    try {
      await this.init();

      // Step 1: Get FBB inventory from Bol.com
      const fbbInventory = await this.getFbbInventory();

      if (Object.keys(fbbInventory).length === 0) {
        console.log('[BolFulfillmentSwapper] No FBB inventory found');
        return { success: true, ...results, message: 'No FBB inventory' };
      }

      // Step 2: Get all offers via export (async process)
      const offers = await this.getAllOffers();

      if (offers.length === 0) {
        console.log('[BolFulfillmentSwapper] No offers found');
        return { success: true, ...results, message: 'No offers found' };
      }

      // Step 3: Get local warehouse stock AND safety stock for all offer EANs
      const allEans = offers.map(o => o.ean).filter(Boolean);
      const [localStock, safetyStockMap] = await Promise.all([
        this.getLocalStock(allEans),
        this.getSafetyStock(allEans)
      ]);
      console.log(`[BolFulfillmentSwapper] Got local stock for ${Object.keys(localStock).length} products`);

      console.log(`[BolFulfillmentSwapper] Checking ${offers.length} offers...`);

      // Step 4: Check each offer and swap if needed
      for (const offer of offers) {
        results.checked++;

        const ean = offer.ean;
        if (!ean) continue;

        const fbbStock = fbbInventory[ean]?.regularStock || 0;
        const cwFreeQty = localStock[ean] || 0;
        const safetyStock = safetyStockMap[ean] || DEFAULT_SAFETY_STOCK;

        // Available stock for Bol = CW free - safety stock
        const availableForBol = Math.max(0, cwFreeQty - safetyStock);
        const currentMethod = offer.fulfillmentMethod;

        let needsSwap = false;
        let newMethod = null;
        let reason = '';

        // Logic (updated with safety stock):
        // - If currently FBB and FBB stock <= 0 and availableForBol > 0 → swap to FBR
        // - If currently FBB and FBB stock <= 0 and cwFreeQty > 0 but < safetyStock → blocked by safety stock
        // - If currently FBR and FBB stock > 0 → swap to FBB
        if (currentMethod === 'FBB' && fbbStock <= 0) {
          if (availableForBol > 0) {
            // Has enough stock after safety deduction → swap to FBR
            needsSwap = true;
            newMethod = 'FBR';
            reason = `FBB out of stock, CW has ${cwFreeQty} (safety: ${safetyStock}, available: ${availableForBol})`;
          } else if (cwFreeQty > 0 && cwFreeQty <= safetyStock) {
            // Has some stock but below safety stock → blocked
            results.blockedBySafetyStock++;
            results.blockedOffers.push({
              ean,
              sku: offer.reference || null,
              offerId: offer.offerId,
              cwFreeQty,
              safetyStock,
              reason: `CW has ${cwFreeQty} but safety stock is ${safetyStock}`
            });
            console.log(`[BolFulfillmentSwapper] Blocked ${ean}: FBB out, CW=${cwFreeQty} < safety=${safetyStock}`);
          }
          // else: cwFreeQty is 0, nothing we can do
        } else if (currentMethod === 'FBR' && fbbStock > 0) {
          needsSwap = true;
          newMethod = 'FBB';
          reason = `FBB has stock (${fbbStock})`;
        }

        if (needsSwap) {
          console.log(`[BolFulfillmentSwapper] Swapping ${ean}: ${currentMethod} → ${newMethod} (${reason})`);

          const swapResult = await this.swapFulfillment(offer.offerId, newMethod);

          if (swapResult.success) {
            if (newMethod === 'FBR') {
              results.swappedToFbr++;
            } else {
              results.swappedToFbb++;
            }

            const swapRecord = {
              ean,
              sku: offer.reference || null,
              offerId: offer.offerId,
              from: currentMethod,
              to: newMethod,
              reason,
              processStatusId: swapResult.processStatusId,
              cwFreeQty,
              safetyStock,
              stockSentToBol: null,
              stockUpdateSuccess: null
            };

            // After FBB→FBR swap, immediately update stock on Bol.com
            if (newMethod === 'FBR') {
              await this.sleep(REQUEST_DELAY_MS);  // Small delay before stock update
              const stockResult = await this.updateOfferStock(offer.offerId, availableForBol);

              if (stockResult.success) {
                swapRecord.stockSentToBol = stockResult.amount;
                swapRecord.stockUpdateSuccess = true;
                console.log(`[BolFulfillmentSwapper] Updated stock for ${ean}: ${stockResult.amount} (CW=${cwFreeQty}, safety=${safetyStock})`);
              } else {
                swapRecord.stockUpdateSuccess = false;
                swapRecord.stockUpdateError = stockResult.error;
                console.error(`[BolFulfillmentSwapper] Failed to update stock for ${ean}:`, stockResult.error);
              }
            }

            results.swaps.push(swapRecord);

            // Send Teams notification immediately
            await this.sendSwapNotification(swapRecord);
          } else {
            results.failed++;
            console.error(`[BolFulfillmentSwapper] Failed to swap ${ean}:`, swapResult.error);
          }

          await this.sleep(REQUEST_DELAY_MS);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastRun = new Date();
      this.lastResult = { ...results, duration };

      console.log(`[BolFulfillmentSwapper] Complete in ${duration}s:`, {
        checked: results.checked,
        swappedToFbr: results.swappedToFbr,
        swappedToFbb: results.swappedToFbb,
        blockedBySafetyStock: results.blockedBySafetyStock,
        failed: results.failed
      });

      return {
        success: true,
        ...results,
        duration: `${duration}s`
      };

    } catch (error) {
      console.error('[BolFulfillmentSwapper] Error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      lastResult: this.lastResult
    };
  }

  /**
   * Generate Excel report for a swap
   */
  async generateSwapExcel(swap) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 Bol Fulfillment Swapper';
    workbook.created = new Date();

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
    const directionText = swap.to === 'FBB' ? 'FBR → FBB' : 'FBB → FBR';

    const worksheet = workbook.addWorksheet('Fulfillment Swap', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    // Title
    worksheet.addRow(['Bol.com Fulfillment Swap Report', '', dateStr]);
    worksheet.mergeCells('A1:B1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('C1').font = { italic: true, size: 10 };

    // Swap details
    worksheet.addRow([]);
    worksheet.addRow(['Field', 'Value']);
    const headerRow = worksheet.getRow(3);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

    worksheet.addRow(['EAN', swap.ean || '-']);
    worksheet.addRow(['SKU', swap.sku || '-']);
    worksheet.addRow(['Product Name', swap.productName || swap.title || '-']);
    worksheet.addRow(['Direction', directionText]);
    worksheet.addRow(['Reason', swap.reason || '-']);

    if (swap.to === 'FBR') {
      worksheet.addRow(['CW Free Qty', swap.cwFreeQty ?? '-']);
      worksheet.addRow(['Safety Stock', swap.safetyStock ?? DEFAULT_SAFETY_STOCK]);
      worksheet.addRow(['Stock Sent to Bol', swap.stockSentToBol ?? '-']);
      worksheet.addRow(['Stock Update Status', swap.stockUpdateSuccess ? 'Success' : 'Failed']);
      if (swap.stockUpdateError) {
        worksheet.addRow(['Stock Update Error', swap.stockUpdateError]);
      }
    }

    if (swap.to === 'FBB') {
      worksheet.addRow(['FBB Stock', swap.fbbStock ?? '-']);
    }

    worksheet.addRow(['Timestamp', dateStr]);

    worksheet.columns = [{ width: 20 }, { width: 50 }, { width: 20 }];

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Send Teams notification for a swap
   * @param {Object} swap - Swap details
   */
  async sendSwapNotification(swap) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      console.log('[BolFulfillmentSwapper] No Teams webhook configured, skipping notification');
      return;
    }

    // Generate and upload Excel report
    let reportUrl = null;
    try {
      const excelBuffer = await this.generateSwapExcel(swap);
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const fileName = `Bol_Swap_${swap.ean}_${timestamp}.xlsx`;

      const uploadResult = await oneDriveService.uploadReport(excelBuffer, fileName, REPORTS_FOLDER);
      reportUrl = uploadResult.url;
      console.log(`[BolFulfillmentSwapper] Excel report uploaded: ${reportUrl}`);
    } catch (uploadError) {
      console.error('[BolFulfillmentSwapper] Failed to upload Excel report:', uploadError.message);
    }

    try {
      const teams = new TeamsNotificationService({ webhookUrl });

      const directionEmoji = swap.to === 'FBB' ? '📦' : '🏭';
      const directionText = swap.to === 'FBB' ? 'FBR → FBB' : 'FBB → FBR';

      // Build facts list
      const facts = [
        { title: 'SKU', value: swap.sku || '-' },
        { title: 'EAN', value: swap.ean },
        { title: 'Direction', value: directionText },
        { title: 'Reason', value: swap.reason }
      ];

      // Add stock details for FBB→FBR swaps
      if (swap.to === 'FBR') {
        facts.push({ title: 'CW Free Qty', value: String(swap.cwFreeQty ?? '-') });
        facts.push({ title: 'Safety Stock', value: String(swap.safetyStock ?? DEFAULT_SAFETY_STOCK) });
        if (swap.stockSentToBol !== null) {
          const stockStatus = swap.stockUpdateSuccess ? '✅' : '❌';
          facts.push({ title: 'Stock Sent to Bol', value: `${stockStatus} ${swap.stockSentToBol}` });
        }
      }

      facts.push({ title: 'Time', value: new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) });

      const cardBody = [
        {
          type: 'TextBlock',
          text: `${directionEmoji} Bol.com Fulfillment Swap`,
          weight: 'bolder',
          size: 'medium'
        },
        {
          type: 'FactSet',
          facts
        }
      ];

      // Add warning if stock update failed
      if (swap.to === 'FBR' && swap.stockUpdateSuccess === false) {
        cardBody.push({
          type: 'TextBlock',
          text: `⚠️ Stock update failed: ${swap.stockUpdateError || 'Unknown error'}`,
          color: 'warning',
          wrap: true
        });
      }

      // Add action buttons
      const actions = [];
      if (reportUrl) {
        actions.push({
          type: 'Action.OpenUrl',
          title: '📊 Download Excel Report',
          url: reportUrl
        });
      }

      if (actions.length > 0) {
        cardBody.push({ type: 'ActionSet', actions });
      }

      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: cardBody
      };

      await teams.sendMessage(card);
      console.log(`[BolFulfillmentSwapper] Teams notification sent for ${swap.ean}`);
    } catch (error) {
      console.error('[BolFulfillmentSwapper] Failed to send Teams notification:', error.message);
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolFulfillmentSwapper instance
 */
function getBolFulfillmentSwapper() {
  if (!instance) {
    instance = new BolFulfillmentSwapper();
  }
  return instance;
}

/**
 * Run fulfillment swap check (for scheduler)
 */
async function runFulfillmentSwap() {
  const swapper = getBolFulfillmentSwapper();
  return swapper.run();
}

module.exports = {
  BolFulfillmentSwapper,
  getBolFulfillmentSwapper,
  runFulfillmentSwap
};
