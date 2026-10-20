// ---------------------------------------------------------------------------
// sso.js — "Sign in with Launchpad" for other LR Paris apps (LR Parrot first).
//
// The other app has no accounts of its own. It borrows Launchpad's: the same
// people, the same email codes, the same passkeys. A small authorization-code
// flow, in two steps:
//
//  1. GET /api/auth/sso/authorize?client_id=&redirect_uri=&state=  (browser)
//     The app sends the browser here. Launchpad checks the app and the address
//     it wants to come back to, then:
//       - nobody signed in: off to the sign-in page, with a `next` that brings
//         the browser back to this exact URL once the email code or the passkey
//         has done its job (frontend/src/lib/sso.js). That includes a session
//         sessionGuard has just ended (too old, or its account deleted): for
//         this route the guard carries on signed out instead of answering 401
//         JSON (isAuthorizeNavigation, below);
//       - signed in, account in one of the app's allowed domains: back to the
//         app with ?code=<one time>&state=<state, unchanged>;
//       - signed in, any other domain: a plain 403 page.
//     An unknown app, or an address that is not EXACTLY one the app registered,
//     gets a plain 400 page and is never redirected anywhere. That is the rule
//     that stops this route being used to send a code to a stranger.
//
//  2. POST /api/auth/sso/token  {client_id, client_secret, code, redirect_uri}
//     The app's SERVER swaps the code for the person. No cookie, no CSRF token:
//     the client secret is the credential. Answers {user: {id, username, email,
//     name, role}}, or 401 invalid_client, or 400 invalid_grant, or 400
//     invalid_request for a body that is not JSON (tokenErrors, below).
//
// Codes are 32 random bytes, base64url. Only their SHA-256 is kept, for 60
// seconds, and the first attempt to use one ends it, right or wrong. They live
// in this process's memory, which is fine while Launchpad is one process: a
// restart between the two steps costs that person one more click, nothing
// else. Running two backends behind a load balancer would need a shared store.
//
// The apps come from SSO_CLIENTS, a JSON object, one entry per app:
//   {"parrot":{"name":"LR Parrot","secret":"<openssl rand -hex 32>",
//     "redirectUris":["https://parrot.lrparis.com/auth/callback"],
//     "allowedDomains":["lrparis.com"]}}
// allowedDomains is optional and defaults to ["lrparis.com"]. Launchpad also has
// accounts for people outside LR Paris; they never get into an internal app
// unless that app lists their domain. docs/SIGN-IN.md has the operator steps.
//
// Mounted in index.js as:
//   app.use('/api/auth/sso', tokenRouter);       // before express-session
//   app.use('/api/auth/sso', tokenErrors);       // right after it
//   sessionGuard({ ..., continueAfterEnd: isAuthorizeNavigation })
//   app.use('/api/auth/sso', authorizeRouter);   // after sessionGuard
// ---------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const users = require('./users');

