/**
 * Accounting Services - Module exports
 */

const InvoiceParser = require('./InvoiceParser');
const POMatchingEngine = require('./POMatchingEngine');
const { OdooVendorBillCreator, createVendorBill } = require('./OdooVendorBillCreator');
const {
  InvoiceProcessor,
  processInvoice,
  processQueue,
  retryFailed,
} = require('./InvoiceProcessor');
const {
  InvoiceEmailPoller,
  scanForInvoices,
  extractInvoiceFromEmail,
  pollForInvoices,
} = require('./InvoiceEmailPoller');

module.exports = {
  // Classes
  InvoiceParser,
  POMatchingEngine,
  OdooVendorBillCreator,
  InvoiceProcessor,
  InvoiceEmailPoller,

  // Factory functions
  createVendorBill,
  processInvoice,
  processQueue,
  retryFailed,
  scanForInvoices,
  extractInvoiceFromEmail,
  pollForInvoices,
};
