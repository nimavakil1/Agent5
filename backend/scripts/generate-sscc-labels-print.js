/**
 * Generate print-ready SSCC + GLS labels for shipment PKG-1768984539721
 * Optimized for 100x150mm label paper
 */

require('dotenv').config();
const bwipjs = require('bwip-js');
const fs = require('fs').promises;
const path = require('path');

// Shipment data with the NEW SSCCs already generated
const SHIPMENT = {
  shipmentId: 'PKG-1768984539721',
  poNumber: '1I1EH29Q',
  parcels: [
    { sscc: '054008820000000191', glsTracking: 'ZMYP18S7', sku: '18023', ean: '5400882001884', quantity: 24 },
    { sscc: '054008820000000207', glsTracking: 'ZMYP18S8', sku: '18023', ean: '5400882001884', quantity: 24 },
    { sscc: '054008820000000214', glsTracking: 'ZMYP18S9', sku: '18023', ean: '5400882001884', quantity: 24 }
  ],
  shipTo: {
    fcName: 'Amazon FC',
    fcPartyId: 'XDEZ'
  }
};

async function generateBarcodeDataURL(data, type = 'code128') {
  return new Promise((resolve, reject) => {
    const options = type === 'gs1-128'
      ? {
          bcid: 'gs1-128',
          text: `(00)${data}`,
          scale: 3,
          height: 12,
          includetext: true,
          textxalign: 'center',
          textsize: 9,
          parsefnc: true
        }
      : {
          bcid: 'code128',
          text: data,
          scale: 3,
          height: 10,
          includetext: true,
          textxalign: 'center',
          textsize: 9
        };

    bwipjs.toBuffer(options, (err, png) => {
      if (err) reject(err);
      else resolve(`data:image/png;base64,${png.toString('base64')}`);
    });
  });
}

function formatSSCC(sscc) {
  return `(00) ${sscc[0]} ${sscc.substring(1, 8)} ${sscc.substring(8)}`;
}

async function generatePrintHTML(parcels) {
  let pages = '';

  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    const ssccBarcode = await generateBarcodeDataURL(p.sscc, 'gs1-128');
    const glsBarcode = await generateBarcodeDataURL(p.glsTracking, 'code128');

    // SSCC Label
    pages += `
    <div class="page sscc">
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
        <img src="${ssccBarcode}" class="barcode">
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
      <div class="parcel-num">Parcel ${i + 1} of ${parcels.length}</div>
    </div>`;

    // GLS Label
    pages += `
    <div class="page gls">
      <div class="gls-header">
        <div class="gls-logo">GLS</div>
        <div class="gls-parcel">Parcel ${i + 1}/${parcels.length}</div>
      </div>
      <div class="gls-tracking">
        <div class="tracking-label">Tracking Number</div>
        <img src="${glsBarcode}" class="barcode">
        <div class="tracking-num">${p.glsTracking}</div>
      </div>
      <div class="gls-info">
        <div><span class="bold">PO:</span> ${SHIPMENT.poNumber}</div>
        <div><span class="bold">SSCC:</span> ${p.sscc}</div>
      </div>
      <div class="gls-contents">${p.sku} x${p.quantity}</div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Labels - ${SHIPMENT.poNumber}</title>
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

    /* SSCC Label */
    .sscc .top-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .sscc .label-text {
      font-size: 7pt;
      color: #666;
    }
    .sscc .fc-name {
      font-size: 12pt;
      font-weight: bold;
    }
    .sscc .fc-code {
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
    .sscc .po-row {
      font-size: 10pt;
      padding: 1mm 0;
    }
    .bold {
      font-weight: bold;
    }
    .sscc .barcode-area {
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
    .sscc .sscc-human {
      font-family: 'Courier New', monospace;
      font-size: 11pt;
      font-weight: bold;
      margin-top: 2mm;
      letter-spacing: 0.5px;
    }
    .sscc .contents {
      padding: 2mm 0;
    }
    .sscc .contents-header {
      display: flex;
      justify-content: space-between;
      font-size: 9pt;
      margin-bottom: 1mm;
    }
    .sscc .sku-line {
      font-family: 'Courier New', monospace;
      font-size: 8pt;
    }
    .sscc .badge {
      display: inline-block;
      background: #000;
      color: #fff;
      padding: 1mm 2mm;
      font-size: 8pt;
      font-weight: bold;
      margin-top: 1mm;
    }
    .sscc .parcel-num {
      text-align: center;
      font-size: 8pt;
      color: #666;
      border-top: 1px dashed #ccc;
      padding-top: 1mm;
      margin-top: 1mm;
    }

    /* GLS Label */
    .gls {
      border: 2px solid #003D7D;
    }
    .gls-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #003D7D;
      color: white;
      padding: 3mm;
      margin: -4mm -4mm 3mm -4mm;
    }
    .gls-logo {
      font-size: 24pt;
      font-weight: bold;
    }
    .gls-parcel {
      font-size: 11pt;
    }
    .gls-tracking {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .tracking-label {
      font-size: 9pt;
      color: #666;
      margin-bottom: 2mm;
    }
    .tracking-num {
      font-family: 'Courier New', monospace;
      font-size: 18pt;
      font-weight: bold;
      margin-top: 3mm;
      letter-spacing: 2px;
    }
    .gls-info {
      border-top: 1px solid #ccc;
      padding: 3mm 0;
      font-size: 9pt;
    }
    .gls-info div {
      margin-bottom: 1mm;
    }
    .gls-contents {
      background: #f0f0f0;
      padding: 2mm;
      text-align: center;
      font-size: 10pt;
      font-weight: bold;
    }
  </style>
</head>
<body>
${pages}
</body>
</html>`;
}

async function main() {
  console.log('Generating print-ready labels...');

  const html = await generatePrintHTML(SHIPMENT.parcels);

  const outputPath = path.join(__dirname, '..', 'output', `Labels_${SHIPMENT.poNumber}.html`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html);

  console.log(`✓ Saved to: ${outputPath}`);
  console.log('\nLabels:');
  SHIPMENT.parcels.forEach((p, i) => {
    console.log(`  ${i + 1}. SSCC: ${p.sscc} | GLS: ${p.glsTracking}`);
  });
}

main().catch(console.error);
