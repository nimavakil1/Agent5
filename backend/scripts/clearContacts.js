#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const CustomerRecord = require('../src/models/CustomerRecord');
const DeliveryContact = require('../src/models/DeliveryContact');

(async () => {
  try {
    await connectDB();
    const before = await CustomerRecord.countDocuments();
    const beforeDel = await DeliveryContact.countDocuments();
    console.log(`[clearContacts] CustomerRecord before: ${before}, DeliveryContact before: ${beforeDel}`);
    const res = await CustomerRecord.deleteMany({});
    const resDel = await DeliveryContact.deleteMany({});
    const after = await CustomerRecord.countDocuments();
    const afterDel = await DeliveryContact.countDocuments();
    console.log(`[clearContacts] deleted: parents=${res.deletedCount}, deliveries=${resDel.deletedCount}; remaining parents=${after}, deliveries=${afterDel}`);
  } catch (e) {
    console.error('[clearContacts] error', e);
    process.exit(1);
  } finally {
    try { await mongoose.connection.close(); } catch(_) {}
  }
})();
