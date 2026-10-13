#!/usr/bin/env node
// ---------------------------------------------------------------------------
// new-shop-flow.test.js — the pieces behind /new-shop that do not need a
// running server: the empty starter DATABASE, the shop password, the preset
// reader the go-live checks use, the audit slug for shop_created, and access
// that waits for someone's first sign in.
//
//   cd backend && node test/new-shop-flow.test.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('./_sandbox');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (rel.endsWith('/')) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// What the Shuttle template's DATABASE folder looks like today: a real
// client's catalog, logo, fonts, photos, FAQ and password.
const TEMPLATE_SHOP_TYPE = [
  '# Shop Type Configuration',
  '# Options:',
  '#   free   - Basic free shop. No payment or PO required. (Default if this file/folder is missing)',
  '#   po     - Purchase Order shop. Requires user to upload a PO PDF at checkout.',
  '#',
  '# Only one value should be set below:',
  '',
  'type: po',
  '',
].join('\n');

function templateDatabase(root) {
  writeTree(root, {
    'README.md': '# DATABASE\n',
    'Design/README.md': '# Design\n',
    'Design/Details/README.md': '# Details\n',
    'Design/Details/CompanyName.txt': 'MICHAEL KORS\n',
    'Design/Details/Password.txt': 'mk2026\n',
    'Design/Details/Email.txt': 'contact: orders@michaelkors.com\n',
    'Design/Details/AdminEmail.txt': 'someone@lrparis.com\n',
    'Design/Details/Descriptions.txt': 'tagline: Gift With Purchase 2026 Webstore.\n',
    'Design/Fonts/Kors_Sans-Book.otf': 'font',
    'Design/Fonts/Kors_Sans-Light.otf': 'font',
    'Design/Logos/README.md': '# Logos\n',
    'Design/Logos/logo.png': 'png',
    'Design/Logos/logo-white.png': 'png',
    'Design/ShowcasePhotos/README.md': '# Showcase\n',
    'Design/ShowcasePhotos/holiday.jpg': 'jpg',
    'Design/ShowcasePhotos/Collections/holiday.jpg': 'jpg',
    'Design/FAQ/FAQ.txt': 'Q: What collections are available?\nA: Six GWP collections.\n',
    'ShopCollections/README.md': '# Collections\n',
    'ShopCollections/Holiday/Metal Ornament/Details/SKU.txt': '7117190000',
    'ShopCollections/Holiday/Mini Tic Tac Toe Set/Details/SKU.txt': '7117190000',
    'ShopCollections/Evergreen/Dopp Kit/Details/SKU.txt': '4202220000',
    'Inventory/inventory.csv': 'SKU,Product ID,Product Name,Collection,Stock,Last Updated,Notes\n4202220000,evergreen-dopp-kit,Dopp Kit,Evergreen,12,,\n',
    'Orders/orders.csv': 'Order ID,Date,Customer Name\nMK-1,2026-03-02,Someone\n',
    'Presets/ShopType.txt': TEMPLATE_SHOP_TYPE,
  });
}

