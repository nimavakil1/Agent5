#!/usr/bin/env node
// Drops the unique index on CustomerRecord.invoice.phone and recreates it as non-unique (sparse)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const CustomerRecord = require('../src/models/CustomerRecord');

(async () => {
  try {
    await connectDB();
    const col = CustomerRecord.collection;
    const idx = await col.indexes();
    const target = idx.find(i => i.key && i.key['invoice.phone'] === 1);
    if (!target) {
      console.log('[dropUniqueInvoicePhoneIndex] No index on invoice.phone found. Creating non-unique sparse index...');
      await col.createIndex({ 'invoice.phone': 1 }, { sparse: true });
      console.log('[dropUniqueInvoicePhoneIndex] Created non-unique sparse index.');
    } else {
      const name = target.name;
      const wasUnique = !!target.unique;
      console.log(`[dropUniqueInvoicePhoneIndex] Found index ${name} (unique=${wasUnique}). Dropping...`);
      await col.dropIndex(name);
      console.log('[dropUniqueInvoicePhoneIndex] Dropped. Re-creating as non-unique sparse index...');
      await col.createIndex({ 'invoice.phone': 1 }, { sparse: true });
      console.log('[dropUniqueInvoicePhoneIndex] Recreated non-unique sparse index on invoice.phone');
    }
  } catch (e) {
    console.error('[dropUniqueInvoicePhoneIndex] error', e);
    process.exit(1);
  } finally {
    try { await mongoose.connection.close(); } catch(_) {}
  }
})();

