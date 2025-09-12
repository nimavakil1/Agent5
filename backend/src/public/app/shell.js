(() => {
  const PRIMARY = '#0d7ff2';
  async function getMe(){ try{ const r=await fetch('/api/auth/me',{credentials:'include'}); if(!r.ok) return null; return await r.json(); }catch(_){ return null; } }
  function ensureUiCss(){
    if (!document.querySelector('link[href$="/app/ui.css"]')){
      const l=document.createElement('link'); l.rel='stylesheet'; l.href='/app/ui.css'; document.head.appendChild(l);
    }
  }
  function redirectToLogin(nextUrl){
    const rawNext = nextUrl || (location.pathname+location.search+location.hash);
    try { sessionStorage.setItem('next_url', rawNext); } catch(_){}
    const next = encodeURIComponent(rawNext);
    location.href = `/app/login?next=${next}`;
  }
  function ensureIconFont(){
    if (!document.querySelector('link[href*="Material+Symbols"]')){
      const l=document.createElement('link'); l.rel='stylesheet'; l.href='https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined'; document.head.appendChild(l);
      const style=document.createElement('style'); style.textContent = `.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24}`; document.head.appendChild(style);
    }
  }
  function currentPath(){ return location.pathname; }
  function navItem(href, icon, label, active=false){
    const base = 'flex items-center gap-3 rounded-md px-3 py-2 transition-colors overflow-hidden';
    const cls = active? 'bg-[#283039] text-white' : 'text-[#9cabba] hover:bg-[#1b2127] hover:text-white';
    return `<a href="${href}" class="${base} ${cls}"><span class="material-symbols-outlined shrink-0">${icon}</span><span class="text-sm font-medium whitespace-nowrap truncate">${label}</span></a>`;
  }
  function injectShell(me){
    if(document.getElementById('acq-shell')) return; // once
    ensureIconFont();
    ensureUiCss();
    const p = currentPath();
    const is = (k)=> p.endsWith(k);
    const aside = document.createElement('div');
    aside.id = 'acq-shell';
    aside.innerHTML = `
      <style>
        :root { --primary-color: ${PRIMARY}; }
        body { background:#111418; color:#e5e7eb; padding-left: 256px; }
        @media (max-width: 1024px){ body { padding-left: 0; } #acq-aside { transform: translateX(-100%);} }
        .btn { display:inline-flex; align-items:center; gap:.5rem; border-radius:.5rem; padding:.5rem .75rem; background: var(--primary-color); color:#fff; }
      </style>
      <aside id="acq-aside" class="fixed left-0 top-0 bottom-0 w-64 shrink-0 border-r border-[#283039] bg-[#111418] p-6 z-40">
        <div class="flex items-center gap-2 mb-8">
          <div class="w-8 h-8 rounded-full" style="background:${PRIMARY}"></div>
          <h1 class="text-white text-lg font-bold">ACROPAQ AI</h1>
        </div>
        <nav class="flex flex-col gap-2">
          ${navItem('/dashboard.html','dashboard','Dashboard', is('/dashboard.html'))}
          ${navItem('/app/campaigns.html','campaign','Campaigns', is('/app/campaigns.html'))}
          ${navItem('/app/prospects.html','group','Contacts', is('/app/prospects.html'))}
          ${navItem('/app/agent-studio.html','headset_mic','Agent Studio', is('/app/agent-studio.html'))}
          ${navItem('/monitor.html','call','Live Calls', is('/monitor.html'))}
          ${navItem('/call-review.html','analytics','Call Review', is('/call-review.html'))}
          ${navItem('/app/products.html','inventory_2','Products', is('/app/products.html'))}
          ${navItem('/app/profile.html','settings','Settings', is('/app/profile.html'))}
          ${(me && (me.role==='admin'||me.role==='superadmin'))? navItem('/app/admin/users.html','admin_panel_settings','Admin · Users', is('/app/admin/users.html')):''}
        </nav>
        <div class="mt-8 text-[#9cabba] text-sm overflow-hidden">
          <div class="flex items-center gap-2 overflow-hidden"><span class="material-symbols-outlined shrink-0">account_circle</span><span class="truncate" title="${me? (me.email||'') : ''}">${me? (me.email||'') : ''}</span></div>
          <button id="acq-logout" class="mt-3 btn">Logout</button>
          <div id="acq-ver" class="mt-3 text-xs text-[#6b7280]">v —</div>
        </div>
      </aside>
    `;
    document.body.appendChild(aside);
    // Global 401 handler: redirect to login preserving return URL
    if (!window.__acq_fetch_wrapped){
      window.__acq_fetch_wrapped = true;
      const origFetch = window.fetch.bind(window);
      let redirecting = false;
      window.fetch = async function(input, init){
        const resp = await origFetch(input, init);
        if (resp && resp.status === 401 && !redirecting){
          redirecting = true;
          redirectToLogin(location.pathname+location.search+location.hash);
        }
        return resp;
      };
    }
    const logout = document.getElementById('acq-logout');
    if (logout) logout.onclick = async()=>{ try{ await fetch('/api/auth/logout',{method:'POST',credentials:'include'});}catch(_){} location.href='/app/login'; };
    // Fetch version info
    try { const r = await fetch('/version',{ credentials:'include' }); if (r.ok){ const j = await r.json(); const el=document.getElementById('acq-ver'); if (el) el.textContent = 'v ' + (j.commit || 'unknown'); } } catch(_) {}
  }
  getMe().then(u=>{
    if(!u){ if(!location.pathname.endsWith('/app/login')) redirectToLogin(location.pathname+location.search+location.hash); return; }
    injectShell(u);
  });
})();
