import React from 'react';

type User = { id:string; email:string; role:'superadmin'|'admin'|'manager'|'user' } | null;

const Ctx = React.createContext<{user:User, setUser:(u:User)=>void, logout:()=>Promise<void>}>({user:null,setUser:()=>{},logout:async()=>{}});

export const AuthProvider: React.FC<{children:React.ReactNode}> = ({children})=>{
  const [user, setUser] = React.useState<User>(null);
  React.useEffect(()=>{ (async()=>{ try{ const r=await fetch('/api/auth/me',{credentials:'include'}); if(r.ok){ setUser(await r.json()); } }catch(_){} })(); },[]);
  const logout = async()=>{ try{ await fetch('/api/auth/logout',{method:'POST',credentials:'include'});}catch(_){} window.location.href='/app/login'; };
  return <Ctx.Provider value={{user,setUser,logout}}>{children}</Ctx.Provider>;
};

export const useAuth = ()=> React.useContext(Ctx);

