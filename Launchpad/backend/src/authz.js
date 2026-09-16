// ---------------------------------------------------------------------------
// authz.js — ADR-001 "Shuttle Dev Tool"
//
// One place that answers three questions for every /:slug route:
//   which shop is this, what may this person do to it, and who do they ask if
//   the answer is no. The third one is the point: a refusal that does not name
//   a person is a dead end for an agent and for a human.
//
// Nothing here replaces the existing checkShopPermission() booleans. The role
// column and the booleans are two representations of one fact and are always
// written together (see setShopRole below).
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { db: platformDb, USERS_DB_PATH, SHOPS_DB_PATH } = require('./platform-db');
const fileLock = require('./lock');

const ROLES = ['viewer', 'editor', 'owner'];
const RANK = { any: 0, viewer: 1, editor: 2, owner: 3 };

// Locks older than this are assumed to belong to a crashed request and are
// stolen. 10 minutes is longer than any apply we perform and shorter than a
// coffee break, which is the window a human would wait before asking why the
// shop is stuck.
const LOCK_STALE_MS = 10 * 60 * 1000;
// The launch lock in lock.js is cleared by the build poller, but a container
// that never comes up leaves the file behind. shops.js gives a build 15 minutes
// before it calls it dead, so we use the same number rather than inventing one.
const LAUNCH_LOCK_STALE_MS = 15 * 60 * 1000;

// Long-lived read handles. better-sqlite3 is synchronous and these databases
// are opened by users.js / shops.js too; WAL makes concurrent readers fine.
let _usersDb = null;
let _shopsDb = null;

function usersDb() {
  if (!_usersDb) {
    _usersDb = new Database(USERS_DB_PATH);
    _usersDb.pragma('busy_timeout = 5000');
  }
  return _usersDb;
}

function shopsDb() {
  if (!_shopsDb) {
    _shopsDb = new Database(SHOPS_DB_PATH);
    _shopsDb.pragma('busy_timeout = 5000');
  }
  return _shopsDb;
}

// Tests build a throwaway data directory and call this before anything else.
function _useDatabases({ users, shops }) {
  if (_usersDb) { try { _usersDb.close(); } catch { /* ignore */ } }
  if (_shopsDb) { try { _shopsDb.close(); } catch { /* ignore */ } }
  _usersDb = users ? new Database(users) : null;
  _shopsDb = shops ? new Database(shops) : null;
}

// ---------------------------------------------------------------------------
// The refusal payload. Identical everywhere, because the MCP server and the
// plugin both parse it and neither should need a special case.
// ---------------------------------------------------------------------------
function refuse(res, status, code, message, resolution, possible = false) {
  return res.status(status).json({
    error: { code, message, resolution, possible: !!possible },
  });
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

// Derive a role from the legacy booleans. Used only for rows written before the
// migration ran, or by an older endpoint that still writes booleans directly.
function roleFromBooleans(row) {
  if (!row) return null;
  if (row.can_delete) return 'owner';
  if (row.can_edit_ui || row.can_edit_items) return 'editor';
  return 'viewer';
}

const BOOLEANS_FOR_ROLE = {
  owner: { can_delete: 1, can_edit_ui: 1, can_edit_items: 1, can_view_orders: 1, can_view_analytics: 1 },
  editor: { can_delete: 0, can_edit_ui: 1, can_edit_items: 1, can_view_orders: 1, can_view_analytics: 1 },
  viewer: { can_delete: 0, can_edit_ui: 0, can_edit_items: 0, can_view_orders: 1, can_view_analytics: 1 },
};

function membershipRow(userId, slug) {
  if (!userId || !slug) return null;
  try {
    return usersDb()
      .prepare('SELECT * FROM user_shop_permissions WHERE user_id = ? AND shop_slug = ?')
      .get(userId, slug) || null;
  } catch {
    return null;
  }
}

function membershipRole(userId, slug) {
  const row = membershipRow(userId, slug);
  if (!row) return null;
  if (row.role && ROLES.includes(row.role)) return row.role;
  return roleFromBooleans(row);
}

// Write a role. Always writes the legacy booleans in the same statement: the
// Launchpad UI and half the existing endpoints still read them, and a row where
// the two disagree is a bug waiting to be hit at 6pm on a Friday.
function setShopRole(userId, slug, role, grantedBy) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const b = BOOLEANS_FOR_ROLE[role];
  usersDb().prepare(`
    INSERT INTO user_shop_permissions
      (user_id, shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders, can_view_analytics, role, granted_by, granted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, shop_slug) DO UPDATE SET
      can_delete = excluded.can_delete,
      can_edit_ui = excluded.can_edit_ui,
      can_edit_items = excluded.can_edit_items,
      can_view_orders = excluded.can_view_orders,
      can_view_analytics = excluded.can_view_analytics,
      role = excluded.role,
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at
  `).run(
    userId, slug, b.can_delete, b.can_edit_ui, b.can_edit_items, b.can_view_orders,
    b.can_view_analytics, role, grantedBy ?? null, Date.now(),
  );
  return role;
}

function removeShopRole(userId, slug) {
  return usersDb()
    .prepare('DELETE FROM user_shop_permissions WHERE user_id = ? AND shop_slug = ?')
    .run(userId, slug).changes;
}