const CODE_TTL_MS = 60 * 1000;
// A ceiling against a bug or a flood, not a budget: a code lives one minute,
// so a few thousand at once would already be an incident.
const CODE_MAX = 10000;
const DEFAULT_ALLOWED_DOMAINS = ['lrparis.com'];
const MIN_SECRET_LENGTH = 32;
const MAX_STATE_LENGTH = 1024;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Where index.js mounts authorize. Express routes it without regard to letter
// case or one trailing slash, so /authorize/ and /SSO/Authorize land on it too.
// The sign-in page only follows a next that starts with exactly this path and
// a "?" (frontend/src/lib/sso.js), so the next is always written with it.
const AUTHORIZE_PATH = '/api/auth/sso/authorize';
const AUTHORIZE_PATH_RE = /^\/api\/auth\/sso\/authorize\/?$/i;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// Why an entry cannot be used, or null when it can. A broken entry is left out
// on its own, out loud, rather than half working.
function clientProblem(id, c) {
  if (!CLIENT_ID_RE.test(id)) return 'the client id may only use letters, digits, ".", "_" and "-"';
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'its settings are not an object';
  if (typeof c.secret !== 'string' || c.secret.length < MIN_SECRET_LENGTH) {
    return `"secret" must be a string of ${MIN_SECRET_LENGTH} characters or more (openssl rand -hex 32)`;
  }
  if (!Array.isArray(c.redirectUris) || c.redirectUris.length === 0) return '"redirectUris" must be a list of addresses';
  for (const uri of c.redirectUris) {
    let url;
    try { url = new URL(uri); } catch { return `redirect address ${JSON.stringify(uri)} is not a full URL`; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return `redirect address ${JSON.stringify(uri)} is not http(s)`;
    if (url.hash || String(uri).includes('#')) return `redirect address ${JSON.stringify(uri)} has a #fragment`;
  }
  if (c.allowedDomains !== undefined) {
    if (!Array.isArray(c.allowedDomains) || c.allowedDomains.length === 0
      || !c.allowedDomains.every((d) => typeof d === 'string' && d.trim())) {
      return '"allowedDomains" must be a list of domains, or left out for lrparis.com';
    }
  }
  if (c.name !== undefined && typeof c.name !== 'string') return '"name" must be a string';
  return null;
}

function parseClients(text) {
  const clients = new Map();
  if (!text) return clients;

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the text around the error, and the
    // text holds the secrets.
    console.error('[sso] SSO_CLIENTS is not valid JSON, so no app can sign in with Launchpad. Keep it on one line in single quotes.');
    return clients;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    console.error('[sso] SSO_CLIENTS must be a JSON object of client id to settings, so no app can sign in with Launchpad.');
    return clients;
  }

  for (const [id, c] of Object.entries(config)) {
    const problem = clientProblem(id, c);
    if (problem) {
      console.error(`[sso] SSO_CLIENTS: "${id.slice(0, 64)}" is left out: ${problem}.`);
      continue;
    }
    clients.set(id, {
      id,
      name: (c.name || '').trim() || id,
      secret: c.secret,
      redirectUris: c.redirectUris.slice(),
      allowedDomains: (c.allowedDomains || DEFAULT_ALLOWED_DOMAINS).map((d) => d.trim().toLowerCase()),
    });
  }
  return clients;
}

// Parsed once per distinct value of SSO_CLIENTS, so a broken value is logged
// once and not on every request. A Map, so a client_id of "__proto__" or
// "constructor" is just an unknown client.
let parsedFrom = null;
let parsedClients = new Map();

function loadClients() {
  const text = String(process.env.SSO_CLIENTS || '').trim();
  if (text !== parsedFrom) {
    parsedFrom = text;
    parsedClients = parseClients(text);
  }
  return parsedClients;
}

function getClient(clientId) {
  return typeof clientId === 'string' ? loadClients().get(clientId) || null : null;
}

