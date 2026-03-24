#!/usr/bin/env node
const readline = require('readline');
const path = require('path');

// Load env so DB path resolves correctly
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { initUsersDb, getUserCount, createUser } = require('../src/users');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  initUsersDb();

  const count = getUserCount();
  if (count > 0) {
    console.log(`Users already exist (${count} user(s) in database).`);
    const proceed = await ask('Create another super admin? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
      rl.close();
      process.exit(0);
    }
  }

  console.log('=== Launchpad — Create Super Admin ===\n');

  const username = await ask('Username: ');
  if (!username.trim()) {
    console.error('Username cannot be empty.');
    rl.close();
    process.exit(1);
  }

  const email = await ask('Email: ');
  if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    console.error('A valid email is required (used for sign-in codes).');
    rl.close();
    process.exit(1);
  }

  const name = await ask('Display Name: ');
  if (!name.trim()) {
    console.error('Display name cannot be empty.');
    rl.close();
    process.exit(1);
  }

  try {
    const user = createUser({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: 'super_admin',
      created_by: 'cli',
    });

    console.log(`\nSuper admin "${user.username}" created successfully.`);
    console.log(`Sign-in codes will be sent to: ${user.email}`);
    console.log('\nNote: If Mailgun is not configured, codes will be logged to the server console.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }

  rl.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
