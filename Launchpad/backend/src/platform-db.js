// ---------------------------------------------------------------------------
// platform-db.js — ADR-001 "Shuttle Dev Tool"
//
// All state the dev tool adds lives in ONE new file, backend/data/platform.db.
// shops.db holds 2 MB of live analytics and users.db holds the only copy of the
// user list; neither is worth the risk of a wide migration. Keeping the new
// tables in their own file also means a rollback is "delete platform.db".
//
// Cross-database references are by value (user_id INTEGER, shop_slug TEXT).
// SQLite cannot enforce a FOREIGN KEY across files, so there are none here.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.LAUNCHPAD_DATA_DIR || path.join(__dirname, '..', 'data');
const PLATFORM_DB_PATH = path.join(DATA_DIR, 'platform.db');
const USERS_DB_PATH = path.join(DATA_DIR, 'users.db');
const SHOPS_DB_PATH = path.join(DATA_DIR, 'shops.db');

// ---------------------------------------------------------------------------
// Opening the database must never stop the server from starting.
//
// This module is required transitively by authz.js at the top of index.js, so a
// throw here used to take the whole backend down at boot, and with it every
// shop's admin console: a corrupt platform.db, an unreadable one, or a data
// directory that is not writable each exited the process with an uncaught
// SqliteError before a single route was mounted.
//
// So: try the real file, and if it cannot be opened, say so loudly and fall
// back to an in-memory database. The ADR's own features degrade (audit rows,
// access requests, tickets, stagings and locks stop surviving a restart) while
// everything that predates ADR-001 keeps working. Nothing gets MORE permissive:
// memberships and roles live in users.db, which this fallback does not touch.
// ---------------------------------------------------------------------------
let degradedReason = null;

function openPlatformDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    degradedReason = `data directory ${DATA_DIR} could not be created: ${err.message}`;
  }

  if (!degradedReason) {
    try {
      const handle = new Database(PLATFORM_DB_PATH);
      handle.pragma('journal_mode = WAL');
      // A blocked writer waits instead of throwing SQLITE_BUSY. The lock table
      // is written from request handlers that must not fail because another
      // turn is mid-insert.
      handle.pragma('busy_timeout = 5000');
      // Prove the file is really a database before anything depends on it. A
      // corrupt file opens fine and only throws on first use, which would be
      // somewhere much less convenient than here.
      handle.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      return handle;
    } catch (err) {
      degradedReason = `${PLATFORM_DB_PATH} could not be opened: ${err.message}`;
    }
  }

  console.error('='.repeat(72));
  console.error(`[platform-db] DEGRADED: ${degradedReason}`);
  console.error('[platform-db] Falling back to an in-memory database. The server is up and');
  console.error('[platform-db] every shop admin works, but audit history, access requests,');
  console.error('[platform-db] upload tickets, stagings and locks will not survive a restart.');
  console.error('[platform-db] Fix the file or the permissions and restart. Tell Gio.');
  console.error('='.repeat(72));
  try {
    const memory = new Database(':memory:');
    memory.pragma('busy_timeout = 5000');
    return memory;
  } catch (err) {
    // Nothing left to fall back to. Hand out an object that refuses rather than
    // one that throws TypeError halfway through a request.
    degradedReason = `${degradedReason}; in-memory fallback also failed: ${err.message}`;
    const dead = () => { throw new Error(`platform.db is unavailable: ${degradedReason}`); };
    return { prepare: dead, exec: dead, pragma: dead, transaction: dead, close: () => {} };
  }
}

const db = openPlatformDb();

