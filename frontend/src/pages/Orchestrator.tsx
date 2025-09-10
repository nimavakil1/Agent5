import React from 'react';
const Orchestrator: React.FC = () => (
  <div>
    <h1 style={{fontWeight:600,color:'#0f172a',fontSize:20, marginBottom:12}}>Orchestrator</h1>
    <iframe src="/app/orchestrator.html" style={{width:'100%', height:'80vh', border:'1px solid #e2e8f0', background:'#fff', borderRadius:8}}></iframe>
  </div>
);
export default Orchestrator;

