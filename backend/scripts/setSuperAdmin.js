require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');

async function main(){
  const uri = process.env.MONGO_URI; if (!uri) throw new Error('MONGO_URI not set');
  const email = process.argv[2] || 'nima@acropaq.com';
  await mongoose.connect(uri);
  let u = await User.findOne({ email: email.toLowerCase() });
  if (!u) {
    const pw = process.env.SUPERADMIN_PASSWORD || 'ChangeMe123!';
    const passwordHash = await bcrypt.hash(pw, 10);
    u = await User.create({ email: email.toLowerCase(), passwordHash, role: 'superadmin', active: true });
    console.log('Created superadmin:', u.email);
  } else {
    if (u.role !== 'superadmin') { u.role = 'superadmin'; await u.save(); console.log('Promoted to superadmin:', u.email); }
    else { console.log('Already superadmin:', u.email); }
  }
  // Demote any others accidentally set as superadmin
  await User.updateMany({ email: { $ne: email.toLowerCase() }, role: 'superadmin' }, { $set: { role: 'admin' } });
  console.log('Ensured single superadmin');
  await mongoose.disconnect();
}
main().catch(e=>{ console.error(e); process.exit(1); });

