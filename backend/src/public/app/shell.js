(() => {
  const PRIMARY = '#0d7ff2';
  async function getMe(){ try{ const r=await fetch('/api/auth/me',{credentials:'include'}); if(!r.ok) return null; return await r.json(); }catch(_){ return null; } }
  function currentPath(){ return location.pathname; }
  function navItem(href, icon, label, active=false){
    const base = 'flex items-center gap-3 rounded-md px-3 py-2 transition-colors';
    const cls = active? 'bg-[#283039] text-white' : 'text-[#9cabba] hover:bg-[#1b2127] hover:text-white';
    return `<a href="${href}" class="${base} ${cls}"><span class="material-symbols-outlined"> ${icon} </span><span class="text-sm font-medium">${label}</span></a>`;
  }
  function injectShell(me){
    if(document.getElementById('acq-shell')) return; // once
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
          ${navItem('/app/prospects.html','group','Prospects', is('/app/prospects.html'))}
          ${navItem('/app/monitor.html','call','Live Calls', is('/app/monitor.html'))}
          ${navItem('/call-review.html','analytics','Call Review', is('/call-review.html'))}
          ${navItem('/app/products.html','inventory_2','Products', is('/app/products.html'))}
          ${navItem('/app/profile.html','settings','Settings', is('/app/profile.html'))}
          ${(me && (me.role==='admin'||me.role==='superadmin'))? navItem('/app/admin/users.html','admin_panel_settings','Admin · Users', is('/app/admin/users.html')):''}
        </nav>
        <div class="mt-8 text-[#9cabba] text-sm">
          <div class="flex items-center gap-2"><span class="material-symbols-outlined">account_circle</span><span>${me? (me.email||'') : ''}</span></div>
          <button id="acq-logout" class="mt-3 btn">Logout</button>
        </div>
      </aside>
    `;
    document.body.appendChild(aside);
    const logout = document.getElementById('acq-logout');
    if (logout) logout.onclick = async()=>{ try{ await fetch('/api/auth/logout',{method:'POST',credentials:'include'});}catch(_){} location.href='/app/login'; };
  }
  getMe().then(u=>{
    if(!u){ if(!location.pathname.endsWith('/app/login')) location.href='/app/login'; return; }
    injectShell(u);
  });
})();
