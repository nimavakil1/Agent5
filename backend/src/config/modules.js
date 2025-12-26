/**
 * Agent5 Module Registry
 *
 * Central configuration for all platform modules.
 * Used by both frontend (navigation, permissions) and backend (API authorization).
 */

const MODULES = {
  'ai-agents': {
    id: 'ai-agents',
    name: 'AI Agents',
    icon: 'smart_toy',
    color: '#6366f1',
    description: 'Chat with AI agents, train models, orchestrate workflows',
    order: 1,
    pages: [
      { id: 'console', path: '/test/app/ai/console', name: 'Agent Console', icon: 'chat', default: true },
      { id: 'studio', path: '/test/app/ai/studio', name: 'Agent Studio', icon: 'psychology' },
      { id: 'training', path: '/test/app/ai/training', name: 'AI Training', icon: 'school' },
      { id: 'orchestrator', path: '/test/app/ai/orchestrator', name: 'Orchestrator', icon: 'account_tree' }
    ],
    notifications: {
      endpoint: '/api/ai/notifications',
      refreshInterval: 60000
    },
    actions: [
      { id: 'chat', name: 'Chat with agents', description: 'Use the agent console' },
      { id: 'train', name: 'Train AI', description: 'Add training data and fine-tune' },
      { id: 'deploy', name: 'Deploy agents', description: 'Deploy agents to production' },
      { id: 'configure', name: 'Configure agents', description: 'Modify agent settings and prompts' }
    ]
  },

  'call-center': {
    id: 'call-center',
    name: 'Call Center',
    icon: 'headset_mic',
    color: '#22c55e',
    description: 'Voice AI calls, campaigns, and contact management',
    order: 2,
    pages: [
      { id: 'calls', path: '/test/app/calls/', name: 'Call Center', icon: 'call', default: true },
      { id: 'campaigns', path: '/test/app/calls/campaigns', name: 'Campaigns', icon: 'campaign' },
      { id: 'contacts', path: '/test/app/calls/contacts', name: 'Contacts', icon: 'contacts' },
      { id: 'review', path: '/test/app/calls/review', name: 'Call Review', icon: 'rate_review' }
    ],
    notifications: {
      endpoint: '/api/calls/notifications',
      refreshInterval: 30000
    },
    actions: [
      { id: 'make_call', name: 'Make calls', description: 'Initiate outbound calls' },
      { id: 'manage_campaigns', name: 'Manage campaigns', description: 'Create and edit campaigns' },
      { id: 'manage_contacts', name: 'Manage contacts', description: 'Add and edit contacts' },
      { id: 'review_calls', name: 'Review calls', description: 'Listen to and rate calls' }
    ]
  },

  'amazon-seller': {
    id: 'amazon-seller',
    name: 'Amazon Seller',
    icon: 'storefront',
    color: '#f59e0b',
    description: 'Seller Central orders, settlements, and reports',
    order: 3,
    pages: [
      { id: 'orders', path: '/test/app/seller/', name: 'Orders', icon: 'shopping_cart', default: true },
      { id: 'settlements', path: '/test/app/seller/settlements', name: 'Settlements', icon: 'account_balance' },
      { id: 'vcs', path: '/test/app/seller/vcs', name: 'VCS Reports', icon: 'receipt_long' },
      { id: 'reports', path: '/test/app/seller/reports', name: 'Upload Reports', icon: 'upload_file' }
    ],
    notifications: {
      endpoint: '/api/amazon/notifications',
      refreshInterval: 60000
    },
    actions: [
      { id: 'view_orders', name: 'View orders', description: 'See Amazon orders' },
      { id: 'upload_reports', name: 'Upload reports', description: 'Upload settlement/VCS reports' },
      { id: 'create_invoices', name: 'Create invoices', description: 'Generate Odoo invoices from VCS' }
    ]
  },

  'amazon-vendor': {
    id: 'amazon-vendor',
    name: 'Amazon Vendor',
    icon: 'local_shipping',
    color: '#f97316',
    description: 'Vendor Central purchase orders, invoices, and shipments',
    order: 4,
    pages: [
      { id: 'orders', path: '/test/app/vendor/', name: 'Purchase Orders', icon: 'receipt_long', default: true },
      { id: 'invoices', path: '/test/app/vendor/invoices', name: 'Invoices', icon: 'description' },
      { id: 'shipments', path: '/test/app/vendor/shipments', name: 'Shipments', icon: 'local_shipping' },
      { id: 'settings', path: '/test/app/vendor/settings', name: 'Settings', icon: 'settings' }
    ],
    notifications: {
      endpoint: '/api/vendor/notifications',
      refreshInterval: 60000
    },
    actions: [
      { id: 'view_pos', name: 'View POs', description: 'See purchase orders' },
      { id: 'acknowledge_po', name: 'Acknowledge POs', description: 'Send acknowledgments to Amazon' },
      { id: 'create_order', name: 'Create Odoo orders', description: 'Create sale orders in Odoo' },
      { id: 'submit_invoice', name: 'Submit invoices', description: 'Submit invoices to Amazon' },
      { id: 'create_shipment', name: 'Create shipments', description: 'Create ASN/shipment confirmations' },
      { id: 'manage_mappings', name: 'Manage party mappings', description: 'Configure party ID mappings' }
    ]
  },

  'inventory': {
    id: 'inventory',
    name: 'Inventory',
    icon: 'inventory_2',
    color: '#8b5cf6',
    description: 'Products, purchasing intelligence, and stock optimization',
    order: 5,
    pages: [
      { id: 'products', path: '/test/app/inventory/', name: 'Products', icon: 'category', default: true },
      { id: 'purchasing', path: '/test/app/inventory/purchasing', name: 'Purchasing', icon: 'shopping_cart' },
      { id: 'optimization', path: '/test/app/inventory/optimization', name: 'Stock Optimization', icon: 'trending_up' }
    ],
    notifications: {
      endpoint: '/api/inventory/notifications',
      refreshInterval: 120000
    },
    actions: [
      { id: 'view_products', name: 'View products', description: 'See product catalog' },
      { id: 'purchasing_suggestions', name: 'View purchasing suggestions', description: 'See AI-powered purchase recommendations' },
      { id: 'create_po', name: 'Create purchase orders', description: 'Create supplier POs in Odoo' }
    ]
  },

  'accounting': {
    id: 'accounting',
    name: 'Accounting',
    icon: 'account_balance',
    color: '#14b8a6',
    description: 'VCS invoicing, remittances, and chargebacks',
    order: 6,
    pages: [
      { id: 'invoicing', path: '/test/app/accounting/', name: 'VCS Invoicing', icon: 'receipt', default: true },
      { id: 'remittances', path: '/test/app/accounting/remittances', name: 'Remittances', icon: 'payments' },
      { id: 'chargebacks', path: '/test/app/accounting/chargebacks', name: 'Chargebacks', icon: 'money_off' }
    ],
    notifications: {
      endpoint: '/api/accounting/notifications',
      refreshInterval: 300000
    },
    actions: [
      { id: 'view_invoices', name: 'View invoices', description: 'See invoice status' },
      { id: 'create_invoices', name: 'Create invoices', description: 'Generate Odoo invoices' },
      { id: 'reconcile', name: 'Reconcile payments', description: 'Match remittances to invoices' }
    ]
  },

  'analytics': {
    id: 'analytics',
    name: 'Analytics',
    icon: 'analytics',
    color: '#ec4899',
    description: 'Dashboards, reports, and KPIs',
    order: 7,
    pages: [
      { id: 'dashboard', path: '/test/app/analytics/', name: 'Dashboard', icon: 'dashboard', default: true },
      { id: 'reports', path: '/test/app/analytics/reports', name: 'Reports', icon: 'summarize' },
      { id: 'kpis', path: '/test/app/analytics/kpis', name: 'KPIs', icon: 'speed' }
    ],
    notifications: null, // No notifications for analytics
    actions: [
      { id: 'view_dashboards', name: 'View dashboards', description: 'See analytics dashboards' },
      { id: 'export_reports', name: 'Export reports', description: 'Download report data' }
    ]
  },

  'settings': {
    id: 'settings',
    name: 'Settings',
    icon: 'settings',
    color: '#64748b',
    description: 'Users, roles, integrations, and system configuration',
    order: 8,
    pages: [
      { id: 'users', path: '/test/app/settings/users', name: 'Users', icon: 'group', default: true },
      { id: 'roles', path: '/test/app/settings/roles', name: 'Roles & Permissions', icon: 'admin_panel_settings' },
      { id: 'integrations', path: '/test/app/settings/integrations', name: 'Integrations', icon: 'hub' },
      { id: 'mcp', path: '/test/app/settings/mcp', name: 'MCP Tools', icon: 'build' },
      { id: 'profile', path: '/test/app/settings/profile', name: 'My Profile', icon: 'person' }
    ],
    notifications: null,
    actions: [
      { id: 'manage_users', name: 'Manage users', description: 'Create, edit, delete users' },
      { id: 'manage_roles', name: 'Manage roles', description: 'Create and configure roles' },
      { id: 'manage_integrations', name: 'Manage integrations', description: 'Configure external integrations' }
    ],
    adminOnly: true // Only visible to admins
  }
};

/**
 * Get all modules as an array, sorted by order
 */
function getModuleList() {
  return Object.values(MODULES).sort((a, b) => a.order - b.order);
}

/**
 * Get a specific module by ID
 */
function getModule(moduleId) {
  return MODULES[moduleId] || null;
}

/**
 * Get all module IDs
 */
function getModuleIds() {
  return Object.keys(MODULES);
}

/**
 * Check if a path belongs to a module and return the module
 */
function getModuleByPath(path) {
  for (const module of Object.values(MODULES)) {
    for (const page of module.pages) {
      if (path.startsWith(page.path)) {
        return module;
      }
    }
  }
  return null;
}

/**
 * Get the default page for a module
 */
function getDefaultPage(moduleId) {
  const module = MODULES[moduleId];
  if (!module) return null;
  return module.pages.find(p => p.default) || module.pages[0];
}

module.exports = {
  MODULES,
  getModuleList,
  getModule,
  getModuleIds,
  getModuleByPath,
  getDefaultPage
};