const SCHEMA = `
  -- Every privileged action, in one place, queryable by shop and by user.
  -- The existing data/audit.log file keeps being written too; this table is
  -- what the tool reads back ("who changed this shop last week").
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    user_id    INTEGER,
    username   TEXT,
    shop_slug  TEXT,
    action     TEXT NOT NULL,
    detail     TEXT,
    via        TEXT NOT NULL DEFAULT 'web'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_shop_ts ON audit_log (shop_slug, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit_log (user_id, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log (action, ts);

  CREATE TABLE IF NOT EXISTS access_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_slug      TEXT NOT NULL,
    user_id        INTEGER NOT NULL,
    requested_role TEXT NOT NULL DEFAULT 'editor',
    reason         TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending | granted | denied | withdrawn
    created_at     INTEGER NOT NULL,
    decided_at     INTEGER,
    decided_by     INTEGER,
    decision_note  TEXT
  );
  -- One open request per person per shop, so a retry does not spam the owners.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_access_req_open
    ON access_requests (shop_slug, user_id) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_access_req_shop ON access_requests (shop_slug, status);

  -- Per-shop advisory lock. Primary key on shop_slug is what makes the second
  -- caller lose the race even across processes.
  CREATE TABLE IF NOT EXISTS shop_locks (
    shop_slug    TEXT PRIMARY KEY,
    held_by      INTEGER,
    held_by_name TEXT,
    action       TEXT NOT NULL,
    since        INTEGER NOT NULL,
    token        TEXT NOT NULL
  );

  -- ---------------------------------------------------------------------
  -- The four tables below belong to agents B and C. They are created here so
  -- there is ONE migration entry point, but the column names and types are
  -- THEIRS, copied verbatim from upload-ticket.js, staging.js and golive.js.
  -- Those modules run the same CREATE TABLE IF NOT EXISTS themselves, so
  -- whichever runs first wins: if these ever drift, the module that owns the
  -- table starts reading columns that are not there. Do not "tidy" them.
  -- ---------------------------------------------------------------------

  -- Agent B — backend/src/upload-ticket.js
  CREATE TABLE IF NOT EXISTS upload_tickets (
    id          TEXT PRIMARY KEY,
    shop_slug   TEXT NOT NULL,
    user_id     INTEGER NOT NULL,
    via         TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    used_ip     TEXT,
    upload_path TEXT,
    bytes       INTEGER,
    staging_id  TEXT,
    staged_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_upload_tickets_shop ON upload_tickets(shop_slug);
  CREATE INDEX IF NOT EXISTS idx_upload_tickets_expiry ON upload_tickets(expires_at);

  -- Agent B — backend/src/staging.js
  CREATE TABLE IF NOT EXISTS database_stagings (
    id             TEXT PRIMARY KEY,
    shop_slug      TEXT NOT NULL,
    user_id        INTEGER,
    ticket_id      TEXT,
    created_at     INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'staged',
    blocking_count INTEGER NOT NULL DEFAULT 0,
    warning_count  INTEGER NOT NULL DEFAULT 0,
    diff_json      TEXT NOT NULL,
    applied_at     INTEGER,
    backup_id      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_database_stagings_shop ON database_stagings(shop_slug);

  -- Agent C — backend/src/golive.js
  CREATE TABLE IF NOT EXISTS approvals (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_slug         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | changes_requested | withdrawn
    requested_by      INTEGER NOT NULL,
    requested_at      INTEGER NOT NULL,
    note              TEXT DEFAULT '',
    client_email      TEXT NOT NULL,
    token_hash        TEXT NOT NULL,   -- sha256 of the review token; the token itself is never stored
    token_issued_at   INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    preflight_json    TEXT DEFAULT '',
    decided_at        INTEGER,
    decided_by_name   TEXT,
    decided_by_email  TEXT,
    decided_ip        TEXT,
    decided_user_agent TEXT,
    withdrawn_at      INTEGER,
    withdrawn_by      INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_token_hash ON approvals(token_hash);
  CREATE INDEX IF NOT EXISTS idx_approvals_shop ON approvals(shop_slug, requested_at DESC);

  -- Agent C — backend/src/golive.js
  CREATE TABLE IF NOT EXISTS review_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id INTEGER NOT NULL,
    shop_slug   TEXT NOT NULL,
    target_type TEXT NOT NULL,          -- page | product | general
    target_ref  TEXT DEFAULT '',
    body        TEXT NOT NULL,
    author_name TEXT DEFAULT '',
    author_email TEXT DEFAULT '',
    created_at  INTEGER NOT NULL,
    created_ip  TEXT,
    resolved    INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER,
    resolved_by INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_review_comments_approval ON review_comments(approval_id);

  -- Agent F — static tool tokens.
  --
  -- The tool server accepts two kinds of credential: an OAuth access token it
  -- mints itself, and a static token issued here (prefix lpmcp_). Only the
  -- SHA-256 is stored, so a copy of this file yields no usable token. There is
  -- no minting UI yet; rows are inserted by hand or by a later Profile page,
  -- and POST /api/mcp/token/introspect is the only reader.
  CREATE TABLE IF NOT EXISTS mcp_static_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL,
    label      TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_static_tokens_user ON mcp_static_tokens(user_id);

  -- A first sign in that has been started but not yet proved.
  --
  -- The ADR says "verify; if no user -> INSERT INTO users", and Launchpad's OTP
  -- routes only mail a user that already exists. Those two facts do not fit
  -- together on their own: a colleague who has never signed in has no row to
  -- send a code to. The first build resolved that by creating the users row on
  -- email submission, which meant anyone who could reach the login page could
  -- write an @lrparis.com row into the user admin, under any name they liked.
  --
  -- This table is the missing middle. It holds the claim on an address for as
  -- long as the code is good and no longer. It is not a user: it has no id
  -- anyone can be granted access to, it never appears in the user admin, and it
  -- carries nothing but the right to become a users row by answering mail.
  CREATE TABLE IF NOT EXISTS pending_enrollments (
    email      TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pending_enroll_expiry ON pending_enrollments(expires_at);
`;

