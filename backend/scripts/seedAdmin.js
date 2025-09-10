#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const validateEnv = require('../src/config/validateEnv');

async function main(){
  const email = process.env.ADMIN_EMAIL || process.argv[2];
  const password = process.env.ADMIN_PASSWORD || process.argv[3];
  const desiredRole = (process.env.ADMIN_ROLE || 'superadmin').toLowerCase() === 'superadmin' ? 'superadmin' : 'admin';
  if (!email || !password) {
    console.error('Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seedAdmin.js');
    process.exit(1);
  }
  if (process.env.NODE_ENV !== 'test') {
    try { validateEnv(); } catch (_) {}
  }
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(uri);
  const exists = await User.findOne({ email: String(email).toLowerCase() });
  const passwordHash = await bcrypt.hash(password, 10);
  if (exists) {
    if (process.env.FORCE_RESET === '1') {
      const role = exists.role === 'superadmin' ? 'superadmin' : desiredRole;
      await User.updateOne({ _id: exists._id }, { $set: { passwordHash, role, active: true } });
      console.log('Admin password reset for:', email);
    } else {
      // escalate role if needed
      if (desiredRole === 'superadmin' && exists.role !== 'superadmin') {
        await User.updateOne({ _id: exists._id }, { $set: { role: 'superadmin', active: true } });
        console.log('User existed; escalated to superadmin:', email);
      } else {
        console.log('User already exists');
      }
    }
  } else {
    await User.create({ email: String(email).toLowerCase(), passwordHash, role: desiredRole, active: true });
    console.log('Admin user created:', email);
  }
  await mongoose.disconnect();
}
main().catch(e=>{ console.error(e); process.exit(1); });
