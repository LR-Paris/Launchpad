// ---------------------------------------------------------------------------
// health.js — GET /api/shops/:slug/health (ADR-001 §4)
//
// This is the first thing an agent calls on every turn, so it has a budget:
// one shallow pass over the shop tree, one small CSV read, no photo bytes, no
// full catalog, no docker subprocess, and the Shuttle tag cached for an hour.
// Container state comes from the shops.db row that the existing build poller
// already keeps fresh rather than from `docker compose ps`.
//
// Every check answers three things a person actually asks: is it ok, why does
// it matter, and what do I do about it. `you_can` / `you_cannot` are filtered
// by the caller's role so an agent never proposes an action it cannot perform.
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const path = require('path');

const { refuse, shopOwners, nameList, RANK } = require('./authz');
const fileLock = require('./lock');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
// The ADR says to compare against the newest STS-* tag on the Shuttle repo.
// The repo has exactly two tags, "Alpha" and "2.0", and neither is an STS
// version; the real one is `export const VERSION = 'STS-4.1.0'` in
// lib/version.ts on the default branch. So we read that file, and only fall
// back to the tag list if GitHub will not serve it.
const SHUTTLE_VERSION_URL = 'https://raw.githubusercontent.com/LR-Paris/Shuttle/HEAD/lib/version.ts';
const SHUTTLE_TAGS_URL = 'https://api.github.com/repos/LR-Paris/Shuttle/tags?per_page=100';
const STS_CACHE_MS = 60 * 60 * 1000;
const STS_FETCH_TIMEOUT_MS = 2000;

// Variant folders are named "Base Name (Variant)". Same grammar the Shuttle
// catalog parser uses, kept here verbatim so the two never drift apart.
const VARIANT_RE = /^(.+?)\s*\(([^)]+)\)\s*$/;

// The stage vocabulary belongs to golive.js (Agent C), which also owns the
// banner these values switch on. Read it from there so the two can never drift.
let STAGES = ['no_status', 'in_testing', 'in_production'];
// The stage a shop is actually at is derived from lifecycle_status, which is
// the live column; shops.stage is written alongside it but has years of rows
// where it was never set. golive.js owns that derivation.
let effectiveStage = (shop) => (shop && shop.stage) || 'no_status';
try {
  const golive = require('./golive');
  if (Array.isArray(golive.STAGES) && golive.STAGES.length) STAGES = golive.STAGES;
  if (typeof golive.effectiveStage === 'function') effectiveStage = golive.effectiveStage;
} catch { /* golive is not installed yet; the fallbacks above match its values */ }

