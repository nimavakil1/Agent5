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
    const { name, description, privileges } = req.body || {};
    if (!name || !Array.isArray(privileges)) return res.status(400).json({ message: 'name and privileges required' });
    const role = await Role.create({ name: String(name).trim(), description: description||'', privileges: privileges.filter(Boolean) });
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
    if (role.protected && req.body.privileges && role.name === 'superadmin') {
      return res.status(400).json({ message: 'cannot modify superadmin privileges' });
    }
    const update = {};
    if (req.body.description !== undefined) update.description = String(req.body.description);
    if (Array.isArray(req.body.privileges)) update.privileges = req.body.privileges.filter(Boolean);
    await Role.findByIdAndUpdate(role._id, update);
    const fresh = await Role.findById(role._id);
    res.json(fresh);
  } catch (e) {
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

