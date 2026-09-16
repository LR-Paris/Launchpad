const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

// authz.js and platform-db.js are agent A's files and land in the same change as
// this one. They are required lazily so the ticket helpers below stay loadable
// (and testable) with plain `node` before the server is wired together.
let _authz = null;
function authz() {
  if (!_authz) _authz = require('./authz');
  return _authz;
}

const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const TMP_DIR = path.join(__dirname, '..', 'data', 'tmp');

// A ticket is valid for 15 minutes. Long enough to zip a folder and start a
// 500 MB upload on hotel wifi, short enough that a ticket pasted into a Slack
// thread is dead before anyone scrolls back to it.
const TICKET_TTL_MS = 15 * 60 * 1000;

// The ADR says a real DATABASE with photos is 50 to 500 MB. Photos are already
// JPEG, so the zip is roughly the size of the folder: the compressed and
// uncompressed caps are within a factor of two of each other, not a hundred.
// 512 MiB leaves headroom above the documented ceiling while keeping the worst
// case per request bounded (512 MiB temp + 512 MiB staging + one backup zip).
// files.js caps its own upload at 100 MB, which is below a real DATABASE, and
// that is one of the reasons "zip it and pray" fails on the shops that matter.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let _tablesReady = false;
function db() {
  const { db: handle } = require('./platform-db');
  if (!_tablesReady) {
    // Idempotent on purpose: platform-db.js creates this table too, and a second
    // CREATE IF NOT EXISTS is free. Declared here as well so this module is
    // never at the mercy of another file having been migrated first.
    handle.exec(`
      CREATE TABLE IF NOT EXISTS upload_tickets (
        id TEXT PRIMARY KEY,
        shop_slug TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        via TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_ip TEXT,
        upload_path TEXT,
        bytes INTEGER,
        staging_id TEXT,
        staged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_upload_tickets_shop ON upload_tickets(shop_slug);
      CREATE INDEX IF NOT EXISTS idx_upload_tickets_expiry ON upload_tickets(expires_at);
    `);
    _tablesReady = true;
  }
  return handle;
}

