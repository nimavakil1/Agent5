/**
 * Generate SSCC labels only (no carrier labels)
 * Carrier labels come from the carrier (GLS, etc.)
 */

require('dotenv').config();
const bwipjs = require('bwip-js');
const fs = require('fs').promises;
const path = require('path');

const SHIPMENT = {
  poNumber: '1I1EH29Q',
  shipTo: {
    fcName: 'Amazon FC',
    fcPartyId: 'CDG7'
  },
  parcels: [
    { sscc: '054008820000000191', sku: '18023', ean: '5400882001884', quantity: 24 },
    { sscc: '054008820000000207', sku: '18023', ean: '5400882001884', quantity: 24 },
    { sscc: '054008820000000214', sku: '18023', ean: '5400882001884', quantity: 24 }
  ]
};

async function generateBarcodeDataURL(sscc) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer({
      bcid: 'gs1-128',
      text: `(00)${sscc}`,
      scale: 3,
      height: 12,
      includetext: true,
      textxalign: 'center',
      textsize: 9,
      parsefnc: true
    }, (err, png) => {
      if (err) reject(err);
      else resolve(`data:image/png;base64,${png.toString('base64')}`);
    });
  });
}

function formatSSCC(sscc) {
  return `(00) ${sscc[0]} ${sscc.substring(1, 8)} ${sscc.substring(8)}`;
}

async function generateHTML(parcels) {
  let pages = '';

  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    const barcode = await generateBarcodeDataURL(p.sscc);

    pages += `
    <div class="page">
      <div class="top-row">
        <div class="ship-to">
          <div class="label-text">SHIP TO:</div>
          <div class="fc-name">${SHIPMENT.shipTo.fcName}</div>
        </div>
        <div class="fc-code">${SHIPMENT.shipTo.fcPartyId}</div>
      </div>
      <div class="divider"></div>
      <div class="po-row">
        <span class="bold">PO:</span> ${SHIPMENT.poNumber}
      </div>
      <div class="divider thin"></div>
      <div class="barcode-area">
        <img src="${barcode}" class="barcode">
        <div class="sscc-human">${formatSSCC(p.sscc)}</div>
      </div>
      <div class="divider thin"></div>
      <div class="contents">
        <div class="contents-header">
          <span class="bold">Contents:</span>
          <span>1 SKU | ${p.quantity} units</span>
        </div>
        <div class="sku-line">${p.sku} (${p.ean}) x${p.quantity}</div>
        <div class="badge">SINGLE-SKU</div>
      </div>
      <div class="parcel-num">Carton ${i + 1} of ${parcels.length}</div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SSCC Labels - ${SHIPMENT.poNumber}</title>
  <style>
    @page {
      size: 100mm 150mm;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 100mm;
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
    }
    .page {
      width: 100mm;
      height: 150mm;
      padding: 4mm;
      page-break-after: always;
      page-break-inside: avoid;
      display: flex;
      flex-direction: column;
    }
    .page:last-child {
      page-break-after: auto;
    }
    .top-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .label-text {
      font-size: 7pt;
      color: #666;
    }
    .fc-name {
      font-size: 12pt;
      font-weight: bold;
    }
    .fc-code {
      font-size: 28pt;
      font-weight: bold;
      line-height: 1;
    }
    .divider {
      border-bottom: 2px solid #000;
      margin: 2mm 0;
    }
    .divider.thin {
      border-bottom-width: 1px;
    }
    .po-row {
      font-size: 10pt;
      padding: 1mm 0;
    }
    .bold {
      font-weight: bold;
    }
    .barcode-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      min-height: 50mm;
    }
    .barcode {
      max-width: 88mm;
      height: auto;
    }
    .sscc-human {
      font-family: 'Courier New', monospace;
      font-size: 11pt;
      font-weight: bold;
      margin-top: 2mm;
      letter-spacing: 0.5px;
    }
    .contents {
      padding: 2mm 0;
    }
    .contents-header {
      display: flex;
      justify-content: space-between;
      font-size: 9pt;
      margin-bottom: 1mm;
    }
    .sku-line {
      font-family: 'Courier New', monospace;
      font-size: 8pt;
    }
    .badge {
      display: inline-block;
      background: #000;
      color: #fff;
      padding: 1mm 2mm;
      font-size: 8pt;
      font-weight: bold;
      margin-top: 1mm;
    }
    .parcel-num {
      text-align: center;
      font-size: 8pt;
      color: #666;
      border-top: 1px dashed #ccc;
      padding-top: 1mm;
      margin-top: 1mm;
    }
  </style>
</head>
<body>
${pages}
</body>
</html>`;
}

async function main() {
  console.log('Generating SSCC labels only...');

  const html = await generateHTML(SHIPMENT.parcels);

  const outputPath = path.join(__dirname, '..', 'output', `SSCC_Labels_${SHIPMENT.poNumber}.html`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html);

  console.log(`Saved: ${outputPath}`);
  SHIPMENT.parcels.forEach((p, i) => {
    console.log(`  Carton ${i + 1}: ${p.sscc}`);
  });
}

main().catch(console.error);