// Everyone with a membership on this shop, newest grant first.
function shopMembers(slug) {
  try {
    return usersDb().prepare(`
      SELECT u.id, u.username, u.name, u.email, u.role AS account_role,
             p.role, p.can_delete, p.can_edit_ui, p.can_edit_items,
             p.can_view_orders, p.can_view_analytics, p.granted_by, p.granted_at
        FROM user_shop_permissions p
        JOIN users u ON u.id = p.user_id
       WHERE p.shop_slug = ?
       ORDER BY u.name COLLATE NOCASE
    `).all(slug).map((r) => ({ ...r, role: r.role && ROLES.includes(r.role) ? r.role : roleFromBooleans(r) }));
  } catch {
    return [];
  }
}

// Looked up live, never cached: a refusal that names last week's owner is worse
// than one that names nobody.
function shopOwners(slug) {
  const owners = shopMembers(slug).filter((m) => m.role === 'owner');
  if (owners.length) return owners;
  // An unclaimed shop falls back to the admins, who can always grant.
  try {
    return usersDb()
      .prepare("SELECT id, username, name, email FROM users WHERE role = 'super_admin' ORDER BY id")
      .all()
      .map((u) => ({ ...u, role: 'owner', is_fallback_admin: true }));
  } catch {
    return [];
  }
}

function displayName(user) {
  return (user && (user.name || user.username)) || 'an admin';
}

