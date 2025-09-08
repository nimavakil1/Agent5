const express = require('express');
const { forceRecreateAdmin } = require('../../util/ensureAdmin');
const User = require('../../models/User');

const router = express.Router();

// Emergency admin recovery - only works if no admin users exist
router.post('/admin-recovery', async (req, res) => {
  try {
    // Security check: only allow if no admin users exist at all
    const adminCount = await User.countDocuments({ role: 'admin', active: true });
    
    if (adminCount > 0) {
      return res.status(403).json({ 
        message: 'Admin recovery blocked: Active admin users exist',
        adminCount 
      });
    }
    
    // Force recreate admin
    const result = await forceRecreateAdmin();
    
    res.json({
      message: 'Admin user recreated successfully',
      email: result.user.email,
      role: result.user.role,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Emergency admin recovery failed:', error);
    res.status(500).json({ 
      message: 'Admin recovery failed', 
      error: error.message 
    });
  }
});

// Check admin status
router.get('/admin-status', async (req, res) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    
    if (!adminEmail) {
      return res.json({
        configured: false,
        message: 'ADMIN_EMAIL not configured'
      });
    }
    
    const adminUser = await User.findOne({ email: adminEmail.toLowerCase().trim() });
    const totalAdmins = await User.countDocuments({ role: 'admin', active: true });
    
    res.json({
      configured: true,
      adminEmail,
      adminExists: !!adminUser,
      adminActive: adminUser?.active || false,
      adminRole: adminUser?.role || null,
      totalActiveAdmins: totalAdmins,
      lastLogin: adminUser?.lastLoginAt || null,
      status: adminUser?.active ? 'OK' : 'MISSING_OR_INACTIVE'
    });
    
  } catch (error) {
    console.error('Admin status check failed:', error);
    res.status(500).json({ 
      message: 'Status check failed', 
      error: error.message 
    });
  }
});

module.exports = router;