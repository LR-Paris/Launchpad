// ---------------------------------------------------------------------------
// issues.js — platform problem reports.
//
// When the platform itself gets in the way (a link that 404s, a refusal that
// makes no sense, a build that never finishes), the person's assistant used to
// say "tell Gio", and Gio heard about every one of them. Now the assistant
// files a report here and keeps going. The reports wait in one queue for
// whoever maintains Launchpad, nobody gets an email, and nobody is asked to
// relay anything.
//
// Who sees what: your own reports, every report on a shop you own, and every
// report for a super_admin. Closing one takes the reporter, an owner of the
// shop, or a super_admin.
// ---------------------------------------------------------------------------
const express = require('express');
const rateLimit = require('express-rate-limit');

let _authz = null;
function authz() {
  if (!_authz) _authz = require('./authz');
  return _authz;
}

let _ready = false;
function db() {
  const { db: handle } = require('./platform-db');
  if (!_ready) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS issue_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT,
        shop_slug TEXT,
        title TEXT NOT NULL,
        details TEXT,
        tool TEXT,
        error_code TEXT,
        via TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at INTEGER,
        resolved_by TEXT,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_issue_reports_status ON issue_reports(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_issue_reports_shop ON issue_reports(shop_slug);
    `);
    _ready = true;
  }
  return handle;
}

const SLUG_RE = /^[a-z0-9-]{1,63}$/;
const TOOL_RE = /^[a-z_]{1,60}$/;
const CODE_RE = /^[A-Z_]{1,40}$/;
const DUPLICATE_WINDOW_MS = 60 * 60 * 1000;

function isSuperAdmin(user) {
  return !!user && user.role === 'super_admin';
}

function canSee(user, row) {
  if (!user || !row) return false;
  if (isSuperAdmin(user)) return true;
  if (row.user_id === user.id) return true;
  return !!row.shop_slug && authz().membershipRole(user.id, row.shop_slug) === 'owner';
}

function shape(row) {
  return {
    issue_id: row.id,
    status: row.status,
    shop: row.shop_slug || null,
    title: row.title,
    details: row.details || '',
    tool: row.tool || null,
    error_code: row.error_code || null,
    reported_by: row.username || null,
    reported_at: new Date(row.created_at).toISOString(),
    ...(row.status === 'resolved' ? {
      resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      resolved_by: row.resolved_by || null,
      resolution: row.resolution || '',
    } : {}),
  };
}

const router = express.Router();

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `issues:${req.session?.user?.id || req.ip || 'anon'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'NOT_PERMITTED', message: 'Too many reports in one hour from this account.', resolution: 'The ones already filed are in the queue. Carry on with the task.', possible: true } },
});

// POST /api/issues  { title, details?, shop_slug?, tool?, error_code? }
router.post('/', reportLimiter, (req, res) => {
  const { refuse, audit } = authz();
  const user = req.session?.user;
  const body = req.body || {};
  const title = String(body.title || '').replace(/\s+/g, ' ').trim();
  const details = String(body.details || '').replace(/\r\n?/g, '\n').trim();
  const shopSlug = body.shop_slug ? String(body.shop_slug).trim() : null;
  const tool = body.tool ? String(body.tool).trim() : null;
  const errorCode = body.error_code ? String(body.error_code).trim() : null;

  if (title.length < 3 || title.length > 140) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'A report needs a title of 3 to 140 characters.',
      'Say in one line what went wrong, for example "Upload link opens a 404".', true);
  }
  if (details.length > 4000) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'The details are longer than 4,000 characters.',
      'Keep what you tried, what came back and when. Leave out file contents.', true);
  }
  if (shopSlug && !SLUG_RE.test(shopSlug)) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'That shop slug is not valid.', 'Use the slug as list_my_shops shows it, or leave it out.', true);
  }
  if (tool && !TOOL_RE.test(tool)) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'That tool name is not valid.', 'Use the tool name exactly, for example request_upload.', true);
  }
  if (errorCode && !CODE_RE.test(errorCode)) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'That error code is not valid.', 'Use the code from the refusal, for example SHOP_BUSY, or leave it out.', true);
  }

  const handle = db();
  const now = Date.now();
  const same = handle.prepare(`
    SELECT * FROM issue_reports
    WHERE user_id IS ? AND title = ? AND shop_slug IS ? AND status = 'open' AND created_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(user?.id ?? null, title, shopSlug, now - DUPLICATE_WINDOW_MS);
  if (same) {
    return res.json({ ...shape(same), duplicate: true, next: 'Already in the queue. Carry on with what you can do.' });
  }

  const info = handle.prepare(`
    INSERT INTO issue_reports (created_at, user_id, username, shop_slug, title, details, tool, error_code, via)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now, user?.id ?? null, user?.username ?? null, shopSlug, title, details, tool, errorCode, req.via || 'web');
  const row = handle.prepare('SELECT * FROM issue_reports WHERE id = ?').get(info.lastInsertRowid);
  const audit_id = audit(req, 'issue_reported', { shop_slug: shopSlug, issue_id: row.id, title, tool, error_code: errorCode });
  return res.json({
    ...shape(row),
    audit_id,
    next: 'Logged for the people who maintain Launchpad. Nothing else is needed from the person. Carry on with what you can do.',
  });
});

// GET /api/issues?status=open|resolved|all&shop_slug=&limit=&offset=
router.get('/', (req, res) => {
  const user = req.session?.user;
  const status = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const shopSlug = SLUG_RE.test(String(req.query.shop_slug || '')) ? String(req.query.shop_slug) : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = [];
  const args = [];
  if (status !== 'all') { where.push('status = ?'); args.push(status); }
  if (shopSlug) { where.push('shop_slug = ?'); args.push(shopSlug); }
  const rows = db().prepare(`
    SELECT * FROM issue_reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT 1000
  `).all(...args).filter((row) => canSee(user, row));
  return res.json({
    total: rows.length,
    offset,
    issues: rows.slice(offset, offset + limit).map(shape),
  });
});

// POST /api/issues/:id/resolve  { resolution }
router.post('/:id/resolve', (req, res) => {
  const { refuse, audit } = authz();
  const user = req.session?.user;
  const id = parseInt(req.params.id, 10);
  const resolution = String((req.body || {}).resolution || '').replace(/\s+/g, ' ').trim();
  const handle = db();
  const row = Number.isInteger(id) ? handle.prepare('SELECT * FROM issue_reports WHERE id = ?').get(id) : null;
  if (!row || !canSee(user, row)) {
    return refuse(res, 404, 'PREFLIGHT_FAILED', 'There is no report by that number that you can see.',
      'Call list_issues to see the reports you can close.', true);
  }
  if (resolution.length < 3 || resolution.length > 500) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'Say in one sentence what fixed it, 3 to 500 characters.',
      'For example "Upload links open a page since deploy-20261020-3".', true);
  }
  if (row.status === 'resolved') return res.json({ ...shape(row), already: true });
  handle.prepare(`
    UPDATE issue_reports SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?
  `).run(Date.now(), user?.username ?? null, resolution, id);
  const updated = handle.prepare('SELECT * FROM issue_reports WHERE id = ?').get(id);
  const audit_id = audit(req, 'issue_resolved', { shop_slug: row.shop_slug, issue_id: id });
  return res.json({ ...shape(updated), audit_id });
});

module.exports = { router, canSee };
