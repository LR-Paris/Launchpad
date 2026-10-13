#!/usr/bin/env node
// Create a Launchpad super admin. Sign-in is by emailed code or passkey,
// so there is no password to set.
//
//   node scripts/create-admin.js <email> [username] [name]
const { initUsersDb, getUserByEmail, createUser } = require('../src/users');

function main() {
  const [email, username, name] = process.argv.slice(2);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: node scripts/create-admin.js <email> [username] [name]');
    process.exit(1);
  }
  initUsersDb();
  if (getUserByEmail(email)) {
    console.log(`${email} already has an account.`);
    return;
  }
  const user = createUser({
    username: username || email.split('@')[0],
    email,
    name: name || '',
    role: 'super_admin',
    created_by: null,
  });
  console.log(`Created super_admin ${user.email} (id ${user.id}). Sign in with an emailed code.`);
}

main();
