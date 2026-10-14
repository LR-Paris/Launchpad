// passkey.js — WebAuthn / passkey login for Launchpad (additive to the OTP flow).
// Passkeys are the fast primary login; email OTP stays as bootstrap + recovery.
// Built on @simplewebauthn/server v14. User verification is "preferred".
//
// Mounted in index.js as:
//   app.use('/api/auth/passkey', passkeyPublicRouter);                         // pre-login
//   app.use('/api/auth/passkey', requireAuth, csrfProtection, authedRouter);   // manage while signed in
//   app.use('/api/mcp/passkey', passkeyMcpRouter);                             // the connector's sign-in page

const express = require('express');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const users = require('./users');
const { startSignedInSession } = require('./session-policy');

let authAlerts = null;
try { authAlerts = require('./security/authAlerts'); } catch (_) { /* optional */ }
let geo = null;
try { geo = require('./security/geo'); } catch (_) { /* optional */ }

// Relying Party. Behind Cloudflare the browser's origin is the public URL.
const RP_ID = process.env.RP_ID || process.env.BASE_DOMAIN || 'lrparisstore.com';
const RP_NAME = process.env.RP_NAME || 'Launchpad';
const ORIGIN = process.env.PUBLIC_URL || `https://${RP_ID}`;
// Gio chose user-verification "preferred": request it, don't hard-require it at verify.
const UV = 'preferred';
const REQUIRE_UV = false;

const b64 = {
  enc: (u8) => Buffer.from(u8).toString('base64'),
  dec: (s) => new Uint8Array(Buffer.from(s, 'base64')),
};

function clientMeta(req) {
  try {
    if (geo && geo.clientIp) {
      return { ip: geo.clientIp(req), location: (geo.locationFromHeaders && geo.locationFromHeaders(req)) || '' };
    }
  } catch (_) { /* fall through */ }
  return { ip: String(req.headers['cf-connecting-ip'] || req.ip || ''), location: '' };
}

// ---------------------------------------------------------------------------
// PUBLIC router — pre-login authentication ceremony (mirrors login-verify).
// ---------------------------------------------------------------------------
const publicRouter = express.Router();

// POST /api/auth/passkey/auth-options — start a usernameless (discoverable) login.
publicRouter.post('/auth-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: UV,
      // allowCredentials omitted → the client lets the user pick a discoverable passkey.
    });
    req.session.passkeyAuthChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('[passkey] auth-options error:', err.message);
    res.status(500).json({ error: 'Could not start passkey sign-in' });
  }
});

// POST /api/auth/passkey/auth-verify — finish login, create a session.
publicRouter.post('/auth-verify', async (req, res) => {
  const audit = req.app.locals.auditLog;
  const meta = clientMeta(req);
  try {
    const expectedChallenge = req.session.passkeyAuthChallenge;
    if (!expectedChallenge) return res.status(400).json({ error: 'No challenge in session' });

    const body = req.body || {};
    const cred = users.getCredentialByCredentialId(body.id);
    if (!cred) {
      audit?.('login_failed', { req, details: { reason: 'passkey_unknown' } });
      authAlerts?.notifyLogin?.({ event: 'login_failed', ip: meta.ip, location: meta.location, details: { reason: 'passkey_unknown' } });
      return res.status(401).json({ error: 'Unknown passkey' });
    }

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: REQUIRE_UV,
      credential: {
        id: cred.credential_id,
        publicKey: b64.dec(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });

    delete req.session.passkeyAuthChallenge;

    if (!verification.verified) {
      audit?.('login_failed', { req, details: { username: cred.user_id, reason: 'passkey_bad_signature' } });
      authAlerts?.notifyLogin?.({ event: 'login_failed', ip: meta.ip, location: meta.location, details: { reason: 'passkey_bad_signature' } });
      return res.status(401).json({ error: 'Passkey verification failed' });
    }

    users.updateCredentialCounter(cred.credential_id, verification.authenticationInfo.newCounter);

    const user = users.getUserById(cred.user_id);
    if (!user) return res.status(401).json({ error: 'Account not found' });

    startSignedInSession(req, body.rememberMe, user);
    const permissions = users.getAllUserPermissions(user.id);
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Failed to save session' });
      audit?.('login_success', { req, actor: user.username, details: { method: 'passkey' } });
      authAlerts?.notifyLogin?.({ event: 'login_success', actor: user.username, email: user.email, ip: meta.ip, location: meta.location });
      res.json({ user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role, permissions } });
    });
  } catch (err) {
    console.error('[passkey] auth-verify error:', err.message);
    res.status(400).json({ error: 'Passkey verification error' });
  }
});