function shopDir(slug) {
  return path.join(SHOPS_DIR, slug);
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// One shallow pass over DATABASE/ShopCollections: collection names, item names.
// No file reads, no Photos listing.
// ---------------------------------------------------------------------------
function scanCollections(slug) {
  const root = path.join(shopDir(slug), 'DATABASE', 'ShopCollections');
  if (!fs.existsSync(root)) return { present: false, collections: [], itemCount: 0 };
  const collections = [];
  let itemCount = 0;
  for (const col of safeReaddir(root)) {
    if (!col.isDirectory()) continue;
    const items = safeReaddir(path.join(root, col.name))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    itemCount += items.length;
    collections.push({ name: col.name, items });
  }
  return { present: true, collections, itemCount };
}

// A group with exactly one sibling is almost always a mistake: somebody made
// "Tote (Black)" and never added "Tote (Navy)", so the storefront shows a
// variant picker with one option in it.
function lonelyVariants(scan) {
  const lonely = [];
  for (const col of scan.collections) {
    const groups = new Map();
    for (const item of col.items) {
      const m = item.match(VARIANT_RE);
      if (!m) continue;
      const base = m[1].trim();
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(m[2].trim());
    }
    for (const [base, variants] of groups) {
      if (variants.length === 1) lonely.push({ collection: col.name, product: base, variant: variants[0] });
    }
  }
  return lonely;
}

// ---------------------------------------------------------------------------
// Orders. Same file the orders router reads; counted, not returned.
// ---------------------------------------------------------------------------
const FULFILLED = ['shipped', 'delivered', 'complete', 'completed', 'fulfilled'];

function ordersCsvPath(slug) {
  const candidates = [
    path.join(shopDir(slug), 'DATABASE', 'Orders', 'orders.csv'),
    path.join(shopDir(slug), 'DATABASE', 'Orders', 'Orders.csv'),
    path.join(shopDir(slug), 'DATABASE', 'orders', 'orders.csv'),
    path.join(shopDir(slug), 'orders', 'orders.csv'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function countUnfulfilled(slug) {
  const csvPath = ordersCsvPath(slug);
  if (!csvPath) return { total: 0, unfulfilled: 0, hasFile: false };
  let records;
  try {
    const { parse } = require('csv-parse/sync');
    records = parse(fs.readFileSync(csvPath, 'utf8'), {
      columns: true, skip_empty_lines: true, trim: true, relax_column_count: true,
    });
  } catch {
    return { total: 0, unfulfilled: 0, hasFile: true, unreadable: true };
  }
  let unfulfilled = 0;
  for (const r of records) {
    const status = String(r.Status || r.status || '').trim().toLowerCase();
    if (!status) { unfulfilled++; continue; }
    if (status.startsWith('cancel')) continue;
    if (FULFILLED.some((f) => status.startsWith(f))) continue;
    unfulfilled++;
  }
  return { total: records.length, unfulfilled, hasFile: true };
}

// ---------------------------------------------------------------------------
// Shuttle template version. lib/version.ts is what the template writes; a shop
// without it predates the template entirely.
//
// Parse only the exported constant. The top of that file is a version HISTORY
// comment listing every STS release since 0.10, so a loose "first STS-x.y in
// the file" match reports the oldest version instead of the current one.
// ---------------------------------------------------------------------------
function parseStsVersion(text) {
  const m = String(text).match(/export\s+const\s+VERSION\s*(?::\s*string\s*)?=\s*['"`]([^'"`]+)['"`]/)
    || String(text).match(/^\s*const\s+VERSION\s*(?::\s*string\s*)?=\s*['"`]([^'"`]+)['"`]/m);
  return m ? m[1].trim() : null;
}

function readShopSts(slug) {
  const p = path.join(shopDir(slug), 'lib', 'version.ts');
  if (!fs.existsSync(p)) return { legacy: true, version: null };
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return { legacy: false, version: null, unreadable: true };
  }
  return { legacy: false, version: parseStsVersion(text) };
}

function versionKey(tag) {
  return String(tag).replace(/^STS-?/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

const stsCache = { tag: null, fetchedAt: 0, error: null, inFlight: null };

function githubHeaders() {
  const headers = { 'User-Agent': 'launchpad-health' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: githubHeaders(), signal: ctrl.signal });
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestSts() {
  try {
    const res = await getWithTimeout(SHUTTLE_VERSION_URL);
    const newest = parseStsVersion(await res.text());
    if (newest) {
      stsCache.tag = newest;
      stsCache.fetchedAt = Date.now();
      stsCache.error = null;
      return newest;
    }
    throw new Error('lib/version.ts on the Shuttle repo has no VERSION constant');
  } catch (err) {
    // Fall back to the tag list in case the repo layout changes under us.
    try {
      const res = await getWithTimeout(SHUTTLE_TAGS_URL);
      const tags = await res.json();
      const sts = (Array.isArray(tags) ? tags : [])
        .map((t) => t && t.name)
        .filter((n) => typeof n === 'string' && /^STS-/i.test(n))
        .sort(compareVersions);
      const newest = sts[sts.length - 1] || null;
      if (newest) {
        stsCache.tag = newest;
        stsCache.fetchedAt = Date.now();
        stsCache.error = null;
        return newest;
      }
    } catch { /* fall through to the error path */ }
    stsCache.error = err.message;
    stsCache.fetchedAt = Date.now();
    return stsCache.tag;
  }
}

// Fresh cache: return it. Stale cache: return it now and refresh behind the
// request. Empty cache: wait, but only for STS_FETCH_TIMEOUT_MS.
async function latestSts() {
  const age = Date.now() - stsCache.fetchedAt;
  if (stsCache.tag && age < STS_CACHE_MS) return stsCache.tag;
  if (stsCache.tag) {
    if (!stsCache.inFlight) {
      stsCache.inFlight = fetchLatestSts().finally(() => { stsCache.inFlight = null; });
    }
    return stsCache.tag;
  }
  if (!stsCache.inFlight) {
    stsCache.inFlight = fetchLatestSts().finally(() => { stsCache.inFlight = null; });
  }
  return stsCache.inFlight;
}

// ---------------------------------------------------------------------------
// The only tool names an agent can call, which is the tool server's whole
// surface. Anything this file names in a `tool` field has to be in here: a name
// that is not a tool sends the agent looking for something that does not exist,
// and it finds out in front of the person it is talking to.
// route-coverage.test.js reads this list and fails on any other name, so a tool
// added to the server is added here once and nowhere else.
// ---------------------------------------------------------------------------
const MCP_TOOLS = Object.freeze([
  'whoami', 'list_my_shops', 'create_shop', 'request_access',
  'get_shop', 'shop_health', 'shop_logs', 'list_audit', 'list_backups',
  'list_orders', 'get_order', 'get_inventory', 'get_approval_status', 'list_review_feedback',
  'fulfill_order', 'set_stock', 'restart_shop', 'request_upload',
  'stage_database', 'apply_database', 'rollback_database', 'resolve_feedback',
  'request_go_live', 'withdraw_go_live', 'resend_review_link', 'set_stage',
  'grant_access', 'revoke_access', 'list_access_requests', 'decide_access_request',
]);

// ---------------------------------------------------------------------------
// What each role may do. you_cannot is the interesting half: it names the
// person to ask, so an agent's "I can't do that" is never a dead end.
//
// A capability with `tool: null` is real work that no tool does. It keeps its
// label so an agent can still say what it is, and the label names who does it,
// because "I can do that" with nothing to call is worse than a refusal.
// ---------------------------------------------------------------------------
const CAPABILITIES = [
  { id: 'read_health', role: 'viewer', label: 'See this shop\'s health', tool: 'shop_health' },
  { id: 'read_catalog', role: 'viewer', label: 'Read the catalog', tool: 'get_inventory' },
  { id: 'read_orders', role: 'viewer', label: 'Read orders', tool: 'list_orders' },
  { id: 'edit_catalog', role: 'editor', label: 'Set how much stock an item has', tool: 'set_stock' },
  { id: 'stage_database', role: 'editor', label: 'Stage a new DATABASE folder', tool: 'stage_database' },
  { id: 'apply_database', role: 'editor', label: 'Apply a staged DATABASE folder', tool: 'apply_database' },
  { id: 'rollback_database', role: 'editor', label: 'Roll back the last DATABASE apply', tool: 'rollback_database' },
  { id: 'launch_shop', role: 'editor', label: 'Launch or restart the shop', tool: 'restart_shop' },
  { id: 'request_review', role: 'editor', label: 'Send the shop for go-live review', tool: 'request_go_live' },
  { id: 'set_stage', role: 'owner', label: 'Change the shop stage', tool: 'set_stage' },
  { id: 'approve_go_live', role: 'owner', label: 'Approve go-live, which Gio does in the Launchpad console', tool: null },
  { id: 'grant_access', role: 'owner', label: 'Grant or remove access', tool: 'grant_access' },
  { id: 'delete_shop', role: 'owner', label: 'Delete the shop, which Gio does in the Launchpad console', tool: null },
  { id: 'set_stage_production', role: 'admin', label: 'Move the shop to in_production', tool: 'set_stage' },
];

function splitCapabilities(role, isAdminBypass, slug) {
  const have = RANK[role] || 0;
  const can = [];
  const cannot = [];
  let owners = null;
  const ownerNames = () => {
    if (owners === null) {
      // An unclaimed or brand new shop still has to answer with a name to ask.
      try { owners = shopOwners(slug); } catch { owners = []; }
    }
    return nameList(owners);
  };

  for (const cap of CAPABILITIES) {
    if (cap.role === 'admin') {
      if (isAdminBypass) can.push({ id: cap.id, label: cap.label, tool: cap.tool });
      else cannot.push({
        id: cap.id, label: cap.label, tool: cap.tool,
        reason: 'This one is admin only, and the dev tool never acts as an admin.',
        ask: 'Gio, from the Launchpad console.',
      });
      continue;
    }
    if (have >= RANK[cap.role]) {
      can.push({ id: cap.id, label: cap.label, tool: cap.tool });
    } else {
      cannot.push({
        id: cap.id, label: cap.label, tool: cap.tool,
        reason: role
          ? `Needs ${cap.role} access, and yours is ${role}.`
          : `Needs ${cap.role} access, and you are not a member of this shop.`,
        ask: `${ownerNames()} (or call request_access).`,
      });
    }
  }
  return { can, cannot };
}

// ---------------------------------------------------------------------------
// Overall status and the suggestion list
//
// The ADR calls this the token-thrift keystone: the ONE call an agent makes to
// answer "what is going on with this shop", where the backend has already done
// the thinking. An agent that has to re-derive next steps from logs and
// inventory spends many times the tokens and can be wrong. So the ranking is
// here, next to the checks it ranks, rather than in the tool server or in a
// prompt.
//
// Ranking is by how badly the shop is broken, most broken first. A shop with no
// catalog needs a catalog before anything else is worth saying.
// ---------------------------------------------------------------------------
const CHECK_SEVERITY = {
  legacy: 0,              // nothing else in this list applies to a pre-template shop
  database_present: 1,    // no catalog, no shop
  variants_ok: 2,         // the catalog is there but will render wrong
  unfulfilled_orders: 3,  // somebody is waiting on a parcel
  stage_unset: 4,         // it works, but nobody has said what it is
  sts_current: 5,         // it works and it is behind
};

function overallStatus(checks, container) {
  const failing = checks.filter((c) => !c.ok);
  const blocking = failing.filter((c) => (CHECK_SEVERITY[c.id] ?? 9) <= 2);
  if (blocking.length) return 'broken';
  if (failing.length) return 'needs_attention';
  if (container.building) return 'building';
  if (container.status && container.status !== 'running') return 'stopped';
  return 'ok';
}

// One flat list of plain sentences, ranked, each naming what to do next and
// which tool does it. Written for somebody who has never opened a terminal.
function buildSuggestions(checks, container) {
  const out = [];
  const failing = checks
    .filter((c) => !c.ok)
    .sort((a, b) => (CHECK_SEVERITY[a.id] ?? 9) - (CHECK_SEVERITY[b.id] ?? 9));

  for (const c of failing) {
    for (const step of c.how || []) {
      out.push({ why: c.why, do: step, tool: c.tool || null, role_needed: c.role_needed || null, check: c.id });
    }
    // A failing check with no `how` is still worth saying out loud, otherwise
    // the agent sees a red check and no next step and invents one.
    if (!(c.how || []).length) {
      out.push({ why: c.why, do: `Look at this: ${c.title}.`, tool: c.tool || null, role_needed: c.role_needed || null, check: c.id });
    }
  }

  if (container.locked) {
    out.unshift({
      why: 'The shop is mid launch, so its catalog is read only right now.',
      do: 'Wait for the build to finish, usually two or three minutes, then look again.',
      tool: 'shop_health', role_needed: 'viewer', check: 'locked',
    });
  } else if (container.status && container.status !== 'running' && !container.building) {
    out.push({
      why: `The container is ${container.status}, so the shop is not answering.`,
      do: 'Restart the shop, then check its health again in about a minute.',
      tool: 'restart_shop', role_needed: 'editor', check: 'container',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
// A title is the line an agent reads out loud first, so it has to be true in
// the state the check is actually in. Pass { ok, fail } and the failing shop
// gets the failing sentence, with the number in it, rather than the headline it
// would have had if everything were fine.
function pickTitle(title, ok) {
  if (title && typeof title === 'object') return (ok ? title.ok : title.fail) || title.ok || title.fail;
  return title;
}

function check(id, ok, title, why, how, tool, roleNeeded, extra = {}) {
  return { id, ok, title: pickTitle(title, ok), why, how: how || [], tool: tool || null, role_needed: roleNeeded || null, ...extra };
}

async function buildChecks(shop) {
  const slug = shop.slug;
  const dir = shopDir(slug);
  const dirExists = fs.existsSync(dir);
  const scan = scanCollections(slug);
  const orders = countUnfulfilled(slug);
  const sts = readShopSts(slug);
  // The derived stage, not the shops.stage column: the column has years of rows
  // where it was never written, and the payload reports the derived one. A check
  // reading the other of the two says "this shop has no stage" on a shop the
  // same payload calls in_production.
  const stage = effectiveStage(shop);
  const checks = [];

  // 1. database_present
  checks.push(check(
    'database_present',
    dirExists && scan.present && scan.itemCount > 0,
    {
      ok: 'DATABASE folder is in place',
      fail: !dirExists
        ? 'Shop folder is missing on the server'
        : !scan.present
          ? 'No DATABASE folder yet'
          : 'DATABASE folder has no products in it',
    },
    !dirExists
      ? 'The shop folder does not exist on the server yet.'
      : !scan.present
        ? 'There is no DATABASE/ShopCollections folder, so the storefront has nothing to sell.'
        : scan.itemCount === 0
          ? 'DATABASE/ShopCollections exists but has no products in it.'
          : `${scan.itemCount} product folder(s) across ${scan.collections.length} collection(s).`,
    dirExists && scan.present && scan.itemCount > 0 ? [] : [
      'Build the DATABASE folder from the client inventory sheet.',
      'Stage it with stage_database, read the report, then apply_database.',
    ],
    'stage_database', 'editor',
    { collections: scan.collections.length, products: scan.itemCount },
  ));

  // 2. unfulfilled_orders
  checks.push(check(
    'unfulfilled_orders',
    orders.unfulfilled === 0,
    {
      ok: 'No orders waiting',
      fail: `${orders.unfulfilled} order${orders.unfulfilled === 1 ? '' : 's'} waiting to ship`,
    },
    orders.unreadable
      ? 'The orders file could not be parsed.'
      : !orders.hasFile
        ? 'No orders have come in yet.'
        : orders.unfulfilled === 0
          ? `All ${orders.total} order(s) are shipped or cancelled.`
          : `${orders.unfulfilled} of ${orders.total} order(s) are still waiting to ship.`,
    orders.unfulfilled === 0 ? [] : [
      'Read them with list_orders.',
      'Mark each one shipped with fulfill_order once it leaves, with the tracking number.',
    ],
    'list_orders', 'viewer',
    { unfulfilled: orders.unfulfilled, total: orders.total },
  ));

  // 3. stage_unset
  checks.push(check(
    'stage_unset',
    stage !== 'no_status' && STAGES.includes(stage),
    { ok: 'Shop stage is set', fail: 'Shop has no stage set' },
    stage === 'no_status'
      ? 'This shop has no stage, so nothing knows whether it is a sandbox or a live store.'
      : `Stage is ${stage}.`,
    stage === 'no_status'
      ? ['Set it with set_stage: in_testing while you build, in_production once the client has approved it.']
      : [],
    'set_stage', 'owner',
    { stage },
  ));

  // 4. variants_ok
  const lonely = lonelyVariants(scan);
  checks.push(check(
    'variants_ok',
    lonely.length === 0,
    {
      ok: 'Product variants look complete',
      fail: `${lonely.length} product${lonely.length === 1 ? ' has' : 's have'} only one variant`,
    },
    lonely.length === 0
      ? 'Every product with a variant in its folder name has at least one sibling.'
      : `${lonely.length} product(s) have exactly one variant, which usually means the rest were never added.`,
    // No tool reads folder names, and no tool renames them. Somebody opens the
    // DATABASE folder and looks, which is why this names the person, not a tool.
    lonely.length === 0 ? [] : [
      'Open the DATABASE folder on your computer and read the product folder names under ShopCollections.',
      'Either add the missing variants or drop the parentheses from the folder name, then send the folder up again with request_upload and stage_database.',
    ],
    null, 'editor',
    { lonely: lonely.slice(0, 10) },
  ));

  // 5. legacy
  checks.push(check(
    'legacy',
    !sts.legacy,
    { ok: 'Shop is on the Shuttle template', fail: 'Shop predates the Shuttle template' },
    sts.legacy
      ? 'There is no lib/version.ts, so this shop predates the Shuttle template. Template tools will not work on it.'
      : `Shop reports ${sts.version || 'an unreadable version'}.`,
    sts.legacy ? ['Ask Gio to rebuild this shop from the current Shuttle template, or leave it as it is and edit it by hand.'] : [],
    null, 'owner',
    { shop_version: sts.version },
  ));

  // 6. sts_current
  let latest = null;
  try {
    latest = await latestSts();
  } catch {
    latest = null;
  }
  if (sts.legacy) {
    checks.push(check('sts_current', true, 'Shuttle version was not checked',
      'Skipped: this shop is not on the Shuttle template.', [], null, 'owner',
      { shop_version: null, latest_version: latest, note: 'not applicable' }));
  } else if (!latest || !sts.version) {
    // GitHub unreachable, or the version file is unreadable. Degrade to ok so a
    // network blip never looks like a broken shop.
    checks.push(check('sts_current', true, 'Shuttle version was not checked',
      !latest
        ? `Could not read the newest Shuttle version from GitHub, so this was not checked${stsCache.error ? ` (${stsCache.error})` : ''}.`
        : 'Could not read a VERSION out of this shop\'s lib/version.ts, so this was not checked.',
      [], null, 'owner',
      { shop_version: sts.version, latest_version: latest, note: 'not checked', error: stsCache.error }));
  } else {
    const behind = compareVersions(sts.version, latest) < 0;
    checks.push(check('sts_current', !behind,
      {
        ok: 'Shuttle version is current',
        fail: `Shop is on ${sts.version}, newest is ${latest}`,
      },
      behind
        ? `This shop is on ${sts.version} and the newest Shuttle is ${latest}.`
        : `This shop is on ${sts.version}, which is current.`,
      // Moving a shop to a newer Shuttle rebuilds it from the template, which is
      // Gio's job on the server. No tool does it, and none should pretend to.
      behind ? [`Ask Gio to move this shop to ${latest}, then check the storefront once it has rebuilt.`] : [],
      null, 'owner',
      { shop_version: sts.version, latest_version: latest }));
  }

  return checks;
}

// Agent C owns the go-live preflight. This stays defensive on purpose: health is
// called on every agent turn, so a preflight that is missing or throwing reports
// "not available" instead of breaking the one call an agent always makes.
// golive.preflight(slug) returns { slug, ok, checked_at, checks[], failures[] }.
function readyForReview(slug) {
  // checks and failures are arrays in every branch, including the two where
  // there was no preflight to run. A caller walks them without asking whether
  // the preflight was there, which on an empty shop it may not be.
  const unavailable = {
    available: false, ok: null, checks: [], failures: [],
    note: 'The go-live preflight is not installed on this server yet.',
  };
  let golive;
  try {
    golive = require('./golive');
  } catch {
    return unavailable;
  }
  try {
    if (typeof golive.preflight !== 'function') return unavailable;
    const result = golive.preflight(slug) || {};
    return {
      available: true,
      ...result,
      checks: Array.isArray(result.checks) ? result.checks : [],
      failures: Array.isArray(result.failures) ? result.failures : [],
    };
  } catch (err) {
    return {
      available: true, ok: false, checks: [], failures: [],
      note: `The go-live preflight failed to run: ${err.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// GET /api/shops/:slug/health
// resolveShopAndRole + requireShopAccess('viewer') are applied by the shop
// scope mounted ahead of this router in index.js.
// ---------------------------------------------------------------------------
router.get('/:slug/health', async (req, res) => {
  const shop = req.shop;
  if (!shop) {
    return refuse(res, 500, 'NOT_PERMITTED', 'This shop could not be identified.',
      'Tell Gio: the health route is missing its shop resolver.', false);
  }

  let checks;
  try {
    checks = await buildChecks(shop);
  } catch (err) {
    console.error(`[health] ${shop.slug} failed: ${err.message}`);
    return refuse(res, 500, 'NOT_PERMITTED', 'The health check could not finish.',
      'Try again. If it keeps failing, tell Gio and include the shop name.', true);
  }

  // you_can and you_cannot are lists an agent walks, and you_cannot is the half
  // that names a person to ask. A shop with no members and no folder on disk
  // must still answer with both, so neither the membership read nor the lock
  // file can take the whole payload down with it.
  let can = [];
  let cannot = [];
  try {
    ({ can, cannot } = splitCapabilities(req.shopRole, req.isAdminBypass, shop.slug));
  } catch (err) {
    console.error(`[health] ${shop.slug} could not list capabilities: ${err.message}`);
  }
  let locked = false;
  try {
    locked = fileLock.isLocked(shop.slug);
  } catch {
    locked = false;
  }

  const container = {
    status: shop.status || 'unknown',
    building: !!shop.is_building,
    locked,
    port: shop.port,
    url: `/${shop.slug}`,
    lifecycle_status: shop.lifecycle_status || 'none',
  };

  res.json({
    shop: shop.slug,
    name: shop.name,
    // One word for the whole shop, so a caller can decide whether to read the
    // rest. ok | needs_attention | broken | building | stopped.
    status: overallStatus(checks, container),
    stage: effectiveStage(shop),
    container,
    role: req.shopRole,
    via: req.via || 'web',
    // Every check carries `name` as well as `id`: `id` is the stable key the
    // backend ranks on, `name` and `detail` are what a person reads, and the
    // tool server passes them straight through without renaming anything.
    checks: checks.map((c) => ({ ...c, name: c.title, detail: c.why })),
    suggestions: buildSuggestions(checks, container),
    you_can: Array.isArray(can) ? can : [],
    you_cannot: Array.isArray(cannot) ? cannot : [],
    ready_for_review: readyForReview(shop.slug),
  });
});

module.exports = router;
module.exports.router = router;
module.exports.STAGES = STAGES;
module.exports.MCP_TOOLS = MCP_TOOLS;
module.exports.VARIANT_RE = VARIANT_RE;
module.exports._internals = { scanCollections, lonelyVariants, countUnfulfilled, readShopSts, parseStsVersion, compareVersions, latestSts };
