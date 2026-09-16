const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

const { db } = require('./platform-db');
const { requireShopAccess, refuse, audit } = require('./authz');
const {
  sendMail, emailShell, getFromAddress, getBaseUrl, getShopBranding, getAdminEmail, esc,
} = require('./email');

const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOPS_DB_PATH = path.join(DATA_DIR, 'shops.db');

// A review link is a bearer URL a client forwards around, so it dies on its own.
const REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_COMMENT_CHARS = 2000;
const MAX_NAME_CHARS = 120;

// ---------------------------------------------------------------------------
// Schema
//
// Agent A's platform-db.js creates platform.db and the empty tables; these
// statements own the columns and are idempotent, so a fresh checkout and an
// already-migrated server end up with the same shape either way.
// ---------------------------------------------------------------------------

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      note TEXT DEFAULT '',
      client_email TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      preflight_json TEXT DEFAULT '',
      decided_at INTEGER,
      decided_by_name TEXT,
      decided_by_email TEXT,
      decided_ip TEXT,
      decided_user_agent TEXT,
      withdrawn_at INTEGER,
      withdrawn_by INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_token_hash ON approvals(token_hash);
    CREATE INDEX IF NOT EXISTS idx_approvals_shop ON approvals(shop_slug, requested_at DESC);

    CREATE TABLE IF NOT EXISTS review_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id INTEGER NOT NULL,
      shop_slug TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_ref TEXT DEFAULT '',
      body TEXT NOT NULL,
      author_name TEXT DEFAULT '',
      author_email TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      created_ip TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER,
      resolved_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_review_comments_approval ON review_comments(approval_id);
  `);
}
ensureSchema();

// ---------------------------------------------------------------------------
// Stage
//
// GROUND TRUTH: the running code has no `stage` field. shops.db carries a
// `stage` column but nothing reads or writes it. What the settings UI, the
// delete guard, the wipe guard and the launch guard all read is
// `lifecycle_status`, whose values are none | development | testing | active |
// closed. So `lifecycle_status` stays the source of truth and the ADR's three
// stages are a view over it. Both columns are written together below, so a
// later reader of `stage` is not wrong.
// ---------------------------------------------------------------------------

const STAGES = ['no_status', 'in_testing', 'in_production'];
const STAGE_LABELS = {
  no_status: 'No status',
  in_testing: 'In testing',
  in_production: 'In production',
};
const STAGE_TO_LIFECYCLE = {
  no_status: 'none',
  in_testing: 'testing',
  in_production: 'active',
};
const LIFECYCLE_TO_STAGE = {
  none: 'no_status',
  development: 'in_testing',
  testing: 'in_testing',
  active: 'in_production',
  // A closed shop is not a live shop, so it keeps the banner and the noindex.
  closed: 'no_status',
};

function effectiveStage(shopRow) {
  if (!shopRow) return 'no_status';
  return LIFECYCLE_TO_STAGE[shopRow.lifecycle_status || 'none'] || 'no_status';
}

function openShopsDb(readonly = false) {
  return new Database(SHOPS_DB_PATH, readonly ? { readonly: true } : {});
}

function getShopRow(slug) {
  let sdb;
  try {
    sdb = openShopsDb(true);
    return sdb.prepare('SELECT * FROM shops WHERE slug = ?').get(slug) || null;
  } catch {
    return null;
  } finally {
    try { sdb?.close(); } catch { /* best-effort */ }
  }
}

function hasStageColumn(sdb) {
  try {
    return sdb.pragma('table_info(shops)').map(c => c.name).includes('stage');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SHOP_STAGE plumbing
//
// The banner and the noindex header are compiled into the shop bundle, so a
// stage change is a source change: rewrite the env line, drop .next/, restart.
// ---------------------------------------------------------------------------

function getComposeFilePath(slug) {
  if (fs.existsSync('/host/project')) {
    return path.join('/host/project/shops', slug, 'docker-compose.yml');
  }
  return path.join(SHOPS_DIR, slug, 'docker-compose.yml');
}

// Write SHOP_STAGE into a shop's docker-compose.yml. Returns true if the file
// changed. Mirrors the SHUTTLE_LANG rewrite in shops.js so both behave the same
// on a compose file that predates either variable.
function writeStageToCompose(slug, stage) {
  const composePath = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return false;
  const before = fs.readFileSync(composePath, 'utf8');
  let after;
  if (/SHOP_STAGE=/.test(before)) {
    after = before.replace(/SHOP_STAGE=[\w-]*/g, `SHOP_STAGE=${stage}`);
  } else {
    after = before.replace(
      /(- BASE_PATH=[^\n]*\n)/,
      `$1      - SHOP_STAGE=${stage}\n`
    );
  }
  if (after === before) return false;
  fs.writeFileSync(composePath, after);
  return true;
}

function clearBuildCache(slug) {
  const nextDir = path.join(SHOPS_DIR, slug, '.next');
  if (fs.existsSync(nextDir)) {
    fs.rmSync(nextDir, { recursive: true, force: true });
  }
}

// Render the stage into the shop's environment and rebuild so what the site
// shows matches the database. Best effort: a stopped shop gets the compose
// change and picks it up on its next launch.
function applyShopStage(slug, stage, { rebuild = true } = {}) {
  const result = { composeUpdated: false, rebuilt: false, log: '' };
  try {
    result.composeUpdated = writeStageToCompose(slug, stage);
  } catch (err) {
    result.log += `compose rewrite failed: ${err.message}\n`;
    return result;
  }
  if (!rebuild) return result;
  try {
    clearBuildCache(slug);
    const composeFile = getComposeFilePath(slug);
    if (fs.existsSync(path.join(SHOPS_DIR, slug, 'docker-compose.yml'))) {
      result.log += execSync(`docker compose -f ${composeFile} up -d 2>&1`, {
        stdio: 'pipe', encoding: 'utf8',
      }) || '';
      result.rebuilt = true;
    }
  } catch (err) {
    result.log += `restart failed: ${err.stdout?.toString() || err.message}\n`;
  }
  return result;
}

// Create-time patch: render <StageBanner /> as the first child of <body> in the
// shop layout, so no individual page can leave it out. Same shape as the
// analytics patch in shops.js, and idempotent.
function injectStageBanner(shopDir) {
  const candidates = [
    path.join(shopDir, 'app', 'layout.tsx'),
    path.join(shopDir, 'app', 'layout.jsx'),
  ];
  const layoutPath = candidates.find(p => fs.existsSync(p));
  if (!layoutPath) return 0;

  let content = fs.readFileSync(layoutPath, 'utf8');
  if (content.includes('StageBanner')) return 0;

  const importLine = "import StageBanner, { StageRobotsMeta } from '@/components/StageBanner';";
  const lastImportIdx = content.lastIndexOf('\nimport ');
  if (lastImportIdx >= 0) {
    const lineEnd = content.indexOf('\n', lastImportIdx + 1);
    content = content.slice(0, lineEnd + 1) + importLine + '\n' + content.slice(lineEnd + 1);
  } else {
    content = importLine + '\n' + content;
  }

  // First child of <body>, which puts it above the shop header on every page.
  content = content.replace(/(<body[^>]*>)/, '$1\n        <StageBanner />');

  // The robots tag has to be in <head> to count, so it goes there, and a <head>
  // is added if the layout does not already have one.
  if (/<head[^>]*>/.test(content)) {
    content = content.replace(/(<head[^>]*>)/, '$1\n        <StageRobotsMeta />');
  } else {
    content = content.replace(/(\n(\s*)<body[^>]*>)/, '\n$2<head>\n$2  <StageRobotsMeta />\n$2</head>$1');
  }

  fs.writeFileSync(layoutPath, content);
  return 1;
}

// ---------------------------------------------------------------------------
// Preflight
//
// One function, used by request_go_live and by health.ready_for_review. It
// never throws: a check that blows up is reported as a failed check, because a
// crash here would read as "the shop is fine" to whatever called it.
// ---------------------------------------------------------------------------

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

// Matches parseVariantInfo in the shop's lib/catalog.ts: "Base Name (A, B)".
function parseVariantInfo(folderName) {
  const match = folderName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return null;
  return {
    baseName: match[1].trim(),
    values: match[2].split(',').map(v => v.trim()).filter(Boolean),
  };
}

function collectProducts(slug) {
  const root = path.join(SHOPS_DIR, slug, 'DATABASE', 'ShopCollections');
  const products = [];
  for (const collection of listDirs(root)) {
    for (const item of listDirs(path.join(root, collection))) {
      products.push({
        collection,
        folder: item,
        dir: path.join(root, collection, item),
      });
    }
  }
  return products;
}

function checkDatabasePresent(slug) {
  const dbDir = path.join(SHOPS_DIR, slug, 'DATABASE');
  if (!fs.existsSync(dbDir)) {
    return { ok: false, detail: 'This shop has no DATABASE folder yet. Upload one before asking for a review.' };
  }
  const collections = listDirs(path.join(dbDir, 'ShopCollections'));
  if (collections.length === 0) {
    return { ok: false, detail: 'DATABASE/ShopCollections has no collections in it.' };
  }
  const products = collectProducts(slug);
  if (products.length === 0) {
    return { ok: false, detail: 'There are no products in any collection.' };
  }
  return {
    ok: true,
    detail: `${plural(products.length, 'product')} in ${plural(collections.length, 'collection')}.`,
  };
}

// A variant group is two or more sibling folders in one collection that share a
// base name. The shop's catalog engine assumes every member of a group has the
// same number of options and that no combination repeats. When that is not true
// the picker renders dead pills, so it blocks a launch rather than warning.
function checkVariantGroups(slug) {
  const problems = [];
  const byCollection = new Map();
  for (const p of collectProducts(slug)) {
    if (!byCollection.has(p.collection)) byCollection.set(p.collection, []);
    byCollection.get(p.collection).push(p);
  }

  for (const [collection, items] of byCollection) {
    const groups = new Map();
    for (const item of items) {
      const info = parseVariantInfo(item.folder);
      if (!info) continue;
      if (!groups.has(info.baseName)) groups.set(info.baseName, []);
      groups.get(info.baseName).push({ ...item, values: info.values });
    }
    for (const [baseName, members] of groups) {
      if (members.length < 2) continue; // a lone folder with parentheses is a normal product
      const widths = new Set(members.map(m => m.values.length));
      if (widths.size > 1) {
        problems.push(`"${baseName}" in ${collection} mixes ${[...widths].sort().join(' and ')} option levels.`);
      }
      const seen = new Set();
      for (const m of members) {
        const key = m.values.join(' / ').toLowerCase();
        if (seen.has(key)) {
          problems.push(`"${baseName}" in ${collection} has two folders for the same option: ${m.values.join(', ')}.`);
        }
        seen.add(key);
      }
      for (const m of members) {
        const typeRaw = readTextFile(path.join(m.dir, 'Details', 'VariantType.txt'));
        if (!typeRaw) continue;
        const names = typeRaw.trim().split(',').map(s => s.trim()).filter(Boolean);
        if (names.length !== m.values.length) {
          problems.push(`"${m.folder}" in ${collection} names ${names.length} option types but has ${m.values.length} options.`);
        }
      }
    }
  }

  if (problems.length) {
    return { ok: false, detail: problems.slice(0, 8).join(' ') };
  }
  return { ok: true, detail: 'Product options are consistent.' };
}

function checkProductSkus(slug) {
  const missing = [];
  const duplicates = [];
  const seen = new Map();
  for (const p of collectProducts(slug)) {
    const sku = (readTextFile(path.join(p.dir, 'Details', 'SKU.txt')) || '').trim();
    if (!sku) {
      missing.push(`${p.collection}/${p.folder}`);
      continue;
    }
    const key = sku.toLowerCase();
    if (seen.has(key)) duplicates.push(`${sku} is on ${seen.get(key)} and on ${p.collection}/${p.folder}`);
    else seen.set(key, `${p.collection}/${p.folder}`);
  }
  if (missing.length) {
    const head = missing.slice(0, 6).join(', ');
    const more = missing.length > 6 ? ` and ${missing.length - 6} more` : '';
    return { ok: false, detail: `${plural(missing.length, 'product')} with no SKU: ${head}${more}.` };
  }
  if (duplicates.length) {
    return { ok: false, detail: `Two products share a SKU. ${duplicates.slice(0, 4).join('. ')}.` };
  }
  return { ok: true, detail: 'Every product has its own SKU.' };
}

function checkBrandFiles(slug) {
  const detailsDir = path.join(SHOPS_DIR, slug, 'DATABASE', 'Design', 'Details');
  const missing = [];
  for (const name of ['Colors.txt', 'Fonts.txt']) {
    const body = readTextFile(path.join(detailsDir, name));
    if (body === null) missing.push(`${name} is missing`);
    else if (!body.trim()) missing.push(`${name} is empty`);
  }
  if (missing.length) {
    return { ok: false, detail: `${missing.join(' and ')}. Set them under Shop Settings.` };
  }
  return { ok: true, detail: 'Colors and fonts are set.' };
}

function checkContainer(slug) {
  try {
    const composeFile = getComposeFilePath(slug);
    const out = execSync(`docker compose -f ${composeFile} ps --format json`, {
      stdio: 'pipe', encoding: 'utf8',
    });
    const containers = out.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    if (containers.length && containers[0].State === 'running') {
      return { ok: true, detail: 'The shop is running.' };
    }
    return { ok: false, detail: 'The shop container is not running. Launch it, then ask again.' };
  } catch {
    return { ok: false, detail: 'The shop container is not running. Launch it, then ask again.' };
  }
}

// The shop's mode comes from DATABASE/Presets, written at creation time by the
// dataRequired block in shops.js. Every value defaults to true except hotel_list.
function readShopMode(slug) {
  const presets = path.join(SHOPS_DIR, slug, 'DATABASE', 'Presets');
  const typeRaw = readTextFile(path.join(presets, 'ShopType.txt')) || '';
  const shopType = (typeRaw.split(':')[1] || '').trim() || 'standard';

  const drRaw = readTextFile(path.join(presets, 'DataRequired.txt')) || '';
  const dr = {};
  for (const line of drRaw.split('\n')) {
    const [k, v] = line.split(':');
    if (!k || v === undefined) continue;
    dr[k.trim()] = v.trim() === 'true';
  }
  return {
    shopType,
    address: dr.address !== false,
    details: dr.details !== false,
    extraNotes: dr.extra_notes !== false,
    shippingHandler: dr.shipping_handler !== false,
    hotelList: dr.hotel_list === true,
  };
}

function enabledSection(schema, id) {
  return (schema.sections || []).find(s => s.id === id && s.enabled !== false) || null;
}

function sectionHasRequired(section, fieldId) {
  return (section.fields || []).some(f => f.id === fieldId && f.required);
}

// "Valid" means three things: the file parses, its shape is one checkout.js
// would accept on a PUT, and it collects what this shop's mode says it needs.
// A shop with no schema.json falls back to DEFAULT_SCHEMA in checkout.js, which
// is valid for every mode except one that needs a hotel list, so a missing file
// is not a failure on its own.
function checkCheckoutConfig(slug) {
  const schemaPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'Checkout', 'schema.json');
  const mode = readShopMode(slug);
  let schema;
  let usingDefault = false;

  if (fs.existsSync(schemaPath)) {
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (err) {
      return { ok: false, detail: `The checkout form file will not open: ${err.message}` };
    }
    if (!schema || !Array.isArray(schema.sections)) {
      return { ok: false, detail: 'The checkout form file has no sections in it.' };
    }
  } else {
    usingDefault = true;
    schema = { sections: [
      { id: 'contact', enabled: true, fields: [{ id: 'email', required: true }] },
      { id: 'shipping', enabled: true, fields: [
        { id: 'address', required: true }, { id: 'city', required: true }, { id: 'postalCode', required: true },
      ] },
      { id: 'billing', enabled: true, fields: [] },
      { id: 'freight', type: 'freight', enabled: true },
      { id: 'notes', enabled: true, fields: [] },
    ] };
  }

  const problems = [];

  // Every field id becomes one column on the order row, so a repeated id
  // silently overwrites the earlier answer.
  const ids = new Map();
  for (const section of schema.sections) {
    if (!section || !section.id) {
      problems.push('One checkout section has no id.');
      continue;
    }
    for (const f of section.fields || []) {
      if (!f || !f.id) { problems.push(`A field in "${section.id}" has no id.`); continue; }
      if (ids.has(f.id)) problems.push(`The field "${f.id}" appears in both "${ids.get(f.id)}" and "${section.id}".`);
      else ids.set(f.id, section.id);
    }
  }

  // The order confirmation email is addressed from this field, so without it
  // the customer never hears back.
  const contact = enabledSection(schema, 'contact');
  if (!contact) problems.push('There is no contact section, so orders would arrive with no name or email.');
  else if (!sectionHasRequired(contact, 'email')) problems.push('Email is not a required field, so an order can arrive with no way to reply to it.');

  if (mode.address) {
    const shipping = enabledSection(schema, 'shipping');
    if (!shipping) problems.push('This shop collects a shipping address but the shipping section is turned off.');
    else {
      for (const f of ['address', 'city', 'postalCode']) {
        if (!sectionHasRequired(shipping, f)) problems.push(`The shipping section does not require "${f}".`);
      }
    }
  }

  if (mode.shippingHandler) {
    const freight = (schema.sections || []).find(s => s.type === 'freight' && s.enabled !== false);
    if (!freight) problems.push('This shop asks who ships the order but the freight section is turned off.');
  }

  if (mode.extraNotes && !enabledSection(schema, 'notes')) {
    problems.push('This shop takes order notes but the notes section is turned off.');
  }

  if (mode.hotelList) {
    const hotels = readTextFile(path.join(SHOPS_DIR, slug, 'DATABASE', 'Design', 'Details', 'Hotels.txt'));
    if (!hotels || !hotels.trim()) problems.push('This shop asks the customer to pick a hotel but the hotel list is empty.');
  }

  if (problems.length) return { ok: false, detail: problems.slice(0, 8).join(' ') };
  return {
    ok: true,
    detail: usingDefault
      ? `The standard checkout form is in use and fits a ${mode.shopType} shop.`
      : `The checkout form fits a ${mode.shopType} shop.`,
  };
}

const PREFLIGHT_CHECKS = [
  ['database', 'Shop content is uploaded', checkDatabasePresent],
  ['variants', 'Product options are consistent', checkVariantGroups],
  ['skus', 'Every product has a SKU', checkProductSkus],
  ['branding', 'Colors and fonts are set', checkBrandFiles],
  ['container', 'The shop is running', checkContainer],
  ['checkout', 'The checkout form is complete', checkCheckoutConfig],
];

/**
 * Run every launch check for one shop.
 *
 * Returns { slug, ok, checked_at, checks[], failures[] } and never throws, so a
 * caller can render the result without a guard. `failures` is the plain English
 * list a person reads.
 */
function preflight(slug) {
  const checkedAt = Date.now();
  const shop = getShopRow(slug);
  if (!shop) {
    return {
      slug, ok: false, checked_at: checkedAt,
      checks: [{ id: 'shop', label: 'The shop exists', ok: false, detail: `There is no shop called "${slug}".` }],
      failures: [`There is no shop called "${slug}".`],
    };
  }

  const checks = [];
  for (const [id, label, fn] of PREFLIGHT_CHECKS) {
    let result;
    try {
      result = fn(slug);
    } catch (err) {
      result = { ok: false, detail: `This check could not run: ${err.message}` };
    }
    checks.push({ id, label, ok: !!result.ok, detail: result.detail || '' });
  }

  const failures = checks.filter(c => !c.ok).map(c => `${c.label}: ${c.detail}`);
  return { slug, ok: failures.length === 0, checked_at: checkedAt, checks, failures };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function reviewUrl(token) {
  return `${getBaseUrl()}/review/${token}`;
}

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Control characters are dropped by code point rather than by an escape in a
// regular expression, so the source of this file stays printable.
function stripControlChars(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 10 || code === 9) { out += ch; continue; }
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out;
}

// Free text off a public page. It is stored as text and never rendered as
// markup, and the angle brackets go anyway so a forwarded copy cannot carry a
// tag into somebody's mail client.
function cleanText(value, maxChars) {
  return stripControlChars(String(value ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxChars);
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const selectActive = db.prepare(
  "SELECT * FROM approvals WHERE shop_slug = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1"
);
const selectLatest = db.prepare(
  'SELECT * FROM approvals WHERE shop_slug = ? ORDER BY requested_at DESC LIMIT 1'
);
const selectLatestDecided = db.prepare(
  "SELECT * FROM approvals WHERE shop_slug = ? AND status IN ('approved','changes_requested') ORDER BY decided_at DESC LIMIT 1"
);

function isExpired(row) {
  return !!row && row.status === 'pending' && row.expires_at <= Date.now();
}

function publicApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    shop_slug: row.shop_slug,
    status: isExpired(row) ? 'expired' : row.status,
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    note: row.note || '',
    client_email: row.client_email,
    expires_at: row.expires_at,
    decided_at: row.decided_at || null,
    decided_by_name: row.decided_by_name || null,
    decided_by_email: row.decided_by_email || null,
    preflight: row.preflight_json ? safeParse(row.preflight_json) : null,
  };
}

// --- email -----------------------------------------------------------------

function sendReviewInvite(slug, approval, token, { resent = false } = {}) {
  const { companyName, primaryColor } = getShopBranding(slug);
  const inline = [];
  const url = reviewUrl(token);
  const body = `
    <h2 style="margin:0 0 14px;font-size:18px;color:#111;">Your site is ready to look at</h2>
    <p style="margin:0 0 14px;font-size:14px;color:#444;line-height:1.55;">
      The ${esc(companyName)} test site is ready for your review. Open the link below, look
      through the pages and the products, and leave a comment anywhere something needs to change.
    </p>
    ${approval.note ? `<p style="margin:0 0 14px;padding:12px 14px;background:#f6f6f6;border-radius:8px;font-size:14px;color:#333;line-height:1.55;">${esc(approval.note)}</p>` : ''}
    <p style="margin:0 0 20px;">
      <a href="${esc(url)}" style="display:inline-block;background:${primaryColor};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;">Open the review page</a>
    </p>
    <p style="margin:0 0 6px;font-size:12px;color:#777;line-height:1.5;">
      This link works for 30 days and does not need a password.
      ${resent ? 'It replaces the link we sent before, which no longer works.' : ''}
    </p>
    <p style="margin:0;font-size:12px;color:#777;line-height:1.5;">
      The site is a test site. Please do not place real orders on it.
    </p>`;
  const html = emailShell({ companyName, primaryColor, body, slug, inline });
  return sendMail({
    to: approval.client_email,
    from: getFromAddress(companyName),
    subject: `Please review the ${companyName} site`,
    html,
    inline,
  }).catch(() => {});
}

function sendDecisionNotice(slug, approval, decision, comments) {
  const { companyName, primaryColor } = getShopBranding(slug);
  const to = getAdminEmail(slug);
  if (!to) return Promise.resolve();
  const inline = [];
  const approved = decision === 'approved';
  const list = comments.length
    ? `<ul style="margin:0 0 16px;padding-left:18px;font-size:14px;color:#444;line-height:1.6;">${
        comments.map(c => `<li><strong>${esc(c.target_ref || 'General')}</strong>: ${esc(c.body)}</li>`).join('')
      }</ul>`
    : '<p style="margin:0 0 16px;font-size:14px;color:#444;">No comments were left.</p>';
  const body = `
    <h2 style="margin:0 0 14px;font-size:18px;color:#111;">
      ${approved ? 'The client approved the site' : 'The client asked for changes'}
    </h2>
    <p style="margin:0 0 14px;font-size:14px;color:#444;line-height:1.55;">
      ${esc(approval.decided_by_name || 'The client')}
      ${approval.decided_by_email ? `(${esc(approval.decided_by_email)})` : ''}
      ${approved ? 'approved' : 'asked for changes to'} the ${esc(companyName)} site on
      ${esc(new Date(approval.decided_at).toUTCString())}.
    </p>
    ${list}
    <p style="margin:0;font-size:12px;color:#777;line-height:1.5;">
      This is a record, not a release. An admin still has to move the shop to production in Launchpad.
    </p>`;
  const html = emailShell({ companyName, primaryColor, body, slug, inline });
  return sendMail({
    to,
    from: getFromAddress(companyName),
    subject: `${approved ? 'Approved' : 'Changes requested'}: ${companyName} site review`,
    html,
    inline,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Authenticated router — mounted under /api/shops behind requireAuth + CSRF
// ---------------------------------------------------------------------------

const router = express.Router();

// GET /api/shops/:slug/preflight
router.get('/:slug/preflight', requireShopAccess('viewer'), (req, res) => {
  res.json({ preflight: preflight(req.params.slug) });
});

// GET /api/shops/:slug/golive — get_approval_status
router.get('/:slug/golive', requireShopAccess('viewer'), (req, res) => {
  const { slug } = req.params;
  const active = selectActive.get(slug);
  const latest = selectLatest.get(slug);
  const decided = selectLatestDecided.get(slug);
  const shop = getShopRow(slug);
  const openComments = db.prepare(
    'SELECT COUNT(*) AS n FROM review_comments WHERE shop_slug = ? AND resolved = 0'
  ).get(slug).n;

  res.json({
    stage: effectiveStage(shop),
    stage_label: STAGE_LABELS[effectiveStage(shop)],
    active: publicApproval(active && !isExpired(active) ? active : null),
    latest: publicApproval(latest),
    approval: publicApproval(decided),
    open_comments: openComments,
  });
});

// POST /api/shops/:slug/golive — request_go_live
router.post('/:slug/golive', requireShopAccess('owner'), (req, res) => {
  const { slug } = req.params;
  const note = cleanText(req.body?.note, 1000);
  const clientEmail = cleanText(req.body?.client_email, 200).toLowerCase();

  if (!EMAIL_RE.test(clientEmail)) {
    return refuse(res, 400, 'NOT_PERMITTED',
      'That does not look like an email address.',
      'Enter the address of the person at the client who will look at the site.');
  }

  const existing = selectActive.get(slug);
  if (existing && !isExpired(existing)) {
    return refuse(res, 409, 'NOT_PERMITTED',
      `A review is already open for "${slug}", sent to ${existing.client_email}.`,
      'Use Resend review link to send it again, or Withdraw to cancel it and start over.');
  }

  // Run the checks before creating anything. A pending request that cannot pass
  // is worse than no request at all, because it reads as progress.
  const pf = preflight(slug);
  if (!pf.ok) {
    return refuse(res, 409, 'PREFLIGHT_FAILED',
      `This shop is not ready for review. ${pf.failures.join(' ')}`,
      'Fix the items listed in the Go live panel, then ask again.',
      true);
  }

  const token = newToken();
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO approvals
      (shop_slug, status, requested_by, requested_at, note, client_email,
       token_hash, token_issued_at, expires_at, preflight_json)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug, req.session.user.id, now, note, clientEmail,
    hashToken(token), now, now + REVIEW_TTL_MS, JSON.stringify(pf),
  );

  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(info.lastInsertRowid);
  sendReviewInvite(slug, row, token);
  const audit_id = audit(req, 'golive_requested', { slug, approval_id: row.id, client_email: clientEmail });

  res.status(201).json({ approval: publicApproval(row), review_url: reviewUrl(token), preflight: pf, audit_id });
});

// POST /api/shops/:slug/golive/withdraw — withdraw_go_live
router.post('/:slug/golive/withdraw', requireShopAccess('owner'), (req, res) => {
  const { slug } = req.params;
  const active = selectActive.get(slug);
  if (!active) {
    return refuse(res, 404, 'NOT_PERMITTED',
      `There is no open review for "${slug}".`,
      'Request a review first.');
  }
  // The token hash is replaced with a value nothing can hash to, so the link
  // dies with the request instead of living on in a forwarded email.
  db.prepare(`
    UPDATE approvals
    SET status = 'withdrawn', withdrawn_at = ?, withdrawn_by = ?, token_hash = ?
    WHERE id = ?
  `).run(Date.now(), req.session.user.id, `withdrawn:${active.id}:${crypto.randomUUID()}`, active.id);

  const audit_id = audit(req, 'golive_withdrawn', { slug, approval_id: active.id });
  res.json({ approval: publicApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(active.id)), audit_id });
});

// POST /api/shops/:slug/golive/resend — resend_review_link
router.post('/:slug/golive/resend', requireShopAccess('owner'), (req, res) => {
  const { slug } = req.params;
  const active = selectActive.get(slug);
  if (!active || isExpired(active)) {
    return refuse(res, 404, 'NOT_PERMITTED',
      `There is no open review for "${slug}".`,
      'Request a review first.');
  }
  const token = newToken();
  const now = Date.now();
  db.prepare(
    'UPDATE approvals SET token_hash = ?, token_issued_at = ?, expires_at = ? WHERE id = ?'
  ).run(hashToken(token), now, now + REVIEW_TTL_MS, active.id);

  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(active.id);
  sendReviewInvite(slug, row, token, { resent: true });
  const audit_id = audit(req, 'golive_link_resent', { slug, approval_id: active.id });

  res.json({ approval: publicApproval(row), review_url: reviewUrl(token), audit_id });
});

// GET /api/shops/:slug/golive/feedback — list_review_feedback
router.get('/:slug/golive/feedback', requireShopAccess('viewer'), (req, res) => {
  const { slug } = req.params;
  const includeResolved = req.query.include_resolved === 'true';
  const rows = db.prepare(`
    SELECT * FROM review_comments
    WHERE shop_slug = ? ${includeResolved ? '' : 'AND resolved = 0'}
    ORDER BY created_at DESC
  `).all(slug);
  res.json({ comments: rows });
});

// POST /api/shops/:slug/golive/feedback/:id/resolve — resolve_feedback
router.post('/:slug/golive/feedback/:id/resolve', requireShopAccess('editor'), (req, res) => {
  const { slug, id } = req.params;
  const row = db.prepare('SELECT * FROM review_comments WHERE id = ? AND shop_slug = ?').get(id, slug);
  if (!row) {
    return refuse(res, 404, 'NOT_PERMITTED',
      'That comment is not on this shop.',
      'Reload the feedback list and try again.');
  }
  const resolved = req.body?.resolved === false ? 0 : 1;
  db.prepare('UPDATE review_comments SET resolved = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
    .run(resolved, resolved ? Date.now() : null, resolved ? req.session.user.id : null, row.id);

  const audit_id = audit(req, resolved ? 'review_comment_resolved' : 'review_comment_reopened', { slug, comment_id: row.id });
  res.json({ comment: db.prepare('SELECT * FROM review_comments WHERE id = ?').get(row.id), audit_id });
});

// PUT /api/shops/:slug/stage — the admin flips the stage, not the client.
//
// Client approval is evidence. This is the trigger, and it stays in the web UI
// behind a person who can see the approval and the preflight next to it.
router.put('/:slug/stage', requireShopAccess('owner'), (req, res) => {
  const { slug } = req.params;
  const stage = String(req.body?.stage || '');

  if (!STAGES.includes(stage)) {
    return refuse(res, 400, 'NOT_PERMITTED',
      `"${stage}" is not a stage. The stages are no status, in testing and in production.`,
      'Pick one of the three stages.');
  }

  if (stage === 'in_production') {
    if (req.via === 'mcp') {
      return refuse(res, 403, 'ADMIN_ONLY',
        'Moving a shop to production has to be done in Launchpad, in a browser.',
        'Open the shop settings page in Launchpad and use the Stage control there.');
    }
    if (req.session?.user?.role !== 'super_admin') {
      return refuse(res, 403, 'ADMIN_ONLY',
        'Only a super admin can move a shop to production.',
        'Ask Giovanni Lupo or Arnaud Aubert to make the change.');
    }
  }

  const shop = getShopRow(slug);
  if (!shop) {
    return refuse(res, 404, 'NO_SUCH_SHOP',
      `There is no shop called "${slug}".`,
      'Check the shop list in Launchpad for the right name.');
  }

  const from = effectiveStage(shop);
  const lifecycle = STAGE_TO_LIFECYCLE[stage];
  let sdb;
  try {
    sdb = openShopsDb();
    if (hasStageColumn(sdb)) {
      sdb.prepare('UPDATE shops SET lifecycle_status = ?, stage = ? WHERE slug = ?').run(lifecycle, stage, slug);
    } else {
      sdb.prepare('UPDATE shops SET lifecycle_status = ? WHERE slug = ?').run(lifecycle, slug);
    }
  } finally {
    try { sdb?.close(); } catch { /* best-effort */ }
  }

  const applied = applyShopStage(slug, stage, { rebuild: from !== stage });
  const audit_id = audit(req, 'shop_stage_changed', { slug, from, to: stage, rebuilt: applied.rebuilt });

  res.json({
    audit_id,
    slug,
    previous_stage: from,
    stage,
    stage_label: STAGE_LABELS[stage],
    lifecycle_status: lifecycle,
    rebuilt: applied.rebuilt,
    log: applied.log,
  });
});

// ---------------------------------------------------------------------------
// Public review router — no login, no account, one shop per token
//
// Mounted at /api/review, outside the /api/shops requireAuth tree. Everything
// this router can reach is reached through the token, so no URL here carries a
// slug and nothing here can be pointed at a second shop.
// ---------------------------------------------------------------------------

const publicRouter = express.Router();

const reviewReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: { code: 'NOT_PERMITTED', message: 'Too many requests from this network. Wait a few minutes and open the link again.', resolution: 'Wait a few minutes, then open the link again.', possible: true } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Writes are the expensive half: a comment is stored and a decision sends mail.
// Tighter, and counted per IP, so a forwarded link cannot be used to flood.
const reviewWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: { code: 'NOT_PERMITTED', message: 'Too many comments in a short time. Wait a few minutes and try again.', resolution: 'Wait a few minutes, then send the comment again.', possible: true } },
  standardHeaders: true,
  legacyHeaders: false,
});

publicRouter.use(reviewReadLimiter);

// One answer for every bad token: expired, withdrawn, replaced, made up. A
// different answer for each would tell a guesser which guesses were closer.
function invalidLink(res) {
  return refuse(res, 404, 'TICKET_INVALID',
    'This review link is not valid. It may have been replaced by a newer one, or it may have expired.',
    'Ask your contact at LR Paris to send you a new link.');
}

function loadByToken(req) {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  const row = db.prepare('SELECT * FROM approvals WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  if (row.status === 'withdrawn') return null;
  if (row.expires_at <= Date.now()) return null;
  return row;
}

// The list the client is asked to look at. Short on purpose: it is read on a
// phone by somebody who is not an engineer.
const REVIEW_CHECKLIST = [
  'The company name, the logo and the colors look right.',
  'The products are the right ones, with the right names and photos.',
  'Prices and quantities are correct.',
  'The checkout form asks for what you need it to ask for.',
  'The text on the About page reads the way you want it to.',
];

const REVIEW_PAGES = [
  { ref: 'home', label: 'Home page' },
  { ref: 'shop', label: 'Products' },
  { ref: 'about', label: 'About page' },
  { ref: 'checkout', label: 'Checkout' },
];

// GET /api/review/:token
publicRouter.get('/:token', (req, res) => {
  const row = loadByToken(req);
  if (!row) return invalidLink(res);

  const shop = getShopRow(row.shop_slug);
  const comments = db.prepare(
    'SELECT id, target_type, target_ref, body, author_name, created_at FROM review_comments WHERE approval_id = ? ORDER BY created_at'
  ).all(row.id);

  // Pages and products are read out of this shop's own DATABASE folder, so the
  // list cannot name anything outside it.
  const products = collectProducts(row.shop_slug).map(p => ({
    ref: `${p.collection}/${p.folder}`,
    collection: p.collection,
    name: p.folder,
  }));

  res.json({
    shop: {
      name: shop?.name || row.shop_slug,
      url: `${getBaseUrl()}/${row.shop_slug}/`,
      stage_label: STAGE_LABELS[effectiveStage(shop)],
    },
    status: row.status,
    decided_at: row.decided_at || null,
    decided_by_name: row.decided_by_name || null,
    expires_at: row.expires_at,
    note: row.note || '',
    checklist: REVIEW_CHECKLIST,
    pages: REVIEW_PAGES,
    products,
    comments,
  });
});

// POST /api/review/:token/comment
publicRouter.post('/:token/comment', reviewWriteLimiter, (req, res) => {
  const row = loadByToken(req);
  if (!row) return invalidLink(res);
  if (row.status !== 'pending') {
    return refuse(res, 409, 'NOT_PERMITTED',
      'This review is closed, so comments cannot be added to it.',
      'Ask your contact at LR Paris to open a new review.');
  }

  const targetType = ['page', 'product', 'general'].includes(req.body?.target_type)
    ? req.body.target_type : 'general';
  const body = cleanText(req.body?.body, MAX_COMMENT_CHARS);
  const authorName = cleanText(req.body?.author_name, MAX_NAME_CHARS);
  let targetRef = cleanText(req.body?.target_ref, 200);

  if (!body) {
    return refuse(res, 400, 'NOT_PERMITTED',
      'The comment is empty.',
      'Write what needs to change, then send it again.');
  }

  // The reference has to be one this shop offered, so a comment cannot be filed
  // against a page or a product that belongs to somebody else.
  if (targetType === 'product') {
    const known = collectProducts(row.shop_slug).some(p => `${p.collection}/${p.folder}` === targetRef);
    if (!known) targetRef = '';
  } else if (targetType === 'page') {
    if (!REVIEW_PAGES.some(p => p.ref === targetRef)) targetRef = '';
  } else {
    targetRef = '';
  }

  const info = db.prepare(`
    INSERT INTO review_comments
      (approval_id, shop_slug, target_type, target_ref, body, author_name, author_email, created_at, created_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.shop_slug, targetType, targetRef, body, authorName, row.client_email, Date.now(), clientIp(req));

  res.status(201).json({
    comment: db.prepare(
      'SELECT id, target_type, target_ref, body, author_name, created_at FROM review_comments WHERE id = ?'
    ).get(info.lastInsertRowid),
  });
});

