#!/usr/bin/env node
// ---------------------------------------------------------------------------
// migrate-adr001.js — bring an existing Launchpad up to ADR-001.
//
//   node backend/scripts/migrate-adr001.js --dry-run     # say what would happen
//   node backend/scripts/migrate-adr001.js               # do it
//
// Safe to run twice. Everything it does is additive:
//   * creates data/platform.db and its tables
//   * adds role / granted_by / granted_at to user_shop_permissions
//   * adds stage to shops (the live database already has it; a fresh one does not)
//   * fills in a role for every existing permission row, most generous wins,
//     so nobody comes out of this with less access than they went in with
//   * makes the admin an owner of every existing shop, so no shop is ownerless
//     and every refusal has a real person to name
//
// It never deletes a row, never narrows a permission, and never touches the
// legacy booleans on anyone else's row.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('-n');
const adminArg = args.find((a) => a.startsWith('--admin-id='));
const ADMIN_ID = adminArg ? Number(adminArg.split('=')[1]) : 1;

const DATA_DIR = process.env.LAUNCHPAD_DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_DB = path.join(DATA_DIR, 'users.db');
const SHOPS_DB = path.join(DATA_DIR, 'shops.db');
const PLATFORM_DB = path.join(DATA_DIR, 'platform.db');

const plan = [];
const notes = [];
let problems = 0;

function will(text) { plan.push(text); }
function note(text) { notes.push(text); }
function fail(text) {
  problems++;
  notes.push(`PROBLEM: ${text}`);
  console.log(`PROBLEM: ${text}`);
}

