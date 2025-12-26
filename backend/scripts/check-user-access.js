require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Role = require('../src/models/Role');

async function checkUserAccess() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Find the user
  const user = await User.findOne({ email: 'nimavakil@gmail.com' }).lean();

  if (!user) {
    console.log('User not found!');
    return;
  }

  console.log('User found:');
  console.log('  Email:', user.email);
  console.log('  Role (legacy):', user.role);
  console.log('  RoleId:', user.roleId);
  console.log('  Status:', user.status);
  console.log('  Active:', user.active);
  console.log();

  // If roleId exists, check the role
  if (user.roleId) {
    const role = await Role.findById(user.roleId).lean();
    if (role) {
      console.log('Assigned Role:');
      console.log('  Name:', role.name);
      console.log('  Description:', role.description);
      console.log('  Module Access:', role.moduleAccess || 'NONE');
      console.log('  Privileges:', role.privileges || 'NONE');
    } else {
      console.log('ERROR: RoleId points to non-existent role!');
    }
  } else {
    console.log('No roleId assigned - will use legacy role mapping');
  }

  // List all roles
  console.log('\n--- All Available Roles ---');
  const roles = await Role.find().lean();
  for (const r of roles) {
    console.log('  ' + r.name + ': moduleAccess = ' + JSON.stringify(r.moduleAccess || []));
  }

  await mongoose.disconnect();
}

checkUserAccess().catch(console.error);
