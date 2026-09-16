// ---------------------------------------------------------------------------
// _sandbox.js — build a throwaway copy of the backend for the ADR-001 tests.
//
// Every backend module resolves its data directory as path.join(__dirname,
// '..', 'data'), so the only way to keep a test off the real users.db and
// shops.db is to run the modules from somewhere else. We copy src/ (it is
// small), symlink node_modules and templates, and hand the copy a fresh data/
// and shops/ tree. Nothing under backend/data is ever opened by a test.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.join(__dirname, '..');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

// The live schema, verbatim, so a test can never pass against a schema the
// server does not have.
const USERS_SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')), created_by TEXT,
    can_create_shops INTEGER DEFAULT 0);
  CREATE TABLE user_shop_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, shop_slug TEXT NOT NULL,
    can_delete INTEGER DEFAULT 0, can_edit_ui INTEGER DEFAULT 0, can_edit_items INTEGER DEFAULT 0,
    can_view_orders INTEGER DEFAULT 0, can_view_analytics INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, shop_slug),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code TEXT NOT NULL,
    expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
`;

const SHOPS_SCHEMA = `
  CREATE TABLE shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    status TEXT DEFAULT 'stopped', created_at TEXT DEFAULT (datetime('now')),
    port INTEGER NOT NULL, subdomain TEXT NOT NULL, description TEXT DEFAULT '',
    stage TEXT DEFAULT 'no_status', shuttle_version TEXT DEFAULT NULL,
    lifecycle_status TEXT DEFAULT 'none', is_building INTEGER DEFAULT 0,
    build_started_at INTEGER DEFAULT 0, language TEXT DEFAULT 'en');
`;

// Mirrors the real people and shops closely enough that a refusal message in a
// test reads like one a person would actually get.
const USERS = [
  { id: 1, username: 'admin', email: 'g.lupo@lrparis.com', name: 'Gio', role: 'super_admin' },
  { id: 2, username: 'marc', email: 'marc@lrparis.com', name: 'Marc', role: 'user' },
  { id: 7, username: 'rachael', email: 'r.loiseau@lrparis.com', name: 'Rachael Loiseau', role: 'user' },
  { id: 8, username: 'margot', email: 'm.drevno@lrparis.com', name: 'Margot Drevno', role: 'user' },
];

const SHOPS = [
  { slug: 'serhant', name: 'Serhant', port: 8110, stage: 'in_development' },
  { slug: 'michael-kors', name: 'Michael Kors', port: 8109, stage: 'in_production' },
];

function create({ label = 'adr001', seed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const backend = path.join(root, 'backend');
  fs.mkdirSync(backend, { recursive: true });

  copyDir(path.join(BACKEND, 'src'), path.join(backend, 'src'));
  fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(backend, 'node_modules'), 'dir');
  if (fs.existsSync(path.join(BACKEND, 'templates'))) {
    fs.symlinkSync(path.join(BACKEND, 'templates'), path.join(backend, 'templates'), 'dir');
  }
  fs.mkdirSync(path.join(backend, 'data'), { recursive: true });
  fs.mkdirSync(path.join(backend, 'shops'), { recursive: true });
  fs.mkdirSync(path.join(backend, 'logs'), { recursive: true });

  const Database = require(path.join(BACKEND, 'node_modules', 'better-sqlite3'));
  const usersDbPath = path.join(backend, 'data', 'users.db');
  const shopsDbPath = path.join(backend, 'data', 'shops.db');

  if (seed) {
    const u = new Database(usersDbPath);
    u.exec(USERS_SCHEMA);
    const insU = u.prepare('INSERT INTO users (id, username, email, name, role) VALUES (?, ?, ?, ?, ?)');
    for (const user of USERS) insU.run(user.id, user.username, user.email, user.name, user.role);
    u.close();

    const sdb = new Database(shopsDbPath);
    sdb.exec(SHOPS_SCHEMA);
    const insS = sdb.prepare('INSERT INTO shops (slug, name, port, subdomain, stage) VALUES (?, ?, ?, ?, ?)');
    for (const shop of SHOPS) insS.run(shop.slug, shop.name, shop.port, shop.slug, shop.stage);
    sdb.close();

    for (const shop of SHOPS) {
      fs.mkdirSync(path.join(backend, 'shops', shop.slug, 'DATABASE', 'ShopCollections'), { recursive: true });
    }
  }

  return {
    root,
    backend,
    src: path.join(backend, 'src'),
    dataDir: path.join(backend, 'data'),
    shopsDir: path.join(backend, 'shops'),
    usersDbPath,
    shopsDbPath,
    require: (name) => require(path.join(backend, 'src', name)),
    destroy: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

module.exports = { create, USERS, SHOPS };
