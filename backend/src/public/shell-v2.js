/**
 * Agent5 Shell v2 - Modern Top Bar Navigation
 *
 * Features:
 * - Top bar with logo, breadcrumbs, and user menu
 * - Module-aware sub-navigation
 * - Permission-based visibility
 * - Notification badges
 */
(() => {
  // Skip shell injection when embedded in an iframe
  if (window.self !== window.top) return;

  const BRAND_COLOR = '#6366f1';
  const ACCENT_COLOR = '#8b5cf6';

  // Module registry (mirrors backend config)
  const MODULES = {
    'ai-agents': {
      id: 'ai-agents', name: 'AI Agents', icon: 'smart_toy', color: '#6366f1',
      basePath: '/ai',
      pages: [
        { id: 'console', path: '/ai/', name: 'Console', icon: 'chat' },
        { id: 'studio', path: '/ai/studio', name: 'Studio', icon: 'psychology' },
        { id: 'training', path: '/ai/training', name: 'Training', icon: 'school' },
        { id: 'orchestrator', path: '/ai/orchestrator', name: 'Orchestrator', icon: 'account_tree' }
      ]
    },
    'call-center': {
      id: 'call-center', name: 'Call Center', icon: 'headset_mic', color: '#22c55e',
      basePath: '/calls',
      pages: [
        { id: 'calls', path: '/calls/', name: 'Calls', icon: 'call' },
        { id: 'campaigns', path: '/calls/campaigns', name: 'Campaigns', icon: 'campaign' },
        { id: 'contacts', path: '/calls/contacts', name: 'Contacts', icon: 'contacts' },
        { id: 'review', path: '/calls/review', name: 'Review', icon: 'rate_review' }
      ]
    },
    'amazon-seller': {
      id: 'amazon-seller', name: 'Amazon Seller', icon: 'storefront', color: '#f59e0b',
      basePath: '/seller',
      pages: [
        { id: 'orders', path: '/seller/', name: 'Dashboard', icon: 'dashboard' },
        { id: 'vcs', path: '/seller/vcs.html', name: 'VCS Reports', icon: 'receipt_long' },
        { id: 'settlements', path: '/seller/settlements.html', name: 'Settlements', icon: 'account_balance' },
        { id: 'reports', path: '/seller/reports.html', name: 'Upload Reports', icon: 'upload_file' }
      ]
    },
    'amazon-vendor': {
      id: 'amazon-vendor', name: 'Amazon Vendor', icon: 'local_shipping', color: '#f97316',
      basePath: '/vendor',
      pages: [
        { id: 'orders', path: '/vendor/', name: 'Purchase Orders', icon: 'receipt_long' },
        { id: 'invoices', path: '/vendor/invoices.html', name: 'Invoices', icon: 'description' },
        { id: 'remittances', path: '/vendor/remittances.html', name: 'Remittances', icon: 'payments' },
        { id: 'shipments', path: '/vendor/shipments.html', name: 'Shipments', icon: 'local_shipping' },
        { id: 'settings', path: '/vendor/settings.html', name: 'Settings', icon: 'settings' }
      ]
    },
    'inventory': {
      id: 'inventory', name: 'Inventory', icon: 'inventory_2', color: '#8b5cf6',
      basePath: '/inventory',
      pages: [
        { id: 'products', path: '/inventory/', name: 'Products', icon: 'category' },
        { id: 'purchasing', path: '/inventory/purchasing', name: 'Purchasing', icon: 'shopping_cart' },
        { id: 'optimization', path: '/inventory/optimization', name: 'Optimization', icon: 'trending_up' }
      ]
    },
    'accounting': {
      id: 'accounting', name: 'Accounting', icon: 'account_balance', color: '#14b8a6',
      basePath: '/accounting',
      pages: [
        { id: 'invoicing', path: '/accounting/', name: 'VCS Invoicing', icon: 'receipt' },
        { id: 'remittances', path: '/accounting/remittances', name: 'Remittances', icon: 'payments' },
        { id: 'chargebacks', path: '/accounting/chargebacks', name: 'Chargebacks', icon: 'money_off' }
      ]
    },
    'analytics': {
      id: 'analytics', name: 'Analytics', icon: 'analytics', color: '#ec4899',
      basePath: '/analytics',
      pages: [
        { id: 'dashboard', path: '/analytics/', name: 'Dashboard', icon: 'dashboard' },
        { id: 'reports', path: '/analytics/reports', name: 'Reports', icon: 'summarize' },
        { id: 'kpis', path: '/analytics/kpis', name: 'KPIs', icon: 'speed' }
      ]
    },
    'settings': {
      id: 'settings', name: 'Settings', icon: 'settings', color: '#64748b',
      basePath: '/settings',
      pages: [
        { id: 'users', path: '/settings/', name: 'Users', icon: 'group' },
        { id: 'roles', path: '/settings/roles.html', name: 'Roles', icon: 'admin_panel_settings' },
        { id: 'integrations', path: '/settings/integrations.html', name: 'Integrations', icon: 'hub' },
        { id: 'profile', path: '/settings/profile.html', name: 'Profile', icon: 'person' }
      ],
      adminOnly: true
    }
  };

  let currentUser = null;
  let currentModule = null;
  let currentPage = null;
  let accessibleModules = []; // Module IDs user has access to

  async function getMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  async function getMyModules() {
    try {
      const r = await fetch('/api/auth/me/modules', { credentials: 'include' });
      if (!r.ok) return [];
      const data = await r.json();
      return data.modules || [];
    } catch (_) {
      return [];
    }
  }

  function hasModuleAccess(moduleId) {
    return accessibleModules.includes(moduleId);
  }

  function redirectToLogin(nextUrl) {
    const rawNext = nextUrl || (location.pathname + location.search + location.hash);
    try { sessionStorage.setItem('next_url', rawNext); } catch (_) {}
    const next = encodeURIComponent(rawNext);
    location.href = `/app/login?next=${next}`;
  }

  function ensureIconFont() {
    if (!document.querySelector('link[href*="Material+Symbols"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200';
      document.head.appendChild(l);
    }
  }

  function ensureInterFont() {
    if (!document.querySelector('link[href*="Inter"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap';
      document.head.appendChild(l);
    }
  }

  function detectCurrentModule() {
    const path = location.pathname;
    for (const [id, module] of Object.entries(MODULES)) {
      if (path.startsWith(module.basePath)) {
        currentModule = module;
        // Find current page
        for (const page of module.pages) {
          if (path === page.path || path === page.path + 'index.html' ||
              (page.path.endsWith('/') && path.startsWith(page.path))) {
            currentPage = page;
            break;
          }
        }
        // If no exact match, try to find by path prefix
        if (!currentPage) {
          for (const page of module.pages) {
            if (path.startsWith(page.path.replace(/\/$/, ''))) {
              currentPage = page;
              break;
            }
          }
        }
        return;
      }
    }
    // Home page
    if (path === '/' || path === '/index.html') {
      currentModule = null;
      currentPage = null;
    }
  }

  function isActivePage(pagePath) {
    const path = location.pathname;
    if (pagePath.endsWith('/')) {
      return path === pagePath || path === pagePath + 'index.html' || path === pagePath.slice(0, -1);
    }
    return path === pagePath || path === pagePath + '.html';
  }

  async function injectShell(me) {
    if (document.getElementById('agent5-shell-v2')) return;

    currentUser = me;
    detectCurrentModule();
    ensureIconFont();
    ensureInterFont();

    const shell = document.createElement('div');
    shell.id = 'agent5-shell-v2';

    const isHome = !currentModule;
    const moduleColor = currentModule?.color || BRAND_COLOR;

    shell.innerHTML = `
      <style>
        :root {
          --shell-bg: #0a0a0f;
          --shell-surface: #12121a;
          --shell-border: #1f1f2e;
          --shell-hover: #1a1a28;
          --shell-active: #252536;
          --shell-text: #e4e4e7;
          --shell-muted: #71717a;
          --shell-brand: ${BRAND_COLOR};
          --shell-accent: ${ACCENT_COLOR};
          --shell-module: ${moduleColor};
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          padding: 0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: var(--shell-bg);
          color: var(--shell-text);
          min-height: 100vh;
          padding-top: ${isHome ? '64px' : '112px'} !important;
        }

        /* Top Bar */
        .shell-topbar {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 64px;
          background: var(--shell-surface);
          border-bottom: 1px solid var(--shell-border);
          display: flex;
          align-items: center;
          padding: 0 24px;
          z-index: 1000;
          gap: 24px;
        }

        /* Logo */
        .shell-logo {
          display: flex;
          align-items: center;
          gap: 12px;
          text-decoration: none;
          flex-shrink: 0;
        }

        .shell-logo-icon {
          width: 36px;
          height: 36px;
          background: linear-gradient(135deg, var(--shell-brand), var(--shell-accent));
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .shell-logo-icon .material-symbols-outlined {
          font-size: 22px;
          color: white;
        }

        .shell-logo-text {
          font-size: 18px;
          font-weight: 700;
          color: white;
          letter-spacing: -0.02em;
        }

        /* Breadcrumb */
        .shell-breadcrumb {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
        }

        .shell-breadcrumb-sep {
          color: var(--shell-muted);
          font-size: 18px;
        }

        .shell-breadcrumb-item {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--shell-muted);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          padding: 6px 12px;
          border-radius: 6px;
          transition: all 0.15s;
        }

        .shell-breadcrumb-item:hover {
          color: var(--shell-text);
          background: var(--shell-hover);
        }

        .shell-breadcrumb-item.current {
          color: var(--shell-text);
        }

        .shell-breadcrumb-item .material-symbols-outlined {
          font-size: 20px;
        }

        .shell-module-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 14px 8px;
          background: transparent;
          border: none;
          border-bottom: 2px solid var(--shell-module);
          border-radius: 0;
          color: var(--shell-text);
          font-weight: 600;
          font-size: 14px;
        }

        .shell-module-badge .material-symbols-outlined {
          font-size: 20px;
        }

        /* User Menu */
        .shell-user-area {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-shrink: 0;
        }

        .shell-notifications {
          position: relative;
          width: 40px;
          height: 40px;
          border-radius: 10px;
          background: var(--shell-hover);
          border: 1px solid var(--shell-border);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: var(--shell-muted);
          transition: all 0.15s;
        }

        .shell-notifications:hover {
          background: var(--shell-active);
          color: var(--shell-text);
        }

        .shell-notifications .material-symbols-outlined {
          font-size: 22px;
        }

        .shell-notifications-badge {
          position: absolute;
          top: -4px;
          right: -4px;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          background: #ef4444;
          color: white;
          font-size: 11px;
          font-weight: 600;
          border-radius: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .shell-user-menu {
          position: relative;
        }

        .shell-user-btn {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 12px 6px 6px;
          background: var(--shell-hover);
          border: 1px solid var(--shell-border);
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .shell-user-btn:hover {
          background: var(--shell-active);
          border-color: var(--shell-muted);
        }

        .shell-avatar {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          background: linear-gradient(135deg, #3b82f6, #8b5cf6);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 600;
          color: white;
          overflow: hidden;
        }

        .shell-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .shell-user-info {
          text-align: left;
        }

        .shell-user-email {
          font-size: 13px;
          font-weight: 500;
          color: var(--shell-text);
          max-width: 150px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .shell-user-role {
          font-size: 11px;
          color: var(--shell-muted);
          text-transform: capitalize;
        }

        .shell-user-dropdown {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: 200px;
          background: var(--shell-surface);
          border: 1px solid var(--shell-border);
          border-radius: 12px;
          padding: 8px;
          display: none;
          z-index: 1001;
          box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        }

        .shell-user-dropdown.open {
          display: block;
        }

        .shell-dropdown-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 8px;
          color: var(--shell-text);
          text-decoration: none;
          font-size: 13px;
          font-weight: 500;
          transition: all 0.15s;
          cursor: pointer;
          border: none;
          background: none;
          width: 100%;
          text-align: left;
        }

        .shell-dropdown-item:hover {
          background: var(--shell-hover);
        }

        .shell-dropdown-item .material-symbols-outlined {
          font-size: 20px;
          color: var(--shell-muted);
        }

        .shell-dropdown-item.danger {
          color: #ef4444;
        }

        .shell-dropdown-item.danger .material-symbols-outlined {
          color: #ef4444;
        }

        .shell-dropdown-divider {
          height: 1px;
          background: var(--shell-border);
          margin: 8px 0;
        }

        /* Module Sub-Nav */
        .shell-subnav {
          position: fixed;
          top: 64px;
          left: 0;
          right: 0;
          height: 48px;
          background: var(--shell-bg);
          border-bottom: 1px solid var(--shell-border);
          display: flex;
          align-items: center;
          padding: 0 24px;
          gap: 4px;
          z-index: 999;
        }

        .shell-subnav-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          border-radius: 8px;
          color: var(--shell-muted);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.15s;
          border: 1px solid transparent;
          position: relative;
        }

        .shell-subnav-item:hover {
          color: var(--shell-text);
          background: var(--shell-hover);
        }

        .shell-subnav-item.active {
          color: var(--shell-text);
          background: transparent;
          border: none;
          border-bottom: 2px solid var(--shell-module);
          border-radius: 0;
        }

        .shell-subnav-item .material-symbols-outlined {
          font-size: 20px;
        }

        /* Toast Notifications */
        .shell-toast-container {
          position: fixed;
          top: 80px;
          right: 24px;
          z-index: 9999;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .shell-toast {
          padding: 12px 16px;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 10px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
          animation: toast-in 0.3s ease-out;
          max-width: 320px;
        }

        .shell-toast.success {
          background: rgba(34, 197, 94, 0.15);
          border: 1px solid rgba(34, 197, 94, 0.3);
          color: #4ade80;
        }

        .shell-toast.error {
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #f87171;
        }

        .shell-toast.info {
          background: rgba(59, 130, 246, 0.15);
          border: 1px solid rgba(59, 130, 246, 0.3);
          color: #60a5fa;
        }

        .shell-toast .material-symbols-outlined {
          font-size: 20px;
        }

        @keyframes toast-in {
          from {
            opacity: 0;
            transform: translateX(20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        /* Responsive */
        @media (max-width: 768px) {
          .shell-topbar {
            padding: 0 16px;
          }

          .shell-logo-text {
            display: none;
          }

          .shell-user-info {
            display: none;
          }

          .shell-breadcrumb-item span:not(.material-symbols-outlined) {
            display: none;
          }
        }
      </style>

      <!-- Top Bar -->
      <header class="shell-topbar">
        <a href="/" class="shell-logo">
          ${isHome ? `<span class="shell-logo-text">ACROPAQ AI platform</span>` : ''}
        </a>

        <div class="shell-breadcrumb">
          ${currentModule ? `
            <a href="/" class="shell-breadcrumb-item">
              <span class="material-symbols-outlined">home</span>
              <span>Home</span>
            </a>
            <span class="shell-breadcrumb-sep">/</span>
            <div class="shell-module-badge">
              <span class="material-symbols-outlined">${currentModule.icon}</span>
              <span>${currentModule.name}</span>
            </div>
          ` : ''}
        </div>

        <div class="shell-user-area">
          <div class="shell-notifications" id="shell-notifications">
            <span class="material-symbols-outlined">notifications</span>
          </div>

          <div class="shell-user-menu">
            <div class="shell-user-btn" id="shell-user-btn">
              <div class="shell-avatar" id="shell-avatar">${me && me.avatar
                ? `<img src="${me.avatar}" alt="Avatar">`
                : (me ? (me.firstName || me.email || 'U').charAt(0).toUpperCase() : 'U')}</div>
              <div class="shell-user-info">
                <div class="shell-user-email">${me ? (me.firstName || me.email) : ''}</div>
              </div>
            </div>
            <div class="shell-user-dropdown" id="shell-user-dropdown">
              <a href="/settings/profile.html" class="shell-dropdown-item">
                <span class="material-symbols-outlined">person</span>
                My Profile
              </a>
              <a href="/settings/" class="shell-dropdown-item">
                <span class="material-symbols-outlined">settings</span>
                Settings
              </a>
              <div class="shell-dropdown-divider"></div>
              <button class="shell-dropdown-item danger" id="shell-logout">
                <span class="material-symbols-outlined">logout</span>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      ${currentModule ? `
        <!-- Module Sub-Nav -->
        <nav class="shell-subnav">
          ${currentModule.pages.map(page => `
            <a href="${page.path}" class="shell-subnav-item ${isActivePage(page.path) ? 'active' : ''}">
              <span class="material-symbols-outlined">${page.icon}</span>
              <span>${page.name}</span>
            </a>
          `).join('')}
        </nav>
      ` : ''}
    `;

    document.body.appendChild(shell);

    // Toast container
    const toastContainer = document.createElement('div');
    toastContainer.className = 'shell-toast-container';
    toastContainer.id = 'shell-toast-container';
    document.body.appendChild(toastContainer);

    // User menu toggle
    const userBtn = document.getElementById('shell-user-btn');
    const userDropdown = document.getElementById('shell-user-dropdown');
    if (userBtn && userDropdown) {
      userBtn.onclick = (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('open');
      };
      document.addEventListener('click', () => {
        userDropdown.classList.remove('open');
      });
    }

    // Logout handler
    const logoutBtn = document.getElementById('shell-logout');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        } catch (_) {}
        location.href = '/app/login';
      };
    }

    // Global 401 handler
    if (!window.__shell_fetch_wrapped) {
      window.__shell_fetch_wrapped = true;
      const origFetch = window.fetch.bind(window);
      let redirecting = false;
      window.fetch = async function(input, init) {
        const resp = await origFetch(input, init);
        if (resp && resp.status === 401 && !redirecting) {
          redirecting = true;
          redirectToLogin(location.pathname + location.search + location.hash);
        }
        return resp;
      };
    }
  }

  // Initialize
  (async () => {
    const u = await getMe();
    if (!u) {
      if (!location.pathname.includes('/login')) {
        redirectToLogin(location.pathname + location.search + location.hash);
      }
      return;
    }

    // Fetch accessible modules
    accessibleModules = await getMyModules();

    // Check if user is trying to access a module they don't have access to
    const path = location.pathname;
    for (const [id, module] of Object.entries(MODULES)) {
      if (path.startsWith(module.basePath) && !hasModuleAccess(id)) {
        // Redirect to home with access denied message
        sessionStorage.setItem('access_denied', module.name);
        location.href = '/';
        return;
      }
    }

    injectShell(u);
  })();

  // Show toast notification
  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('shell-toast-container');
    if (!container) return;

    const icons = {
      success: 'check_circle',
      error: 'error',
      info: 'info'
    };

    const toast = document.createElement('div');
    toast.className = `shell-toast ${type}`;
    toast.innerHTML = `
      <span class="material-symbols-outlined">${icons[type] || 'info'}</span>
      <span>${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Export for use in pages
  window.Agent5Shell = {
    MODULES,
    getCurrentModule: () => currentModule,
    getCurrentPage: () => currentPage,
    getCurrentUser: () => currentUser,
    getAccessibleModules: () => accessibleModules,
    hasModuleAccess,
    showToast
  };
})();
