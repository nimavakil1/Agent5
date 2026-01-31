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
const {
  PaymentReconciliationEngine,
  reconcilePayment,
  executeReconciliation,
  processReconciliationQueue,
} = require('./PaymentReconciliationEngine');

const { EmbeddingService, getEmbeddingService } = require('./EmbeddingService');
const { seedAll: seedAcropaqKnowledge, ACROPAQ_KNOWLEDGE } = require('./seedAcropaqKnowledge');

module.exports = {
  // Classes
  InvoiceParser,
  POMatchingEngine,
  OdooVendorBillCreator,
  InvoiceProcessor,
  InvoiceEmailPoller,
  PaymentReconciliationEngine,

  // Invoice factory functions
  createVendorBill,
  processInvoice,
  processQueue,
  retryFailed,
  scanForInvoices,
  extractInvoiceFromEmail,
  pollForInvoices,

  // Payment reconciliation factory functions
  reconcilePayment,
  executeReconciliation,
  processReconciliationQueue,

  // Embedding and knowledge services
  EmbeddingService,
  getEmbeddingService,
  seedAcropaqKnowledge,
  ACROPAQ_KNOWLEDGE,
};
