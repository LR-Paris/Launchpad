const bcrypt = require('bcrypt');
const { loadUsers, saveUsers, BCRYPT_ROUNDS } = require('./src/auth');
const users = loadUsers();
if (users.length > 0) {
  console.log('Admin already exists');
  process.exit(0);
}
const hash = bcrypt.hashSync('Basilbelle1!', BCRYPT_ROUNDS);
saveUsers([{ username: 'admin', password: hash }]);
console.log('Admin user admin created successfully');
