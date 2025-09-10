const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function ensureAdmin() {
  try {
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || '';
    const desiredRole = (process.env.ADMIN_ROLE || 'superadmin').toLowerCase() === 'superadmin' ? 'superadmin' : 'admin';
    
    if (!email || !password) {
      console.warn('[auth] ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping admin check');
      return { created: false, reason: 'missing env' };
    }

    // Check if the specific admin user exists
    let adminUser = await User.findOne({ email: email });
    
    if (adminUser) {
      // Admin user exists - ensure they have admin role and are active
      let updated = false;
      // escalate to superadmin if desired
      if (desiredRole === 'superadmin' && adminUser.role !== 'superadmin') {
        adminUser.role = 'superadmin';
        updated = true;
      } else if (adminUser.role !== 'admin' && desiredRole === 'admin') {
        adminUser.role = 'admin';
        updated = true;
      }
      if (!adminUser.active) {
        adminUser.active = true;
        updated = true;
      }
      
      if (updated) {
        await adminUser.save();
        console.log('[auth] Updated existing admin user:', email);
        return { created: false, updated: true };
      } else {
        console.log('[auth] Admin user already exists and is properly configured:', email);
        return { created: false, exists: true };
      }
    } else {
      // Admin user doesn't exist - create it
      const passwordHash = await bcrypt.hash(password, 10);
      await User.create({ 
        email, 
        passwordHash, 
        role: desiredRole, 
        active: true,
        createdAt: new Date(),
        lastLoginAt: null
      });
      console.log('[auth] Created admin user:', email);
      return { created: true };
    }
  } catch (e) {
    console.error('[auth] ensureAdmin failed:', e?.message || e);
    return { created: false, error: true, message: e?.message };
  }
}

// Additional function to force recreate admin (for emergency recovery)
async function forceRecreateAdmin() {
  try {
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || '';
    const desiredRole = (process.env.ADMIN_ROLE || 'superadmin').toLowerCase() === 'superadmin' ? 'superadmin' : 'admin';
    
    if (!email || !password) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required');
    }

    // Delete existing admin user if exists
    await User.deleteOne({ email: email });
    
    // Create new admin user
    const passwordHash = await bcrypt.hash(password, 10);
    const newAdmin = await User.create({ 
      email, 
      passwordHash, 
      role: desiredRole, 
      active: true,
      createdAt: new Date(),
      lastLoginAt: null
    });
    
    console.log('[auth] Force recreated admin user:', email);
    return { success: true, user: { email: newAdmin.email, role: newAdmin.role } };
  } catch (e) {
    console.error('[auth] forceRecreateAdmin failed:', e?.message || e);
    throw e;
  }
}

module.exports = ensureAdmin;
module.exports.forceRecreateAdmin = forceRecreateAdmin;
