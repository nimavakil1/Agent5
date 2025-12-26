const Role = require('../models/Role');
const { AVAILABLE_MODULES } = require('../models/Role');

// Canonical privilege list grouped by module for UI; backend uses flat strings
const PRIVILEGES = [
  'dashboard.view',
  'campaigns.view','campaigns.create','campaigns.edit','campaigns.control','campaigns.delete',
  'prospects.view','prospects.upload','prospects.edit','prospects.optout','prospects.fields',
  'calls.history.view','calls.recordings.listen','calls.recordings.delete',
  'reports.view',
  'products.view','products.manage',
  'settings.view','settings.manage',
  'users.view','users.manage',
  'roles.view','roles.manage',
  'costs.view',
  'notifications.view','notifications.manage',
  'orchestrator.view','orchestrator.manage',
];

// Legacy role string -> implied privileges
const LEGACY_MAP = {
  superadmin: new Set(PRIVILEGES),
  admin: new Set(PRIVILEGES.filter(p => p !== 'roles.manage')), // admins can view roles but not manage superadmin-level
  manager: new Set([
    'dashboard.view',
    'campaigns.view','campaigns.create','campaigns.edit','campaigns.control',
    'prospects.view','prospects.upload','prospects.edit','prospects.optout',
    'calls.history.view','calls.recordings.listen',
    'reports.view','products.view','products.manage'
  ]),
  user: new Set(['dashboard.view','campaigns.view','prospects.view','calls.history.view','reports.view','products.view'])
};

const roleCache = new Map(); // roleId -> {privileges:Set, at:number}
const TTL_MS = 60 * 1000;

async function getPrivilegesForUser(user) {
  // Superadmin shortcut
  if (user?.role === 'superadmin') return new Set(PRIVILEGES);
  // If roleId present, load role privileges with cache
  if (user?.roleId) {
    const key = String(user.roleId);
    const now = Date.now();
    const cached = roleCache.get(key);
    if (cached && (now - cached.at) < TTL_MS) return cached.privileges;
    const role = await Role.findById(user.roleId).lean();
    const set = new Set(role?.privileges || []);
    roleCache.set(key, { privileges: set, at: now });
    return set;
  }
  // Fall back to legacy role mapping
  const set = LEGACY_MAP[user?.role || 'user'] || LEGACY_MAP.user;
  return new Set(set);
}

function listAllPrivileges() { return PRIVILEGES.slice(); }

// Module access cache
const moduleCache = new Map(); // roleId -> {modules:string[], at:number}

/**
 * Get modules a user has access to
 * @param {Object} user - User object with role and roleId
 * @returns {Promise<string[]>} Array of module IDs
 */
async function getModuleAccessForUser(user) {
  // Superadmin has access to all modules
  if (user?.role === 'superadmin') return AVAILABLE_MODULES.slice();

  // If roleId present, load role's moduleAccess with cache
  if (user?.roleId) {
    const key = String(user.roleId);
    const now = Date.now();
    const cached = moduleCache.get(key);
    if (cached && (now - cached.at) < TTL_MS) return cached.modules;

    const role = await Role.findById(user.roleId).lean();
    const modules = role?.moduleAccess || [];
    moduleCache.set(key, { modules, at: now });
    return modules;
  }

  // Legacy role mapping - admin gets all, others get none
  if (user?.role === 'admin') return AVAILABLE_MODULES.slice();

  // Default: no access (must be explicitly granted)
  return [];
}

/**
 * Check if user has access to a specific module
 * @param {Object} user - User object
 * @param {string} moduleId - Module ID to check
 * @returns {Promise<boolean>}
 */
async function hasModuleAccess(user, moduleId) {
  const modules = await getModuleAccessForUser(user);
  return modules.includes(moduleId);
}

function listAllModules() { return AVAILABLE_MODULES.slice(); }

module.exports = {
  getPrivilegesForUser,
  listAllPrivileges,
  PRIVILEGES,
  getModuleAccessForUser,
  hasModuleAccess,
  listAllModules,
  AVAILABLE_MODULES
};

