/**
 * InvoiceSyncScheduler - Automated invoice scanning and processing
 *
 * Runs Mo-Fr at 09:00 and 14:00 (Europe/Brussels timezone):
 * 1. Scan Gmail for new invoice emails from all active suppliers
 * 2. Parse downloaded PDFs with Claude AI
 * 3. Auto-submit to destination if supplier has autoProcess enabled
 */

const { scanEmails } = require('./EmailScanner');
const { parseInvoicePdf } = require('./PdfParser');
const { submitToOdoo } = require('./OdooInserter');
const { submitToPortal } = require('./PortalInserter');
const InvoiceSyncRecord = require('../../models/InvoiceSyncRecord');
const InvoiceSyncSupplier = require('../../models/InvoiceSyncSupplier');

/**
 * Run full invoice sync cycle: scan → parse → submit
 */
async function runInvoiceSyncCycle() {
  console.log('[InvoiceSyncScheduler] Starting invoice sync cycle...');
  const startTime = Date.now();

  const result = {
    scanned: 0,
    newInvoices: 0,
    parsed: 0,
    submitted: 0,
    errors: [],
  };

  try {
    // 1. Scan emails (last 3 days to catch weekend emails on Monday)
    const isMonday = new Date().getDay() === 1;
    const daysBack = isMonday ? 4 : 2;

    const scanResult = await scanEmails({ daysBack });
    result.scanned = scanResult.scanned;
    result.newInvoices = scanResult.newInvoices;

    if (scanResult.errors.length > 0) {
      result.errors.push(...scanResult.errors.map(e => `Scan: ${e.supplier || ''}: ${e.error}`));
    }

    console.log(`[InvoiceSyncScheduler] Scan done: ${scanResult.newInvoices} new invoices found`);

    // 2. Parse all pending invoices
    const pendingInvoices = await InvoiceSyncRecord.find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(50);

    for (const invoice of pendingInvoices) {
      try {
        if (!invoice.pdfFilepath) continue;

        const parsed = await parseInvoicePdf(invoice.pdfFilepath, invoice.supplierName);

        invoice.invoiceNumber = parsed.invoiceNumber || null;
        invoice.invoiceDate = parsed.invoiceDate || null;
        invoice.netAmount = parsed.netAmount ?? null;
        invoice.vatAmount = parsed.vatAmount ?? null;
        invoice.grossAmount = parsed.grossAmount ?? null;
        invoice.poNumbers = parsed.poNumbers || '';
        invoice.parsedDataJson = parsed;
        invoice.status = 'parsed';
        invoice.addEvent('parsed', { confidence: parsed.confidence });
        await invoice.save();

        result.parsed++;
      } catch (err) {
        console.error(`[InvoiceSyncScheduler] Parse error for ${invoice._id}: ${err.message}`);
        invoice.status = 'failed';
        invoice.errorMessage = `Parse failed: ${err.message}`;
        invoice.addEvent('parse_failed', { error: err.message });
        await invoice.save();
        result.errors.push(`Parse: ${invoice.supplierName}: ${err.message}`);
      }
    }

    console.log(`[InvoiceSyncScheduler] Parsed ${result.parsed} invoices`);

    // 3. Auto-submit if configured
    const autoProcessSuppliers = await InvoiceSyncSupplier.find({
      isActive: true,
      autoProcess: true,
    }).lean();

    const autoSupplierIds = new Set(autoProcessSuppliers.map(s => s._id.toString()));

    const parsedInvoices = await InvoiceSyncRecord.find({
      status: 'parsed',
      supplier: { $in: autoProcessSuppliers.map(s => s._id) },
    }).limit(20);

    for (const invoice of parsedInvoices) {
      if (!autoSupplierIds.has(invoice.supplier.toString())) continue;

      const supplierConfig = autoProcessSuppliers.find(
        s => s._id.toString() === invoice.supplier.toString()
      );

      try {
        if (supplierConfig.destination === 'odoo') {
          await submitToOdoo(invoice, supplierConfig);
        } else if (supplierConfig.destination === 'portal') {
          await submitToPortal(invoice, supplierConfig);
        }
        result.submitted++;
      } catch (err) {
        console.error(`[InvoiceSyncScheduler] Submit error for ${invoice._id}: ${err.message}`);
        result.errors.push(`Submit: ${invoice.supplierName}: ${err.message}`);
      }
    }

    console.log(`[InvoiceSyncScheduler] Auto-submitted ${result.submitted} invoices`);

  } catch (err) {
    console.error('[InvoiceSyncScheduler] Cycle error:', err.message);
    result.errors.push(`Cycle: ${err.message}`);
  }

  const durationMs = Date.now() - startTime;
  console.log(`[InvoiceSyncScheduler] Cycle complete in ${(durationMs / 1000).toFixed(1)}s: scanned=${result.scanned}, new=${result.newInvoices}, parsed=${result.parsed}, submitted=${result.submitted}, errors=${result.errors.length}`);

  return result;
}

module.exports = {
  runInvoiceSyncCycle,
};
