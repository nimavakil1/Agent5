#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');

async function main(){
  const email = process.env.EMAIL || process.argv[2];
  const password = process.env.PASSWORD || process.argv[3] || '';
  if (!email) { console.error('Usage: EMAIL=user@example.com PASSWORD=secret node scripts/inspectUser.js'); process.exit(1); }
  const uri = process.env.MONGO_URI; if (!uri) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(uri);
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user) { console.log('No user for', email); process.exit(0); }
  console.log('User:', { id: user._id.toString(), email: user.email, role: user.role, active: user.active, createdAt: user.createdAt, updatedAt: user.updatedAt });
  if (password) {
    const ok = await bcrypt.compare(password, user.passwordHash);
    console.log('Password compare:', ok);
  } else {
    console.log('Password hash (first 12):', user.passwordHash?.slice(0, 12) + '...');
  }
  await mongoose.disconnect();
}
main().catch(e=>{ console.error(e); process.exit(1); });

