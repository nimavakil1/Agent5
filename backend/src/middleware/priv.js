const { getPrivilegesForUser } = require('../util/privileges');

function requirePrivilege(required) {
  return async function(req, res, next) {
    try {
      const user = req.user || {};
      // Legacy allowance: superadmin/admin string roles keep working (admin gets broad access)
      if (user.role === 'superadmin') return next();
      if (user.role === 'admin' && required !== 'roles.manage') return next();
      const set = await getPrivilegesForUser(user);
      if (set.has(required)) return next();
      return res.status(403).json({ message: 'forbidden' });
    } catch (e) {
      return res.status(500).json({ message: 'error', error: String(e?.message || e) });
    }
  };
}

module.exports = { requirePrivilege };

