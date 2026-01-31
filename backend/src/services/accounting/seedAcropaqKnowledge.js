/**
 * Seed Acropaq Tax Knowledge
 *
 * Pre-loads essential knowledge about Acropaq's complex EU tax structure
 * into the AccountingKnowledge collection.
 *
 * Run: node -e "require('./backend/src/services/accounting/seedAcropaqKnowledge').seedAll()"
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB if not already connected
async function ensureConnection() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
  }
}

const AccountingKnowledge = require('../../models/AccountingKnowledge');

/**
 * Acropaq Tax Knowledge Entries
 */
const ACROPAQ_KNOWLEDGE = [
  // ===== COMPANY OVERVIEW =====
  {
    category: 'general',
    subject: 'Acropaq Company Overview',
    fact: 'Acropaq is a Belgian e-commerce company based in Zaventem, specializing in office supplies and accessories. Sells B2B and B2C through own webshop, Amazon (multiple EU marketplaces), and Bol.com. Uses Odoo 16 (hosted on odoo.sh) as ERP system.',
    priority: 100,
    tags: ['company', 'overview'],
  },

  // ===== WAREHOUSE LOCATIONS =====
  {
    category: 'warehouse',
    subject: 'Belgium Warehouse',
    fact: 'Main warehouse located in Zaventem, Belgium. This is the primary fulfillment center and company headquarters. Shipments from here follow Belgian VAT rules unless OSS applies for EU B2C.',
    structuredData: { country: 'BE', city: 'Zaventem', type: 'owned', primary: true },
    priority: 90,
    tags: ['warehouse', 'belgium', 'primary'],
  },
  {
    category: 'warehouse',
    subject: 'Germany FBA Warehouse',
    fact: 'Amazon FBA warehouse(s) in Germany. Stock stored here for Amazon.de and pan-EU FBA. Shipments from DE warehouse to German customers use German VAT (19%). Cross-border from DE uses local VAT or OSS rules.',
    structuredData: { country: 'DE', type: 'amazon_fba', vatRate: 19 },
    priority: 85,
    tags: ['warehouse', 'germany', 'fba', 'amazon'],
  },
  {
    category: 'warehouse',
    subject: 'France FBA Warehouse',
    fact: 'Amazon FBA warehouse(s) in France. Stock stored here for Amazon.fr. Shipments from FR warehouse to French customers use French VAT (20%).',
    structuredData: { country: 'FR', type: 'amazon_fba', vatRate: 20 },
    priority: 85,
    tags: ['warehouse', 'france', 'fba', 'amazon'],
  },
  {
    category: 'warehouse',
    subject: 'Poland FBA Warehouse',
    fact: 'Amazon FBA warehouse(s) in Poland. Pan-EU FBA storage location. Polish VAT rate is 23%.',
    structuredData: { country: 'PL', type: 'amazon_fba', vatRate: 23 },
    priority: 85,
    tags: ['warehouse', 'poland', 'fba', 'amazon'],
  },
  {
    category: 'warehouse',
    subject: 'Czech Republic FBA Warehouse',
    fact: 'Amazon FBA warehouse(s) in Czech Republic. Pan-EU FBA storage location. Czech VAT rate is 21%.',
    structuredData: { country: 'CZ', type: 'amazon_fba', vatRate: 21 },
    priority: 85,
    tags: ['warehouse', 'czech', 'fba', 'amazon'],
  },
  {
    category: 'warehouse',
    subject: 'Spain FBA Warehouse',
    fact: 'Amazon FBA warehouse(s) in Spain. Stock stored here for Amazon.es. Spanish VAT rate is 21%.',
    structuredData: { country: 'ES', type: 'amazon_fba', vatRate: 21 },
    priority: 85,
    tags: ['warehouse', 'spain', 'fba', 'amazon'],
  },
  {
    category: 'warehouse',
    subject: 'Italy FBA Warehouse',
    fact: 'Amazon FBA warehouse(s) in Italy. Stock stored here for Amazon.it. Italian VAT rate is 22%.',
    structuredData: { country: 'IT', type: 'amazon_fba', vatRate: 22 },
    priority: 85,
    tags: ['warehouse', 'italy', 'fba', 'amazon'],
  },

  // ===== VAT RATES BY COUNTRY =====
  {
    category: 'country_vat',
    subject: 'Belgium VAT Rates',
    fact: 'Belgium has standard VAT rate of 21%, reduced rates of 12% (certain goods/services) and 6% (basic necessities, books). Most office supplies use 21%.',
    structuredData: { country: 'BE', standard: 21, reduced: [12, 6] },
    priority: 95,
    tags: ['vat', 'belgium', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'Germany VAT Rates',
    fact: 'Germany has standard VAT rate of 19%, reduced rate of 7% (food, books, newspapers). Office supplies typically 19%.',
    structuredData: { country: 'DE', standard: 19, reduced: [7] },
    priority: 95,
    tags: ['vat', 'germany', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'France VAT Rates',
    fact: 'France has standard VAT rate of 20%, reduced rates of 10% and 5.5% (food, books). Office supplies typically 20%.',
    structuredData: { country: 'FR', standard: 20, reduced: [10, 5.5] },
    priority: 95,
    tags: ['vat', 'france', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'Netherlands VAT Rates',
    fact: 'Netherlands has standard VAT rate of 21%, reduced rate of 9% (food, books, medicines). Office supplies typically 21%.',
    structuredData: { country: 'NL', standard: 21, reduced: [9] },
    priority: 95,
    tags: ['vat', 'netherlands', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'Spain VAT Rates',
    fact: 'Spain has standard VAT rate of 21%, reduced rates of 10% and 4% (super-reduced). Office supplies typically 21%.',
    structuredData: { country: 'ES', standard: 21, reduced: [10, 4] },
    priority: 95,
    tags: ['vat', 'spain', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'Italy VAT Rates',
    fact: 'Italy has standard VAT rate of 22%, reduced rates of 10%, 5%, and 4%. Office supplies typically 22%.',
    structuredData: { country: 'IT', standard: 22, reduced: [10, 5, 4] },
    priority: 95,
    tags: ['vat', 'italy', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'Poland VAT Rates',
    fact: 'Poland has standard VAT rate of 23%, reduced rates of 8% and 5%. Office supplies typically 23%.',
    structuredData: { country: 'PL', standard: 23, reduced: [8, 5] },
    priority: 95,
    tags: ['vat', 'poland', 'rates'],
  },
  {
    category: 'country_vat',
    subject: 'Czech Republic VAT Rates',
    fact: 'Czech Republic has standard VAT rate of 21%, reduced rates of 15% and 12%. Office supplies typically 21%.',
    structuredData: { country: 'CZ', standard: 21, reduced: [15, 12] },
    priority: 95,
    tags: ['vat', 'czech', 'rates'],
  },

  // ===== TAX RULES =====
  {
    category: 'tax_rule',
    subject: 'OSS (One-Stop-Shop) Overview',
    fact: 'Acropaq uses the EU OSS (One-Stop-Shop) scheme for B2C distance selling. All EU B2C sales are declared through the Belgian OSS return. Must track sales by destination country and apply that country\'s VAT rate. OSS simplifies VAT compliance by allowing single return in Belgium for all EU B2C sales.',
    priority: 100,
    tags: ['oss', 'b2c', 'eu', 'vat'],
  },
  {
    category: 'tax_rule',
    subject: 'B2C Sales - Same Country as Warehouse',
    fact: 'When shipping B2C from a warehouse to a customer in the SAME country (e.g., DE warehouse to German consumer), apply the local VAT of that country. This is a domestic sale in that country.',
    priority: 95,
    tags: ['b2c', 'domestic', 'vat'],
  },
  {
    category: 'tax_rule',
    subject: 'B2C Sales - Cross-Border (Belgium Origin)',
    fact: 'When shipping B2C from Belgium warehouse to another EU country consumer, use OSS. Charge destination country VAT rate and report via Belgian OSS return.',
    priority: 95,
    tags: ['b2c', 'cross-border', 'oss', 'belgium'],
  },
  {
    category: 'tax_rule',
    subject: 'B2C Sales - Cross-Border (Foreign Warehouse Origin)',
    fact: 'When shipping B2C from a foreign warehouse (e.g., Germany) to a consumer in a DIFFERENT EU country, this is also a distance sale. Use OSS with destination country VAT rate.',
    priority: 95,
    tags: ['b2c', 'cross-border', 'oss', 'foreign'],
  },
  {
    category: 'tax_rule',
    subject: 'B2B Intra-Community Sales',
    fact: 'B2B sales to businesses with valid VAT numbers in other EU countries are intra-community supplies. Apply 0% VAT with reverse charge mechanism. MUST verify VAT number via VIES before applying 0%.',
    priority: 100,
    tags: ['b2b', 'intra-community', 'reverse-charge', 'vat'],
  },
  {
    category: 'tax_rule',
    subject: 'VAT Number Verification',
    fact: 'Before applying 0% VAT on B2B intra-community sales, ALWAYS verify customer VAT number via VIES (VAT Information Exchange System). Invalid VAT = must charge local VAT.',
    priority: 100,
    tags: ['vat', 'verification', 'vies', 'b2b'],
  },
  {
    category: 'tax_rule',
    subject: 'Amazon Pan-EU FBA Movement',
    fact: 'When Amazon moves stock between FBA warehouses in different EU countries (pan-EU FBA), this is a deemed intra-community supply (movement of own goods). Acropaq must report this as movement in Intrastat and EC Sales List.',
    priority: 90,
    tags: ['amazon', 'fba', 'pan-eu', 'movement'],
  },
  {
    category: 'tax_rule',
    subject: 'Fiscal Representative',
    fact: 'In some EU countries where Acropaq has VAT obligations but no establishment, a fiscal representative may be required. Check country-specific requirements for VAT registration without establishment.',
    priority: 85,
    tags: ['fiscal-rep', 'vat', 'registration'],
  },
  {
    category: 'tax_rule',
    subject: 'Intrastat Reporting',
    fact: 'Acropaq must file Intrastat declarations for intra-EU movements of goods above reporting thresholds. Applies to both sales and stock movements (Amazon FBA transfers). Belgian Intrastat thresholds apply for BE dispatches/arrivals.',
    priority: 85,
    tags: ['intrastat', 'reporting', 'eu'],
  },
  {
    category: 'tax_rule',
    subject: 'EC Sales List',
    fact: 'Acropaq must file EC Sales List (recapitulative statement) reporting B2B intra-community supplies by customer VAT number. Filed with Belgian VAT return.',
    priority: 85,
    tags: ['ec-sales-list', 'b2b', 'reporting'],
  },

  // ===== PEPPOL =====
  {
    category: 'peppol',
    subject: 'PEPPOL Overview',
    fact: 'PEPPOL is the Pan-European Public Procurement Online network for e-invoicing. Belgian B2G (business-to-government) invoices MUST use PEPPOL. PEPPOL uses UBL 2.1 XML format and routes through certified Access Points.',
    priority: 95,
    tags: ['peppol', 'e-invoicing', 'b2g'],
  },
  {
    category: 'peppol',
    subject: 'PEPPOL ID Format',
    fact: 'PEPPOL participant IDs follow format: scheme:identifier. Belgian VAT scheme is 0208, so Belgian company ID is 0208:BE0123456789. Always include country prefix in VAT number for PEPPOL.',
    structuredData: { belgianScheme: '0208', format: 'scheme:identifier' },
    priority: 90,
    tags: ['peppol', 'id', 'format'],
  },
  {
    category: 'peppol',
    subject: 'PEPPOL Tax Categories',
    fact: 'PEPPOL tax category codes: S = Standard rate, Z = Zero rated (exports, some food), E = Exempt (medical, education), AE = Reverse charge (intra-EU B2B), G = Export outside EU. Category must match the actual VAT treatment.',
    structuredData: { S: 'Standard', Z: 'Zero', E: 'Exempt', AE: 'Reverse charge', G: 'Export' },
    priority: 90,
    tags: ['peppol', 'tax', 'categories'],
  },

  // ===== ACCOUNTING RULES =====
  {
    category: 'accounting_rule',
    subject: 'Invoice Booking Currency',
    fact: 'All invoices should be booked in their original currency. Odoo handles multi-currency. For financial reporting, use EUR as functional currency. Exchange rate at invoice date for conversion.',
    priority: 85,
    tags: ['currency', 'booking', 'exchange-rate'],
  },
  {
    category: 'accounting_rule',
    subject: 'Invoice Tolerance',
    fact: 'For matching invoices to purchase orders, allow a tolerance of €0.02 for rounding differences. Amounts within tolerance can be auto-approved. Larger differences require manual review.',
    structuredData: { tolerance: 0.02, currency: 'EUR' },
    priority: 85,
    tags: ['invoice', 'matching', 'tolerance'],
  },
  {
    category: 'accounting_rule',
    subject: 'Approval Thresholds',
    fact: 'Invoice approval thresholds: Under €500 can be auto-approved. €500-€5000 requires manager approval. Over €5000 requires executive approval. New vendors always require manual review regardless of amount.',
    structuredData: { auto: 500, manager: 5000, executive: Infinity },
    priority: 90,
    tags: ['approval', 'threshold', 'invoice'],
  },
  {
    category: 'accounting_rule',
    subject: 'Payment Terms Default',
    fact: 'Default payment terms for suppliers is 30 days unless specific terms are agreed. Always check supplier-specific knowledge for negotiated terms.',
    priority: 80,
    tags: ['payment-terms', 'default'],
  },

  // ===== MARKETPLACE SPECIFICS =====
  {
    category: 'accounting_rule',
    subject: 'Amazon Commission Invoices',
    fact: 'Amazon sends commission invoices (for selling fees, FBA fees, advertising) with reverse charge. These are intra-EU B2B services. Book with 0% VAT and self-assess VAT in Belgium.',
    priority: 90,
    tags: ['amazon', 'commission', 'reverse-charge'],
  },
  {
    category: 'accounting_rule',
    subject: 'Amazon VCS (VAT Calculation Service)',
    fact: 'Amazon provides VCS reports for VAT calculation on marketplace sales. Use VCS data to reconcile VAT on Amazon sales. VCS shows VAT collected by Amazon on behalf of seller for sales to EU consumers.',
    priority: 90,
    tags: ['amazon', 'vcs', 'vat'],
  },
  {
    category: 'accounting_rule',
    subject: 'Bol.com Commission Structure',
    fact: 'Bol.com charges commission and fulfillment fees. Invoices from Bol.com B.V. (Netherlands) are reverse charge within EU. Book with 0% VAT and self-assess.',
    priority: 90,
    tags: ['bol', 'commission', 'reverse-charge'],
  },

  // ===== PROCEDURES =====
  {
    category: 'procedure',
    subject: 'Month-End Closing',
    fact: 'Month-end closing procedure: 1) Reconcile all bank statements 2) Ensure all invoices are booked 3) Review aged payables/receivables 4) Post accruals if needed 5) Generate trial balance 6) Review P&L. Complete by 5th of following month.',
    priority: 85,
    tags: ['month-end', 'closing', 'procedure'],
  },
  {
    category: 'procedure',
    subject: 'VAT Return Filing',
    fact: 'Belgian VAT return is filed monthly by the 20th of the following month. Include domestic sales, intra-EU supplies (EC Sales List), imports, and OSS amounts. OSS return filed quarterly in addition to regular VAT return.',
    priority: 90,
    tags: ['vat-return', 'filing', 'deadline'],
  },
  {
    category: 'procedure',
    subject: 'OSS Return Filing',
    fact: 'OSS return is filed quarterly via Belgian tax portal. Deadline is end of month following the quarter. Report all B2C distance sales by destination country with corresponding VAT rates.',
    priority: 90,
    tags: ['oss', 'return', 'quarterly'],
  },
];

/**
 * Seed all Acropaq knowledge
 */
async function seedAll() {
  await ensureConnection();

  console.log(`Seeding ${ACROPAQ_KNOWLEDGE.length} knowledge entries...`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const entry of ACROPAQ_KNOWLEDGE) {
    try {
      // Check if entry already exists
      const existing = await AccountingKnowledge.findOne({
        category: entry.category,
        subject: entry.subject,
      });

      if (existing) {
        // Update if system default
        if (existing.source?.type === 'system_default') {
          existing.fact = entry.fact;
          existing.structuredData = entry.structuredData;
          existing.tags = entry.tags;
          existing.priority = entry.priority;
          existing.updatedBy = 'seed_script';
          await existing.save();
          updated++;
          console.log(`  Updated: ${entry.subject}`);
        } else {
          skipped++;
          console.log(`  Skipped (user modified): ${entry.subject}`);
        }
      } else {
        // Create new
        await AccountingKnowledge.create({
          ...entry,
          source: { type: 'system_default' },
          createdBy: 'seed_script',
          active: true,
        });
        created++;
        console.log(`  Created: ${entry.subject}`);
      }
    } catch (error) {
      console.error(`  Error with "${entry.subject}": ${error.message}`);
    }
  }

  console.log(`\nSeed complete: ${created} created, ${updated} updated, ${skipped} skipped`);

  // Generate embeddings if embedding service available
  try {
    const { getEmbeddingService } = require('./EmbeddingService');
    const embeddingService = getEmbeddingService();
    console.log('\nUpdating embeddings for new entries...');
    const embeddingCount = await embeddingService.updateMissingEmbeddings(100);
    console.log(`Updated ${embeddingCount} embeddings`);
  } catch (e) {
    console.log('Embedding service not available, skipping embedding generation');
  }
}

/**
 * Clear all system default knowledge (for re-seeding)
 */
async function clearSystemDefaults() {
  await ensureConnection();

  const result = await AccountingKnowledge.deleteMany({
    'source.type': 'system_default',
  });

  console.log(`Cleared ${result.deletedCount} system default entries`);
}

/**
 * List all knowledge categories and counts
 */
async function showStats() {
  await ensureConnection();

  const stats = await AccountingKnowledge.aggregate([
    { $match: { active: true } },
    {
      $group: {
        _id: '$category',
        count: { $sum: 1 },
        systemDefault: {
          $sum: { $cond: [{ $eq: ['$source.type', 'system_default'] }, 1, 0] }
        },
        userTrained: {
          $sum: { $cond: [{ $eq: ['$source.type', 'user_training'] }, 1, 0] }
        },
      }
    },
    { $sort: { count: -1 } },
  ]);

  console.log('\nKnowledge Base Statistics:');
  console.log('─'.repeat(60));
  for (const stat of stats) {
    console.log(`${stat._id.padEnd(20)} Total: ${stat.count.toString().padStart(3)}  System: ${stat.systemDefault.toString().padStart(3)}  User: ${stat.userTrained.toString().padStart(3)}`);
  }
  console.log('─'.repeat(60));
  console.log(`Total: ${stats.reduce((sum, s) => sum + s.count, 0)} entries`);
}

module.exports = {
  seedAll,
  clearSystemDefaults,
  showStats,
  ACROPAQ_KNOWLEDGE,
};

// Run if called directly
if (require.main === module) {
  const command = process.argv[2] || 'seed';

  (async () => {
    try {
      if (command === 'seed') {
        await seedAll();
      } else if (command === 'clear') {
        await clearSystemDefaults();
      } else if (command === 'stats') {
        await showStats();
      } else {
        console.log('Usage: node seedAcropaqKnowledge.js [seed|clear|stats]');
      }
      process.exit(0);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  })();
}
