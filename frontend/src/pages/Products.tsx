import React from 'react';
const Products: React.FC = () => (
  <div>
    <h1 style={{fontWeight:600,color:'#0f172a',fontSize:20, marginBottom:12}}>Products</h1>
    <iframe src="/app/products.html" style={{width:'100%', height:'80vh', border:'1px solid #e2e8f0', background:'#fff', borderRadius:8}}></iframe>
  </div>
);
export default Products;

