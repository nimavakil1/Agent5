#!/usr/bin/env node
/**
 * Emergency Admin Recovery Script
 * 
 * This script forcefully recreates the admin user if they get lost/deleted
 * Usage: node scripts/fix-admin.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { forceRecreateAdmin } = require('../src/util/ensureAdmin');

async function main() {
  try {
    console.log('🔧 Starting admin recovery...');
    
    // Connect to database
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGO_URI environment variable is required');
    }
    
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to database');
    
    // Force recreate admin
    const result = await forceRecreateAdmin();
    console.log('✅ Admin user recreated successfully');
    console.log(`📧 Email: ${result.user.email}`);
    console.log(`👤 Role: ${result.user.role}`);
    console.log('');
    console.log('🎉 You can now login with your ADMIN_EMAIL and ADMIN_PASSWORD');
    
  } catch (error) {
    console.error('❌ Admin recovery failed:', error.message);
    console.log('');
    console.log('💡 Make sure these environment variables are set:');
    console.log('   - MONGO_URI');
    console.log('   - ADMIN_EMAIL');
    console.log('   - ADMIN_PASSWORD');
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database');
  }
}

main();