const box = sandbox.create({ label: 'new-shop-flow' });
try {
  const { writeStarterDatabase, generateShopPassword } = box.require('starter-database.js');

  // -------------------------------------------------------------------------
  // The empty starter
  // -------------------------------------------------------------------------
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-'));
  const db = path.join(work, 'DATABASE');
  templateDatabase(db);
  const result = writeStarterDatabase(db, { name: 'The Ritz-Carlton', slug: 'the-ritz-carlton', year: 2026 });
  const read = (rel) => fs.readFileSync(path.join(db, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(db, rel));

  test('a new shop opens with no products from the template client', () => {
    const left = fs.readdirSync(path.join(db, 'ShopCollections'));
    assert.deepStrictEqual(left, ['README.md'], `left behind: ${left.join(', ')}`);
    assert.strictEqual(result.removed.products, 3);
  });
  test('and with none of their logos, photos or font files', () => {
    assert.ok(!exists('Design/Logos/logo.png') && !exists('Design/Logos/logo-white.png'));
    assert.ok(!exists('Design/ShowcasePhotos/holiday.jpg') && !exists('Design/ShowcasePhotos/Collections/holiday.jpg'));
    assert.deepStrictEqual(fs.readdirSync(path.join(db, 'Design', 'Fonts')), []);
  });
  test('the READMEs people build from are kept', () => {
    for (const rel of ['README.md', 'Design/README.md', 'Design/Logos/README.md', 'Design/ShowcasePhotos/README.md', 'ShopCollections/README.md']) {
      assert.ok(exists(rel), `${rel} was deleted`);
    }
  });
  test('the shop carries its own name, not the template client', () => {
    assert.strictEqual(read('Design/Details/CompanyName.txt').trim(), 'The Ritz-Carlton');
    assert.ok(!/kors|gwp/i.test(read('Design/Details/Descriptions.txt')), read('Design/Details/Descriptions.txt'));
    assert.ok(!/collections are available/i.test(read('Design/FAQ/FAQ.txt')));
  });
  test('and its own password, never the template one', () => {
    const pw = read('Design/Details/Password.txt').trim();
    assert.notStrictEqual(pw, 'mk2026');
    assert.strictEqual(pw, result.password);
    assert.ok(/^ritz[0-9]{4}$/.test(pw), pw);
  });
  test('no contact or admin address is inherited', () => {
    assert.strictEqual(read('Design/Details/AdminEmail.txt'), '');
    assert.strictEqual(read('Design/Details/Email.txt').trim(), 'contact:');
  });
  test('stock and orders keep their header row and nothing else', () => {
    assert.strictEqual(read('Inventory/inventory.csv'), 'SKU,Product ID,Product Name,Collection,Stock,Last Updated,Notes\n');
    assert.strictEqual(read('Orders/orders.csv'), 'Order ID,Date,Customer Name\n');
  });
  test('presets are written with no comment lines', () => {
    assert.strictEqual(read('Presets/ShopType.txt'), 'type: free\n');
    assert.ok(!read('Presets/DataRequired.txt').includes('#'));
  });
  test('every color key the shop reads is present and readable on white', () => {
    const colors = read('Design/Details/Colors.txt');
    for (const key of ['primary', 'secondary', 'accent', 'background', 'text', 'textLight', 'border', 'success']) {
      assert.ok(new RegExp(`^${key}: #[0-9A-F]{6}$`, 'm').test(colors), `${key} missing`);
    }
  });
  fs.rmSync(work, { recursive: true, force: true });

  test('a password comes from the first real word of the slug', () => {
    assert.ok(/^bozzuto[0-9]{4}$/.test(generateShopPassword('bozzuto')));
    assert.ok(/^shop[0-9]{4}$/.test(generateShopPassword('a-b')));
    assert.ok(/^winter[0-9]{4}$/.test(generateShopPassword('winter-gwp-26')));
  });

  // -------------------------------------------------------------------------
  // The preset reader behind the go-live checkout check
  // -------------------------------------------------------------------------
  const golive = box.require('golive.js');
  test('the checkout check reads the shop type past the comment block', () => {
    assert.strictEqual(golive.parsePresetFile(TEMPLATE_SHOP_TYPE).type, 'po');
  });
  test('and a comment with a colon in it is never a key', () => {
    const parsed = golive.parsePresetFile('# Each toggle can be: true or false\naddress: true\n');
    assert.deepStrictEqual(parsed, { address: 'true' });
  });

  // -------------------------------------------------------------------------
  // Audit: shop_created lands on the shop it created
  // -------------------------------------------------------------------------
  const authz = box.require('authz.js');
  const platform = box.require('platform-db.js');
  platform.initPlatformDb();
  const platformDb = platform.db;
  test('an audit row with no :slug param takes the slug from its detail', () => {
    const req = { session: { user: { id: 1, username: 'admin' } }, via: 'mcp', params: {} };
    const id = authz.audit(req, 'shop_created', { slug: 'brand-new', name: 'Brand New' });
    const row = platformDb.prepare('SELECT shop_slug, via FROM audit_log WHERE id = ?').get(id);
    assert.strictEqual(row && row.shop_slug, 'brand-new');
    assert.strictEqual(row.via, 'mcp');
  });

  // -------------------------------------------------------------------------
  // Access that waits for a first sign in
  // -------------------------------------------------------------------------
  test('a waiting grant becomes a membership when the account appears, once', () => {
    platformDb.prepare(`INSERT INTO pending_grants (email, shop_slug, role, granted_by, created_at)
      VALUES ('s.sacks@lrparis.com', 'serhant', 'owner', 7, ?)`).run(Date.now());
    const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
    const u = new Database(box.usersDbPath);
    const info = u.prepare(`INSERT INTO users (username, email, name, role, created_by)
      VALUES ('s.sacks', 's.sacks@lrparis.com', 'Samantha Sacks', 'user', 'test')`).run();
    u.close();
    authz._useDatabases({ users: box.usersDbPath, shops: box.shopsDbPath });
    const user = { id: Number(info.lastInsertRowid), username: 's.sacks', email: 'S.Sacks@lrparis.com' };
    assert.deepStrictEqual(authz.applyPendingGrants(user), ['serhant']);
    assert.strictEqual(authz.membershipRole(user.id, 'serhant'), 'owner');
    assert.deepStrictEqual(authz.pendingGrantsFor('serhant'), []);
    assert.deepStrictEqual(authz.applyPendingGrants(user), [], 'a grant applied twice');
  });

  // -------------------------------------------------------------------------
  // scripts/reset-starter-database.js, for shops made before the starter
  // -------------------------------------------------------------------------
  const { spawnSync } = require('child_process');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const script = path.join(__dirname, '..', 'scripts', 'reset-starter-database.js');
  const env = { ...process.env, LAUNCHPAD_DATA_DIR: box.dataDir, LAUNCHPAD_SHOPS_DIR: box.shopsDir };
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { env, encoding: 'utf8' });
  {
    const sdb = new Database(box.shopsDbPath);
    sdb.prepare("INSERT INTO shops (slug, name, port, subdomain, stage) VALUES ('the-ritz-carlton', 'The Ritz-Carlton', 8120, 'the-ritz-carlton', 'in_testing')").run();
    sdb.close();
  }
  const trc = path.join(box.shopsDir, 'the-ritz-carlton', 'DATABASE');
  templateDatabase(trc);
  fs.writeFileSync(path.join(trc, 'Orders', 'orders.csv'), 'Order ID,Date,Customer Name\n');

  test('the reset script defaults to a dry run that changes nothing', () => {
    const r = run('the-ritz-carlton');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/DRY RUN/.test(r.stdout), r.stdout);
    assert.ok(fs.existsSync(path.join(trc, 'ShopCollections', 'Holiday')), 'a dry run deleted products');
  });
  test('--apply backs up, resets to the starter, and leaves an audit row', () => {
    const r = run('the-ritz-carlton', '--apply');
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.deepStrictEqual(fs.readdirSync(path.join(trc, 'ShopCollections')), ['README.md']);
    assert.strictEqual(fs.readFileSync(path.join(trc, 'Design', 'Details', 'CompanyName.txt'), 'utf8').trim(), 'The Ritz-Carlton');
    const backups = fs.readdirSync(path.join(box.shopsDir, 'the-ritz-carlton', '.backups'));
    assert.strictEqual(backups.length, 1, backups.join(', '));
    const row = platformDb.prepare("SELECT shop_slug, via FROM audit_log WHERE action = 'database_reset_to_starter'").get();
    assert.ok(row && row.shop_slug === 'the-ritz-carlton' && row.via === 'script', JSON.stringify(row));
  });
  test('it refuses a shop with orders on it', () => {
    templateDatabase(trc); // back to the sample, with its order row
    const r = run('the-ritz-carlton', '--apply');
    assert.strictEqual(r.status, 1);
    assert.ok(/has orders on it/.test(r.stderr), r.stderr);
    assert.ok(fs.existsSync(path.join(trc, 'ShopCollections', 'Holiday')), 'it changed a shop with orders');
  });
  test('and a catalog that is not the template sample, unless forced', () => {
    fs.writeFileSync(path.join(trc, 'Orders', 'orders.csv'), 'Order ID\n');
    fs.writeFileSync(path.join(trc, 'Design', 'Details', 'CompanyName.txt'), 'THE RITZ-CARLTON\n');
    fs.writeFileSync(path.join(trc, 'Design', 'Details', 'Password.txt'), 'Candle2026\n');
    const r = run('the-ritz-carlton', '--apply');
    assert.strictEqual(r.status, 1);
    assert.ok(/not the template sample/.test(r.stderr), r.stderr);
  });
} finally {
  box.destroy();
}

console.log(failed === 0 ? `\nPASS  ${passed} test(s).` : `\nFAIL  ${failed} of ${passed + failed} test(s).`);
process.exit(failed === 0 ? 0 : 1);