// ---------------------------------------------------------------------------
// AUTHED router — manage passkeys while signed in (requireAuth + CSRF upstream).
// ---------------------------------------------------------------------------
const authedRouter = express.Router();

// POST /api/auth/passkey/register-options
authedRouter.post('/register-options', async (req, res) => {
  try {
    const u = req.session.user;
    const existing = users.getCredentialsByUser(u.id);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: u.email,
      userDisplayName: u.name || u.username,
      userID: new Uint8Array(Buffer.from(String(u.id))),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
      // Required, not preferred: both sign-in pages ask for a passkey without
      // naming the account first, which only a discoverable passkey can answer.
      // An authenticator that cannot store one now fails here, out loud, instead
      // of saving a passkey that can never sign anyone in.
      authenticatorSelection: { residentKey: 'required', userVerification: UV },
    });
    req.session.passkeyRegChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('[passkey] register-options error:', err.message);
    res.status(500).json({ error: 'Could not start passkey registration' });
  }
});

// POST /api/auth/passkey/register-verify
authedRouter.post('/register-verify', async (req, res) => {
  try {
    const u = req.session.user;
    const expectedChallenge = req.session.passkeyRegChallenge;
    if (!expectedChallenge) return res.status(400).json({ error: 'No challenge in session' });

    const body = req.body || {};
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: REQUIRE_UV,
    });

    delete req.session.passkeyRegChallenge;

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey registration failed' });
    }
    const info = verification.registrationInfo;
    const c = info.credential;
    users.addCredential({
      userId: u.id,
      credentialId: c.id,
      publicKey: b64.enc(c.publicKey),
      counter: c.counter || 0,
      transports: c.transports ? JSON.stringify(c.transports) : null,
      deviceType: info.credentialDeviceType || null,
      backedUp: info.credentialBackedUp ? 1 : 0,
      nickname: (body.nickname || '').toString().slice(0, 60) || null,
    });
    req.app.locals.auditLog?.('passkey_registered', { req, actor: u.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('[passkey] register-verify error:', err.message);
    // Unique-constraint = this passkey is already registered.
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That passkey is already registered' });
    }
    res.status(400).json({ error: 'Passkey registration error' });
  }
});

// GET /api/auth/passkey/list — the signed-in user's passkeys.
authedRouter.get('/list', (req, res) => {
  const list = users.getCredentialsByUser(req.session.user.id).map((c) => ({
    credential_id: c.credential_id,
    nickname: c.nickname,
    device_type: c.device_type,
    backed_up: !!c.backed_up,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
  }));
  res.json({ passkeys: list });
});

// DELETE /api/auth/passkey/:credentialId — remove one of your own passkeys.
authedRouter.delete('/:credentialId', (req, res) => {
  const removed = users.deleteCredential(req.session.user.id, req.params.credentialId);
  req.app.locals.auditLog?.('passkey_removed', { req, actor: req.session.user.username });
  res.json({ ok: true, removed });
});


// ---------------------------------------------------------------------------
// MCP router — passkey sign-in for the Claude connector.
//
// The connector's sign-in page is https://lrparisstore.com/mcp/login, served by
// shuttle-mcp on the same origin as Launchpad, so a passkey made in Launchpad
// Settings answers there too. The browser runs the ceremony. shuttle-mcp
// carries the options and the signed answer between the browser and these two
// routes, signed as actor 0 the way the email-code routes are. Every check that
// decides who the person is stays here: the challenge, the signature, the
// counter, the account and its domain.
//
// The challenge cannot live in a browser session, because the caller is the
// tool server and not the browser. It lives in a short in-memory map instead,
// keyed by a random ceremony id that shuttle-mcp keeps beside its own sign-in
// row. Single use, five minutes. A Launchpad restart in the middle of a
// sign-in costs that person one more tap.
// ---------------------------------------------------------------------------
const MCP_CEREMONY_TTL_MS = 5 * 60 * 1000;
const MCP_CEREMONY_MAX = 500;
const mcpCeremonies = new Map(); // ceremony id -> { challenge, expiresAt }

