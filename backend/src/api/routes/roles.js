const express = require('express');
const Role = require('../../models/Role');
const User = require('../../models/User');
const { listAllPrivileges } = require('../../util/privileges');
const { requirePrivilege } = require('../../middleware/priv');

const router = express.Router();

// List roles
router.get('/', requirePrivilege('roles.view'), async (req, res) => {
  const roles = await Role.find({}).sort({ protected: -1, name: 1 }).lean();
  // include user counts
  const ids = roles.map(r=>r._id);
  const counts = await User.aggregate([ { $match: { roleId: { $in: ids } } }, { $group: { _id: '$roleId', c: { $sum: 1 } } } ]);
  const map = new Map(counts.map(x=>[String(x._id), x.c]));
  res.json(roles.map(r=> ({...r, users: map.get(String(r._id)) || 0 })));
});

// Available privileges
router.get('/privileges/list', requirePrivilege('roles.view'), async (req, res) => {
  res.json(listAllPrivileges());
});

// Create role
router.post('/', requirePrivilege('roles.manage'), async (req, res) => {
  try {
    const { name, description, privileges, moduleAccess } = req.body || {};
    if (!name || !Array.isArray(privileges)) return res.status(400).json({ message: 'name and privileges required' });
    const roleData = {
      name: String(name).trim(),
      description: description || '',
      privileges: privileges.filter(Boolean),
      moduleAccess: Array.isArray(moduleAccess) ? moduleAccess.filter(Boolean) : []
    };
    const role = await Role.create(roleData);
    res.status(201).json(role);
  } catch (e) {
    if (String(e.message||'').includes('duplicate key')) return res.status(409).json({ message: 'role exists' });
    res.status(500).json({ message: 'error', error: e.message });
  }
});

// Update role
router.put('/:id', requirePrivilege('roles.manage'), async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'not found' });

    console.log('=== ROLE UPDATE DEBUG ===');
    console.log('Role ID:', req.params.id);
    console.log('Role name:', role.name);
    console.log('Role protected:', role.protected);
    console.log('Current moduleAccess:', role.moduleAccess);
    console.log('Incoming body:', JSON.stringify(req.body, null, 2));

    // Block modifying superadmin privileges (but allow moduleAccess changes)
    if (role.name === 'superadmin' && req.body.privileges) {
      // Only block if privileges are actually being changed
      const currentPrivs = JSON.stringify([...role.privileges].sort());
      const newPrivs = JSON.stringify([...req.body.privileges].sort());
      if (currentPrivs !== newPrivs) {
        return res.status(400).json({ message: 'cannot modify superadmin privileges' });
      }
    }
    const update = {};
    if (req.body.description !== undefined) update.description = String(req.body.description);
    if (Array.isArray(req.body.privileges)) update.privileges = req.body.privileges.filter(Boolean);
    if (Array.isArray(req.body.moduleAccess)) update.moduleAccess = req.body.moduleAccess.filter(Boolean);

    console.log('Update object:', JSON.stringify(update, null, 2));

    await Role.findByIdAndUpdate(role._id, update);
    const fresh = await Role.findById(role._id);

    console.log('After save moduleAccess:', fresh.moduleAccess);
    console.log('=== END ROLE UPDATE DEBUG ===');

    res.json(fresh);
  } catch (e) {
    console.error('Role update error:', e);
    res.status(500).json({ message: 'error', error: e.message });
  }
});

// Delete role
router.delete('/:id', requirePrivilege('roles.manage'), async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'not found' });
    if (role.protected) return res.status(400).json({ message: 'cannot delete protected role' });
    const count = await User.countDocuments({ roleId: role._id });
    if (count > 0) return res.status(400).json({ message: 'role in use' });
    await Role.findByIdAndDelete(role._id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: 'error', error: e.message });
  }
});

module.exports = router;

