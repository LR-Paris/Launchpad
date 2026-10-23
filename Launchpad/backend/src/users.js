const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const selfSignup = require('./self-signup');

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

  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT,
    backed_up INTEGER DEFAULT 0,
    nickname TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT
  )`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      can_create_shops INTEGER DEFAULT 0,
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
      can_view_analytics INTEGER DEFAULT 0,
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

  // A first sign in that has been started and not yet proved (self-signup.js).
  // Not a user: it never appears in the user admin and holds only the hash of a
  // code that is good for ten minutes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_signups (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      requests INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Addresses nobody may sign up with (self-signup.js): written by deleteUser, so
  // deleting an account keeps revoking access, and by an admin for a shared
  // mailbox. Signing up never clears one. An admin who makes the account by hand
  // does.
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_emails (
      email TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at INTEGER NOT NULL,
      blocked_by TEXT
    )
  `);

  // The people who really work at LR Paris, as another app that has the company
  // directory (LR Parrot, from Microsoft 365) last sent them (sso.js POST
  // /members). Once any exist, only these addresses can sign up: an address
  // nobody has a mailbox for, a shared mailbox or a list gets no code. One set
  // per app, replaced whole each time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS signup_members (
      email TEXT NOT NULL,
      source TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (email, source)
    )
  `);

  // Safe column migrations for existing DBs
  try { db.exec('ALTER TABLE otp_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'); } catch(e) { /* already exists */ }
  try { db.exec('ALTER TABLE user_shop_permissions ADD COLUMN can_view_analytics INTEGER NOT NULL DEFAULT 1'); } catch(e) { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN can_create_shops INTEGER DEFAULT 0'); } catch(e) { /* already exists */ }

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
  return db.prepare('SELECT id, username, email, name, role, can_create_shops, created_at, created_by FROM users').all();
}

function getUserById(id) {
  return db.prepare('SELECT id, username, email, name, role, can_create_shops, created_at, created_by FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserByUsernameOrEmail(identifier) {
  // Case-insensitive: auto-capitalized emails ("G.lupo@...") were silently
  // failing lookup, so no OTP was ever sent while the UI claimed it was.
  return db
    .prepare('SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)')
    .get(identifier, identifier);
}

function createUser({ username, email, name, role, created_by }) {
  const result = db.prepare(
    'INSERT INTO users (username, email, name, role, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(username, email, name, role || 'user', created_by);
  return getUserById(result.lastInsertRowid);
}

function updateUser(id, { username, email, name, role, can_create_shops }) {
  const fields = [];
  const values = [];
  if (username !== undefined) { fields.push('username = ?'); values.push(username); }
  if (email !== undefined) { fields.push('email = ?'); values.push(email); }
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (role !== undefined) { fields.push('role = ?'); values.push(role); }
  if (can_create_shops !== undefined) { fields.push('can_create_shops = ?'); values.push(can_create_shops ? 1 : 0); }
  if (fields.length === 0) return getUserById(id);
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

// Deleting an account is how access is taken away, so it also blocks the address
// from signing itself up again (blocked_emails): without that, the person types
// the email once more and self-signup makes a new account, and through Sign in
// with Launchpad a way back into every app. `by` is who deleted it.
function deleteUser(id, by) {
  const row = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
  db.transaction(() => {
    if (row) blockEmail(row.email, { by, reason: 'account deleted' });
    db.prepare('DELETE FROM user_shop_permissions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM otp_codes WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
}

function getUserCount() {
  return db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
}

// ---------------------------------------------------------------------------
// Per-shop permission helpers
// ---------------------------------------------------------------------------
function getUserShopPermissions(userId, shopSlug) {
  return db.prepare(
    'SELECT can_delete, can_edit_ui, can_edit_items, can_view_orders, can_view_analytics FROM user_shop_permissions WHERE user_id = ? AND shop_slug = ?'
  ).get(userId, shopSlug) || { can_delete: 0, can_edit_ui: 0, can_edit_items: 0, can_view_orders: 0, can_view_analytics: 0 };
}

function getAllUserPermissions(userId) {
  const rows = db.prepare(
    'SELECT shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders, can_view_analytics FROM user_shop_permissions WHERE user_id = ?'
  ).all(userId);
  const perms = {};
  for (const row of rows) {
    perms[row.shop_slug] = {
      can_delete: !!row.can_delete,
      can_edit_ui: !!row.can_edit_ui,
      can_edit_items: !!row.can_edit_items,
      can_view_orders: !!row.can_view_orders,
      can_view_analytics: !!row.can_view_analytics,
    };
  }
  return perms;
}

function setUserShopPermissions(userId, shopSlug, perms) {
  db.prepare(`
    INSERT INTO user_shop_permissions (user_id, shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders, can_view_analytics)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, shop_slug) DO UPDATE SET
      can_delete = excluded.can_delete,
      can_edit_ui = excluded.can_edit_ui,
      can_edit_items = excluded.can_edit_items,
      can_view_orders = excluded.can_view_orders,
      can_view_analytics = excluded.can_view_analytics
  `).run(
    userId,
    shopSlug,
    perms.can_delete ? 1 : 0,
    perms.can_edit_ui ? 1 : 0,
    perms.can_edit_items ? 1 : 0,
    perms.can_view_orders ? 1 : 0,
    perms.can_view_analytics ? 1 : 0
  );
}

function deleteUserShopPermissions(userId, shopSlug) {
  db.prepare('DELETE FROM user_shop_permissions WHERE user_id = ? AND shop_slug = ?').run(userId, shopSlug);
}

// ---------------------------------------------------------------------------
// OTP helpers
// ---------------------------------------------------------------------------
// OTP pepper — codes are stored only as HMAC(code), never plaintext, so a read
// of users.db yields nothing usable. Falls back to SESSION_SECRET if unset.
const OTP_PEPPER = process.env.OTP_PEPPER || process.env.SESSION_SECRET || 'launchpad-otp';
function hashOTP(code) {
  return crypto.createHmac('sha256', OTP_PEPPER).update(String(code)).digest('hex');
}

// Per-account brake, independent of IP/identifier string. A burst of code
// requests for one account (the Oct 2026 bot: 9 in 65s) all resolve to the same
// user id and are stopped here even when every request rides a different IP.
// Returns { ok } or { ok:false, reason, retryAfterSec }.
function canIssueOTP(userId) {
  const now = Date.now();
  const TEN_MIN = 10 * 60 * 1000;
  // expires_at = issue_time + 10min. The freshest code is unused and unexpired,
  // so it survives cleanup and makes the cooldown reliable.
  const maxExp = db.prepare('SELECT MAX(expires_at) AS e FROM otp_codes WHERE user_id = ?').get(userId).e;
  if (maxExp && (maxExp - TEN_MIN) > now - 60 * 1000) {
    return { ok: false, reason: 'cooldown', retryAfterSec: 60 };
  }
  // No more than 5 codes issued in the last 15 min for one account.
  const issued = db.prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE user_id = ? AND expires_at > ?')
    .get(userId, now - 5 * 60 * 1000).n;
  if (issued >= 5) {
    return { ok: false, reason: 'too_many_codes', retryAfterSec: 900 };
  }
  return { ok: true };
}

function generateOTP(userId) {
  // Invalidate any existing unused OTPs for this user
  db.prepare('UPDATE otp_codes SET used = 1 WHERE user_id = ? AND used = 0').run(userId);

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Store only the HMAC of the code, never the code itself.
  db.prepare(
    'INSERT INTO otp_codes (user_id, code, expires_at) VALUES (?, ?, ?)'
  ).run(userId, hashOTP(code), expiresAt);

  return code;
}

const OTP_MAX_ATTEMPTS = 5;

function verifyOTP(userId, code) {
  // Compare against the stored HMAC, not plaintext. Fetch the live code for the
  // user (generateOTP keeps at most one unused), then timing-safe compare.
  const row = db.prepare(
    'SELECT id, code, attempts FROM otp_codes WHERE user_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1'
  ).get(userId, Date.now());

  if (!row) return false;
  // The fifth wrong try burns the code, as for a first sign in (spendSignupCode):
  // the limiter in index.js counts per IP, so on its own it cannot stop a guess
  // spread over many addresses of one person.
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
    return false;
  }

  const a = Buffer.from(String(row.code));
  const b = Buffer.from(hashOTP(String(code).trim()));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1, used = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END WHERE id = ?')
      .run(OTP_MAX_ATTEMPTS, row.id);
    return false;
  }

  // Mark as used
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
  return true;
}

// ---------------------------------------------------------------------------
// Self-signup (self-signup.js): the code for an address with no account yet
//
// One row per address, replaced by each new code, the way generateOTP retires a
// user's earlier code. The same hash as otp_codes, the same ten minutes. The row
// also remembers when this address last asked and how many codes it has had in
// the current fifteen minutes, which is the per-address brake (an address with no
// account has no user id for canIssueOTP to count against).
// ---------------------------------------------------------------------------
const SIGNUP_TTL_MS = 10 * 60 * 1000; // same as generateOTP, on purpose
const SIGNUP_MAX_ATTEMPTS = 5;
const SIGNUP_COOLDOWN_MS = 60 * 1000;
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_MAX_CODES = 5;

// Same shape as canIssueOTP: { ok } or { ok:false, reason, retryAfterSec }.
function canIssueSignupCode(email) {
  const now = Date.now();
  const row = db.prepare('SELECT created_at, window_start, requests FROM pending_signups WHERE email = ?').get(email);
  if (!row) return { ok: true };
  if (now - row.created_at < SIGNUP_COOLDOWN_MS) return { ok: false, reason: 'cooldown', retryAfterSec: 60 };
  if (now - row.window_start < SIGNUP_WINDOW_MS && row.requests >= SIGNUP_MAX_CODES) {
    return { ok: false, reason: 'too_many_codes', retryAfterSec: Math.ceil((row.window_start + SIGNUP_WINDOW_MS - now) / 1000) };
  }
  return { ok: true };
}

function issueSignupCode(email) {
  const now = Date.now();
  const code = crypto.randomInt(100000, 999999).toString();
  const prev = db.prepare('SELECT window_start, requests FROM pending_signups WHERE email = ?').get(email);
  const sameWindow = prev && now - prev.window_start < SIGNUP_WINDOW_MS;
  db.prepare(`
    INSERT INTO pending_signups (email, code, expires_at, attempts, created_at, window_start, requests)
    VALUES (?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      code = excluded.code, expires_at = excluded.expires_at, attempts = 0,
      created_at = excluded.created_at, window_start = excluded.window_start, requests = excluded.requests
  `).run(email, hashOTP(code), now + SIGNUP_TTL_MS, now, sameWindow ? prev.window_start : now, sameWindow ? prev.requests + 1 : 1);
  return code;
}

// Right code: the row is spent. Wrong code: one attempt used, and the fifth wrong
// one ends this code (the right code is refused after that, ask for a new one).
// Returns null when the code is good, or why not (for the audit log only: every
// reason gets the same answer on the wire).
function spendSignupCode(email, code) {
  const row = db.prepare('SELECT code, expires_at, attempts FROM pending_signups WHERE email = ?').get(email);
  if (!row) return 'no_pending_code';
  if (row.expires_at <= Date.now()) return 'expired';
  if (row.attempts >= SIGNUP_MAX_ATTEMPTS) return 'too_many_attempts';

  const a = Buffer.from(String(row.code));
  const b = Buffer.from(hashOTP(String(code).trim()));
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    db.prepare('UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ?').run(email);
    return 'invalid_otp';
  }
  db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
  return null;
}

// "arnaud.messager" -> "arnaud.messager", then "arnaud.messager2" if taken. The
// check ignores case: usernames are matched that way at sign in.
function freeUsername(email, skip = 0) {
  const base = selfSignup.usernameBase(email);
  for (let n = 1 + skip; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}${n}`;
    if (!db.prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)').get(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// The proof step of a first sign in: spend the code and, if it was right, make
// the account, in one transaction so a failure after the code is spent gives the
// code back. Returns { user, created } or { reason }. An account that appeared in
// the meantime (an admin made one, a parallel request won) is not an error: the
// code was right, so that person is signed in as themselves, and never twice.
// The account is looked up by its email alone: the code proves this mailbox, so
// it must never open an account that merely has this text as its username.
function verifySignupCode(email, code) {
  const byEmail = () => db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  return db.transaction(() => {
    const reason = spendSignupCode(email, code);
    if (reason) return { reason };
    const existing = byEmail();
    if (existing) return { user: existing, created: false };

    for (let skip = 0; skip < 5; skip += 1) {
      try {
        const user = createUser({
          username: freeUsername(email, skip),
          email,
          name: selfSignup.displayName(email),
          role: 'user',
          created_by: 'self-signup',
        });
        return { user, created: true };
      } catch {
        // UNIQUE(email) lost to another writer: they made the account. UNIQUE(username):
        // that name was just taken, so the loop tries the next one.
        const raced = byEmail();
        if (raced) return { user: raced, created: false };
      }
    }
    throw new Error('no free username');
  })();
}

// ---------------------------------------------------------------------------
// Who may sign themselves up (self-signup.js, and the dev tool's first sign in)
//
// Two lists, both read only when an address has no account yet; an account that
// exists signs in as it always did.
//   blocked_emails   addresses nobody gets an account with: deleted accounts, and
//                    whatever an admin adds (info@, a list that takes mail).
//   signup_members   the people who really work here, from LR Parrot's copy of
//                    the Microsoft 365 directory. Empty (nothing ever sent):
//                    every address in an allowed domain may sign up, as before.
//                    Not empty: only those. A new hire is in it after the next
//                    directory sync (POST /api/admin/directory/sync in LR Parrot).
// ---------------------------------------------------------------------------
const normalEmail = (email) => String(email || '').trim().toLowerCase();

function blockEmail(email, { by, reason } = {}) {
  db.prepare(`
    INSERT INTO blocked_emails (email, reason, blocked_at, blocked_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at, blocked_by = excluded.blocked_by
  `).run(normalEmail(email), reason || null, Date.now(), by || null);
}

function unblockEmail(email) {
  return db.prepare('DELETE FROM blocked_emails WHERE email = ?').run(normalEmail(email)).changes;
}

function isBlocked(email) {
  return Boolean(db.prepare('SELECT 1 FROM blocked_emails WHERE email = ?').get(normalEmail(email)));
}

function listBlocked() {
  return db.prepare('SELECT email, reason, blocked_at, blocked_by FROM blocked_emails ORDER BY blocked_at DESC').all();
}

// Replaces what `source` sent last time, whole, in one transaction.
function replaceSignupMembers(source, emails) {
  const now = Date.now();
  const insert = db.prepare('INSERT OR IGNORE INTO signup_members (email, source, synced_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM signup_members WHERE source = ?').run(source);
    for (const email of emails) insert.run(normalEmail(email), source, now);
  })();
}

function signupMemberCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM signup_members').get().n;
}

function isSignupMember(email) {
  return Boolean(db.prepare('SELECT 1 FROM signup_members WHERE email = ?').get(normalEmail(email)));
}

// { ok } or { ok: false, reason: 'blocked' | 'not_a_member' }, for an address with no account.
function signupAllowed(email) {
  const e = normalEmail(email);
  if (isBlocked(e)) return { ok: false, reason: 'blocked' };
  if (signupMemberCount() > 0 && !isSignupMember(e)) return { ok: false, reason: 'not_a_member' };
  return { ok: true };
}

// Cleanup expired OTPs periodically
function cleanupExpiredOTPs() {
  db.prepare('DELETE FROM otp_codes WHERE expires_at < ? OR used = 1').run(Date.now() - 60 * 60 * 1000);
  // A pending signup is kept until its fifteen minute window is over, then it
  // is gone: a code that was never used leaves nothing behind.
  db.prepare('DELETE FROM pending_signups WHERE created_at < ?').run(Date.now() - SIGNUP_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Permission check helpers (for use in route handlers)
// ---------------------------------------------------------------------------
// ADR-001: an account role only means something on the web console. A signed
// tool request is never an admin, even when the row says super_admin, so every
// check that reads the role has to ask how the request arrived. Without this,
// "admin" leaked back in through the legacy boolean checks in files.js and
// orders.js, which call checkShopPermission rather than requireShopAccess.
function isWebAdmin(req) {
  const user = req.session?.user;
  if (!user) return false;
  if (req.via === 'mcp') return false;
  return user.role === 'super_admin' || user.role === 'admin';
}

function checkShopPermission(req, permission) {
  const user = req.session?.user;
  if (!user) return false;
  if (isWebAdmin(req)) return true;
  const perms = getUserShopPermissions(user.id, req.params.slug);
  return perms && !!perms[permission];
}

function checkRole(req, ...roles) {
  if (req.via === 'mcp') return false;
  return req.session?.user && roles.includes(req.session.user.role);
}

function isAdminOrAbove(req) {
  return checkRole(req, 'super_admin', 'admin');
}

// Middleware factories
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    // Fails closed for a signed tool request whatever the account role says.
    // denyMcp in index.js already keeps the tool server off these mounts; this
    // is the same answer given one layer down, so a router mounted somewhere
    // else later still gets it.
    if (req.via === 'mcp') {
      return res.status(403).json({
        error: {
          code: 'ADMIN_ONLY',
          message: 'That is admin only, and the dev tool never acts as an admin.',
          resolution: 'Ask Gio to do this from the Launchpad console.',
          possible: false,
        },
      });
    }
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

// GET /api/users/blocked — addresses nobody can sign up with (deleted accounts, and what an admin added)
router.get('/blocked', requireRole('super_admin'), (req, res) => {
  res.json({ blocked: listBlocked() });
});

// POST /api/users/blocked {email, reason?} — block an address, for a shared mailbox or a list
router.post('/blocked', requireRole('super_admin'), (req, res) => {
  const audit = req.app.locals.auditLog;
  const email = normalEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  blockEmail(email, { by: req.session.user.username, reason: String(req.body?.reason || 'blocked by an admin').slice(0, 200) });
  audit?.('signup_blocked', { req, details: { email } });
  res.status(201).json({ blocked: listBlocked() });
});

// DELETE /api/users/blocked/:email — let an address sign up again
router.delete('/blocked/:email', requireRole('super_admin'), (req, res) => {
  const audit = req.app.locals.auditLog;
  if (!unblockEmail(req.params.email)) return res.status(404).json({ error: 'That address is not blocked' });
  audit?.('signup_unblocked', { req, details: { email: normalEmail(req.params.email) } });
  res.json({ blocked: listBlocked() });
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
    // An admin making the account by hand is the way back for a blocked address.
    unblockEmail(user.email);

    // Set shop permissions if provided
    if (shopPermissions && typeof shopPermissions === 'object') {
      for (const [slug, perms] of Object.entries(shopPermissions)) {
        setUserShopPermissions(user.id, slug, perms);
      }
    }

    // Access an owner granted before this account existed (pending_grants).
    // Required lazily: authz.js requires this file at load time.
    try { require('./authz').applyPendingGrants(user); } catch (err) {
      console.error(`[users] pending grants for ${user.email} failed: ${err.message}`);
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
    deleteUser(id, req.session.user.username);
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

// ---------------------------------------------------------------------------
// GET /api/me — ADR-001
//
// One call that tells a client who it is, whether it is an admin, and exactly
// which shops it can reach and at what role. Everything else the dev tool does
// starts from this answer.
// ---------------------------------------------------------------------------
const meRouter = express.Router();

meRouter.get('/', (req, res) => {
  // Required lazily: authz reads users.db through its own handle and this file
  // is loaded first at boot.
  const { membershipRole } = require('./authz');
  const { db: platformDb, SHOPS_DB_PATH } = require('./platform-db');

  const sessionUser = req.session.user;
  const user = getUserById(sessionUser.id) || sessionUser;
  const isAdmin = user.role === 'super_admin';
  // The admin bypass is a web-console convenience, so over MCP an admin sees
  // only the shops they were actually granted.
  const seeEverything = isAdmin && req.via !== 'mcp';

  let rows = [];
  try {
    const shopsDb = new Database(SHOPS_DB_PATH, { readonly: true });
    try {
      rows = shopsDb.prepare(
        'SELECT slug, name, status, stage, lifecycle_status, port FROM shops ORDER BY name COLLATE NOCASE'
      ).all();
    } finally {
      shopsDb.close();
    }
  } catch (err) {
    // A brand new install has no shops.db yet. An empty list is the right answer.
    console.error('[me] could not read shops.db:', err.message);
  }

  const shops = [];
  for (const shop of rows) {
    const role = seeEverything ? 'owner' : membershipRole(user.id, shop.slug);
    if (!role) continue;
    shops.push({
      slug: shop.slug,
      name: shop.name,
      role,
      stage: shop.stage || 'no_status',
      status: shop.status || 'unknown',
      lifecycle_status: shop.lifecycle_status || 'none',
    });
  }

  // "Have we ever seen this person do anything?" There is no first_login column
  // and adding one would mean a write on every request; the audit log already
  // answers it and is the only record that matters.
  let firstLogin = false;
  try {
    const seen = platformDb
      .prepare('SELECT 1 FROM audit_log WHERE user_id = ? LIMIT 1')
      .get(user.id);
    firstLogin = !seen;
  } catch { /* if the audit table is unreadable, do not claim a first login */ }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    // Reported the same way it is enforced: over MCP nobody is an admin, so an
    // agent is never told it has an authority the routes will not honour.
    is_admin: seeEverything,
    via: req.via || 'web',
    shops,
    first_login: firstLogin,
  });
});

// ---------------------------------------------------------------------------
// WebAuthn / passkey credential storage
// ---------------------------------------------------------------------------
function addCredential({ userId, credentialId, publicKey, counter, transports, deviceType, backedUp, nickname }) {
  db.prepare(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports, device_type, backed_up, nickname)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, credentialId, publicKey, counter, transports, deviceType, backedUp, nickname);
}

function getCredentialsByUser(userId) {
  return db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id').all(userId);
}

function getCredentialByCredentialId(credentialId) {
  return db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credentialId);
}

function updateCredentialCounter(credentialId, counter) {
  db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE credential_id = ?")
    .run(counter, credentialId);
}

function deleteCredential(userId, credentialId) {
  return db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?')
    .run(userId, credentialId).changes;
}

module.exports = {
  router,
  meRouter,
  initUsersDb,
  getUserById,
  getUserByUsername,
  getUserByEmail,
  getUserByUsernameOrEmail,
  getUserCount,
  createUser,
  generateOTP,
  verifyOTP,
  canIssueOTP,
  canIssueSignupCode,
  issueSignupCode,
  verifySignupCode,
  signupAllowed,
  replaceSignupMembers,
  signupMemberCount,
  blockEmail,
  unblockEmail,
  isBlocked,
  listBlocked,
  cleanupExpiredOTPs,
  addCredential,
  getCredentialsByUser,
  getCredentialByCredentialId,
  updateCredentialCounter,
  deleteCredential,
  getAllUserPermissions,
  getUserShopPermissions,
  checkShopPermission,
  checkRole,
  isAdminOrAbove,
  isWebAdmin,
  requireRole,
  requireShopPerm,
};
