/**
 * Agent5 Shell - Modern Navigation System
 *
 * Injects a beautiful sidebar navigation with grouped sections
 * and consistent styling across all pages.
 */
(() => {
  // Skip shell injection when embedded in an iframe
  if (window.self !== window.top) return;

  const BRAND_COLOR = '#6366f1'; // Indigo
  const ACCENT_COLOR = '#8b5cf6'; // Purple

  async function getMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
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

  function currentPath() {
    return location.pathname;
  }

  function isActive(href) {
    const p = currentPath();
    if (href === '/app/index.html' && (p === '/' || p === '/app/' || p === '/app/index.html')) return true;
    return p === href || p.endsWith(href);
  }

  function navItem(href, icon, label, active = false, badge = null) {
    const cls = active
      ? 'nav-item active'
      : 'nav-item';
    const badgeHtml = badge ? `<span class="nav-badge">${badge}</span>` : '';
    return `
      <a href="${href}" class="${cls}">
        <span class="material-symbols-outlined nav-icon">${icon}</span>
        <span class="nav-label">${label}</span>
        ${badgeHtml}
      </a>
    `;
  }

  function navSection(title, items) {
    return `
      <div class="nav-section">
        <div class="nav-section-title">${title}</div>
        ${items}
      </div>
    `;
  }

  async function injectShell(me) {
    if (document.getElementById('agent5-shell')) return;

    ensureIconFont();
    ensureInterFont();

    const aside = document.createElement('div');
    aside.id = 'agent5-shell';

    aside.innerHTML = `
      <style>
        :root {
          --shell-bg: #0a0a0f;
          --shell-sidebar: #12121a;
          --shell-border: #1f1f2e;
          --shell-hover: #1a1a28;
          --shell-active: #252536;
          --shell-text: #e4e4e7;
          --shell-muted: #71717a;
          --shell-brand: ${BRAND_COLOR};
          --shell-accent: ${ACCENT_COLOR};
          --shell-success: #22c55e;
          --shell-warning: #f59e0b;
          --shell-error: #ef4444;
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          padding: 0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: var(--shell-bg);
          color: var(--shell-text);
          min-height: 100vh;
        }

        /* Sidebar */
        .shell-sidebar {
          position: fixed;
          left: 0;
          top: 0;
          bottom: 0;
          width: 260px;
          background: var(--shell-sidebar);
          border-right: 1px solid var(--shell-border);
          display: flex;
          flex-direction: column;
          z-index: 1000;
          overflow: hidden;
        }

        /* Logo area */
        .shell-logo {
          padding: 20px 20px 16px;
          border-bottom: 1px solid var(--shell-border);
        }

        .shell-logo-inner {
          display: flex;
          align-items: center;
          gap: 12px;
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

        /* Navigation */
        .shell-nav {
          flex: 1;
          overflow-y: auto;
          padding: 16px 12px;
        }

        .shell-nav::-webkit-scrollbar {
          width: 4px;
        }

        .shell-nav::-webkit-scrollbar-track {
          background: transparent;
        }

        .shell-nav::-webkit-scrollbar-thumb {
          background: var(--shell-border);
          border-radius: 2px;
        }

        .nav-section {
          margin-bottom: 24px;
        }

        .nav-section-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--shell-muted);
          padding: 0 12px;
          margin-bottom: 8px;
        }

        .nav-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-radius: 8px;
          color: var(--shell-muted);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.15s ease;
          margin-bottom: 2px;
        }

        .nav-item:hover {
          background: var(--shell-hover);
          color: var(--shell-text);
        }

        .nav-item.active {
          background: var(--shell-active);
          color: white;
        }

        .nav-item.active .nav-icon {
          color: var(--shell-brand);
        }

        .nav-icon {
          font-size: 20px;
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.8;
        }

        .nav-item:hover .nav-icon,
        .nav-item.active .nav-icon {
          opacity: 1;
        }

        .nav-label {
          flex: 1;
        }

        .nav-badge {
          font-size: 11px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 10px;
          background: var(--shell-brand);
          color: white;
        }

        /* User section */
        .shell-user {
          padding: 16px;
          border-top: 1px solid var(--shell-border);
          background: var(--shell-sidebar);
        }

        .shell-user-info {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }

        .shell-avatar {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          background: linear-gradient(135deg, #3b82f6, #8b5cf6);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          font-weight: 600;
          color: white;
        }

        .shell-user-details {
          flex: 1;
          min-width: 0;
        }

        .shell-user-email {
          font-size: 13px;
          font-weight: 500;
          color: var(--shell-text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .shell-user-role {
          font-size: 11px;
          color: var(--shell-muted);
          text-transform: capitalize;
        }

        .shell-logout {
          width: 100%;
          padding: 10px;
          border: 1px solid var(--shell-border);
          border-radius: 8px;
          background: transparent;
          color: var(--shell-muted);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .shell-logout:hover {
          background: var(--shell-hover);
          color: var(--shell-text);
          border-color: var(--shell-muted);
        }

        .shell-version {
          text-align: center;
          font-size: 10px;
          color: var(--shell-muted);
          margin-top: 8px;
          opacity: 0.6;
        }

        /* Main content offset */
        body {
          padding-left: 260px !important;
        }

        /* Mobile responsive */
        @media (max-width: 768px) {
          .shell-sidebar {
            transform: translateX(-100%);
            transition: transform 0.3s ease;
          }

          .shell-sidebar.open {
            transform: translateX(0);
          }

          body {
            padding-left: 0 !important;
          }

          .shell-mobile-toggle {
            display: flex !important;
          }
        }

        .shell-mobile-toggle {
          display: none;
          position: fixed;
          top: 16px;
          left: 16px;
          z-index: 1001;
          width: 40px;
          height: 40px;
          border-radius: 8px;
          background: var(--shell-sidebar);
          border: 1px solid var(--shell-border);
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: var(--shell-text);
        }

        /* Override page styles */
        main, .main-content, [class*="container"] {
          max-width: 100% !important;
        }
      </style>

      <button class="shell-mobile-toggle" onclick="document.querySelector('.shell-sidebar').classList.toggle('open')">
        <span class="material-symbols-outlined">menu</span>
      </button>

      <aside class="shell-sidebar">
        <div class="shell-logo">
          <div class="shell-logo-inner">
            <div class="shell-logo-icon">
              <span class="material-symbols-outlined">auto_awesome</span>
            </div>
            <span class="shell-logo-text">Agent5</span>
          </div>
        </div>

        <nav class="shell-nav">
          ${navSection('Overview', `
            ${navItem('/app/index.html', 'space_dashboard', 'Dashboard', isActive('/app/index.html'))}
          `)}

          ${navSection('AI Platform', `
            ${navItem('/app/agent-console.html', 'smart_toy', 'Agent Console', isActive('/app/agent-console.html'))}
            ${navItem('/app/agent-studio.html', 'psychology', 'Agent Studio', isActive('/app/agent-studio.html'))}
            ${navItem('/app/ai-training.html', 'school', 'AI Training', isActive('/app/ai-training.html'))}
            ${navItem('/app/orchestrator.html', 'account_tree', 'Orchestrator', isActive('/app/orchestrator.html'))}
          `)}

          ${navSection('Communications', `
            ${navItem('/app/call-center.html', 'headset_mic', 'Call Center', isActive('/app/call-center.html'))}
            ${navItem('/app/campaigns.html', 'campaign', 'Campaigns', isActive('/app/campaigns.html'))}
            ${navItem('/app/prospects.html', 'contacts', 'Contacts', isActive('/app/prospects.html'))}
          `)}

          ${navSection('Business Data', `
            ${navItem('/app/products.html', 'inventory_2', 'Products', isActive('/app/products.html'))}
            ${navItem('/app/purchasing.html', 'shopping_cart', 'Purchasing', isActive('/app/purchasing.html'))}
            ${navItem('/app/inventory.html', 'warehouse', 'Inventory Opt.', isActive('/app/inventory.html'))}
            ${navItem('/app/analytics.html', 'analytics', 'Analytics', isActive('/app/analytics.html') || isActive('/dashboard.html'))}
          `)}

          ${navSection('Amazon', `
            ${navItem('/app/amazon-config.html', 'storefront', 'Overview', isActive('/app/amazon-config.html'))}
            ${navItem('/app/amazon-vcs.html', 'receipt_long', 'VCS Tax Reports', isActive('/app/amazon-vcs.html'))}
            ${navItem('/app/amazon-reports.html', 'upload_file', 'Upload Reports', isActive('/app/amazon-reports.html'))}
          `)}

          ${navSection('Settings', `
            ${navItem('/app/integrations.html', 'hub', 'Integrations', isActive('/app/integrations.html'))}
            ${navItem('/app/mcp.html', 'settings_input_component', 'MCP Tools', isActive('/app/mcp.html'))}
            ${navItem('/app/profile.html', 'person', 'My Profile', isActive('/app/profile.html'))}
            ${(me && (me.role === 'admin' || me.role === 'superadmin'))
              ? navItem('/app/admin/users.html', 'admin_panel_settings', 'Admin', isActive('/app/admin/users.html'))
              : ''}
          `)}
        </nav>

        <div class="shell-user">
          <div class="shell-user-info">
            <div class="shell-avatar">${me ? (me.email || 'U').charAt(0).toUpperCase() : 'U'}</div>
            <div class="shell-user-details">
              <div class="shell-user-email" title="${me ? me.email : ''}">${me ? me.email : ''}</div>
              <div class="shell-user-role">${me ? me.role : ''}</div>
            </div>
          </div>
          <button class="shell-logout" id="shell-logout">
            <span class="material-symbols-outlined" style="font-size:18px">logout</span>
            Sign out
          </button>
          <div class="shell-version" id="shell-version">Agent5</div>
        </div>
      </aside>
    `;

    document.body.appendChild(aside);

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

    // Logout handler
    const logout = document.getElementById('shell-logout');
    if (logout) {
      logout.onclick = async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        } catch (_) {}
        location.href = '/app/login';
      };
    }

    // Fetch version info
    try {
      const r = await fetch('/version', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        const el = document.getElementById('shell-version');
        if (el) el.textContent = 'Agent5 · ' + (j.commit ? j.commit.slice(0, 7) : 'dev');
      }
    } catch (_) {}
  }

  getMe().then(u => {
    if (!u) {
      if (!location.pathname.endsWith('/app/login') && !location.pathname.endsWith('/login')) {
        redirectToLogin(location.pathname + location.search + location.hash);
      }
      return;
    }
    injectShell(u);
  });
})();
