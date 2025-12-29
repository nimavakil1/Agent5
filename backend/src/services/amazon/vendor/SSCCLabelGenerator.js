/**
 * SSCCLabelGenerator - Generate GS1-128 barcode labels for Amazon Vendor shipments
 *
 * Generates print-ready labels for:
 * - Carton labels (4x6 inches / 100x150mm)
 * - Pallet labels (A5 / 148x210mm)
 *
 * Labels include:
 * - GS1-128 barcode with SSCC
 * - Human-readable SSCC
 * - Ship-to information (FC)
 * - PO number(s)
 * - Contents summary
 *
 * Output formats:
 * - HTML (for browser printing)
 * - PNG (barcode image)
 * - ZPL (Zebra printer language)
 *
 * @module SSCCLabelGenerator
 */

const bwipjs = require('bwip-js');
const { getSSCCGenerator, parseSSCC } = require('./SSCCGenerator');

/**
 * Label sizes in mm
 */
const LABEL_SIZES = {
  CARTON_4X6: { width: 100, height: 150 }, // Standard shipping label
  CARTON_A6: { width: 105, height: 148 },
  PALLET_A5: { width: 148, height: 210 },
  PALLET_A4: { width: 210, height: 297 }
};

/**
 * Generate GS1-128 barcode as PNG buffer
 * @param {string} sscc - 18-digit SSCC
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateBarcodePNG(sscc) {
  // GS1-128 uses Application Identifier 00 for SSCC
  const barcodeData = `00${sscc}`;

  return new Promise((resolve, reject) => {
    bwipjs.toBuffer({
      bcid: 'gs1-128',
      text: barcodeData,
      scale: 3,
      height: 15,
      includetext: true,
      textxalign: 'center',
      textsize: 10,
      parsefnc: true // Parse FNC1 for GS1
    }, (err, png) => {
      if (err) reject(err);
      else resolve(png);
    });
  });
}

/**
 * Generate barcode as base64 data URL
 * @param {string} sscc - 18-digit SSCC
 * @returns {Promise<string>} Base64 data URL
 */
