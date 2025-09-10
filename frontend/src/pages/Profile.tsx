import React from 'react';
const Profile: React.FC = () => (
  <div>
    <h1 style={{fontWeight:600,color:'#0f172a',fontSize:20, marginBottom:12}}>My Profile</h1>
    <iframe src="/app/profile.html" style={{width:'100%', height:'80vh', border:'1px solid #e2e8f0', background:'#fff', borderRadius:8}}></iframe>
  </div>
);
export default Profile;

