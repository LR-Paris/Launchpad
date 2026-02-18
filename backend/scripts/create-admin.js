#!/usr/bin/env node
const readline = require('readline');
const bcrypt = require('bcrypt');
const path = require('path');

const { loadUsers, saveUsers, BCRYPT_ROUNDS } = require('../src/auth');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  const users = loadUsers();

  if (users.length > 0) {
    console.log('An admin user already exists.');
    rl.close();
    process.exit(0);
  }

  console.log('=== Shuttle Platform — Create Admin User ===\n');

  const username = await ask('Username: ');
  if (!username.trim()) {
    console.error('Username cannot be empty.');
    rl.close();
    process.exit(1);
  }

  const password = await ask('Password: ');
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    rl.close();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  saveUsers([{ username: username.trim(), password: hash }]);

  console.log(`\nAdmin user "${username.trim()}" created successfully.`);
  rl.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
