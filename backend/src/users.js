const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'users.db');
const USERS_JSON_PATH = path.join(DATA_DIR, 'users.json');

let db;

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------
function initUsersDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_shop_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      shop_slug TEXT NOT NULL,
      can_delete INTEGER DEFAULT 0,
      can_edit_ui INTEGER DEFAULT 0,
      can_edit_items INTEGER DEFAULT 0,
      can_view_orders INTEGER DEFAULT 0,
      UNIQUE(user_id, shop_slug),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migrate from legacy users.json if it exists and users table is empty
  migrateFromUsersJson();
}

// ---------------------------------------------------------------------------
// Migration from users.json → SQLite
// ---------------------------------------------------------------------------
function migrateFromUsersJson() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (count > 0) return; // Already have users, skip migration

  if (!fs.existsSync(USERS_JSON_PATH)) return;

  try {
    const legacyUsers = JSON.parse(fs.readFileSync(USERS_JSON_PATH, 'utf8'));
    if (!Array.isArray(legacyUsers) || legacyUsers.length === 0) return;

    const insert = db.prepare(
      'INSERT INTO users (username, email, name, role, created_by) VALUES (?, ?, ?, ?, ?)'
    );

    const txn = db.transaction(() => {
      for (const u of legacyUsers) {
        insert.run(
          u.username,
          u.email || `${u.username}@localhost`,
          u.name || u.username,
          'super_admin',
          'migration'
        );
      }
    });
    txn();

    // Rename old file so migration doesn't run again
    fs.renameSync(USERS_JSON_PATH, USERS_JSON_PATH + '.migrated');
    console.log(`[users] Migrated ${legacyUsers.length} user(s) from users.json → users.db`);
  } catch (err) {
    console.error('[users] Migration from users.json failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// User CRUD helpers
// ---------------------------------------------------------------------------
function getAllUsers() {
  return db.prepare('SELECT id, username, email, name, role, created_at, created_by FROM users').all();
}

function getUserById(id) {
  return db.prepare('SELECT id, username, email, name, role, created_at, created_by FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserByUsernameOrEmail(identifier) {
  return db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier);
}

function createUser({ username, email, name, role, created_by }) {
  const result = db.prepare(
    'INSERT INTO users (username, email, name, role, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(username, email, name, role || 'user', created_by);
  return getUserById(result.lastInsertRowid);
}

function updateUser(id, { username, email, name, role }) {
  const fields = [];
  const values = [];
  if (username !== undefined) { fields.push('username = ?'); values.push(username); }
  if (email !== undefined) { fields.push('email = ?'); values.push(email); }
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (role !== undefined) { fields.push('role = ?'); values.push(role); }
  if (fields.length === 0) return getUserById(id);
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

function deleteUser(id) {
  db.prepare('DELETE FROM user_shop_permissions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM otp_codes WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function getUserCount() {
  return db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
}

// ---------------------------------------------------------------------------
// Per-shop permission helpers
// ---------------------------------------------------------------------------
function getUserShopPermissions(userId, shopSlug) {
  return db.prepare(
    'SELECT can_delete, can_edit_ui, can_edit_items, can_view_orders FROM user_shop_permissions WHERE user_id = ? AND shop_slug = ?'
  ).get(userId, shopSlug) || { can_delete: 0, can_edit_ui: 0, can_edit_items: 0, can_view_orders: 0 };
}

function getAllUserPermissions(userId) {
  const rows = db.prepare(
    'SELECT shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders FROM user_shop_permissions WHERE user_id = ?'
  ).all(userId);
  const perms = {};
  for (const row of rows) {
    perms[row.shop_slug] = {
      can_delete: !!row.can_delete,
      can_edit_ui: !!row.can_edit_ui,
      can_edit_items: !!row.can_edit_items,
      can_view_orders: !!row.can_view_orders,
    };
  }
  return perms;
}

function setUserShopPermissions(userId, shopSlug, perms) {
  db.prepare(`
    INSERT INTO user_shop_permissions (user_id, shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, shop_slug) DO UPDATE SET
      can_delete = excluded.can_delete,
      can_edit_ui = excluded.can_edit_ui,
      can_edit_items = excluded.can_edit_items,
      can_view_orders = excluded.can_view_orders
  `).run(
    userId,
    shopSlug,
    perms.can_delete ? 1 : 0,
    perms.can_edit_ui ? 1 : 0,
    perms.can_edit_items ? 1 : 0,
    perms.can_view_orders ? 1 : 0
  );
}

function deleteUserShopPermissions(userId, shopSlug) {
  db.prepare('DELETE FROM user_shop_permissions WHERE user_id = ? AND shop_slug = ?').run(userId, shopSlug);
}

// ---------------------------------------------------------------------------
// OTP helpers
// ---------------------------------------------------------------------------
function generateOTP(userId) {
  // Invalidate any existing unused OTPs for this user
  db.prepare('UPDATE otp_codes SET used = 1 WHERE user_id = ? AND used = 0').run(userId);

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  db.prepare(
    'INSERT INTO otp_codes (user_id, code, expires_at) VALUES (?, ?, ?)'
  ).run(userId, code, expiresAt);

  return code;
}

function verifyOTP(userId, code) {
  const row = db.prepare(
    'SELECT id FROM otp_codes WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > ?'
  ).get(userId, code, Date.now());

  if (!row) return false;

  // Mark as used
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
  return true;
}

// Cleanup expired OTPs periodically
function cleanupExpiredOTPs() {
  db.prepare('DELETE FROM otp_codes WHERE expires_at < ? OR used = 1').run(Date.now() - 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Permission check helpers (for use in route handlers)
// ---------------------------------------------------------------------------
function checkShopPermission(req, permission) {
  const user = req.session?.user;
  if (!user) return false;
  if (user.role === 'super_admin' || user.role === 'admin') return true;
  const perms = getUserShopPermissions(user.id, req.params.slug);
  return perms && !!perms[permission];
}

function checkRole(req, ...roles) {
  return req.session?.user && roles.includes(req.session.user.role);
}

function isAdminOrAbove(req) {
  return checkRole(req, 'super_admin', 'admin');
}

// Middleware factories
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function requireShopPerm(permission) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    if (checkShopPermission(req, permission)) return next();
    return res.status(403).json({ error: 'Insufficient permissions for this shop' });
  };
}

// ---------------------------------------------------------------------------
// API Routes — User management (super_admin only)
// ---------------------------------------------------------------------------

// GET /api/users — list all users
router.get('/', requireRole('super_admin'), (req, res) => {
  const users = getAllUsers();
  // Attach permissions for each user
  const result = users.map(u => ({
    ...u,
    permissions: getAllUserPermissions(u.id),
  }));
  res.json({ users: result });
});

// GET /api/users/:id — get single user
router.get('/:id', requireRole('super_admin'), (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.permissions = getAllUserPermissions(user.id);
  res.json({ user });
});

// POST /api/users — create user
router.post('/', requireRole('super_admin'), (req, res) => {
  const { username, email, name, role, shopPermissions } = req.body;
  const audit = req.app.locals.auditLog;

  if (!username || !email || !name) {
    return res.status(400).json({ error: 'username, email, and name are required' });
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Validate role
  const validRoles = ['super_admin', 'admin', 'user'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  // Check uniqueness
  if (getUserByUsername(username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: 'Email already exists' });
  }

  try {
    const user = createUser({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: role || 'user',
      created_by: req.session.user.username,
    });

    // Set shop permissions if provided
    if (shopPermissions && typeof shopPermissions === 'object') {
      for (const [slug, perms] of Object.entries(shopPermissions)) {
        setUserShopPermissions(user.id, slug, perms);
      }
    }

    user.permissions = getAllUserPermissions(user.id);
    audit?.('user_created', { req, details: { userId: user.id, username: user.username, role: user.role } });
    res.status(201).json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user: ' + err.message });
  }
});

// PATCH /api/users/:id — update user
router.patch('/:id', requireRole('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const audit = req.app.locals.auditLog;
  const existing = getUserById(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { username, email, name, role, shopPermissions } = req.body;

  // Validate email if provided
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const validRoles = ['super_admin', 'admin', 'user'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  // Check uniqueness for username/email changes
  if (username && username !== existing.username && getUserByUsername(username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  if (email && email !== existing.email && getUserByEmail(email)) {
    return res.status(409).json({ error: 'Email already exists' });
  }

  // Prevent the last super_admin from being demoted
  if (existing.role === 'super_admin' && role && role !== 'super_admin') {
    const superAdminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'").get().cnt;
    if (superAdminCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last super admin' });
    }
  }

  try {
    const updated = updateUser(id, {
      username: username?.trim(),
      email: email?.trim().toLowerCase(),
      name: name?.trim(),
      role,
    });

    // Update shop permissions if provided
    if (shopPermissions && typeof shopPermissions === 'object') {
      for (const [slug, perms] of Object.entries(shopPermissions)) {
        if (perms === null) {
          deleteUserShopPermissions(id, slug);
        } else {
          setUserShopPermissions(id, slug, perms);
        }
      }
    }

    updated.permissions = getAllUserPermissions(id);
    audit?.('user_updated', { req, details: { userId: id, changes: req.body } });
    res.json({ user: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user: ' + err.message });
  }
});

// DELETE /api/users/:id — delete user
router.delete('/:id', requireRole('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const audit = req.app.locals.auditLog;
  const existing = getUserById(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Prevent deleting yourself
  if (req.session.user.id === id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // Prevent deleting last super_admin
  if (existing.role === 'super_admin') {
    const superAdminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'").get().cnt;
    if (superAdminCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last super admin' });
    }
  }

  try {
    deleteUser(id);
    audit?.('user_deleted', { req, details: { userId: id, username: existing.username } });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user: ' + err.message });
  }
});

// PUT /api/users/:id/permissions — set all shop permissions for a user
router.put('/:id/permissions', requireRole('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = getUserById(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { shopPermissions } = req.body;
  if (!shopPermissions || typeof shopPermissions !== 'object') {
    return res.status(400).json({ error: 'shopPermissions object is required' });
  }

  try {
    // Clear existing permissions and set new ones
    db.prepare('DELETE FROM user_shop_permissions WHERE user_id = ?').run(id);
    for (const [slug, perms] of Object.entries(shopPermissions)) {
      if (perms) {
        setUserShopPermissions(id, slug, perms);
      }
    }

    const permissions = getAllUserPermissions(id);
    res.json({ permissions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update permissions: ' + err.message });
  }
});

module.exports = {
  router,
  initUsersDb,
  getUserById,
  getUserByUsername,
  getUserByEmail,
  getUserByUsernameOrEmail,
  getUserCount,
  createUser,
  generateOTP,
  verifyOTP,
  cleanupExpiredOTPs,
  getAllUserPermissions,
  getUserShopPermissions,
  checkShopPermission,
  checkRole,
  isAdminOrAbove,
  requireRole,
  requireShopPerm,
};
