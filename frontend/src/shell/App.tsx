import React from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';

const Sidebar: React.FC = () => (
  <aside style={{ width: 220, background: '#fff', borderRight: '1px solid #e2e8f0', position:'fixed', top:0, bottom:0 }}>
    <div style={{display:'flex',alignItems:'center',gap:8,padding:'12px 14px', borderBottom:'1px solid #e2e8f0'}}>
      <Link to="/"> <img src="/assets/logo.webp" onError={(e:any)=>{e.currentTarget.src='/assets/logo.png'}} style={{height:28}}/> </Link>
      <Link to="/" style={{fontWeight:600,color:'#0f172a',textDecoration:'none'}}>AI Platform</Link>
    </div>
    <nav style={{padding:8,fontSize:14}}>
      <Link to="/" className="nav">Analytics</Link>
      <Link to="/products" className="nav">Products</Link>
      <Link to="/accounting" className="nav">Accounting</Link>
      <Link to="/agent-studio" className="nav">Agent Studio</Link>
      <Link to="/orchestrator" className="nav">Orchestrator</Link>
      <Link to="/profile" className="nav">My Profile</Link>
      <AdminLink />
    </nav>
    <style>{`.nav{display:block;padding:8px 12px;border-radius:6px;color:#475569;text-decoration:none;margin:4px 8px}.nav:hover{background:#f1f5f9;color:#0f172a}`}</style>
  </aside>
);

const AdminLink: React.FC = () => {
  const { user } = useAuth();
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return null;
  return <Link to="/admin/users" className="nav">Admin · Users</Link>;
};

const App: React.FC = () => {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  React.useEffect(()=>{ if(!user) nav('/app/login', { replace: true }); }, [user]);
  return (
    <div style={{marginLeft:220, minHeight:'100vh', background:'#f8fafc'}}>
      <Sidebar />
      <header style={{background:'#fff',borderBottom:'1px solid #e2e8f0', padding:'10px 14px', display:'flex', justifyContent:'flex-end', gap:12}}>
        <span style={{fontSize:14, color:'#475569'}}>{user?.email} · {user?.role}</span>
        <button onClick={logout} style={{fontSize:14,color:'#4f46e5'}}>Logout</button>
      </header>
      <main style={{padding:16}}>
        <Outlet />
      </main>
    </div>
  );
};

export default App;