function sweepCeremonies(now = Date.now()) {
  for (const [id, c] of mcpCeremonies) {
    if (c.expiresAt <= now) mcpCeremonies.delete(id);
  }
  // Oldest first. Only the tool server can reach these routes, so this is a
  // ceiling against a bug, not against strangers.
  while (mcpCeremonies.size >= MCP_CEREMONY_MAX) {
    mcpCeremonies.delete(mcpCeremonies.keys().next().value);
  }
}

function takeCeremony(id) {
  const c = typeof id === 'string' ? mcpCeremonies.get(id) : undefined;
  if (c) mcpCeremonies.delete(id);
  if (!c || c.expiresAt <= Date.now()) return null;
  return c;
}

// Lazy, so this file does not pull authz.js in at require time.
function authz() { return require('./authz'); }

function requirePreIdentityMcp(req, res, next) {
  if (req.via === 'mcp' && req.mcpActorId === 0) return next();
  return authz().refuse(res, 403, 'NOT_PERMITTED',
    'That route is only for the Shuttle connector sign-in page.',
    'Sign in to Launchpad in the browser instead.', false);
}

const mcpRouter = express.Router();

// POST /api/mcp/passkey/options — actor 0. Starts a usernameless sign-in.
mcpRouter.post('/options', requirePreIdentityMcp, async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: UV });
    sweepCeremonies();
    const ceremony = crypto.randomBytes(24).toString('base64url');
    mcpCeremonies.set(ceremony, { challenge: options.challenge, expiresAt: Date.now() + MCP_CEREMONY_TTL_MS });
    res.json({ ceremony, options, expires_in: Math.round(MCP_CEREMONY_TTL_MS / 1000) });
  } catch (err) {
    console.error('[passkey] mcp options error:', err.message);
    authz().refuse(res, 500, 'NOT_PERMITTED', 'Passkey sign-in could not start just now.',
      'Use the email code instead. If it keeps happening, tell Gio.', true);
  }
});

// POST /api/mcp/passkey/verify — actor 0. Proves the passkey, names the person.
// Every failure gets the same answer, so this route says nothing about which
// passkeys or accounts exist.
mcpRouter.post('/verify', requirePreIdentityMcp, async (req, res) => {
  const { refuse, auditRaw, applyPendingGrants, enrollDomains } = authz();
  const deny = () => refuse(res, 401, 'NOT_PERMITTED', 'That passkey did not sign you in.',
    'Try again, or get a code by email instead.', false);

  const ceremony = takeCeremony(req.body?.ceremony);
  const response = req.body?.response;
  if (!ceremony || !response || typeof response !== 'object' || typeof response.id !== 'string') return deny();

  const cred = users.getCredentialByCredentialId(response.id);
  if (!cred) {
    auditRaw({ action: 'mcp_sign_in_failed', detail: { reason: 'passkey_unknown' }, via: 'mcp' });
    return deny();
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: REQUIRE_UV,
      credential: {
        id: cred.credential_id,
        publicKey: b64.dec(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });
  } catch (err) {
    auditRaw({ userId: cred.user_id, action: 'mcp_sign_in_failed', detail: { reason: 'passkey_invalid', error: err.message }, via: 'mcp' });
    return deny();
  }
  if (!verification.verified) {
    auditRaw({ userId: cred.user_id, action: 'mcp_sign_in_failed', detail: { reason: 'passkey_bad_signature' }, via: 'mcp' });
    return deny();
  }
  users.updateCredentialCounter(cred.credential_id, verification.authenticationInfo.newCounter);

  const user = users.getUserById(cred.user_id);
  if (!user) return deny();

  // Same rule as the email-code door: the connector signs in work addresses only.
  const domain = String(user.email || '').toLowerCase().split('@')[1] || '';
  if (!enrollDomains().includes(domain)) {
    return refuse(res, 403, 'NOT_PERMITTED',
      `The dev tool only signs in ${enrollDomains().join(' or ')} addresses.`,
      'Use a passkey on your LR Paris account, or ask Gio.', false);
  }

  auditRaw({
    userId: user.id, username: user.username, action: 'mcp_sign_in',
    detail: { email: user.email, created: false, method: 'passkey' }, via: 'mcp',
  });
  applyPendingGrants(user);
  return res.json({
    user: { id: user.id, username: user.username, email: user.email, name: user.name },
    created: false,
  });
});

module.exports = {
  publicRouter,
  authedRouter,
  mcpRouter,
  // For tests.
  _mcpCeremonies: mcpCeremonies,
};
