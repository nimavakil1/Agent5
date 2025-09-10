import React from 'react';
import { useAuth } from '../shell/auth';

const AdminUsers: React.FC = () => {
  const { user } = useAuth();
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return <div>Forbidden</div>;
  return (
    <div>
      <h1 style={{fontWeight:600,color:'#0f172a',fontSize:20, marginBottom:12}}>Admin · Users</h1>
      <iframe src="/app/admin/users.html" style={{width:'100%', height:'80vh', border:'1px solid #e2e8f0', background:'#fff', borderRadius:8}}></iframe>
    </div>
  );
};
export default AdminUsers;

