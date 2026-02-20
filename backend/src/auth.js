const express = require('express');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const BCRYPT_ROUNDS = 12;

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse users.json:', err.message);
    return [];
  }
}

function saveUsers(users) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const users = loadUsers();
  const user = users.find(u => u.username === username);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  bcrypt.compare(password, user.password, (err, match) => {
    if (err) {
      return res.status(500).json({ error: 'Authentication error' });
    }
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = { username: user.username };
    req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).json({ error: 'Failed to save session' });
      }
      res.json({ user: { username: user.username } });
    });
  });
});

// POST /api/auth/change-password
router.post('/change-password', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'oldPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const users = loadUsers();
  const userIndex = users.findIndex(u => u.username === req.session.user.username);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  bcrypt.compare(oldPassword, users[userIndex].password, (err, match) => {
    if (err) return res.status(500).json({ error: 'Authentication error' });
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    bcrypt.hash(newPassword, BCRYPT_ROUNDS, (hashErr, hash) => {
      if (hashErr) return res.status(500).json({ error: 'Failed to hash password' });
      users[userIndex].password = hash;
      saveUsers(users);
      res.json({ message: 'Password changed successfully' });
    });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.session.user });
});

module.exports = { router, requireAuth, loadUsers, saveUsers, BCRYPT_ROUNDS };
