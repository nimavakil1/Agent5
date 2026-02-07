/**
 * Invoice Sync Module - Entry point
 *
 * Handles supplier invoice processing for SDT (Smart Distribution Technologies):
 * - Scans Gmail (general@distri-smart.com) for invoice emails
 * - Downloads PDF attachments, parses with Claude AI
 * - Submits to supplier portal (s.distri-smart.com) or creates Odoo 14 vendor bills
 */

const InvoiceSyncSupplier = require('../../models/InvoiceSyncSupplier');

// Default supplier configurations for initial seeding
const DEFAULT_SUPPLIERS = [
  {
    name: 'Maul',
    senderPattern: 'maul',
    subjectPattern: 'rechnung|invoice',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Maul',
    autoProcess: false,
  },
  {
    name: 'Leitz-Acco',
    senderPattern: 'leitz|acco',
    subjectPattern: 'rechnung|invoice',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Leitz-Acco',
    autoProcess: false,
  },
  {
    name: 'Go Europe',
    senderPattern: 'goeurope|go-europe|go.europe',
    subjectPattern: 'rechnung|invoice',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Go Europe',
    autoProcess: false,
  },
  {
    name: 'Antalis',
    senderPattern: 'antalis',
    subjectPattern: 'rechnung|invoice|facture',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Antalis',
    autoProcess: false,
  },
  {
    name: 'Exaclair',
    senderPattern: 'exaclair',
    subjectPattern: 'rechnung|invoice|facture',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Exaclair',
    autoProcess: false,
  },
  {
    name: 'Hamelin',
    senderPattern: 'hamelin',
    subjectPattern: 'rechnung|invoice|facture',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Hamelin',
    autoProcess: false,
  },
  {
    name: 'Imcopex',
    senderPattern: 'imcopex',
    subjectPattern: 'rechnung|invoice',
    matchMode: 'sender',
    destination: 'portal',
    portalSupplierName: 'Imcopex',
    autoProcess: false,
  },
  {
    name: 'Vodafone',
    senderPattern: 'vodafone',
    subjectPattern: 'rechnung|invoice',
    matchMode: 'sender',
    destination: 'odoo',
    odooExpenseAccountCode: '6770',
    autoProcess: false,
  },
  {
    name: 'Rithum',
    senderPattern: 'rithum|channeladviso',
    subjectPattern: 'rechnung|invoice',
    matchMode: 'sender',
    destination: 'odoo',
    odooExpenseAccountCode: '6770',
    autoProcess: false,
  },
  {
    name: 'Anthropic',
    senderPattern: 'anthropic',
    subjectPattern: 'invoice',
    matchMode: 'sender',
    destination: 'odoo',
    odooExpenseAccountCode: '6770',
    autoProcess: false,
  },
];

/**
 * Seed default suppliers if none exist
 */
async function seedSuppliers() {
  const count = await InvoiceSyncSupplier.countDocuments();
  if (count > 0) {
    console.log(`[InvoiceSync] ${count} suppliers already configured, skipping seed`);
    return { seeded: 0, existing: count };
  }

  console.log('[InvoiceSync] Seeding default supplier configurations...');
  let seeded = 0;

  for (const supplier of DEFAULT_SUPPLIERS) {
    try {
      await InvoiceSyncSupplier.create(supplier);
      seeded++;
      console.log(`[InvoiceSync] Seeded: ${supplier.name} → ${supplier.destination}`);
    } catch (err) {
      console.warn(`[InvoiceSync] Failed to seed ${supplier.name}: ${err.message}`);
    }
  }

  console.log(`[InvoiceSync] Seeding complete: ${seeded} suppliers created`);
  return { seeded, existing: 0 };
}

module.exports = {
  seedSuppliers,
  DEFAULT_SUPPLIERS,
};