// "Rachael Loiseau", "Rachael Loiseau or Margot Drevno",
// "Rachael Loiseau, Margot Drevno or Gio"
function nameList(users) {
  const names = users.map(displayName);
  if (names.length === 0) return 'an admin';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
const INSERT_AUDIT = `
  INSERT INTO audit_log (ts, user_id, username, shop_slug, action, detail, via)
  VALUES (@ts, @user_id, @username, @shop_slug, @action, @detail, @via)
`;

function serializeDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

// Direct write for callers that have no req (lock theft, background jobs).
// Returns the audit_log row id, or null when the write failed.
function auditRaw({ userId = null, username = null, slug = null, action, detail = null, via = 'system' }) {
  try {
    const info = platformDb.prepare(INSERT_AUDIT).run({
      ts: Date.now(), user_id: userId, username, shop_slug: slug,
      action, detail: serializeDetail(detail), via,
    });
    return Number(info.lastInsertRowid);
  } catch (err) {
    // An audit failure must never fail the thing being audited.
    console.error(`[authz] audit_log write failed (${action}): ${err.message}`);
    return null;
  }
}

// Returns the audit_log row id, which every mutating route puts in its success
// response as `audit_id`. The plugin's speaking rule is "do not say done unless
// the tool handed back an audit id", and a rule nothing can satisfy is not a
// rule. A null means the audit write itself failed, which belongs in the
// response rather than swallowed.
function audit(req, action, detail) {
  const user = req?.session?.user;
  const id = auditRaw({
    userId: user?.id ?? null,
    username: user?.username ?? null,
    slug: req?.shop?.slug || req?.params?.slug || null,
    action,
    detail,
    via: req?.via || 'web',
  });
  // Keep feeding the existing append-only file so nothing that reads
  // data/audit.log today (mission-control, the security view) goes blind.
  try {
    req?.app?.locals?.auditLog?.(action, { req, details: detail });
  } catch (err) {
    console.error(`[authz] legacy auditLog failed (${action}): ${err.message}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// The one answer a caller who is not a member ever gets, for a shop that does
// not exist and for one that does. It names no owner and no shop detail, only
// the slug the caller typed, so there is nothing in it to probe with. A member
// who is merely too junior still gets ROLE_TOO_LOW with the owners' names: they
// already know the shop exists.
// ---------------------------------------------------------------------------
function refuseNotAMember(res, slug) {
  return refuse(res, 403, 'NOT_A_MEMBER',
    `You have no access to "${slug}".`,
    'Call request_access for that shop, and its owners decide. Gio can also add you.', false);
}

// ---------------------------------------------------------------------------
// resolveShopAndRole — mounted as router.use('/:slug', resolveShopAndRole)
// ---------------------------------------------------------------------------
function resolveShopAndRole(req, res, next) {
  const slug = req.params?.slug;
  if (!slug) return next();
  // Several routers sit on /api/shops and each one would otherwise re-resolve.
  if (req.shop && req.shop.slug === slug) return next();

  let shop;
  try {
    shop = shopsDb().prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
  } catch (err) {
    console.error(`[authz] shop lookup failed for ${slug}: ${err.message}`);
    return refuse(res, 500, 'NOT_PERMITTED',
      'The shop list could not be read just now.',
      'Try again in a moment. If it keeps happening, tell Gio.', true);
  }

  const user = req.session?.user || null;
  const isAdminAccount = user?.role === 'super_admin';
  const viaMcp = req.via === 'mcp';

  if (!shop) {
    // An admin on the web gets the honest answer, because they can see every
    // shop anyway. Everybody else gets the same refusal they would get for a
    // shop that does exist and is not theirs, so the pair of answers cannot be
    // used to walk the slug space and learn which shops this server runs.
    if (isAdminAccount && !viaMcp) {
      return refuse(res, 404, 'NO_SUCH_SHOP',
        `There is no shop called "${slug}".`,
        'Check the spelling, or call list_shops to see the shops you can reach.', false);
    }
    return refuseNotAMember(res, slug);
  }

  // The admin bypass is a web-console convenience. Over MCP it is off, so an
  // agent acting as Gio gets exactly the access Gio was actually granted.
  req.isAdminBypass = !!isAdminAccount && !viaMcp;
  req.isAdminAccount = !!isAdminAccount;

  req.shop = shop;
  req.shopMemberRole = user ? membershipRole(user.id, slug) : null;
  req.shopRole = req.isAdminBypass ? 'owner' : req.shopMemberRole;
  next();
}

// ---------------------------------------------------------------------------
// requireShopAccess(minRole)
//
// minRole is 'viewer' | 'editor' | 'owner', or 'any' for a route a non-member
// is allowed to reach (request_access), or a per-method map:
//   requireShopAccess({ GET: 'viewer', DELETE: 'owner', default: 'editor' })
// The map exists because these are mounted with router.use() on a path, which
// sees every method, and GET /:slug and DELETE /:slug are not the same ask.
// ---------------------------------------------------------------------------
function neededRole(minRole, method) {
  if (typeof minRole === 'string') return minRole;
  return minRole[method] || minRole.default || 'viewer';
}

function requireShopAccess(minRole) {
  function shopAccessGuard(req, res, next) {
    if (!req.shop) {
      // resolveShopAndRole was not mounted ahead of this guard. Fail closed.
      console.error(`[authz] ${req.method} ${req.originalUrl}: no req.shop — resolveShopAndRole is not mounted`);
      return refuse(res, 500, 'NOT_PERMITTED',
        'This shop could not be identified.',
        'Tell Gio: a route is missing its shop resolver.', false);
    }
    const need = neededRole(minRole, req.method);
    if (need === 'any') return next();

    const slug = req.shop.slug;
    const have = req.shopRole;

    if (!have) return refuseNotAMember(res, slug);

    if ((RANK[have] || 0) < (RANK[need] || 0)) {
      const owners = shopOwners(slug);
      return refuse(res, 403, 'ROLE_TOO_LOW',
        `Your access to "${slug}" is ${have}, and this needs ${need}.`,
        `Ask ${nameList(owners)} to raise your access to ${need}, or call request_access.`,
        false);
    }
    return next();
  }
  // The route-coverage test looks for this marker, not for a function name.
  shopAccessGuard.__requireShopAccess = true;
  shopAccessGuard.__minRole = minRole;
  return shopAccessGuard;
}

// ---------------------------------------------------------------------------
// denyMcp(what) — a whole mount that a signed request may never enter.
//
// requireAdmin below is a per-route decision, and the pre-ADR admin routers
// (/api/users, /api/system, /api/mission-control) do not use it: they gate on
// requireRole('super_admin'), which reads req.session.user.role and knows
// nothing about req.via. A signed request carrying a super_admin's id therefore
// reached them with full admin rights, which is the one property the ADR is
// built on failing. This is mounted on those three paths in index.js so the
// property holds because of where the routes live, not because three separate
// handlers each remember to check.
// ---------------------------------------------------------------------------
function denyMcp(what) {
  function mcpMountGuard(req, res, next) {
    if (req.via !== 'mcp') return next();
    auditRaw({
      userId: req.session?.user?.id ?? null,
      username: req.session?.user?.username ?? null,
      action: 'mcp_admin_mount_refused',
      detail: { path: req.originalUrl, method: req.method },
      via: 'mcp',
    });
    return refuse(res, 403, 'ADMIN_ONLY',
      `${what} is admin only, and the dev tool never acts as an admin.`,
      'Ask Gio to do this from the Launchpad console.', false);
  }
  mcpMountGuard.__denyMcp = true;
  return mcpMountGuard;
}

// Admin-only, and admin means a real super_admin on the web console. Over MCP
// nobody is an admin, including Gio, which is what makes "the MCP never issues
// an admin-scoped token" true in code instead of in prose.
function requireAdmin(what) {
  function adminGuard(req, res, next) {
    if (req.isAdminBypass) return next();
    const reason = req.via === 'mcp' && req.isAdminAccount
      ? `${what} is admin only, and the dev tool never acts as an admin.`
      : `${what} is admin only.`;
    return refuse(res, 403, 'ADMIN_ONLY', reason,
      'Ask Gio to do this from the Launchpad console.', false);
  }
  adminGuard.__requireAdmin = true;
  return adminGuard;
}

// ---------------------------------------------------------------------------
// withShopLock — one writer per shop at a time
//
// Coordinates with the EXISTING file lock in lock.js (.db.lock, written by the
// launch/restart/deploy paths). A live .db.lock counts as held, so a launch and
// a DATABASE apply can never overlap. We never delete that file: lock.js and
// the build poller own it.
// ---------------------------------------------------------------------------
function busyError(held) {
  const err = new Error(
    `"${held.shop_slug}" is busy: ${held.held_by_name || 'someone'} is running ${held.action}.`,
  );
  err.code = 'SHOP_BUSY';
  err.status = 409;
  err.possible = true;
  err.held_by = held.held_by_name || held.held_by || null;
  err.held_by_id = held.held_by ?? null;
  err.action = held.action;
  err.since = held.since;
  return err;
}

function currentLock(slug) {
  const now = Date.now();

  // 1. A launch in progress wins: the container is mid-build and the catalog
  //    on disk is already being read by docker.
  try {
    const launch = fileLock.readLock(slug);
    if (launch) {
      const since = Number(launch.acquired_at) || 0;
      if (since && now - since < LAUNCH_LOCK_STALE_MS) {
        let name = null;
        if (launch.by_user_id) {
          try {
            name = displayName(usersDb().prepare('SELECT name, username FROM users WHERE id = ?').get(launch.by_user_id));
          } catch { /* best effort */ }
        }
        return { shop_slug: slug, held_by: launch.by_user_id ?? null, held_by_name: name, action: 'launch', since, source: 'file' };
      }
    }
  } catch { /* a missing or unreadable .db.lock is not a lock */ }

  // 2. Our own table.
  const row = platformDb.prepare('SELECT * FROM shop_locks WHERE shop_slug = ?').get(slug);
  if (row && now - row.since < LOCK_STALE_MS) return { ...row, source: 'db' };
  return null;
}

function acquireLock(slug, userId, action) {
  const now = Date.now();
  const token = crypto.randomUUID();
  let name = null;
  if (userId) {
    try {
      name = displayName(usersDb().prepare('SELECT name, username FROM users WHERE id = ?').get(userId));
    } catch { /* best effort */ }
  }

  const held = currentLock(slug);
  if (held) throw busyError(held);

  const stale = platformDb.prepare('SELECT * FROM shop_locks WHERE shop_slug = ?').get(slug);
  if (stale) {
    // Older than LOCK_STALE_MS. Steal it, and say so out loud: a stolen lock
    // means a previous request died mid-write and someone may want to know.
    platformDb.prepare('DELETE FROM shop_locks WHERE shop_slug = ?').run(slug);
    auditRaw({
      userId, username: name, slug, action: 'lock_stolen',
      detail: { from_user_id: stale.held_by, from_action: stale.action, held_for_ms: now - stale.since, new_action: action },
      via: 'system',
    });
  }

  try {
    platformDb.prepare(
      'INSERT INTO shop_locks (shop_slug, held_by, held_by_name, action, since, token) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(slug, userId ?? null, name, action, now, token);
  } catch (err) {
    // PRIMARY KEY collision: another process won the race between our check and
    // our insert. Report whoever is actually holding it.
    const winner = platformDb.prepare('SELECT * FROM shop_locks WHERE shop_slug = ?').get(slug);
    if (winner) throw busyError({ ...winner, source: 'db' });
    throw err;
  }
  return token;
}

function releaseLock(slug, token) {
  try {
    return platformDb
      .prepare('DELETE FROM shop_locks WHERE shop_slug = ? AND token = ?')
      .run(slug, token).changes;
  } catch (err) {
    console.error(`[authz] could not release lock on ${slug}: ${err.message}`);
    return 0;
  }
}

async function withShopLock(slug, userId, action, fn) {
  const token = acquireLock(slug, userId, action);
  try {
    return await fn();
  } finally {
    // Released even when fn throws, otherwise one bad apply wedges the shop
    // for ten minutes.
    releaseLock(slug, token);
  }
}

// Turn a SHOP_BUSY error into the standard payload. resolution carries the
// structured {held_by, action, since} so an agent can say "Marc started a
// launch four minutes ago" without parsing English.
function refuseBusy(res, err) {
  return refuse(res, err.status || 409, 'SHOP_BUSY', err.message,
    { held_by: err.held_by, action: err.action, since: err.since }, true);
}

// ---------------------------------------------------------------------------
// MCP actor authentication
//
// The MCP server is a second client of this same API, not a second brain. It
// signs each call rather than holding a session cookie, so there is no
// long-lived credential for an agent to leak and no admin token to issue.
// ---------------------------------------------------------------------------
const MCP_MAX_SKEW_MS = 60 * 1000;

function mcpEnabled() {
  const s = process.env.MCP_SHARED_SECRET;
  return !!s && s.length >= 32;
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// The signed material. It covers the method, the exact request target (path AND
// query string, byte for byte as it arrived) and the body, not just the body.
//
// BREAKING CHANGE to the header contract, on purpose: a signature used to be
// valid for any method and any path for 60 seconds, so one captured call could
// be re-pointed at a different route with different query parameters inside the
// window. The tool server signs the same string (shuttle-mcp, src/launchpad.js).
//
//   METHOD \n request-target \n rawBody \n actor \n timestamp
//
function mcpSignature(rawBody, actor, ts, secret, method, target) {
  return crypto.createHmac('sha256', secret)
    .update(`${String(method || '').toUpperCase()}\n${target || ''}\n${rawBody}\n${actor}\n${ts}`)
    .digest('hex');
}

// What the signature is computed over on this side: the request line as sent.
// Taken from req.originalUrl because mcpActor runs at the top of the app, before
// any router has trimmed a mount path off req.url.
function signedTarget(req) {
  return req.originalUrl || req.url || '';
}

// An actor id is a decimal integer, nothing else. Number('01') and Number('1.0')
// both came out as 1, so the string that was signed and the id that was resolved
// did not have to be the same bytes.
const ACTOR_RE = /^(0|[1-9][0-9]{0,14})$/;

// Mounted BEFORE express-session and before requireAuth. A signed request never
// touches the session store: it gets a plain session-shaped object with no-op
// persistence, so no junk row is written to sessions.db per tool call.
function mcpActor(req, res, next) {
  const actorHeader = req.headers['x-launchpad-actor'];
  if (!actorHeader) return next();

  if (!mcpEnabled()) {
    return refuse(res, 401, 'NOT_PERMITTED',
      'Signed tool access is turned off on this server.',
      'Ask Gio to set MCP_SHARED_SECRET (32 characters or more) on the Launchpad backend.', false);
  }

  const sig = req.headers['x-launchpad-sig'];
  const ts = req.headers['x-launchpad-ts'];
  const bad = (message) => refuse(res, 401, 'NOT_PERMITTED', message,
    'Check the tool server clock and its copy of MCP_SHARED_SECRET.', false);

  if (!sig || !ts) return bad('That request was not signed correctly.');

  const actorStr = String(actorHeader);
  if (!ACTOR_RE.test(actorStr)) {
    return bad('That actor is not a user id this server can read.');
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return bad('That request was not signed correctly.');
  if (Math.abs(Date.now() - tsNum) > MCP_MAX_SKEW_MS) {
    return bad('That request is too old to accept.');
  }

  // The signature covers req.rawBody, which express.json() only captures for a
  // JSON body. A multipart or form body would therefore travel outside the
  // signed material, so a signed request is simply not allowed to carry one.
  // The tool server only ever sends JSON (shuttle-mcp, src/launchpad.js); file
  // bytes go through the ticket route, which is not signed at all.
  const declaredLength = Number(req.headers['content-length'] || 0);
  const hasBody = (Number.isFinite(declaredLength) && declaredLength > 0) || !!req.headers['transfer-encoding'];
  if (hasBody && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return bad('A signed request may only carry a JSON body.');
  }

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  const expected = mcpSignature(
    rawBody, actorStr, String(ts), process.env.MCP_SHARED_SECRET, req.method, signedTarget(req),
  );
  if (!constantTimeEqualHex(String(sig), expected)) {
    auditRaw({ slug: null, action: 'mcp_bad_signature', detail: { actor: actorStr, method: req.method }, via: 'mcp' });
    return bad('That request was not signed correctly.');
  }

  // Actor 0 is the pre-identity actor: the tool server proves it holds the
  // shared secret but claims to be nobody. Enrollment and token introspection
  // are the only two routes it can reach, because they are the routes you call
  // BEFORE you have a user id. It is never resolved to a user row, so it can
  // never inherit anyone's access.
  if (actorStr === '0') {
    req.via = 'mcp';
    req.mcpActorId = 0;
    req.isAdminBypass = false;
    req.isAdminAccount = false;
    req.session = {
      user: null,
      cookie: {},
      save: (cb) => { if (cb) cb(null); },
      touch: () => {},
      destroy: (cb) => { if (cb) cb(null); },
      regenerate: (cb) => { if (cb) cb(null); },
      reload: (cb) => { if (cb) cb(null); },
    };
    return next();
  }

  let user;
  try {
    user = usersDb()
      .prepare('SELECT id, username, email, name, role FROM users WHERE id = ?')
      .get(Number(actorStr));
  } catch {
    user = null;
  }
  if (!user) return bad('That user does not exist on this server.');

  req.via = 'mcp';
  req.mcpActorId = user.id;
  req.isAdminBypass = false;
  req.session = {
    user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role },
    cookie: {},
    save: (cb) => { if (cb) cb(null); },
    touch: () => {},
    destroy: (cb) => { if (cb) cb(null); },
    regenerate: (cb) => { if (cb) cb(null); },
    reload: (cb) => { if (cb) cb(null); },
  };
  next();
}

// ---------------------------------------------------------------------------
// Access requests and membership management
//
// Mounted on /api/shops BEFORE the shop-access floor, because the whole point
// of request_access is that a non-member can call it.
// ---------------------------------------------------------------------------
const accessRouter = express.Router();

accessRouter.use('/:slug', resolveShopAndRole);
// Order matters: the narrower path is mounted first so a decide call is checked
// against 'owner' before it reaches the request-access floor.
accessRouter.use('/:slug/access-requests/:id/decide', requireShopAccess('owner'));
accessRouter.use('/:slug/access-requests', requireShopAccess({ POST: 'any', default: 'owner' }));
accessRouter.use('/:slug/members', requireShopAccess('owner'));

function userById(id) {
  try {
    return usersDb().prepare('SELECT id, username, email, name, role FROM users WHERE id = ?').get(Number(id));
  } catch {
    return null;
  }
}

function findUser({ user_id, username, email }) {
  if (user_id) return userById(user_id);
  const ident = username || email;
  if (!ident) return null;
  try {
    return usersDb()
      .prepare('SELECT id, username, email, name, role FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)')
      .get(ident, ident);
  } catch {
    return null;
  }
}

// Short on purpose. An owner reading this on a phone needs the shop, the
// person, the role and one link.
function notifyOwners(shop, requester, role, reason, owners) {
  const to = owners.map((o) => o.email).filter(Boolean);
  if (!to.length) return;
  let sendMail;
  try {
    ({ sendMail } = require('./email'));
  } catch (err) {
    console.error(`[authz] email module unavailable: ${err.message}`);
    return;
  }
  if (typeof sendMail !== 'function') return;

  const base = process.env.FRONTEND_URL || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#111;max-width:420px">
      <p><strong>${esc(displayName(requester))}</strong> asked for <strong>${esc(role)}</strong> access to <strong>${esc(shop.name || shop.slug)}</strong>.</p>
      ${reason ? `<p style="color:#555">"${esc(reason)}"</p>` : ''}
      <p><a href="${esc(base)}/shops/${esc(shop.slug)}/settings">Grant or decline in Launchpad</a></p>
    </div>`;

  Promise.resolve(sendMail({
    to: to.join(','),
    subject: `Access request: ${shop.name || shop.slug}`,
    html,
  })).catch((err) => console.error(`[authz] access request email failed: ${err.message}`));
}

// POST /api/shops/:slug/access-requests — any authenticated user
function createAccessRequest(req, res) {
  const user = req.session.user;
  const slug = req.shop.slug;
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'editor';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;

  if (req.shopMemberRole && RANK[req.shopMemberRole] >= RANK[role]) {
    return res.json({
      request: null,
      already: true,
      message: `You already have ${req.shopMemberRole} access to "${slug}".`,
    });
  }

  const open = platformDb
    .prepare("SELECT * FROM access_requests WHERE shop_slug = ? AND user_id = ? AND status = 'pending'")
    .get(slug, user.id);
  if (open) {
    return res.json({
      request: open,
      already: true,
      message: `You already have a request open on "${slug}". The owners have it.`,
    });
  }

  const info = platformDb.prepare(`
    INSERT INTO access_requests (shop_slug, user_id, requested_role, reason, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(slug, user.id, role, reason, Date.now());

  const owners = shopOwners(slug);
  const audit_id = audit(req, 'access_requested', { slug, role, reason });
  notifyOwners(req.shop, user, role, reason, owners);

  res.status(201).json({
    request: platformDb.prepare('SELECT * FROM access_requests WHERE id = ?').get(info.lastInsertRowid),
    owners: owners.map((o) => ({ id: o.id, name: displayName(o) })),
    notified: owners.map((o) => o.email).filter(Boolean),
    audit_id,
    message: `Asked ${nameList(owners)} for ${role} access to "${slug}".`,
  });
}

accessRouter.post('/:slug/access-requests', createAccessRequest);

// GET /api/shops/:slug/access-requests — owner
accessRouter.get('/:slug/access-requests', (req, res) => {
  const status = req.query.status || 'pending';
  const all = status === 'all'
    ? platformDb.prepare('SELECT * FROM access_requests WHERE shop_slug = ? ORDER BY created_at DESC').all(req.shop.slug)
    : platformDb.prepare('SELECT * FROM access_requests WHERE shop_slug = ? AND status = ? ORDER BY created_at DESC').all(req.shop.slug, status);
  // The MCP pages this list, so limit/offset and a total are part of the shape.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = all.slice(offset, offset + limit);
  res.json({
    requests: rows.map((r) => {
      const u = userById(r.user_id);
      return {
        ...r,
        user: u,
        // Flat fields, because the MCP renders a request without a second lookup.
        email: u?.email || null,
        name: u ? displayName(u) : null,
        role: r.requested_role,
        status: r.status,
      };
    }),
    total: all.length,
    limit,
    offset,
  });
});

// POST /api/shops/:slug/access-requests/:id/decide — owner
accessRouter.post('/:slug/access-requests/:id/decide', (req, res) => {
  const slug = req.shop.slug;
  const row = platformDb.prepare('SELECT * FROM access_requests WHERE id = ? AND shop_slug = ?')
    .get(Number(req.params.id), slug);
  if (!row) {
    return refuse(res, 404, 'NO_SUCH_SHOP', 'That access request does not exist.',
      'Reload the access requests list.', false);
  }
  if (row.status !== 'pending') {
    return refuse(res, 409, 'NOT_PERMITTED', `That request was already ${row.status}.`,
      'Nothing to do.', false);
  }

  const grant = req.body?.decision === 'grant' || req.body?.grant === true;
  const role = ROLES.includes(req.body?.role) ? req.body.role : row.requested_role;
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;

  platformDb.prepare(`
    UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?
  `).run(grant ? 'granted' : 'denied', Date.now(), req.session.user.id, note, row.id);

  const previous_role = membershipRole(row.user_id, slug);
  if (grant) setShopRole(row.user_id, slug, role, req.session.user.id);

  const audit_id = audit(req, grant ? 'access_granted' : 'access_denied', { slug, user_id: row.user_id, role: grant ? role : null, note });
  res.json({
    request: platformDb.prepare('SELECT * FROM access_requests WHERE id = ?').get(row.id),
    granted_role: grant ? role : null,
    previous_role: previous_role || null,
    audit_id,
    message: grant
      ? `${displayName(userById(row.user_id))} now has ${role} access to "${slug}".`
      : `Declined the request on "${slug}".`,
  });
});

// GET /api/shops/:slug/members — owner
accessRouter.get('/:slug/members', (req, res) => {
  res.json({ members: shopMembers(req.shop.slug) });
});

// POST /api/shops/:slug/members — owner
accessRouter.post('/:slug/members', (req, res) => {
  const slug = req.shop.slug;
  const target = findUser(req.body || {});
  if (!target) {
    return refuse(res, 404, 'NOT_PERMITTED', 'That person does not have a Launchpad account.',
      'Ask Gio to create the account first, then grant access.', false);
  }
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'viewer';
  const previous_role = membershipRole(target.id, slug);
  setShopRole(target.id, slug, role, req.session.user.id);
  const audit_id = audit(req, 'member_added', { slug, user_id: target.id, role, previous_role });
  res.json({
    member: shopMembers(slug).find((m) => m.id === target.id) || null,
    role,
    previous_role: previous_role || null,
    audit_id,
    message: `${displayName(target)} now has ${role} access to "${slug}".`,
  });
});

// POST /api/shops/:slug/members/revoke — owner
//
// The same work as DELETE /members. It exists because revoking names a person
// in the body, and a DELETE with a body is badly supported by everything from
// fetch to nginx; the tool server sends this one.
function revokeMember(req, res) {
  const slug = req.shop.slug;
  const target = findUser({ ...(req.body || {}), ...(req.query || {}) });
  if (!target) {
    return refuse(res, 404, 'NOT_PERMITTED', 'That person does not have a Launchpad account.',
      'Check the email address and try again.', false);
  }

  const members = shopMembers(slug);
  const owners = members.filter((m) => m.role === 'owner');
  if (owners.length === 1 && owners[0].id === target.id) {
    return refuse(res, 409, 'NOT_PERMITTED',
      `${displayName(target)} is the only owner of "${slug}".`,
      'Make someone else an owner first, then remove this one.', false);
  }

  const previous_role = membershipRole(target.id, slug);
  const removed = removeShopRole(target.id, slug);
  const audit_id = audit(req, 'member_removed', { slug, user_id: target.id, previous_role });
  return res.json({
    removed: removed > 0,
    previous_role: previous_role || null,
    audit_id,
    message: previous_role
      ? `${displayName(target)} no longer has access to "${slug}".`
      : `${displayName(target)} had no access to "${slug}".`,
  });
}

accessRouter.post('/:slug/members/revoke', revokeMember);

// DELETE /api/shops/:slug/members — owner
// DELETE /api/shops/:slug/members — owner. Same work, kept for the console.
accessRouter.delete('/:slug/members', revokeMember);


// ---------------------------------------------------------------------------
// Per-shop audit trail — GET /api/shops/:slug/audit
//
// Mounted in the protected block, so the shop-access floor has already put a
// viewer bar on it. Reading who did what to a shop is a viewer thing; the rows
// themselves carry no secrets, only actions.
// ---------------------------------------------------------------------------
const shopAuditRouter = express.Router();

shopAuditRouter.get('/:slug/audit', (req, res) => {
  const slug = req.shop.slug;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : null;

  const where = action ? 'shop_slug = ? AND action = ?' : 'shop_slug = ?';
  const args = action ? [slug, action] : [slug];
  let total = 0;
  let rows = [];
  try {
    total = platformDb.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).get(...args).n;
    rows = platformDb
      .prepare(`SELECT id, ts, user_id, username, action, detail, via FROM audit_log WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
  } catch (err) {
    console.error(`[authz] audit read failed for ${slug}: ${err.message}`);
  }

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      at: new Date(r.ts).toISOString(),
      actor: r.username || (r.user_id ? `user ${r.user_id}` : 'system'),
      action: r.action,
      via: r.via,
      detail: r.detail,
    })),
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// /api/mcp/* — the five routes that exist only for the tool server
//
// They are here rather than on /api/shops because three of them are not about a
// shop at all, and two of them are called BEFORE the caller has a user id.
// Every one of them refuses a browser: these are not a second way into
// Launchpad, they are the same way with a different envelope.
// ---------------------------------------------------------------------------
function requireMcp(req, res, next) {
  if (req.via === 'mcp') return next();
  return refuse(res, 403, 'NOT_PERMITTED',
    'That route is only for the Shuttle dev tool.',
    'Use the Launchpad console, or call the tool from Claude.', false);
}

// Who may enroll. An address outside these domains never reaches the mail path,
// so this route cannot be used to spray sign-in codes at strangers.
function enrollDomains() {
  return (process.env.MCP_ENROLL_DOMAINS || 'lrparis.com')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "r.loiseau@lrparis.com" -> "r.loiseau", then "r.loiseau2" if that is taken.
function uniqueUsername(base) {
  const root = String(base).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'user';
  let candidate = root;
  for (let n = 2; n < 1000; n += 1) {
    const clash = usersDb().prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(candidate);
    if (!clash) return candidate;
    candidate = `${root}${n}`;
  }
  return `${root}-${Date.now()}`;
}

const mcpPublicRouter = express.Router();

// POST /api/mcp/enroll — actor 0. Creates the users row on a first sign in, so
// a new hire does not wait on an admin to type their name into a form.
mcpPublicRouter.post('/enroll', requireMcp, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return refuse(res, 400, 'NOT_PERMITTED', 'That is not an email address.',
      'Type your work email address and try again.', false);
  }
  const domain = email.split('@')[1];
  if (!enrollDomains().includes(domain)) {
    return refuse(res, 403, 'NOT_PERMITTED',
      `The dev tool only signs in ${enrollDomains().join(' or ')} addresses.`,
      'Use your LR Paris work address. If you do not have one, ask Gio.', false);
  }

  const existing = usersDb()
    .prepare('SELECT id, username, email, name, role FROM users WHERE lower(email) = lower(?)')
    .get(email);
  if (existing) {
    auditRaw({ userId: existing.id, username: existing.username, action: 'mcp_enroll', detail: { email, created: false }, via: 'mcp' });
    return res.json({
      user: { id: existing.id, username: existing.username, email: existing.email, name: existing.name },
      created: false,
    });
  }

  const local = email.split('@')[0];
  const username = uniqueUsername(local);
  // A readable placeholder, replaced the moment an admin edits the profile.
  const name = local.split(/[._-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || username;

  let info;
  try {
    info = usersDb().prepare(
      "INSERT INTO users (username, email, name, role, created_by, can_create_shops) VALUES (?, ?, ?, 'user', 'mcp-enroll', 0)",
    ).run(username, email, name);
  } catch (err) {
    console.error(`[authz] enroll failed for ${email}: ${err.message}`);
    return refuse(res, 500, 'NOT_PERMITTED', 'That account could not be created just now.',
      'Try again in a moment. If it keeps happening, tell Gio.', true);
  }

  const id = Number(info.lastInsertRowid);
  auditRaw({ userId: id, username, action: 'mcp_enroll', detail: { email, created: true }, via: 'mcp' });
  res.status(201).json({ user: { id, username, email, name }, created: true });
});

// POST /api/mcp/token/introspect — actor 0. Static tokens only; the tool
// server resolves its own OAuth tokens and never asks us about them.
mcpPublicRouter.post('/token/introspect', requireMcp, (req, res) => {
  const token = String(req.body?.token || '');
  const deny = () => refuse(res, 401, 'NOT_PERMITTED', 'That token is not valid.',
    'Sign in again from Claude, or ask Gio for a new token.', false);
  if (!token) return deny();

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  let row;
  try {
    row = platformDb.prepare('SELECT * FROM mcp_static_tokens WHERE token_hash = ?').get(hash);
  } catch {
    row = null;
  }
  if (!row || row.revoked_at) return deny();
  if (row.expires_at && row.expires_at < Date.now()) return deny();

  const user = userById(row.user_id);
  if (!user) return deny();
  res.json({
    user: {
      id: user.id, username: user.username, email: user.email, name: user.name,
      ...(row.expires_at ? { expires_at: row.expires_at } : {}),
    },
  });
});

const mcpRouter = express.Router();
mcpRouter.use(requireMcp);

// GET /api/mcp/whoami
mcpRouter.get('/whoami', (req, res) => {
  const user = req.session.user;
  let memberships = [];
  try {
    memberships = usersDb()
      .prepare('SELECT shop_slug, role, can_delete, can_edit_ui, can_edit_items FROM user_shop_permissions WHERE user_id = ? ORDER BY shop_slug')
      .all(user.id)
      .map((r) => ({ shop_slug: r.shop_slug, role: r.role && ROLES.includes(r.role) ? r.role : roleFromBooleans(r) }));
  } catch (err) {
    console.error(`[authz] whoami memberships failed: ${err.message}`);
  }
  res.json({
    user: { id: user.id, username: user.username, email: user.email, name: user.name },
    memberships,
  });
});

// GET /api/mcp/my-shops — membership filtered for everyone, admins included.
//
// This is the route the ADR's rule actually rests on. GET /api/shops keeps the
// console's behaviour; this one never widens anyone, so an agent acting as Gio
// lists exactly the shops Gio was granted.
mcpRouter.get('/my-shops', (req, res) => {
  const user = req.session.user;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let rows = [];
  try {
    rows = shopsDb().prepare('SELECT slug, name, status, stage, lifecycle_status FROM shops ORDER BY name COLLATE NOCASE').all();
  } catch (err) {
    console.error(`[authz] my-shops read failed: ${err.message}`);
  }

  let effectiveStage = null;
  try { ({ effectiveStage } = require('./golive')); } catch { /* stage falls back to the column */ }

  const mine = [];
  for (const shop of rows) {
    const role = membershipRole(user.id, shop.slug);
    if (!role) continue;
    mine.push({
      slug: shop.slug,
      name: shop.name,
      stage: effectiveStage ? effectiveStage(shop) : (shop.stage || 'no_status'),
      status: shop.status || 'unknown',
      role,
    });
  }

  res.json({ shops: mine.slice(offset, offset + limit), total: mine.length, limit, offset });
});

// POST /api/mcp/access-requests — {shop_slug, role, reason}
//
// The slug is in the body rather than the path because the caller is, by
// definition, someone who cannot reach that shop's own routes.
mcpRouter.post('/access-requests', (req, res) => {
  const slug = String(req.body?.shop_slug || '').trim();
  if (!slug) {
    return refuse(res, 400, 'NO_SUCH_SHOP', 'No shop was named.',
      'Call list_my_shops, or name the shop you want access to.', false);
  }

  let shop;
  try {
    shop = shopsDb().prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
  } catch {
    shop = null;
  }
  if (!shop) {
    return refuse(res, 404, 'NO_SUCH_SHOP', `There is no shop called "${slug}".`,
      'Check the spelling with Gio, who can see every shop.', false);
  }

  // createAccessRequest reads these three, and nothing else off the request.
  req.shop = shop;
  req.shopMemberRole = membershipRole(req.session.user.id, slug);
  req.shopRole = req.shopMemberRole;
  return createAccessRequest(req, res);
});

module.exports = {
  // The contract's five.
  resolveShopAndRole,
  requireShopAccess,
  refuse,
  audit,
  withShopLock,
  // Everything else the backend needs.
  accessRouter,
  shopAuditRouter,
  mcpRouter,
  mcpPublicRouter,
  mcpActor,
  mcpEnabled,
  mcpSignature,
  signedTarget,
  requireAdmin,
  denyMcp,
  refuseNotAMember,
  refuseBusy,
  auditRaw,
  membershipRole,
  membershipRow,
  setShopRole,
  removeShopRole,
  shopMembers,
  shopOwners,
  displayName,
  nameList,
  roleFromBooleans,
  currentLock,
  acquireLock,
  releaseLock,
  ROLES,
  RANK,
  LOCK_STALE_MS,
  _useDatabases,
};