// The raw ticket is the whole credential: the consuming route has no session and
// no CSRF token, because a shell curl and a browser drop both have to work. So
// only the SHA-256 of the ticket is stored. Lookup is by that hash, which means
// the index comparison happens on a value an attacker cannot steer toward a
// partial match, and a copy of platform.db yields no usable tickets. The
// timingSafeEqual below closes the last hair of a compare-time signal.
function hashTicket(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function sameHash(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const TICKET_RE = /^[0-9a-f]{64}$/;

function issueTicket(slug, userId, via) {
  const raw = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + TICKET_TTL_MS;
  db().prepare(`
    INSERT INTO upload_tickets (id, shop_slug, user_id, via, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hashTicket(raw), slug, userId, via || 'web', now, expiresAt);
  return {
    ticket: raw,
    shop: slug,
    expires_at: new Date(expiresAt).toISOString(),
    max_bytes: MAX_UPLOAD_BYTES,
    upload_url: `/api/upload/${raw}`,
  };
}

// Claim a ticket for exactly one upload. The UPDATE carries the whole test in
// its WHERE clause so two requests racing on the same ticket cannot both win:
// the loser sees changes === 0. The ticket is burned before the body is read,
// not after, because a credential that survives a failed attempt is a
// credential that can be replayed.
function claimTicket(raw, ip) {
  if (typeof raw !== 'string' || !TICKET_RE.test(raw)) {
    return { ok: false, code: 'TICKET_INVALID' };
  }
  const id = hashTicket(raw);
  const handle = db();
  const row = handle.prepare('SELECT * FROM upload_tickets WHERE id = ?').get(id);
  if (!row || !sameHash(row.id, id)) return { ok: false, code: 'TICKET_INVALID' };

  const now = Date.now();
  if (row.expires_at <= now) return { ok: false, code: 'TICKET_EXPIRED', row };
  if (row.used_at) return { ok: false, code: 'TICKET_INVALID', row, reason: 'already_used' };

  const result = handle.prepare(`
    UPDATE upload_tickets SET used_at = ?, used_ip = ?
    WHERE id = ? AND used_at IS NULL AND expires_at > ?
  `).run(now, ip || null, id, now);
  if (result.changes !== 1) {
    return { ok: false, code: 'TICKET_INVALID', row, reason: 'already_used' };
  }
  return { ok: true, row: handle.prepare('SELECT * FROM upload_tickets WHERE id = ?').get(id) };
}

function recordUpload(ticketId, uploadPath, bytes) {
  db().prepare('UPDATE upload_tickets SET upload_path = ?, bytes = ? WHERE id = ?')
    .run(uploadPath, bytes, ticketId);
}

function recordStaging(ticketId, stagingId) {
  db().prepare('UPDATE upload_tickets SET staging_id = ?, staged_at = ? WHERE id = ?')
    .run(stagingId, Date.now(), ticketId);
}

// Used by staging.js when someone calls stage_database with a ticket whose
// upload landed but whose staging did not finish.
function getTicketByRaw(raw) {
  if (typeof raw !== 'string' || !TICKET_RE.test(raw)) return null;
  return db().prepare('SELECT * FROM upload_tickets WHERE id = ?').get(hashTicket(raw)) || null;
}

function purgeExpiredTickets() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = db().prepare(
    'SELECT id, upload_path FROM upload_tickets WHERE expires_at < ? AND staged_at IS NULL'
  ).all(cutoff);
  for (const t of stale) {
    if (t.upload_path) { try { fs.unlinkSync(t.upload_path); } catch { /* best-effort */ } }
  }
  db().prepare('DELETE FROM upload_tickets WHERE expires_at < ?').run(cutoff);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Pre-template shops (today only michael-kors) have no lib/version.ts and a
// different DATABASE layout. Staging their catalog would produce a confident
// diff about a structure that does not apply to them.
function isLegacyShop(slug) {
  return !fs.existsSync(path.join(SHOPS_DIR, slug, 'lib', 'version.ts'));
}

function refuseLegacy(res, slug) {
  const { refuse } = authz();
  return refuse(res, 409, 'LEGACY_SHOP',
    `"${slug}" runs a pre-template version of Shuttle, so its DATABASE has a different layout than this tool understands.`,
    'Send the DATABASE changes to Giovanni Lupo, who applies them by hand.',
    false);
}

// ---------------------------------------------------------------------------
// Router 1: issuing tickets. Mounted INSIDE the /api/shops requireAuth tree.
// ---------------------------------------------------------------------------

const ticketRouter = express.Router();

const issueLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: { code: 'NOT_PERMITTED', message: 'Too many upload tickets requested.', resolution: 'Wait fifteen minutes and try again.', possible: true } },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/shops/:slug/database/upload-ticket
ticketRouter.post('/:slug/database/upload-ticket', issueLimiter, (req, res) => {
  const { audit } = authz();
  const { slug } = req.params;

  if (isLegacyShop(slug)) return refuseLegacy(res, slug);

  const ticket = issueTicket(slug, req.session.user.id, req.via || 'web');
  const audit_id = audit(req, 'upload_ticket_issued', {
    shop_slug: slug,
    expires_at: ticket.expires_at,
    max_bytes: MAX_UPLOAD_BYTES,
  });
  // The shape is flat: { ticket, shop, expires_at, max_bytes, upload_url }.
  // `ticket` is the credential itself, which is why it is a string here and not
  // an object with an id in it.
  res.json({ ...ticket, audit_id });
});

// ---------------------------------------------------------------------------
// Router 2: consuming tickets. Mounted OUTSIDE requireAuth and outside CSRF.
// ---------------------------------------------------------------------------

const uploadRouter = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // This route is unauthenticated, so the limiter is the only thing standing
  // between a stranger and 512 MB of disk per request. Ten is well above what a
  // real person needs (one ticket, one upload) and low enough that guessing at
  // 2^256 of ticket space is not worth anyone's afternoon.
  max: 10,
  message: { error: { code: 'NOT_PERMITTED', message: 'Too many uploads from this address.', resolution: 'Wait fifteen minutes and try again.', possible: true } },
  standardHeaders: true,
  legacyHeaders: false,
});

const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      cb(null, TMP_DIR);
    },
    filename: (req, file, cb) => {
      cb(null, `dbzip-${req.ticketRow.id.slice(0, 12)}-${Date.now()}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
});

function ticketRefusal(res, code, slug) {
  const { refuse } = authz();
  if (code === 'TICKET_EXPIRED') {
    return refuse(res, 401, 'TICKET_EXPIRED',
      'That upload ticket expired. Tickets are good for fifteen minutes.',
      'Call request_upload again to get a fresh ticket.', true);
  }
  return refuse(res, 401, 'TICKET_INVALID',
    'That upload ticket is not valid, or it has already been used.',
    slug
      ? `Call request_upload for "${slug}" to get a fresh ticket.`
      : 'Call request_upload to get a fresh ticket.', true);
}

// Validate and burn the ticket BEFORE any bytes are written. An unauthenticated
// route that accepts half a gigabyte and only then checks the credential is a
// disk-fill button with a URL.
function resolveTicket(req, res, next) {
  const { audit } = authz();
  const claim = claimTicket(req.params.ticket, req.ip);
  if (!claim.ok) {
    // Never log the raw ticket, and only a prefix of its hash: it is a credential.
    audit(req, 'upload_ticket_rejected', {
      shop_slug: claim.row ? claim.row.shop_slug : null,
      code: claim.code,
      reason: claim.reason || 'not_found',
      ticket_prefix: typeof req.params.ticket === 'string' ? hashTicket(req.params.ticket).slice(0, 8) : null,
      ip: req.ip,
    });
    return ticketRefusal(res, claim.code, claim.row ? claim.row.shop_slug : null);
  }
  req.ticketRow = claim.row;
  next();
}

function uploadFailed(req, res, message) {
  const { refuse, audit } = authz();
  audit(req, 'upload_failed', {
    shop_slug: req.ticketRow ? req.ticketRow.shop_slug : null,
    user_id: req.ticketRow ? req.ticketRow.user_id : null,
    reason: message,
  });
  if (res.headersSent) return undefined;
  return refuse(res, 400, 'PREFLIGHT_FAILED', message,
    'Check the file, then call request_upload for a new ticket and try again.', true);
}

// A shell does `curl --data-binary @db.zip`; a browser drop does multipart. Both
// have to work, so multipart goes through multer and anything else is streamed
// to the same place under the same cap.
function acceptBody(req, res, next) {
  const type = String(req.headers['content-type'] || '');
  if (type.startsWith('multipart/form-data')) {
    return zipUpload.single('file')(req, res, (err) => {
      if (err) return uploadFailed(req, res, err.message);
      if (!req.file) return uploadFailed(req, res, 'No file was included in the upload.');
      req.uploadPath = req.file.path;
      req.uploadBytes = req.file.size;
      return next();
    });
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dest = path.join(TMP_DIR, `dbzip-${req.ticketRow.id.slice(0, 12)}-${Date.now()}`);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  let aborted = false;
  const fail = (message) => {
    if (aborted) return;
    aborted = true;
    out.destroy();
    try { fs.unlinkSync(dest); } catch { /* best-effort */ }
    uploadFailed(req, res, message);
  };
  req.on('data', (chunk) => {
    if (aborted) return;
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) {
      fail(`Upload is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`);
    }
  });
  req.on('error', () => fail('The upload was cut off before it finished.'));
  out.on('error', () => fail('Could not write the upload to disk.'));
  out.on('finish', () => {
    if (aborted) return;
    if (bytes === 0) {
      try { fs.unlinkSync(dest); } catch { /* best-effort */ }
      return uploadFailed(req, res, 'The upload was empty.');
    }
    req.uploadPath = dest;
    req.uploadBytes = bytes;
    return next();
  });
  return req.pipe(out);
}

// POST /api/upload/:ticket — no session, no CSRF. The ticket is the credential.
uploadRouter.post('/:ticket', uploadLimiter, resolveTicket, acceptBody, async (req, res) => {
  const { refuse, audit, withShopLock } = authz();
  const row = req.ticketRow;
  const slug = row.shop_slug;

  recordUpload(row.id, req.uploadPath, req.uploadBytes);
  audit(req, 'upload_ticket_used', {
    shop_slug: slug,
    user_id: row.user_id,
    bytes: req.uploadBytes,
    ip: req.ip,
    ticket_prefix: row.id.slice(0, 8),
  });

  if (isLegacyShop(slug)) {
    try { fs.unlinkSync(req.uploadPath); } catch { /* best-effort */ }
    return refuseLegacy(res, slug);
  }

  // Required lazily: staging.js reads ticket rows from this module, and a
  // top-level require in both directions is a cycle.
  const staging = require('./staging');

  try {
    // await matters twice here. Without it `result` is a Promise, and the
    // finally below deletes the uploaded zip out from under stageDatabase
    // while it is still reading it.
    const result = await withShopLock(slug, row.user_id, 'stage_database', () => (
      staging.stageDatabase({ slug, zipPath: req.uploadPath, userId: row.user_id, ticketId: row.id })
    ));
    recordStaging(row.id, result.staging_id);
    staging.recordStagingRow({
      stagingId: result.staging_id,
      slug,
      userId: row.user_id,
      ticketId: row.id,
      diff: result.diff,
    });
    const audit_id = audit(req, 'database_staged', {
      shop_slug: slug,
      user_id: row.user_id,
      staging_id: result.staging_id,
      blocking: result.diff.blocking.length,
      warnings: result.diff.warnings.length,
    });
    return res.json({ shop: slug, staging_id: result.staging_id, diff: result.diff, audit_id });
  } catch (err) {
    if (err && err.code === 'SHOP_BUSY') {
      return refuse(res, 409, 'SHOP_BUSY',
        `Someone else is working on "${slug}" right now (${err.action}).`,
        'Wait for that to finish, then call request_upload for a new ticket.', true);
    }
    if (err && err.code === 'PREFLIGHT_FAILED') {
      audit(req, 'database_stage_rejected', { shop_slug: slug, user_id: row.user_id, reason: err.message });
      return refuse(res, 400, 'PREFLIGHT_FAILED', err.message,
        'Fix the zip, then call request_upload for a new ticket and upload again.', true);
    }
    // This handler is async, so a rethrow here becomes an unhandled rejection
    // and the caller gets nothing at all. Answer it.
    console.error(`[upload] staging ${slug} failed: ${err && err.message}`);
    return refuse(res, 500, 'NOT_PERMITTED', 'That upload could not be staged.',
      'Try again in a moment. If it keeps happening, tell Gio.', true);
  } finally {
    try { fs.unlinkSync(req.uploadPath); } catch { /* best-effort */ }
  }
});

module.exports = {
  ticketRouter,
  uploadRouter,
  issueTicket,
  claimTicket,
  getTicketByRaw,
  recordStaging,
  purgeExpiredTickets,
  hashTicket,
  isLegacyShop,
  refuseLegacy,
  MAX_UPLOAD_BYTES,
  TICKET_TTL_MS,
};