// ---------------------------------------------------------------------------
// users.db migration — the membership model
//
// The ADR asks for a shop_members table. One already exists in all but name:
// user_shop_permissions. Adding a role column to it keeps a single source of
// truth; the legacy booleans stay in sync so the current Launchpad UI and the
// existing checkShopPermission() calls keep working untouched.
// ---------------------------------------------------------------------------
function columnNames(handle, table) {
  try {
    return handle.pragma(`table_info(${table})`).map((c) => c.name);
  } catch {
    return [];
  }
}

function addColumnIfMissing(handle, table, column, ddl) {
  if (columnNames(handle, table).includes(column)) return false;
  handle.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

// Most generous wins, so the migration can never take access away from anyone.
const BACKFILL_SQL = `
  UPDATE user_shop_permissions
     SET role = CASE
                  WHEN can_delete = 1                            THEN 'owner'
                  WHEN can_edit_ui = 1 OR can_edit_items = 1     THEN 'editor'
                  ELSE 'viewer'
                END
   WHERE role IS NULL OR role = ''
`;

function migrateUsersDb({ verbose = false } = {}) {
  if (!fs.existsSync(USERS_DB_PATH)) {
    // Fresh install: users.js creates the tables at boot, and initPlatformDb()
    // runs after initUsersDb(), so this only happens in isolated tests.
    return { skipped: 'users.db not present' };
  }
  const users = new Database(USERS_DB_PATH);
  try {
    users.pragma('busy_timeout = 5000');
    if (!columnNames(users, 'user_shop_permissions').length) {
      return { skipped: 'user_shop_permissions not present' };
    }
    const added = [];
    if (addColumnIfMissing(users, 'user_shop_permissions', 'role', 'role TEXT')) added.push('role');
    if (addColumnIfMissing(users, 'user_shop_permissions', 'granted_by', 'granted_by INTEGER')) added.push('granted_by');
    if (addColumnIfMissing(users, 'user_shop_permissions', 'granted_at', 'granted_at INTEGER')) added.push('granted_at');

    // Idempotent by construction: only rows with no role yet are touched.
    const backfilled = users.prepare(BACKFILL_SQL).run().changes;
    if (verbose && (added.length || backfilled)) {
      console.log(`[platform-db] users.db: added [${added.join(', ') || 'none'}], backfilled ${backfilled} role(s)`);
    }
    return { added, backfilled };
  } finally {
    users.close();
  }
}

// ---------------------------------------------------------------------------
// shops.db — one additive column.
//
// The live shops.db already has `stage`, but nothing in the code creates it, so
// a fresh checkout (and every test) comes up without it and the ADR's stage
// gate cannot run. This is an ADD COLUMN with a default, which rewrites no
// rows. It is deliberately the only thing this module does to shops.db.
// ---------------------------------------------------------------------------
function migrateShopsDb({ verbose = false } = {}) {
  if (!fs.existsSync(SHOPS_DB_PATH)) return { skipped: 'shops.db not present' };
  const shops = new Database(SHOPS_DB_PATH);
  try {
    shops.pragma('busy_timeout = 5000');
    if (!columnNames(shops, 'shops').length) return { skipped: 'shops table not present' };
    const added = addColumnIfMissing(shops, 'shops', 'stage', "stage TEXT DEFAULT 'no_status'");
    if (verbose && added) console.log('[platform-db] shops.db: added stage column');
    return { added: added ? ['stage'] : [] };
  } finally {
    shops.close();
  }
}

let _initialized = false;

// Never throws. A failure here is logged and reported; boot continues.
function initPlatformDb(opts = {}) {
  const result = { platform: 'ok', users: null, shops: null, degraded: degradedReason };
  try {
    db.exec(SCHEMA);
  } catch (err) {
    result.platform = `failed: ${err.message}`;
    console.error(`[platform-db] schema could not be created: ${err.message}`);
    console.error('[platform-db] The dev tool features will not work. The rest of Launchpad will.');
  }
  try {
    result.users = migrateUsersDb(opts);
  } catch (err) {
    result.users = { failed: err.message };
    console.error(`[platform-db] users.db migration failed: ${err.message}`);
  }
  try {
    result.shops = migrateShopsDb(opts);
  } catch (err) {
    result.shops = { failed: err.message };
    console.error(`[platform-db] shops.db migration failed: ${err.message}`);
  }
  _initialized = true;
  return result;
}

module.exports = {
  db,
  initPlatformDb,
  migrateUsersDb,
  migrateShopsDb,
  PLATFORM_DB_PATH,
  USERS_DB_PATH,
  SHOPS_DB_PATH,
  DATA_DIR,
  isInitialized: () => _initialized,
  // Truthy when platform.db could not be opened and the in-memory fallback is
  // carrying the ADR features. /api/health reports it.
  degradedReason: () => degradedReason,
};