// One line at boot, so the deploy log says which apps can sign in.
function describeClients() {
  const clients = loadClients();
  if (clients.size === 0) return;
  const list = [...clients.values()].map((c) => `${c.id} (${c.name})`).join(', ');
  console.log(`[sso] Sign in with Launchpad is on for: ${list}`);
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------
const codes = new Map(); // sha256(code) hex -> { userId, clientId, redirectUri, expiresAt }

const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

// Every code lives the same 60 seconds, so insertion order is expiry order and
// the sweep stops at the first live one.
function sweepCodes(now = Date.now()) {
  for (const [key, c] of codes) {
    if (c.expiresAt > now) break;
    codes.delete(key);
  }
  while (codes.size >= CODE_MAX) codes.delete(codes.keys().next().value);
}

function issueCode({ userId, clientId, redirectUri }) {
  sweepCodes();
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(hashCode(code), { userId, clientId, redirectUri, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

// The code is gone after this call, whatever the answer.
function takeCode(code) {
  if (typeof code !== 'string' || !code || code.length > 256) return { grant: null, reason: 'unknown_code' };
  const key = hashCode(code);
  const grant = codes.get(key);
  if (!grant) return { grant: null, reason: 'unknown_code' };
  codes.delete(key);
  if (grant.expiresAt <= Date.now()) return { grant: null, reason: 'expired_code' };
  return { grant, reason: null };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Constant time, and the same work whether or not the client exists: both
// sides are hashed first, so the lengths always match.
const NO_CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
function secretMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function emailDomain(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at > 0 ? e.slice(at + 1) : '';
}

// What goes in the audit log for a client id somebody typed. Never the code,
// never the secret.
function clientLabel(clientId) {
  return typeof clientId === 'string' ? clientId.slice(0, 64) : null;
}

function plainPage(res, status, text) {
  return res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(`${text}\n`);
}

const NOT_VALID = [
  'This sign-in link is not valid.',
  '',
  'Launchpad does not know the app that sent you here, or the app asked to come back',
  'to an address it is not registered for.',
  '',
  'Go back to the app and try again. If it keeps happening, tell Gio.',
].join('\n');

function notAllowed(client, email) {
  const domains = client.allowedDomains.map((d) => `@${d}`).join(' or ');
  return [
    `Your Launchpad account (${email}) cannot sign in to ${client.name}.`,
    '',
    `${client.name} only accepts ${domains} accounts. Sign out of Launchpad and sign in`,
    'with that account, or ask Gio if you need access.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rate limits. The global limiter skips GETs and never sees the token route
// (it sits before it in index.js), so each step gets its own, per IP.
// ---------------------------------------------------------------------------
const authorizeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => plainPage(res, 429, 'Too many sign-in attempts from here. Wait a minute and try again.'),
});

// Every sign-in to an app arrives from that app's one server, so this is a
// brake on a runaway loop or a guessing script, not on people.
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).set('Cache-Control', 'no-store').json({ error: 'too_many_requests' }),
});

// ---------------------------------------------------------------------------
// Step 1 — the browser
// ---------------------------------------------------------------------------

// True for a browser landing on authorize, in any spelling Express routes
// there. index.js gives it to sessionGuard as continueAfterEnd: when the guard
// ends a session on this route (past SESSION_MAX_AGE_DAYS, or its account
// deleted), the request carries on signed out and comes here, rather than the
// person seeing the guard's 401 JSON as the whole page with no way back.
function isAuthorizeNavigation(req) {
  return (req.method === 'GET' || req.method === 'HEAD')
    && AUTHORIZE_PATH_RE.test(`${req.baseUrl || ''}${req.path || ''}`);
}

// The sign-in page, with a next that brings the browser back here once the
// person has signed in. The query string goes back unchanged; the path is
// always AUTHORIZE_PATH, whatever spelling this request used.
function toSignIn(req, res) {
  const url = req.originalUrl || '';
  const q = url.indexOf('?');
  const back = `${AUTHORIZE_PATH}?${q >= 0 ? url.slice(q + 1) : ''}`;
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, `/login?next=${encodeURIComponent(back)}`);
}

const authorizeRouter = express.Router();

authorizeRouter.get('/authorize', authorizeLimiter, (req, res) => {
  const audit = req.app.locals.auditLog;
  const { client_id: clientId, redirect_uri: redirectUri, state } = req.query;

  // A signed tool request (authz.js mcpActor) arrives with req.session.user
  // set to whichever person it names, without that person in front of a
  // browser. It must never turn into a code for another app.
  if (req.via === 'mcp') {
    audit?.('sso_denied', { req, actor: req.session?.user?.username, details: { client: clientLabel(clientId), reason: 'signed_tool_request' } });
    return plainPage(res, 403, 'Sign in with Launchpad only works in a browser.');
  }

  // An array (client_id=a&client_id=b) or an object (client_id[x]=a) is never
  // a client and never an address.
  const client = getClient(clientId);
  if (!client) {
    audit?.('sso_denied', { req, details: { client: clientLabel(clientId), reason: 'unknown_client' } });
    return plainPage(res, 400, NOT_VALID);
  }
  if (typeof redirectUri !== 'string' || !client.redirectUris.includes(redirectUri)) {
    audit?.('sso_denied', { req, details: { client: client.id, reason: 'redirect_uri_mismatch' } });
    return plainPage(res, 400, NOT_VALID);
  }
  if (state !== undefined && (typeof state !== 'string' || state.length > MAX_STATE_LENGTH)) {
    audit?.('sso_denied', { req, details: { client: client.id, reason: 'bad_state' } });
    return plainPage(res, 400, NOT_VALID);
  }

  // sessionGuard has already run. A session it ended on this request, too old
  // or with its account deleted, arrives here signed out (continueAfterEnd in
  // index.js) and goes to sign in like any other. A session it let through is
  // the account as it is now, not as it was at sign in.
  const user = req.session && req.session.user;
  if (!user) return toSignIn(req, res);

  if (!client.allowedDomains.includes(emailDomain(user.email))) {
    audit?.('sso_denied', { req, details: { client: client.id, reason: 'domain_not_allowed', domain: emailDomain(user.email) } });
    return plainPage(res, 403, notAllowed(client, user.email));
  }

  const code = issueCode({ userId: user.id, clientId: client.id, redirectUri });
  audit?.('sso_authorize', { req, details: { client: client.id } });

  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (typeof state === 'string') back.searchParams.set('state', state);
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, back.toString());
});

