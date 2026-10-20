#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build-check.test.js — a shop build ends, and its lock goes with it.
//
// Shop ports listen on 127.0.0.1 on the host, out of reach of this container,
// so the old TCP probe never saw a build finish. Shops stayed "building" and
// kept their .db.lock for good, which blocked catalog and stock edits (the
// Ritz since Oct 13, Waldorf since Oct 14). The poller now also reads the
// shop's log for Next's "Ready in", and stale build locks clear themselves.
//
//   cd backend && node test/build-check.test.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
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
    console.log(`FAIL  ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

const sb = sandbox.create({ label: 'build-check' });
const shops = sb.require('shops.js');
const { shopLogsShowReady, settleStaleBuilds } = shops;
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

// What `launchpad-runner compose logs --timestamps` prints for a shop.
const START = Date.parse('2026-10-16T19:32:50.541Z');
const LOG = [
  'web-1  | 2026-10-14T03:32:20.467165498Z  ✓ Ready in 5.2s',
  'web-1  | 2026-10-16T19:32:51.900000000Z > shop-template-system@4.3.0 build',
  'web-1  | 2026-10-16T19:33:55.766049143Z  ✓ Starting...',
  'web-1  | 2026-10-16T19:33:56.281922693Z  ✓ Ready in 879ms',
].join('\n');

test('a Ready line stamped after the build started means the shop is up', () => {
  assert.strictEqual(shopLogsShowReady(LOG, START), true);
});

test('the Ready line of an earlier boot does not count', () => {
  const stillBuilding = LOG.split('\n').slice(0, 3).join('\n');
  assert.strictEqual(shopLogsShowReady(stillBuilding, START), false);
});

test('no log, no timestamp or no Ready line means not up yet', () => {
  assert.strictEqual(shopLogsShowReady('', START), false);
  assert.strictEqual(shopLogsShowReady(null, START), false);
  assert.strictEqual(shopLogsShowReady(' ✓ Ready in 879ms', START), false);
  assert.strictEqual(shopLogsShowReady('web-1  | 2026-10-16T19:40:00.000Z  ✓ Starting...', START), false);
});

test('nanosecond stamps compare to the millisecond', () => {
  const line = 'web-1  | 2026-10-16T19:32:50.541999999Z  ✓ Ready in 1s';
  assert.strictEqual(shopLogsShowReady(line, START), true);
  assert.strictEqual(shopLogsShowReady(line, START + 5000), false);
});

// settleStaleBuilds against the sandbox's shops.db and shop folders.
const NOW = Date.parse('2026-10-20T19:00:00Z');
const MIN = 60 * 1000;
function setShop(slug, building, startedAt) {
  const db = new Database(sb.shopsDbPath);
  db.prepare('INSERT OR IGNORE INTO shops (slug, name, port, subdomain) VALUES (?, ?, ?, ?)').run(slug, slug, 9000, slug);
  db.prepare('UPDATE shops SET is_building = ?, build_started_at = ? WHERE slug = ?').run(building, startedAt, slug);
  db.close();
  fs.mkdirSync(path.join(sb.shopsDir, slug), { recursive: true });
}
function lock(slug, acquiredAt) {
  fs.writeFileSync(path.join(sb.shopsDir, slug, '.db.lock'), JSON.stringify({ acquired_at: acquiredAt, by_user_id: 1 }));
}
const locked = (slug) => fs.existsSync(path.join(sb.shopsDir, slug, '.db.lock'));
const building = (slug) => {
  const db = new Database(sb.shopsDbPath, { readonly: true });
  const row = db.prepare('SELECT is_building FROM shops WHERE slug = ?').get(slug);
  db.close();
  return row.is_building;
};

test('a leftover lock on a shop that is not building is released after the window', () => {
  setShop('old-lock', 0, NOW - 4 * 24 * 60 * MIN);
  lock('old-lock', NOW - 4 * 24 * 60 * MIN);
  setShop('fresh-lock', 0, NOW - 2 * MIN);
  lock('fresh-lock', NOW - 2 * MIN);
  const released = settleStaleBuilds(NOW);
  assert.ok(released.includes('old-lock'));
  assert.strictEqual(locked('old-lock'), false);
  assert.strictEqual(locked('fresh-lock'), true, 'a lock inside the window stays');
});

test('a build past the timeout stops counting as building and loses its lock', () => {
  setShop('timed-out', 1, NOW - 20 * MIN);
  lock('timed-out', NOW - 20 * MIN);
  settleStaleBuilds(NOW);
  assert.strictEqual(building('timed-out'), 0);
  assert.strictEqual(locked('timed-out'), false);
});

test('a build inside the timeout keeps its flag and its lock', () => {
  setShop('in-progress', 1, NOW - 3 * MIN);
  lock('in-progress', NOW - 3 * MIN);
  settleStaleBuilds(NOW);
  assert.strictEqual(building('in-progress'), 1);
  assert.strictEqual(locked('in-progress'), true);
});

test('shops without a lock are left alone', () => {
  setShop('no-lock', 0, 0);
  const released = settleStaleBuilds(NOW);
  assert.ok(!released.includes('no-lock'));
});

sb.destroy();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
