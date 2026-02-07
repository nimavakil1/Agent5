/**
 * Invoice Sync API Routes
 *
 * REST API for managing supplier invoice sync (SDT / distri-smart)
 * Prefix: /api/invoice-sync
 */

const express = require('express');
const router = express.Router();
const InvoiceSyncSupplier = require('../../models/InvoiceSyncSupplier');
const InvoiceSyncRecord = require('../../models/InvoiceSyncRecord');
const { seedSuppliers } = require('../../services/invoice-sync');

// ==================== SUPPLIER CONFIG MANAGEMENT ====================

/**
 * @route GET /api/invoice-sync/suppliers
 * @desc List all supplier configurations
 */
router.get('/suppliers', async (req, res) => {
  try {
    const suppliers = await InvoiceSyncSupplier.find()
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, count: suppliers.length, suppliers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/invoice-sync/suppliers/:id
 * @desc Get a single supplier config
 */
router.get('/suppliers/:id', async (req, res) => {
  try {
    const supplier = await InvoiceSyncSupplier.findById(req.params.id).lean();
    if (!supplier) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }
    res.json({ success: true, supplier });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/invoice-sync/suppliers
 * @desc Create a new supplier configuration
 */
router.post('/suppliers', async (req, res) => {
  try {
    const {
      name, senderPattern, subjectPattern, matchMode,
      destination, portalSupplierName, odooPartnerId,
      odooExpenseAccountCode, autoProcess, isActive,
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!destination || !['portal', 'odoo'].includes(destination)) {
      return res.status(400).json({ success: false, error: 'destination must be "portal" or "odoo"' });
    }

    const supplier = await InvoiceSyncSupplier.create({
      name,
      senderPattern: senderPattern || '',
      subjectPattern: subjectPattern || '',
      matchMode: matchMode || 'sender',
      destination,
      portalSupplierName: portalSupplierName || '',
      odooPartnerId: odooPartnerId || null,
      odooExpenseAccountCode: odooExpenseAccountCode || '6770',
      autoProcess: autoProcess || false,
      isActive: isActive !== false,
    });

    res.status(201).json({ success: true, supplier });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'Supplier with this name already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route PUT /api/invoice-sync/suppliers/:id
 * @desc Update a supplier configuration
 */
router.put('/suppliers/:id', async (req, res) => {
  try {
    const allowedFields = [
      'name', 'isActive', 'senderPattern', 'subjectPattern', 'matchMode',
      'destination', 'portalSupplierName', 'odooPartnerId',
      'odooExpenseAccountCode', 'autoProcess',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const supplier = await InvoiceSyncSupplier.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    if (!supplier) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }

    res.json({ success: true, supplier });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'Supplier with this name already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route DELETE /api/invoice-sync/suppliers/:id
 * @desc Deactivate a supplier (soft delete)
 */
router.delete('/suppliers/:id', async (req, res) => {
  try {
    const supplier = await InvoiceSyncSupplier.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!supplier) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }

    res.json({ success: true, message: `Supplier "${supplier.name}" deactivated`, supplier });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== INVOICE RECORDS ====================

/**
 * @route GET /api/invoice-sync/invoices
 * @desc List invoices with filters
 */
router.get('/invoices', async (req, res) => {
  try {
    const {
      status,
      supplier,
      date_from,
      date_to,
      limit = 50,
      offset = 0,
      sort = '-createdAt',
    } = req.query;

    const query = {};

    if (status && status !== 'all') {
      query.status = status;
    }
    if (supplier) {
      query.supplierName = { $regex: supplier, $options: 'i' };
    }
    if (date_from || date_to) {
      query.emailDate = {};
      if (date_from) query.emailDate.$gte = new Date(date_from);
      if (date_to) query.emailDate.$lte = new Date(date_to);
    }

    const [invoices, total] = await Promise.all([
      InvoiceSyncRecord.find(query)
        .sort(sort)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean(),
      InvoiceSyncRecord.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: invoices.length,
      total,
      invoices: invoices.map(inv => ({
        id: inv._id,
        supplierName: inv.supplierName,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        grossAmount: inv.grossAmount,
        netAmount: inv.netAmount,
        vatAmount: inv.vatAmount,
        poNumbers: inv.poNumbers,
        status: inv.status,
        destination: inv.destination,
        emailSubject: inv.emailSubject,
        emailDate: inv.emailDate,
        odooBillId: inv.odooBillId,
        odooBillNumber: inv.odooBillNumber,
        errorMessage: inv.errorMessage,
        createdAt: inv.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/invoice-sync/invoices/:id
 * @desc Get full invoice details
 */
router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await InvoiceSyncRecord.findById(req.params.id).lean();
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }
    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/invoice-sync/invoices/:id/submit
 * @desc Submit invoice to its destination (portal or odoo)
 */
router.post('/invoices/:id/submit', async (req, res) => {
  try {
    const invoice = await InvoiceSyncRecord.findById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }
    if (invoice.status === 'submitted') {
      return res.status(400).json({ success: false, error: 'Invoice already submitted' });
    }
    if (invoice.status !== 'parsed') {
      return res.status(400).json({ success: false, error: 'Invoice must be parsed before submission' });
    }

    // Get supplier config
    const supplier = await InvoiceSyncSupplier.findById(invoice.supplier);
    if (!supplier) {
      return res.status(404).json({ success: false, error: 'Supplier config not found' });
    }

    // Submit based on destination
    if (supplier.destination === 'odoo') {
      const { submitToOdoo } = require('../../services/invoice-sync/OdooInserter');
      const result = await submitToOdoo(invoice, supplier);
      res.json({ success: true, result });
    } else if (supplier.destination === 'portal') {
      const { submitToPortal } = require('../../services/invoice-sync/PortalInserter');
      const result = await submitToPortal(invoice, supplier);
      res.json({ success: true, result });
    } else {
      res.status(400).json({ success: false, error: `Unknown destination: ${supplier.destination}` });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/invoice-sync/invoices/:id/skip
 * @desc Mark invoice as skipped
 */
router.post('/invoices/:id/skip', async (req, res) => {
  try {
    const invoice = await InvoiceSyncRecord.findById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    invoice.status = 'skipped';
    invoice.addEvent('skipped', { reason: req.body.reason || 'Manual skip' });
    await invoice.save();

    res.json({ success: true, message: 'Invoice skipped' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/invoice-sync/invoices/:id/reparse
 * @desc Re-parse PDF with AI
 */
router.post('/invoices/:id/reparse', async (req, res) => {
  try {
    const invoice = await InvoiceSyncRecord.findById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }
    if (!invoice.pdfFilepath) {
      return res.status(400).json({ success: false, error: 'No PDF file available for re-parsing' });
    }

    const { parseInvoicePdf } = require('../../services/invoice-sync/PdfParser');
    const result = await parseInvoicePdf(invoice.pdfFilepath, invoice.supplierName);

    // Update record with new parsed data
    invoice.invoiceNumber = result.invoiceNumber || invoice.invoiceNumber;
    invoice.invoiceDate = result.invoiceDate || invoice.invoiceDate;
    invoice.netAmount = result.netAmount ?? invoice.netAmount;
    invoice.vatAmount = result.vatAmount ?? invoice.vatAmount;
    invoice.grossAmount = result.grossAmount ?? invoice.grossAmount;
    invoice.poNumbers = result.poNumbers || invoice.poNumbers;
    invoice.parsedDataJson = result;
    invoice.status = 'parsed';
    invoice.errorMessage = null;
    invoice.addEvent('reparsed', { confidence: result.confidence });
    await invoice.save();

    res.json({ success: true, parsedData: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/invoice-sync/scan
 * @desc Trigger manual email scan
 */
router.post('/scan', async (req, res) => {
  try {
    const { supplierId, daysBack } = req.body;

    const { scanEmails } = require('../../services/invoice-sync/EmailScanner');
    const result = await scanEmails({
      supplierId: supplierId || null,
      daysBack: daysBack || 7,
    });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/invoice-sync/status
 * @desc Get scheduler status and stats
 */
router.get('/status', async (req, res) => {
  try {
    const [metrics, supplierCount, activeSuppliers] = await Promise.all([
      InvoiceSyncRecord.getMetrics(),
      InvoiceSyncSupplier.countDocuments(),
      InvoiceSyncSupplier.countDocuments({ isActive: true }),
    ]);

    // Format metrics
    const statusCounts = {};
    let totalAmount = 0;
    for (const m of metrics) {
      statusCounts[m._id] = m.count;
      totalAmount += m.totalGross || 0;
    }

    res.json({
      success: true,
      suppliers: {
        total: supplierCount,
        active: activeSuppliers,
      },
      invoices: {
        byStatus: statusCounts,
        totalAmount,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/invoice-sync/seed
 * @desc Seed default suppliers (idempotent)
 */
router.post('/seed', async (req, res) => {
  try {
    const result = await seedSuppliers();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
