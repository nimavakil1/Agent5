/**
 * Generate new SSCC labels for shipment PKG-1768984539721
 *
 * This script:
 * 1. Generates 3 new SSCCs (replacing burned ones)
 * 2. Creates a combined HTML with SSCC + GLS labels
 * 3. Saves to a file that can be printed/converted to PDF
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { getSSCCGenerator } = require('../src/services/amazon/vendor/SSCCGenerator');
const bwipjs = require('bwip-js');
const fs = require('fs').promises;
const path = require('path');

// Shipment data
const SHIPMENT = {
  shipmentId: 'PKG-1768984539721',
  poNumber: '1I1EH29Q',
  parcels: [
    { glsTracking: 'ZMYP18S7', sku: '18023', ean: '5400882001884', quantity: 24 },
    { glsTracking: 'ZMYP18S8', sku: '18023', ean: '5400882001884', quantity: 24 },
    { glsTracking: 'ZMYP18S9', sku: '18023', ean: '5400882001884', quantity: 24 }
  ],
  shipTo: {
    fcName: 'Amazon FC',
    fcPartyId: 'XDEZ', // Typically the FC code for the destination
    address: {
      addressLine1: 'Amazon Fulfillment Center',
      city: '',
      postalCode: '',
      countryCode: ''
    }
  }
};

async function generateBarcodeDataURL(data, type = 'code128') {
  return new Promise((resolve, reject) => {
    const options = type === 'gs1-128'
      ? {
          bcid: 'gs1-128',
          text: `(00)${data}`,
          scale: 3,
          height: 15,
          includetext: true,
          textxalign: 'center',
          textsize: 10,
          parsefnc: true
        }
      : {
          bcid: 'code128',
          text: data,
          scale: 3,
          height: 12,
          includetext: true,
          textxalign: 'center',
          textsize: 10
        };

    bwipjs.toBuffer(options, (err, png) => {
      if (err) reject(err);
      else resolve(`data:image/png;base64,${png.toString('base64')}`);
    });
  });
}

function formatSSCCForLabel(sscc) {
  return `(00) ${sscc[0]} ${sscc.substring(1, 8)} ${sscc.substring(8)}`;
}

async function generateCombinedLabelHTML(parcels) {
  let labelsHTML = '';

  for (const parcel of parcels) {
    const ssccBarcode = await generateBarcodeDataURL(parcel.sscc, 'gs1-128');
    const glsBarcode = await generateBarcodeDataURL(parcel.glsTracking, 'code128');

    labelsHTML += `
    <!-- SSCC Label for parcel ${parcel.index} -->
    <div class="label sscc-label">
      <div class="header">
        <div class="from-to">
          <div class="from-to-label">Ship To:</div>
          <div class="from-to-value">${SHIPMENT.shipTo.fcName}</div>
        </div>
        <div class="fc-code">${SHIPMENT.shipTo.fcPartyId}</div>
      </div>

      <div class="po-section">
        <span class="po-label">PO:</span> ${SHIPMENT.poNumber}
      </div>

      <div class="barcode-section">
        <img src="${ssccBarcode}" alt="SSCC Barcode" class="barcode-img">
        <div class="sscc-text">${formatSSCCForLabel(parcel.sscc)}</div>
      </div>

      <div class="contents-section">
        <div class="contents-title">Contents:</div>
        <div class="contents-summary">
          <span>1 SKU</span>
          <span>${parcel.quantity} units</span>
        </div>
        <div class="contents-list">${parcel.sku} (EAN: ${parcel.ean}) x${parcel.quantity}</div>
        <div class="single-sku-badge">SINGLE-SKU</div>
      </div>

      <div class="parcel-number">Parcel ${parcel.index} of ${parcels.length}</div>
    </div>

    <!-- GLS Label for parcel ${parcel.index} -->
    <div class="label gls-label">
      <div class="gls-header">
        <div class="gls-logo">GLS</div>
        <div class="parcel-info">Parcel ${parcel.index}/${parcels.length}</div>
      </div>

      <div class="tracking-section">
        <div class="tracking-label">Tracking Number</div>
        <img src="${glsBarcode}" alt="GLS Tracking" class="barcode-img">
        <div class="tracking-number">${parcel.glsTracking}</div>
      </div>

      <div class="shipment-info">
        <div><strong>PO:</strong> ${SHIPMENT.poNumber}</div>
        <div><strong>SSCC:</strong> ${parcel.sscc}</div>
        <div><strong>Shipment:</strong> ${SHIPMENT.shipmentId}</div>
      </div>

      <div class="contents-brief">
        ${parcel.sku} x${parcel.quantity}
      </div>
    </div>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SSCC + GLS Labels - ${SHIPMENT.poNumber}</title>
  <style>
    @page { size: 100mm 150mm; margin: 0; }
    @media print {
      body { margin: 0; }
      .no-print { display: none; }
      .label { page-break-after: always; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; background: #f0f0f0; }

    .info-banner {
      background: #333;
      color: white;
      padding: 15px;
      text-align: center;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
    }
    .info-banner h2 { margin-bottom: 5px; }

    .labels-container {
      padding-top: 100px;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 20px;
      padding: 20px;
      padding-top: 120px;
    }

    .label {
      width: 100mm;
      height: 150mm;
      padding: 3mm;
      border: 1px solid #000;
      display: flex;
      flex-direction: column;
      background: white;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    }

    /* SSCC Label Styles */
    .sscc-label .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #000;
      padding-bottom: 2mm;
      margin-bottom: 2mm;
    }
    .sscc-label .from-to { flex: 1; }
    .sscc-label .from-to-label { font-size: 8pt; color: #666; text-transform: uppercase; }
    .sscc-label .from-to-value { font-size: 11pt; font-weight: bold; }
    .sscc-label .fc-code { font-size: 24pt; font-weight: bold; text-align: right; line-height: 1; }
    .sscc-label .po-section { border-bottom: 1px solid #000; padding: 2mm 0; font-size: 10pt; }
    .sscc-label .po-label { font-weight: bold; }
    .sscc-label .barcode-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 3mm 0;
    }
    .sscc-label .barcode-img { max-width: 90%; height: auto; }
    .sscc-label .sscc-text {
      font-family: 'Courier New', monospace;
      font-size: 12pt;
      font-weight: bold;
      margin-top: 2mm;
      letter-spacing: 1px;
    }
    .sscc-label .contents-section { border-top: 1px solid #000; padding-top: 2mm; font-size: 9pt; }
    .sscc-label .contents-title { font-weight: bold; margin-bottom: 1mm; }
    .sscc-label .contents-summary { display: flex; justify-content: space-between; }
    .sscc-label .contents-list { font-family: 'Courier New', monospace; font-size: 8pt; margin-top: 1mm; }
    .sscc-label .single-sku-badge {
      background: #000;
      color: #fff;
      padding: 1mm 3mm;
      font-size: 10pt;
      font-weight: bold;
      display: inline-block;
      margin-top: 2mm;
    }
    .sscc-label .parcel-number {
      text-align: center;
      font-size: 10pt;
      color: #666;
      border-top: 1px dashed #ccc;
      padding-top: 2mm;
      margin-top: 2mm;
    }

    /* GLS Label Styles */
    .gls-label {
      border: 3px solid #003D7D;
    }
    .gls-label .gls-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #003D7D;
      color: white;
      padding: 3mm;
      margin: -3mm -3mm 3mm -3mm;
    }
    .gls-label .gls-logo {
      font-size: 24pt;
      font-weight: bold;
    }
    .gls-label .parcel-info {
      font-size: 12pt;
    }
    .gls-label .tracking-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 5mm 0;
    }
    .gls-label .tracking-label {
      font-size: 10pt;
      color: #666;
      margin-bottom: 2mm;
    }
    .gls-label .barcode-img {
      max-width: 90%;
      height: auto;
    }
    .gls-label .tracking-number {
      font-family: 'Courier New', monospace;
      font-size: 16pt;
      font-weight: bold;
      margin-top: 3mm;
      letter-spacing: 2px;
    }
    .gls-label .shipment-info {
      border-top: 1px solid #ccc;
      padding: 3mm 0;
      font-size: 9pt;
    }
    .gls-label .shipment-info div {
      margin-bottom: 1mm;
    }
    .gls-label .contents-brief {
      background: #f5f5f5;
      padding: 2mm;
      text-align: center;
      font-size: 10pt;
      font-weight: bold;
    }

    .print-btn {
      position: fixed;
      top: 70px;
      right: 20px;
      padding: 15px 30px;
      font-size: 16px;
      cursor: pointer;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 5px;
      z-index: 1001;
    }
    .print-btn:hover {
      background: #45a049;
    }

    .summary {
      position: fixed;
      bottom: 20px;
      left: 20px;
      background: white;
      padding: 15px;
      border-radius: 5px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      font-size: 12px;
      max-width: 300px;
    }
    .summary h4 { margin-bottom: 10px; }
    .summary table { width: 100%; border-collapse: collapse; }
    .summary td { padding: 3px 5px; border-bottom: 1px solid #eee; }
    .summary td:first-child { font-weight: bold; }
  </style>
</head>
<body>
  <div class="no-print info-banner">
    <h2>SSCC + GLS Labels</h2>
    <div>PO: ${SHIPMENT.poNumber} | Shipment: ${SHIPMENT.shipmentId} | ${parcels.length} parcels</div>
  </div>

  <button class="no-print print-btn" onclick="window.print()">Print All Labels (${parcels.length * 2})</button>

  <div class="labels-container">
    ${labelsHTML}
  </div>

  <div class="no-print summary">
    <h4>New SSCCs Generated</h4>
    <table>
      ${parcels.map(p => `
        <tr>
          <td>Parcel ${p.index}:</td>
          <td style="font-family: monospace; font-size: 10px;">${p.sscc}</td>
        </tr>
        <tr>
          <td></td>
          <td style="color: #666;">GLS: ${p.glsTracking}</td>
        </tr>
      `).join('')}
    </table>
  </div>
</body>
</html>`;
}

async function main() {
  console.log('Connecting to database...');
  await connectDb();

  console.log('Initializing SSCC generator...');
  const ssccGen = await getSSCCGenerator();

  console.log(`\nGenerating ${SHIPMENT.parcels.length} new SSCCs for shipment ${SHIPMENT.shipmentId}...`);

  const parcelsWithSSCC = [];

  for (let i = 0; i < SHIPMENT.parcels.length; i++) {
    const parcel = SHIPMENT.parcels[i];

    // Generate new SSCC
    const ssccResult = await ssccGen.generateSSCC({
      type: 'carton',
      purchaseOrderNumber: SHIPMENT.poNumber,
      shipmentId: SHIPMENT.shipmentId,
      contents: {
        items: [{
          sku: parcel.sku,
          ean: parcel.ean,
          quantity: parcel.quantity
        }]
      }
    });

    console.log(`  Parcel ${i + 1}: SSCC ${ssccResult.sscc} (GLS: ${parcel.glsTracking})`);

    parcelsWithSSCC.push({
      index: i + 1,
      sscc: ssccResult.sscc,
      glsTracking: parcel.glsTracking,
      sku: parcel.sku,
      ean: parcel.ean,
      quantity: parcel.quantity
    });
  }

  console.log('\nGenerating combined label HTML...');
  const html = await generateCombinedLabelHTML(parcelsWithSSCC);

  // Save to file
  const outputDir = path.join(__dirname, '..', 'output');
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const filename = `SSCC-GLS-Labels_${SHIPMENT.poNumber}_${timestamp}.html`;
  const outputPath = path.join(outputDir, filename);

  await fs.writeFile(outputPath, html);

  console.log(`\n✓ Labels saved to: ${outputPath}`);
  console.log('\nNew SSCCs:');
  parcelsWithSSCC.forEach(p => {
    console.log(`  ${p.sscc} → GLS ${p.glsTracking}`);
  });

  console.log('\nOpen the HTML file in a browser and print to PDF, or print directly.');

  // Also update the shipment in the database with new SSCCs
  console.log('\nUpdating shipment in database with new SSCCs...');
  const db = getDb();

  const updateResult = await db.collection('orders').updateOne(
    { shipmentId: SHIPMENT.shipmentId },
    {
      $set: {
        'parcels': parcelsWithSSCC.map((p, idx) => ({
          sscc: p.sscc,
          trackingNumber: p.glsTracking,
          items: [{
            sku: p.sku,
            ean: p.ean,
            quantity: p.quantity
          }]
        })),
        'asnSubmitted': false, // Reset ASN flag since we have new SSCCs
        'asnSubmittedAt': null,
        'updatedAt': new Date(),
        'ssccRegenerated': true,
        'ssccRegeneratedAt': new Date(),
        'previousSSCCs': ['054008820000000160', '054008820000000177', '054008820000000184']
      }
    }
  );

  if (updateResult.matchedCount > 0) {
    console.log('✓ Shipment updated with new SSCCs');
  } else {
    console.log('⚠ Shipment not found in database (may need manual update)');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
