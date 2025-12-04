const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const hash = await bcrypt.hash('Acr0paq', 10);
  await mongoose.connection.db.collection('users').deleteMany({});
  await mongoose.connection.db.collection('users').insertOne({
    email: 'nima@acropaq.com',
    passwordHash: hash,
    role: 'admin',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  console.log('Done! Login: nima@acropaq.com / Acr0paq');
  process.exit(0);
});
