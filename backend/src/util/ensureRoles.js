const Role = require('../models/Role');
const { PRIVILEGES } = require('./privileges');

async function ensureDefaultRoles() {
  const defs = [
    { name: 'superadmin', description: 'Full access', privileges: PRIVILEGES, protected: true },
    { name: 'admin', description: 'Admin (no role management)', privileges: PRIVILEGES.filter(p=>p!=='roles.manage'), protected: true },
    { name: 'manager', description: 'Operational manager', privileges: [
      'dashboard.view',
      'campaigns.view','campaigns.create','campaigns.edit','campaigns.control',
      'prospects.view','prospects.upload','prospects.edit','prospects.optout',
      'calls.history.view','calls.recordings.listen',
      'reports.view','products.view','products.manage'
    ], protected: false },
    { name: 'user', description: 'Basic access', privileges: [
      'dashboard.view','campaigns.view','prospects.view','calls.history.view','reports.view','products.view'
    ], protected: false },
  ];
  for (const d of defs) {
    const exists = await Role.findOne({ name: d.name });
    if (!exists) await Role.create(d);
  }
}

module.exports = { ensureDefaultRoles };

