/**
 * PrintService - QZ Tray Integration for Agent5
 *
 * Enables direct thermal label printing from the web interface.
 * Requires QZ Tray to be installed on the local machine.
 *
 * Download QZ Tray: https://qz.io/download/
 */

window.PrintService = (function() {
  let qzReady = false;
  let qzConnected = false;
  let selectedPrinter = null;
  let printerList = [];

  // Load QZ Tray library dynamically
  async function loadQZTray() {
    if (window.qz) return true;

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js';
      script.onload = () => {
        console.log('[PrintService] QZ Tray library loaded');
        resolve(true);
      };
      script.onerror = () => {
        console.error('[PrintService] Failed to load QZ Tray library');
        reject(new Error('Failed to load QZ Tray library'));
      };
      document.head.appendChild(script);
    });
  }

  // Configure QZ Tray signing for silent printing
  function configureQZSigning() {
    if (!window.qz) return;

    // Certificate - fetched from our backend
    qz.security.setCertificatePromise(function(resolve, reject) {
      fetch('/api/print/certificate', { credentials: 'include' })
        .then(res => res.text())
        .then(resolve)
        .catch(reject);
    });

    // Signature - request signed by our backend
    qz.security.setSignaturePromise(function(toSign) {
      return function(resolve, reject) {
        fetch('/api/print/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ data: toSign })
        })
          .then(res => res.text())
          .then(resolve)
          .catch(reject);
      };
    });
  }

  // Initialize QZ Tray connection
  async function init() {
    try {
      await loadQZTray();
      configureQZSigning();
      qzReady = true;
      console.log('[PrintService] Initialized');
      return { success: true };
    } catch (error) {
      console.error('[PrintService] Init failed:', error);
      return { success: false, error: error.message };
    }
  }

  // Connect to QZ Tray
  async function connect() {
    if (!qzReady) {
      const initResult = await init();
      if (!initResult.success) return initResult;
    }

    if (qzConnected && qz.websocket.isActive()) {
      return { success: true, message: 'Already connected' };
    }

    try {
      await qz.websocket.connect();
      qzConnected = true;
      console.log('[PrintService] Connected to QZ Tray');

      // Load printer list
      await refreshPrinters();

      return { success: true, printers: printerList };
    } catch (error) {
      console.error('[PrintService] Connection failed:', error);

      if (error.message?.includes('Unable to establish connection')) {
        return {
          success: false,
          error: 'QZ Tray not running. Please install and start QZ Tray.',
          downloadUrl: 'https://qz.io/download/'
        };
      }

      return { success: false, error: error.message };
    }
  }

  // Disconnect from QZ Tray
  async function disconnect() {
    if (qzConnected && qz.websocket.isActive()) {
      await qz.websocket.disconnect();
      qzConnected = false;
    }
    return { success: true };
  }

  // Get list of available printers
  async function refreshPrinters() {
    if (!qzConnected) {
      const connResult = await connect();
      if (!connResult.success) return connResult;
    }

    try {
      printerList = await qz.printers.find();
      console.log('[PrintService] Found printers:', printerList);
      return { success: true, printers: printerList };
    } catch (error) {
      console.error('[PrintService] Failed to get printers:', error);
      return { success: false, error: error.message };
    }
  }

  // Get default printer
  async function getDefaultPrinter() {
    if (!qzConnected) {
      const connResult = await connect();
      if (!connResult.success) return connResult;
    }

    try {
      const defaultPrinter = await qz.printers.getDefault();
      return { success: true, printer: defaultPrinter };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Set the printer to use
  function setPrinter(printerName) {
    selectedPrinter = printerName;
    localStorage.setItem('agent5_printer', printerName);
    console.log('[PrintService] Printer set to:', printerName);
    return { success: true, printer: printerName };
  }

  // Get saved printer preference
  function getSavedPrinter() {
    return localStorage.getItem('agent5_printer');
  }

  // Print a PDF label (base64 encoded)
  async function printPdfLabel(pdfBase64, options = {}) {
    if (!qzConnected) {
      const connResult = await connect();
      if (!connResult.success) return connResult;
    }

    const printer = options.printer || selectedPrinter || getSavedPrinter();
    if (!printer) {
      return { success: false, error: 'No printer selected. Please select a printer first.' };
    }

    try {
      const config = qz.configs.create(printer, {
        // Thermal label printer settings
        size: options.size || { width: 4, height: 6 },  // 4x6 inch label (standard shipping)
        units: 'in',
        colorType: 'grayscale',
        interpolation: 'nearest-neighbor',
        scaleContent: true,
        rasterize: true,
        // Orientation
        orientation: options.orientation || 'portrait',
        // Margins
        margins: options.margins || { top: 0, right: 0, bottom: 0, left: 0 }
      });

      const data = [{
        type: 'pixel',
        format: 'pdf',
        flavor: 'base64',
        data: pdfBase64,
        options: {
          ignoreTransparency: true  // Important for thermal printers
        }
      }];

      await qz.print(config, data);
      console.log('[PrintService] PDF label printed successfully');
      return { success: true, message: 'Label printed successfully' };
    } catch (error) {
      console.error('[PrintService] Print failed:', error);
      return { success: false, error: error.message };
    }
  }

  // Print raw ZPL commands (for Zebra printers)
  async function printZpl(zplCommands, options = {}) {
    if (!qzConnected) {
      const connResult = await connect();
      if (!connResult.success) return connResult;
    }

    const printer = options.printer || selectedPrinter || getSavedPrinter();
    if (!printer) {
      return { success: false, error: 'No printer selected' };
    }

    try {
      const config = qz.configs.create(printer);

      const data = [{
        type: 'raw',
        format: 'plain',
        data: zplCommands
      }];

      await qz.print(config, data);
      console.log('[PrintService] ZPL printed successfully');
      return { success: true };
    } catch (error) {
      console.error('[PrintService] ZPL print failed:', error);
      return { success: false, error: error.message };
    }
  }

  // Print shipping label from GLS (fetches and prints)
  async function printGLSLabel(trackingNumber, options = {}) {
    try {
      // Fetch label from backend
      const response = await fetch(`/api/shipping/gls/label/${trackingNumber}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        return { success: false, error: error.message || 'Failed to fetch label' };
      }

      const data = await response.json();
      if (!data.labelPdf) {
        return { success: false, error: 'No label data received' };
      }

      // Print the PDF
      return await printPdfLabel(data.labelPdf, options);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Check if QZ Tray is installed and running
  async function checkStatus() {
    const status = {
      libraryLoaded: !!window.qz,
      connected: qzConnected && window.qz?.websocket?.isActive(),
      selectedPrinter: selectedPrinter || getSavedPrinter(),
      printers: printerList
    };

    if (!status.libraryLoaded) {
      await init();
      status.libraryLoaded = !!window.qz;
    }

    if (status.libraryLoaded && !status.connected) {
      const connResult = await connect();
      status.connected = connResult.success;
      status.printers = connResult.printers || [];
      if (!connResult.success) {
        status.error = connResult.error;
        status.downloadUrl = connResult.downloadUrl;
      }
    }

    return status;
  }

  // Show printer selection dialog
  function showPrinterDialog() {
    return new Promise(async (resolve) => {
      const status = await checkStatus();

      if (!status.connected) {
        resolve({
          success: false,
          error: status.error || 'Not connected to QZ Tray',
          downloadUrl: status.downloadUrl
        });
        return;
      }

      // Create modal
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

      const modal = document.createElement('div');
      modal.style.cssText = 'background:#18181f;border:1px solid #252532;border-radius:16px;padding:24px;min-width:360px;max-width:480px;';

      const savedPrinter = getSavedPrinter();

      modal.innerHTML = `
        <h3 style="margin:0 0 16px;color:#fff;font-size:18px;">Select Printer</h3>
        <div style="margin-bottom:16px;">
          ${status.printers.map(p => `
            <label style="display:flex;align-items:center;padding:12px;margin:8px 0;background:#252532;border-radius:8px;cursor:pointer;${p === savedPrinter ? 'border:2px solid #f97316;' : 'border:2px solid transparent;'}">
              <input type="radio" name="printer" value="${p}" ${p === savedPrinter ? 'checked' : ''} style="margin-right:12px;">
              <span style="color:#e4e4e7;">${p}</span>
            </label>
          `).join('')}
        </div>
        <div style="display:flex;gap:12px;justify-content:flex-end;">
          <button id="cancel-printer-btn" style="padding:10px 20px;background:#252532;border:1px solid #3f3f50;border-radius:8px;color:#e4e4e7;cursor:pointer;">Cancel</button>
          <button id="save-printer-btn" style="padding:10px 20px;background:#f97316;border:none;border-radius:8px;color:#fff;cursor:pointer;font-weight:600;">Save</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      modal.querySelector('#cancel-printer-btn').onclick = () => {
        document.body.removeChild(overlay);
        resolve({ success: false, cancelled: true });
      };

      modal.querySelector('#save-printer-btn').onclick = () => {
        const selected = modal.querySelector('input[name="printer"]:checked');
        if (selected) {
          setPrinter(selected.value);
          document.body.removeChild(overlay);
          resolve({ success: true, printer: selected.value });
        }
      };

      overlay.onclick = (e) => {
        if (e.target === overlay) {
          document.body.removeChild(overlay);
          resolve({ success: false, cancelled: true });
        }
      };
    });
  }

  // Public API
  return {
    init,
    connect,
    disconnect,
    refreshPrinters,
    getDefaultPrinter,
    getPrinters: () => printerList,
    setPrinter,
    getSavedPrinter,
    printPdfLabel,
    printZpl,
    printGLSLabel,
    checkStatus,
    showPrinterDialog,
    isConnected: () => qzConnected && window.qz?.websocket?.isActive()
  };
})();
