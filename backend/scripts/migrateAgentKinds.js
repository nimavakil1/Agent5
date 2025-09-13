#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const AgentProfile = require('../src/models/AgentProfile');

(async () => {
  try {
    await connectDB();
    const res = await AgentProfile.updateMany(
      { $or: [ { kind: { $exists: false } }, { kind: null } ] },
      { $set: { kind: 'call' } }
    );
    console.log(`[migrateAgentKinds] matched=${res.matchedCount||res.n||0} modified=${res.modifiedCount||res.nModified||0}`);
  } catch (e) {
    console.error('[migrateAgentKinds] error', e);
    process.exit(1);
  } finally {
    try { await mongoose.connection.close(); } catch(_) {}
  }
})();