// POST /api/review/:token/decision
publicRouter.post('/:token/decision', reviewWriteLimiter, (req, res) => {
  const row = loadByToken(req);
  if (!row) return invalidLink(res);
  if (row.status !== 'pending') {
    return refuse(res, 409, 'NOT_PERMITTED',
      'This review has already been answered.',
      'Ask your contact at LR Paris to open a new review.');
  }

  const decision = req.body?.decision === 'approved' ? 'approved'
    : req.body?.decision === 'changes_requested' ? 'changes_requested' : null;
  if (!decision) {
    return refuse(res, 400, 'NOT_PERMITTED',
      'Choose Approve or Request changes.',
      'Pick one of the two buttons at the bottom of the page.');
  }

  const name = cleanText(req.body?.name, MAX_NAME_CHARS);
  if (!name) {
    return refuse(res, 400, 'NOT_PERMITTED',
      'Please put your name on the decision.',
      'Type your name in the box above the buttons.');
  }

  const now = Date.now();
  db.prepare(`
    UPDATE approvals
    SET status = ?, decided_at = ?, decided_by_name = ?, decided_by_email = ?,
        decided_ip = ?, decided_user_agent = ?
    WHERE id = ?
  `).run(
    decision, now, name, row.client_email, clientIp(req),
    cleanText(req.headers['user-agent'], 300), row.id,
  );

  const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(row.id);
  const comments = db.prepare(
    'SELECT target_type, target_ref, body FROM review_comments WHERE approval_id = ? ORDER BY created_at'
  ).all(row.id);
  sendDecisionNotice(row.shop_slug, updated, decision, comments);

  res.json({ status: decision, decided_at: now, decided_by_name: name });
});

module.exports = {
  router,
  publicRouter,
  preflight,
  applyShopStage,
  injectStageBanner,
  writeStageToCompose,
  effectiveStage,
  STAGES,
  STAGE_LABELS,
  STAGE_TO_LIFECYCLE,
  LIFECYCLE_TO_STAGE,
};