async function generateBarcodeDataURL(sscc) {
  const png = await generateBarcodePNG(sscc);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Format SSCC for human readability on labels
 * @param {string} sscc - 18-digit SSCC
 * @returns {string} Formatted with spaces
 */
function formatSSCCForLabel(sscc) {
  // Format: (00) X XXXXXXX XXXXXXXXX
  // Groups: AI + Extension + Prefix + Serial+Check
  return `(00) ${sscc[0]} ${sscc.substring(1, 8)} ${sscc.substring(8)}`;
}

class SSCCLabelGenerator {
  constructor() {
    this.ssccGenerator = null;
  }

  async init() {
    this.ssccGenerator = await getSSCCGenerator();
    return this;
  }

  /**
   * Generate HTML label for a carton
   * @param {Object} options
   * @param {string} options.sscc - SSCC code
   * @param {Object} options.shipTo - Ship-to party info (FC)
   * @param {Array} options.purchaseOrders - PO numbers included
   * @param {Array} options.items - Items in this carton
   * @param {string} options.labelSize - Label size key
   * @returns {Promise<string>} HTML string
   */
  async generateCartonLabelHTML(options) {
    const {
      sscc,
      shipTo = {},
      purchaseOrders = [],
      items = [],
      labelSize = 'CARTON_4X6'
    } = options;

    const barcodeDataURL = await generateBarcodeDataURL(sscc);
    const size = LABEL_SIZES[labelSize] || LABEL_SIZES.CARTON_4X6;
    const parsed = parseSSCC(sscc);

    // Calculate total units
    const totalUnits = items.reduce((sum, i) => sum + (i.quantity || 0), 0);

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Carton Label - ${sscc}</title>
  <style>
    @page { size: ${size.width}mm ${size.height}mm; margin: 0; }
    @media print { body { margin: 0; } .no-print { display: none; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; }
    .label {
      width: ${size.width}mm;
      height: ${size.height}mm;
      padding: 3mm;
      border: 1px solid #000;
      display: flex;
      flex-direction: column;
      page-break-after: always;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #000;
      padding-bottom: 2mm;
      margin-bottom: 2mm;
    }
    .from-to { flex: 1; }
    .from-to-label { font-size: 8pt; color: #666; text-transform: uppercase; }
    .from-to-value { font-size: 11pt; font-weight: bold; }
    .fc-code {
      font-size: 24pt;
      font-weight: bold;
      text-align: right;
      line-height: 1;
    }
    .po-section {
      border-bottom: 1px solid #000;
      padding: 2mm 0;
      font-size: 10pt;
    }
    .po-label { font-weight: bold; }
    .barcode-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 3mm 0;
    }
    .barcode-img {
      max-width: 90%;
      height: auto;
    }
    .sscc-text {
      font-family: 'Courier New', monospace;
      font-size: 12pt;
      font-weight: bold;
      margin-top: 2mm;
      letter-spacing: 1px;
    }
    .contents-section {
      border-top: 1px solid #000;
      padding-top: 2mm;
      font-size: 9pt;
    }
    .contents-title { font-weight: bold; margin-bottom: 1mm; }
    .contents-summary { display: flex; justify-content: space-between; }
    .single-sku-badge {
      background: #000;
      color: #fff;
      padding: 1mm 3mm;
      font-size: 10pt;
      font-weight: bold;
      display: inline-block;
      margin-top: 2mm;
    }
    .print-btn {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 20px;
      font-size: 14px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <button class="no-print print-btn" onclick="window.print()">Print Label</button>

  <div class="label">
    <div class="header">
      <div class="from-to">
        <div class="from-to-label">Ship To:</div>
        <div class="from-to-value">${shipTo.fcName || shipTo.name || 'Amazon FC'}</div>
        <div style="font-size: 9pt;">${shipTo.address?.addressLine1 || ''}</div>
        <div style="font-size: 9pt;">${shipTo.address?.postalCode || ''} ${shipTo.address?.city || ''}</div>
      </div>
      <div class="fc-code">${shipTo.fcPartyId || shipTo.partyId || ''}</div>
    </div>

    <div class="po-section">
      <span class="po-label">PO:</span> ${purchaseOrders.join(', ')}
    </div>

    <div class="barcode-section">
      <img src="${barcodeDataURL}" alt="SSCC Barcode" class="barcode-img">
      <div class="sscc-text">${formatSSCCForLabel(sscc)}</div>
    </div>

    <div class="contents-section">
      <div class="contents-title">Contents:</div>
      <div class="contents-summary">
        <span>${items.length} SKU${items.length !== 1 ? 's' : ''}</span>
        <span>${totalUnits} units</span>
      </div>
      ${items.length === 1 ? `<div class="single-sku-badge">SINGLE-SKU</div>` : ''}
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Generate HTML label for a pallet
   * @param {Object} options
   * @param {string} options.sscc - Pallet SSCC
   * @param {Array} options.cartonSSCCs - Carton SSCCs on this pallet
   * @param {Object} options.shipTo - Ship-to party info
   * @param {Array} options.purchaseOrders - PO numbers
   * @param {boolean} options.singleSKU - Is this a single-SKU pallet
   * @returns {Promise<string>} HTML string
   */
  async generatePalletLabelHTML(options) {
    const {
      sscc,
      cartonSSCCs = [],
      shipTo = {},
      purchaseOrders = [],
      singleSKU = false,
      totalUnits = 0,
      labelSize = 'PALLET_A5'
    } = options;

    const barcodeDataURL = await generateBarcodeDataURL(sscc);
    const size = LABEL_SIZES[labelSize] || LABEL_SIZES.PALLET_A5;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Pallet Label - ${sscc}</title>
  <style>
    @page { size: ${size.width}mm ${size.height}mm; margin: 0; }
    @media print { body { margin: 0; } .no-print { display: none; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; }
    .label {
      width: ${size.width}mm;
      height: ${size.height}mm;
      padding: 5mm;
      border: 2px solid #000;
      display: flex;
      flex-direction: column;
      page-break-after: always;
    }
    .pallet-badge {
      background: #000;
      color: #fff;
      padding: 2mm 5mm;
      font-size: 14pt;
      font-weight: bold;
      text-align: center;
      margin-bottom: 3mm;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #000;
      padding-bottom: 3mm;
      margin-bottom: 3mm;
    }
    .ship-to { flex: 1; }
    .ship-to-label { font-size: 10pt; color: #666; text-transform: uppercase; }
    .ship-to-name { font-size: 16pt; font-weight: bold; }
    .ship-to-address { font-size: 11pt; }
    .fc-code {
      font-size: 36pt;
      font-weight: bold;
      text-align: right;
    }
    .po-section {
      border-bottom: 2px solid #000;
      padding: 3mm 0;
      font-size: 12pt;
    }
    .po-label { font-weight: bold; }
    .barcode-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 5mm 0;
    }
    .barcode-img {
      max-width: 95%;
      height: auto;
    }
    .sscc-text {
      font-family: 'Courier New', monospace;
      font-size: 16pt;
      font-weight: bold;
      margin-top: 3mm;
      letter-spacing: 2px;
    }
    .summary-section {
      border-top: 2px solid #000;
      padding-top: 3mm;
      display: flex;
      justify-content: space-around;
      font-size: 14pt;
    }
    .summary-item { text-align: center; }
    .summary-value { font-size: 20pt; font-weight: bold; }
    .summary-label { font-size: 10pt; color: #666; }
    .single-sku-badge {
      background: #000;
      color: #fff;
      padding: 3mm 8mm;
      font-size: 16pt;
      font-weight: bold;
      text-align: center;
      margin-top: 3mm;
    }
    .print-btn {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 20px;
      font-size: 14px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <button class="no-print print-btn" onclick="window.print()">Print Label</button>

  <div class="label">
    <div class="pallet-badge">PALLET</div>

    <div class="header">
      <div class="ship-to">
        <div class="ship-to-label">Ship To:</div>
        <div class="ship-to-name">${shipTo.fcName || shipTo.name || 'Amazon FC'}</div>
        <div class="ship-to-address">${shipTo.address?.addressLine1 || ''}</div>
        <div class="ship-to-address">${shipTo.address?.postalCode || ''} ${shipTo.address?.city || ''}, ${shipTo.address?.countryCode || ''}</div>
      </div>
      <div class="fc-code">${shipTo.fcPartyId || shipTo.partyId || ''}</div>
    </div>

    <div class="po-section">
      <span class="po-label">PO Numbers:</span> ${purchaseOrders.join(', ')}
    </div>

    <div class="barcode-section">
      <img src="${barcodeDataURL}" alt="SSCC Barcode" class="barcode-img">
      <div class="sscc-text">${formatSSCCForLabel(sscc)}</div>
    </div>

    <div class="summary-section">
      <div class="summary-item">
        <div class="summary-value">${cartonSSCCs.length}</div>
        <div class="summary-label">CARTONS</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${totalUnits}</div>
        <div class="summary-label">UNITS</div>
      </div>
    </div>

    ${singleSKU ? '<div class="single-sku-badge">SINGLE-SKU</div>' : ''}
  </div>
</body>
</html>`;
  }

  /**
   * Generate multiple carton labels for printing
   * @param {Array} cartons - Array of carton data
   * @returns {Promise<string>} Combined HTML for all labels
   */
  async generateCartonLabelsHTML(cartons) {
    const labels = await Promise.all(
      cartons.map(carton => this.generateCartonLabelHTML(carton))
    );

    // Extract body content from each label and combine
    const bodyContents = labels.map(html => {
      const match = html.match(/<div class="label">[\s\S]*?<\/div>\s*<\/body>/);
      return match ? match[0].replace('</body>', '') : '';
    });

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Carton Labels (${cartons.length})</title>
  <style>
    @page { size: 100mm 150mm; margin: 0; }
    @media print { body { margin: 0; } .no-print { display: none; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; }
    .label {
      width: 100mm;
      height: 150mm;
      padding: 3mm;
      border: 1px solid #000;
      display: flex;
      flex-direction: column;
      page-break-after: always;
    }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 2mm; margin-bottom: 2mm; }
    .from-to { flex: 1; }
    .from-to-label { font-size: 8pt; color: #666; text-transform: uppercase; }
    .from-to-value { font-size: 11pt; font-weight: bold; }
    .fc-code { font-size: 24pt; font-weight: bold; text-align: right; line-height: 1; }
    .po-section { border-bottom: 1px solid #000; padding: 2mm 0; font-size: 10pt; }
    .po-label { font-weight: bold; }
    .barcode-section { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 3mm 0; }
    .barcode-img { max-width: 90%; height: auto; }
    .sscc-text { font-family: 'Courier New', monospace; font-size: 12pt; font-weight: bold; margin-top: 2mm; letter-spacing: 1px; }
    .contents-section { border-top: 1px solid #000; padding-top: 2mm; font-size: 9pt; }
    .contents-title { font-weight: bold; margin-bottom: 1mm; }
    .contents-summary { display: flex; justify-content: space-between; }
    .single-sku-badge { background: #000; color: #fff; padding: 1mm 3mm; font-size: 10pt; font-weight: bold; display: inline-block; margin-top: 2mm; }
    .print-btn { position: fixed; top: 10px; right: 10px; padding: 10px 20px; font-size: 14px; cursor: pointer; z-index: 1000; }
    .label-count { position: fixed; top: 10px; left: 10px; font-size: 14px; background: #333; color: #fff; padding: 5px 15px; border-radius: 5px; }
  </style>
</head>
<body>
  <div class="no-print label-count">${cartons.length} labels</div>
  <button class="no-print print-btn" onclick="window.print()">Print All Labels</button>
  ${bodyContents.join('\n')}
</body>
</html>`;
  }

  /**
   * Generate barcode image only (PNG)
   * @param {string} sscc - SSCC code
   * @returns {Promise<Buffer>} PNG buffer
   */
  async generateBarcodeImage(sscc) {
    return generateBarcodePNG(sscc);
  }

  /**
   * Generate ZPL (Zebra Printer Language) for carton label
   * @param {Object} options - Same as generateCartonLabelHTML
   * @returns {string} ZPL code
   */
  generateCartonLabelZPL(options) {
    const {
      sscc,
      shipTo = {},
      purchaseOrders = [],
      items = [],
    } = options;

    const totalUnits = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
    const isSingleSKU = items.length === 1;

    // ZPL for 4x6 inch label (100x150mm) at 203 DPI
    return `^XA
^MMT
^PW812
^LL1218
^LS0

^FT30,80^A0N,40,40^FDShip To:^FS
^FT30,130^A0N,50,50^FD${(shipTo.fcName || 'Amazon FC').substring(0, 30)}^FS
^FT30,180^A0N,30,30^FD${(shipTo.address?.addressLine1 || '').substring(0, 40)}^FS
^FT30,220^A0N,30,30^FD${shipTo.address?.postalCode || ''} ${shipTo.address?.city || ''}^FS

^FT600,130^A0N,80,80^FD${shipTo.fcPartyId || ''}^FS

^FO20,250^GB772,3,3^FS

^FT30,310^A0N,35,35^FDPO: ${purchaseOrders.join(', ').substring(0, 50)}^FS

^FO20,340^GB772,3,3^FS

^BY3,3,150^FT100,600^BCN,,Y,N
^FD>:00${sscc}^FS

^FT100,670^A0N,35,35^FD(00) ${sscc[0]} ${sscc.substring(1, 8)} ${sscc.substring(8)}^FS

^FO20,700^GB772,3,3^FS

^FT30,750^A0N,30,30^FDContents: ${items.length} SKU(s), ${totalUnits} units^FS
${isSingleSKU ? '^FT30,800^A0N,40,40^GB200,50,50^FR^FDSINGLE-SKU^FS' : ''}

^XZ`;
  }
}

// Singleton
let labelGeneratorInstance = null;

async function getSSCCLabelGenerator() {
  if (!labelGeneratorInstance) {
    labelGeneratorInstance = new SSCCLabelGenerator();
    await labelGeneratorInstance.init();
  }
  return labelGeneratorInstance;
}

module.exports = {
  SSCCLabelGenerator,
  getSSCCLabelGenerator,
  generateBarcodePNG,
  generateBarcodeDataURL,
  formatSSCCForLabel,
  LABEL_SIZES
};
