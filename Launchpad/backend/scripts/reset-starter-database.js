#!/usr/bin/env node
// ---------------------------------------------------------------------------
// reset-starter-database.js — put an existing shop on the empty starter.
//
// Until fix/new-shop-flow, POST /api/shops cloned the Shuttle template and kept
// its DATABASE, which is the Michael Kors sample catalog: products, logo,
// fonts, FAQ and the password mk2026. Shops created that way still carry it.
// This puts one of them on the same empty starter new shops now get, so a
// design-first catalog upload can land on it.
//
//   node scripts/reset-starter-database.js <slug>           dry run, changes nothing
//   node scripts/reset-starter-database.js <slug> --apply   backs up, then resets
//
// Refuses a shop in production, a shop with orders on it, and a shop whose
// catalog is not the template sample, unless --force is given. The backup is
// written where rollback_database finds it, so the reset can be undone.
// After --apply, rebuild the shop (Launchpad > the shop > Deploy) to see it.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { writeStarterDatabase } = require('../src/starter-database');
const { zipDirectory } = require('../src/staging');

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');

const DATA_DIR = process.env.LAUNCHPAD_DATA_DIR || path.join(__dirname, '..', 'data');
const SHOPS_DIR = process.env.LAUNCHPAD_SHOPS_DIR || path.join(__dirname, '..', 'shops');

function fail(message) {
  console.error(`refused: ${message}`);
  process.exit(1);
}

if (!slug || !/^[a-z0-9-]+$/.test(slug)) fail('name the shop: node scripts/reset-starter-database.js <slug> [--apply]');

const shopDir = path.join(SHOPS_DIR, slug);
const dbDir = path.join(shopDir, 'DATABASE');
if (!fs.existsSync(dbDir)) fail(`there is no DATABASE folder at ${dbDir}`);

let shop = null;
try {
  const sdb = new Database(path.join(DATA_DIR, 'shops.db'), { readonly: true });
  shop = sdb.prepare('SELECT slug, name, stage, lifecycle_status FROM shops WHERE slug = ?').get(slug);
  sdb.close();
} catch (err) {
  fail(`shops.db could not be read: ${err.message}`);
}
if (!shop) fail(`"${slug}" is not a shop in shops.db`);
if (shop.stage === 'in_production' || shop.lifecycle_status === 'active') {
  fail(`"${slug}" is in production. Its catalog belongs to a client now.`);
}

const read = (rel) => {
  try { return fs.readFileSync(path.join(dbDir, rel), 'utf8'); } catch { return ''; }
};
const orderLines = read('Orders/orders.csv').split(/\r?\n/).filter((l) => l.trim()).length;
const poFiles = fs.existsSync(path.join(shopDir, 'orders'))
  ? fs.readdirSync(path.join(shopDir, 'orders')).filter((f) => !f.startsWith('.')).length : 0;
if (orderLines > 1 || poFiles > 0) {
  fail(`"${slug}" has orders on it (${Math.max(orderLines - 1, 0)} row(s), ${poFiles} PO file(s)). Nothing was changed.`);
}

const company = read('Design/Details/CompanyName.txt').trim();
const isTemplateSample = /^michael kors$/i.test(company) || read('Design/Details/Password.txt').trim() === 'mk2026';
if (!isTemplateSample && !FORCE) {
  fail(`the catalog on "${slug}" is "${company || 'unnamed'}", not the template sample. Add --force if you mean it.`);
}

const collectionsDir = path.join(dbDir, 'ShopCollections');
const collections = fs.existsSync(collectionsDir)
  ? fs.readdirSync(collectionsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

console.log(`${APPLY ? 'RESET' : 'DRY RUN'}  ${slug} ("${shop.name}"), stage ${shop.stage || 'no_status'}`);
console.log(`  catalog now: "${company || 'unnamed'}", ${collections.length} collection(s): ${collections.join(', ') || 'none'}`);
console.log('  the starter keeps every README and removes products, logos, photos, fonts, copy, contacts and stock.');

if (!APPLY) {
  console.log('\nNothing was changed. Run again with --apply to back up and reset.');
  process.exit(0);
}

const backupsRoot = path.join(shopDir, '.backups');
fs.mkdirSync(backupsRoot, { recursive: true });
const backupId = `${new Date().toISOString().replace(/:/g, '-')}.zip`;
zipDirectory(dbDir, path.join(backupsRoot, backupId));

const result = writeStarterDatabase(dbDir, { name: shop.name, slug });

try {
  const pdb = new Database(path.join(DATA_DIR, 'platform.db'));
  pdb.prepare(`INSERT INTO audit_log (ts, user_id, username, shop_slug, action, detail, via)
    VALUES (?, NULL, NULL, ?, 'database_reset_to_starter', ?, 'script')`)
    .run(Date.now(), slug, JSON.stringify({ backup_id: backupId, removed: result.removed }));
  pdb.close();
} catch (err) {
  console.error(`  (the audit row could not be written: ${err.message})`);
}

console.log(`\n  backup:   ${backupId} (rollback_database can restore it)`);
console.log(`  removed:  ${result.removed.products} product(s), ${result.removed.images} image(s), ${result.removed.fonts} font file(s)`);
console.log(`  password: ${result.password}`);
console.log('\nRebuild the shop so the change shows: Launchpad > the shop > Deploy.');