// ---------------------------------------------------------------------------
// Step 2 — the app's server
// ---------------------------------------------------------------------------
const tokenRouter = express.Router();

tokenRouter.post('/token', tokenLimiter, (req, res) => {
  const audit = req.app.locals.auditLog;
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri } = body;

  // The secret is checked before the code is looked at, so a caller without it
  // cannot learn anything about codes, nor use one up.
  const client = getClient(clientId);
  const secretOk = secretMatches(typeof secret === 'string' ? secret : '', client ? client.secret : NO_CLIENT_SECRET);
  if (!client || typeof secret !== 'string' || !secretOk) {
    audit?.('sso_denied', { req, details: { client: clientLabel(clientId), reason: client ? 'bad_secret' : 'unknown_client', step: 'token' } });
    return res.status(401).json({ error: 'invalid_client' });
  }

  const { grant, reason } = takeCode(code);
  let denied = reason;
  if (!denied && grant.clientId !== client.id) denied = 'client_mismatch';
  if (!denied && grant.redirectUri !== redirectUri) denied = 'redirect_uri_mismatch';

  // Read the account again: it may have been removed, or moved out of the
  // app's domains, in the seconds since step 1.
  let user = null;
  if (!denied) {
    user = users.getUserById(grant.userId);
    if (!user) denied = 'account_removed';
    else if (!client.allowedDomains.includes(emailDomain(user.email))) denied = 'domain_not_allowed';
  }
  if (denied) {
    audit?.('sso_denied', { req, details: { client: client.id, reason: denied, step: 'token' } });
    return res.status(400).json({ error: 'invalid_grant' });
  }

  audit?.('sso_token', { req, actor: user.username, details: { client: client.id } });
  return res.json({
    user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role },
  });
});

// express.json() runs before tokenRouter, for the whole app. A body it cannot
// read never reaches the route: Express skips the router and hands the error
// on, and the global handler in index.js would write err.message to
// launchpad.log (which Mission Control shows) and send it back. For a body that
// is not JSON that message is V8's, and it quotes the text around the mistake:
// in a hand-written call whose quotes got lost, the start of the client
// secret. This handler sits right after tokenRouter and answers first, in the
// route's own shape, and logs only the kind of problem, never the message.
function tokenErrors(err, req, res, next) {
  if (!err || typeof err.type !== 'string' || !(err.status >= 400 && err.status < 500)) return next(err);
  console.warn(`[sso] ${req.method} ${req.baseUrl}${req.path}: request body refused (${err.type}).`);
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res.status(err.status).json({ error: 'invalid_request' });
}

module.exports = {
  authorizeRouter,
  tokenRouter,
  tokenErrors,
  isAuthorizeNavigation,
  describeClients,
  CODE_TTL_MS,
};
