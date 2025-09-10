(() => {
  async function getMe(){ try{ const r=await fetch('/api/auth/me',{credentials:'include'}); if(!r.ok) return null; return await r.json(); }catch(_){ return null; } }
  function injectSidebar(me){
    if(document.getElementById('acq-shell')) return; // once
    const bar = document.createElement('div'); bar.id='acq-shell'; bar.innerHTML = `
      <style>
        body{ margin-left:220px; }
        @media(max-width: 1024px){ body{ margin-left:0; } #acq-sidebar{ position:fixed; transform:translateX(-100%);} }
        #acq-sidebar{ position:fixed; left:0; top:0; bottom:0; width:220px; background:#ffffff; border-right:1px solid #e2e8f0; z-index:40; }
        #acq-sidebar .brand{ display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid #e2e8f0; }
        #acq-sidebar nav a{ display:block; padding:8px 12px; color:#475569; text-decoration:none; border-radius:6px; margin:4px 8px; }
        #acq-sidebar nav a:hover{ background:#f1f5f9; color:#0f172a; }
      </style>
      <aside id="acq-sidebar">
        <div class="brand">
          <a href="/dashboard.html" style="display:flex;align-items:center;gap:8px;">
            <picture><source srcset="/assets/logo.webp" type="image/webp"><img src="/assets/logo.png" onerror="this.src='/assets/placeholder-logo.svg'" style="height:28px"></picture>
          </a>
          <a href="/dashboard.html" style="font-weight:600;color:#0f172a;text-decoration:none;">AI Platform</a>
        </div>
        <nav>
          <a href="/dashboard.html">Analytics</a>
          <a href="/app/products.html">Products</a>
          <a href="/app/agent-studio.html">Agent Studio</a>
          <a href="/app/orchestrator.html">Orchestrator</a>
          <a href="/customers.html">Customers</a>
          <a href="/call-review.html">Call Review</a>
          <a href="/app/profile.html">My Profile</a>
          ${me && (me.role==='admin'||me.role==='superadmin') ? '<a href="/app/admin/users.html">Admin · Users</a>' : ''}
        </nav>
      </aside>
    `;
    document.body.appendChild(bar);
  }
  getMe().then(injectSidebar);
})();