function heading(text) {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function columns(db, table) {
  try { return db.pragma(`table_info(${table})`).map((c) => c.name); } catch { return []; }
}

const ROLE_BOOLEANS = {
  owner: { can_delete: 1, can_edit_ui: 1, can_edit_items: 1, can_view_orders: 1, can_view_analytics: 1 },
  editor: { can_delete: 0, can_edit_ui: 1, can_edit_items: 1, can_view_orders: 1, can_view_analytics: 1 },
  viewer: { can_delete: 0, can_edit_ui: 0, can_edit_items: 0, can_view_orders: 1, can_view_analytics: 1 },
};

function roleFor(row) {
  if (row.can_delete) return 'owner';
  if (row.can_edit_ui || row.can_edit_items) return 'editor';
  return 'viewer';
}

// Read the world BEFORE anything is written, so the report describes the state
// the operator is actually looking at rather than the state we just created.
function survey() {
  const out = { permissionRows: 0, needsRole: [], permissionCols: [], hasStage: null, slugs: [] };
  if (fs.existsSync(USERS_DB)) {
    const users = new Database(USERS_DB, { readonly: true });
    try {
      out.permissionCols = columns(users, 'user_shop_permissions');
      if (out.permissionCols.length) {
        const rows = users.prepare('SELECT * FROM user_shop_permissions').all();
        out.permissionRows = rows.length;
        out.needsRole = out.permissionCols.includes('role') ? rows.filter((r) => !r.role) : rows;
      }
    } finally { users.close(); }
  }
  if (fs.existsSync(SHOPS_DB)) {
    const shops = new Database(SHOPS_DB, { readonly: true });
    try {
      out.hasStage = columns(shops, 'shops').includes('stage');
      out.slugs = shops.prepare('SELECT slug FROM shops ORDER BY slug').all().map((r) => r.slug);
    } finally { shops.close(); }
  }
  return out;
}

function main() {
  console.log(`ADR-001 migration${DRY ? '  (DRY RUN — nothing will be written)' : ''}`);
  console.log(`data directory: ${DATA_DIR}`);

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`\nThere is no data directory at ${DATA_DIR}. Run this on the server, or set LAUNCHPAD_DATA_DIR.`);
    process.exit(1);
  }

  const before = survey();

  // -- platform.db --------------------------------------------------------
  heading('1. data/platform.db');
  const platformExisted = fs.existsSync(PLATFORM_DB);
  console.log(platformExisted ? 'exists already' : 'does not exist yet');
  if (DRY) {
    will(platformExisted
      ? 'open data/platform.db and create any missing tables (no-op if it is already current)'
      : 'create data/platform.db with audit_log, access_requests, shop_locks, upload_tickets, database_stagings, approvals, review_comments');
    console.log(`would ${platformExisted ? 'top up' : 'create'}: audit_log, access_requests, shop_locks, upload_tickets, database_stagings, approvals, review_comments`);
  } else {
    // initPlatformDb also runs the users.db and shops.db column adds.
    const { initPlatformDb, db } = require('../src/platform-db');
    initPlatformDb({ verbose: false });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
    console.log(`tables: ${tables.join(', ')}`);
    note(`platform.db ${platformExisted ? 'updated' : 'created'} with ${tables.length} table(s)`);
  }

  // -- users.db -----------------------------------------------------------
  heading('2. users.db — user_shop_permissions');
  if (!fs.existsSync(USERS_DB)) {
    fail('users.db is missing. Start the backend once so it is created, then run this again.');
  } else {
    const users = new Database(USERS_DB, { readonly: DRY });
    try {
      const cols = before.permissionCols; // pre-migration snapshot
      if (!cols.length) {
        fail('user_shop_permissions does not exist. Start the backend once, then run this again.');
      } else {
        for (const [col, ddl] of [['role', 'role TEXT'], ['granted_by', 'granted_by INTEGER'], ['granted_at', 'granted_at INTEGER']]) {
          if (cols.includes(col)) {
            console.log(`${col}: already there`);
          } else if (DRY) {
            console.log(`${col}: MISSING`);
            will(`ALTER TABLE user_shop_permissions ADD COLUMN ${ddl}`);
          } else {
            console.log(`${col}: added`);
          }
        }

        // Counted before anything was written, so the numbers are the ones the
        // operator would have seen had they looked first.
        const rows = before.permissionRows;
        const needsRole = before.needsRole;
        const counts = { owner: 0, editor: 0, viewer: 0 };
        for (const r of needsRole) counts[roleFor(r)]++;
        console.log(`\n${rows} permission row(s); ${needsRole.length} without a role yet.`);
        if (needsRole.length) {
          console.log(`would become: ${counts.owner} owner, ${counts.editor} editor, ${counts.viewer} viewer`);
          for (const r of needsRole.slice(0, 8)) {
            console.log(`  user ${r.user_id} on ${r.shop_slug}: ${roleFor(r)}`);
          }
          if (needsRole.length > 8) console.log(`  ... and ${needsRole.length - 8} more`);
          will(`backfill ${needsRole.length} role(s), most generous wins, leaving every legacy boolean exactly as it is`);
        }
        if (!DRY) note(`${needsRole.length} role(s) backfilled`);
      }
    } finally {
      users.close();
    }
  }

  // -- shops.db -----------------------------------------------------------
  heading('3. shops.db — stage column');
  if (!fs.existsSync(SHOPS_DB)) {
    fail('shops.db is missing. Start the backend once so it is created, then run this again.');
  } else {
    const has = before.hasStage;
    console.log(has ? 'stage: already there' : `stage: ${DRY ? 'MISSING' : 'added'}`);
    if (!has && DRY) will("ALTER TABLE shops ADD COLUMN stage TEXT DEFAULT 'no_status'");
  }

  // -- admin ownership ----------------------------------------------------
  heading('4. admin ownership of every shop');
  if (fs.existsSync(SHOPS_DB) && fs.existsSync(USERS_DB)) {
    const slugs = before.slugs;

    const users = new Database(USERS_DB, { readonly: DRY });
    try {
      const admin = users.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(ADMIN_ID);
      if (!admin) {
        fail(`there is no user with id ${ADMIN_ID}. Pass --admin-id=<id> with the right one.`);
      } else {
        if (admin.role !== 'super_admin') {
          fail(`user ${ADMIN_ID} (${admin.username}) is not a super_admin. Pass --admin-id=<id> with the right one, or promote them first.`);
        }
        console.log(`admin: ${admin.name} (${admin.username}, id ${admin.id})`);
        console.log(`${slugs.length} shop(s) in shops.db`);

        // Use the pre-migration snapshot: after the backfill every row has a
        // role, and "already an owner" must mean it was one before we started.
        const byShop = new Map();
        {
          const snapshot = new Database(USERS_DB, { readonly: true });
          try {
            for (const r of snapshot.prepare('SELECT * FROM user_shop_permissions WHERE user_id = ?').all(admin.id)) {
              byShop.set(r.shop_slug, { ...r, role: r.role || (r.can_delete ? 'owner' : null) });
            }
          } finally { snapshot.close(); }
        }
        const toAdd = [];
        const toRaise = [];
        for (const slug of slugs) {
          const row = byShop.get(slug);
          if (!row) toAdd.push(slug);
          else if (row.role !== 'owner') toRaise.push(slug);
        }

        console.log(`\nnew owner rows:   ${toAdd.length}${toAdd.length ? ` (${toAdd.join(', ')})` : ''}`);
        console.log(`raised to owner:  ${toRaise.length}${toRaise.length ? ` (${toRaise.join(', ')})` : ''}`);
        console.log('nobody else\'s row is touched.');

        if (DRY) {
          if (toAdd.length || toRaise.length) {
            will(`make ${admin.name} owner of ${toAdd.length + toRaise.length} shop(s)`);
          }
        } else if (columns(users, 'user_shop_permissions').includes('role')) {
          const b = ROLE_BOOLEANS.owner;
          const stmt = users.prepare(`
            INSERT INTO user_shop_permissions
              (user_id, shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders, can_view_analytics, role, granted_by, granted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?)
            ON CONFLICT(user_id, shop_slug) DO UPDATE SET
              can_delete = excluded.can_delete, can_edit_ui = excluded.can_edit_ui,
              can_edit_items = excluded.can_edit_items, can_view_orders = excluded.can_view_orders,
              can_view_analytics = excluded.can_view_analytics,
              role = 'owner', granted_by = excluded.granted_by, granted_at = excluded.granted_at
          `);
          const now = Date.now();
          const txn = users.transaction((list) => {
            for (const slug of list) {
              stmt.run(admin.id, slug, b.can_delete, b.can_edit_ui, b.can_edit_items, b.can_view_orders, b.can_view_analytics, admin.id, now);
            }
          });
          txn([...toAdd, ...toRaise]);
          note(`${admin.name} is now owner of ${toAdd.length + toRaise.length} shop(s)`);
        }
      }
    } finally {
      users.close();
    }
  }

  // -- summary ------------------------------------------------------------
  heading(DRY ? 'What a real run would do' : 'What this run did');
  if (DRY) {
    if (plan.length === 0) console.log('Nothing. This Launchpad is already migrated.');
    else plan.forEach((line, i) => console.log(`${i + 1}. ${line}`));
    console.log('\nRun it again without --dry-run to apply.');
  } else {
    if (notes.length === 0) console.log('Nothing to do. This Launchpad was already migrated.');
    else notes.forEach((line) => console.log(`- ${line}`));
  }

  if (problems) {
    console.log(`\n${problems} problem(s) above. Fix them and run this again.`);
    process.exit(1);
  }
  console.log('\nDone. Safe to run again at any time.');
}

main();
