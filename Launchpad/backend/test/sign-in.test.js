#!/usr/bin/env node
// ---------------------------------------------------------------------------
// sign-in.test.js — how long a sign-in lasts, and passkeys on both doors.
//
// Boots the real backend on a throwaway copy of the databases, then checks:
//
//   - an email-code sign-in lasts the chosen time, one month by default,
//   - the cookie and the stored session renew on every visit (rolling),
//   - a session ends SESSION_MAX_AGE_DAYS after its sign-in however active,
//   - a session from before this change is not signed out by it,
//   - a passkey signs a person in on the web page, with the same lifetimes,
//   - a passkey signs a person in on the connector page, through the two
//     /api/mcp/passkey routes, and every way that can go wrong is refused.
//
// The passkeys are made here with node:crypto: a P-256 key, its COSE public
// key in webauthn_credentials, and assertions signed the way a browser signs
// them. Nothing is mocked on the Launchpad side.
//
//   cd backend && node test/sign-in.test.js
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const sandbox = require('./_sandbox');

const SESSION_SECRET = 'sign-in-test-session-secret-0123456789abcdef';
const MCP_SHARED_SECRET = 'sign-in-test-mcp-shared-secret-0123456789abcdef';
const KNOWN_CODE = '424242';
const RP_ID = 'lrparisstore.com';
const ORIGIN = 'https://lrparisstore.com';
const DAY = 24 * 60 * 60 * 1000;

const otpHash = (code) => crypto.createHmac('sha256', SESSION_SECRET).update(String(code)).digest('hex');

let passed = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) { passed += 1; console.log(`ok    ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
}
function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(label, actualMs, expectedMs, toleranceMs = 3 * 60 * 1000) {
  ok(label, Math.abs(actualMs - expectedMs) <= toleranceMs,
    `expected about ${Math.round(expectedMs / DAY * 10) / 10} days, got ${Math.round(actualMs / DAY * 10) / 10}`);
}

// --- signed tool-server requests, written out rather than imported ----------
function sign(rawBody, actor, ts, method, target) {
  const material = `${String(method).toUpperCase()}\n${target}\n${rawBody}\n${actor}\n${ts}`;
  return crypto.createHmac('sha256', MCP_SHARED_SECRET).update(material).digest('hex');
}
let BASE = '';
async function callMcp(actor, method, routePath, body) {
  const url = new URL(BASE + routePath);
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (actor !== null) {
    const ts = String(Date.now());
    headers['X-Launchpad-Actor'] = String(actor);
    headers['X-Launchpad-Ts'] = ts;
    headers['X-Launchpad-Sig'] = sign(rawBody, actor, ts, method, `${url.pathname}${url.search}`);
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : rawBody });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

// --- cookies ----------------------------------------------------------------
function sessionCookie(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const raw = all.find((c) => c.startsWith('__lp_sid='));
  if (!raw) return null;
  const pair = raw.split(';')[0];
  const exp = /;\s*Expires=([^;]+)/i.exec(raw);
  return { pair, expiresAt: exp ? Date.parse(exp[1]) : null, raw };
}
function sidOf(pair) {
  const value = decodeURIComponent(pair.split('=').slice(1).join('='));
  return value.replace(/^s:/, '').replace(/\.[^.]+$/, '');
}

// --- a software passkey -----------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function cborBytes(buf) { return Buffer.concat([Buffer.from([0x58, buf.length]), buf]); }
function makePasskey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), cborBytes(x),
    Buffer.from([0x22]), cborBytes(y),
  ]);
  return { id: b64url(crypto.randomBytes(16)), privateKey, coseB64: cose.toString('base64'), counter: 0 };
}
function assertion(pk, challenge, { origin = ORIGIN, rpId = RP_ID, userId = '', crossOrigin = false } = {}) {
  pk.counter += 1;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin }));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(pk.counter);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(rpId).digest(),
    Buffer.from([0x05]), // user present + user verified
    counter,
  ]);
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const signature = crypto.sign('sha256', signed, pk.privateKey); // DER, as authenticators send it
  return {
    id: pk.id,
    rawId: pk.id,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
      userHandle: b64url(Buffer.from(String(userId))),
    },
    clientExtensionResults: {},
  };
}

// --- server -----------------------------------------------------------------
function startServer(backendDir, port, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    SESSION_SECRET,
    MCP_SHARED_SECRET,
    NODE_ENV: 'test',
    MAILGUN_API_KEY: '',
    MAILGUN_DOMAIN: '',
    FRONTEND_URL: `http://127.0.0.1:${port}`,
    ...extraEnv,
  };
  delete env.PUBLIC_URL; delete env.RP_ID; delete env.BASE_DOMAIN; delete env.OTP_PEPPER;
  const child = spawn(process.execPath, [path.join(backendDir, 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  return { child, log };
}
async function waitForHealth(port, child, log) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}:\n${log.join('')}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`backend never answered:\n${log.join('')}`);
}

async function main() {
  const box = sandbox.create({ label: 'sign-in' });
  const Database = require(path.join(box.backend, 'node_modules', 'better-sqlite3'));
  const usersDb = () => new Database(box.usersDbPath);
  const sessionsDb = () => new Database(path.join(box.dataDir, 'sessions.db'));

  // Someone outside the LR Paris domain, for the connector's domain rule.
  { const u = usersDb(); u.exec("INSERT INTO users (id, username, email, name, role) VALUES (20, 'outside', 'someone@example.com', 'Outside Person', 'user')"); u.close(); }

  const port = 4100 + Math.floor(Math.random() * 400);
  BASE = `http://127.0.0.1:${port}`;
  const { child, log } = startServer(box.backend, port, { SESSION_MAX_AGE_DAYS: '180' });

  async function webSignIn(identifier, userId, rememberMe) {
    { const u = usersDb(); u.prepare('DELETE FROM otp_codes WHERE user_id = ?').run(userId); u.close(); }
    await fetch(`${BASE}/api/auth/login-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }),
    });
    { const u = usersDb();
      const row = u.prepare('SELECT id FROM otp_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
      if (row) u.prepare('UPDATE otp_codes SET code = ? WHERE id = ?').run(otpHash(KNOWN_CODE), row.id);
      u.close(); }
    const body = { identifier, code: KNOWN_CODE };
    if (rememberMe !== undefined) body.rememberMe = rememberMe;
    const res = await fetch(`${BASE}/api/auth/login-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { res, cookie: sessionCookie(res) };
  }
  const me = (pair) => fetch(`${BASE}/api/auth/me`, { headers: { Cookie: pair } });

  try {
    await waitForHealth(port, child, log);

    // -----------------------------------------------------------------------
    // 1. Email code: how long it lasts
    // -----------------------------------------------------------------------
    const plain = await webSignIn('marc@lrparis.com', 2);
    eq('an email code signs Marc in', plain.res.status, 200);
    ok('and sets a session cookie', !!plain.cookie);
    near('with no choice sent, the sign-in lasts one month', plain.cookie.expiresAt - Date.now(), 30 * DAY);

    const long = await webSignIn('r.loiseau@lrparis.com', 7, '3m');
    near('"3 months" lasts three months', long.cookie.expiresAt - Date.now(), 90 * DAY);

    const odd = await webSignIn('m.drevno@lrparis.com', 8, 'forever');
    near('an unknown choice falls back to one month', odd.cookie.expiresAt - Date.now(), 30 * DAY);

    const oldTab = await webSignIn('m.drevno@lrparis.com', 8, '1h');
    near('the old "1 hour" choice still works from an old tab', oldTab.cookie.expiresAt - Date.now(), 60 * 60 * 1000, 60 * 1000);

    // -----------------------------------------------------------------------
    // 2. Rolling: every visit renews it
    // -----------------------------------------------------------------------
    const week = await webSignIn('marc@lrparis.com', 2, '1w');
    const sid = sidOf(week.cookie.pair);
    const rowBefore = (() => { const d = sessionsDb(); const r = d.prepare('SELECT expired FROM sessions WHERE sid = ?').get(sid); d.close(); return r; })();
    ok('the session is stored', !!rowBefore);
    // Pretend the sign-in was three days ago: pull the stored expiry back.
    { const d = sessionsDb(); d.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(Date.now() + 4 * DAY, sid); d.close(); }
    const visit = await me(week.cookie.pair);
    eq('a visit with the cookie is signed in', visit.status, 200);
    const renewed = sessionCookie(visit);
    ok('the visit sends the cookie back', !!renewed, 'no Set-Cookie on an authenticated request');
    if (renewed) near('with a fresh week on it', renewed.expiresAt - Date.now(), 7 * DAY);
    const rowAfter = (() => { const d = sessionsDb(); const r = d.prepare('SELECT expired FROM sessions WHERE sid = ?').get(sid); d.close(); return r; })();
    near('and the stored session gets a fresh week too', rowAfter.expired - Date.now(), 7 * DAY);

    // -----------------------------------------------------------------------
    // 3. The absolute limit, and sessions from before this change
    // -----------------------------------------------------------------------
    const editSession = (sidValue, fn) => {
      const d = sessionsDb();
      const row = d.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sidValue);
      const sess = JSON.parse(row.sess);
      fn(sess);
      d.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sidValue);
      d.close();
    };
    const old = await webSignIn('r.loiseau@lrparis.com', 7, '3m');
    const oldSid = sidOf(old.cookie.pair);
    editSession(oldSid, (sess) => { sess.signedInAt = Date.now() - 181 * DAY; });
    const tooOld = await me(old.cookie.pair);
    eq('a session past 180 days is signed out, however active', tooOld.status, 401);
    const gone = (() => { const d = sessionsDb(); const r = d.prepare('SELECT sid FROM sessions WHERE sid = ?').get(oldSid); d.close(); return r; })();
    ok('and its stored row is gone', !gone);
    const again = await me(old.cookie.pair);
    eq('the same cookie stays signed out', again.status, 401);

    const legacy = await webSignIn('m.drevno@lrparis.com', 8, '1m');
    const legacySid = sidOf(legacy.cookie.pair);
    editSession(legacySid, (sess) => { delete sess.signedInAt; delete sess.remember; });
    const legacyVisit = await me(legacy.cookie.pair);
    eq('a session from before this change stays signed in', legacyVisit.status, 200);
    let stamped = null;
    { const d = sessionsDb(); stamped = JSON.parse(d.prepare('SELECT sess FROM sessions WHERE sid = ?').get(legacySid).sess).signedInAt; d.close(); }
    ok('and its 180-day clock starts now', typeof stamped === 'number' && Math.abs(Date.now() - stamped) < 60 * 1000, String(stamped));

    // -----------------------------------------------------------------------
    // 3b. A new session id at sign in, and the account read on every request
    // -----------------------------------------------------------------------
    const preRes = await fetch(`${BASE}/api/auth/csrf-token`);
    const preCookie = sessionCookie(preRes);
    ok('a visitor gets a session before signing in', !!preCookie);
    { const u = usersDb(); u.prepare('DELETE FROM otp_codes WHERE user_id = 2').run(); u.close(); }
    await fetch(`${BASE}/api/auth/login-request`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: preCookie.pair }, body: JSON.stringify({ identifier: 'marc@lrparis.com' }) });
    { const u = usersDb(); const row = u.prepare('SELECT id FROM otp_codes WHERE user_id = 2 ORDER BY id DESC LIMIT 1').get(); u.prepare('UPDATE otp_codes SET code = ? WHERE id = ?').run(otpHash(KNOWN_CODE), row.id); u.close(); }
    const fixed = await fetch(`${BASE}/api/auth/login-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: preCookie.pair },
      body: JSON.stringify({ identifier: 'marc@lrparis.com', code: KNOWN_CODE }),
    });
    const fixedCookie = sessionCookie(fixed);
    eq('signing in from that session works', fixed.status, 200);
    ok('and hands out a different session id', fixedCookie && sidOf(fixedCookie.pair) !== sidOf(preCookie.pair),
      `before ${sidOf(preCookie.pair)} after ${fixedCookie && sidOf(fixedCookie.pair)}`);
    eq('the session id from before sign in is not signed in', (await me(preCookie.pair)).status, 401);
    eq('the new one is', (await me(fixedCookie.pair)).status, 200);

    const adminIn = await webSignIn('g.lupo@lrparis.com', 1, '1m');
    eq('Gio signs in as super_admin', (await (await me(adminIn.cookie.pair)).json()).user.role, 'super_admin');
    { const u = usersDb(); u.prepare("UPDATE users SET role = 'user' WHERE id = 1").run(); u.close(); }
    const demoted = await (await me(adminIn.cookie.pair)).json();
    eq('a lowered role applies on the next request, not at the next sign in', demoted.user && demoted.user.role, 'user');
    const adminOnly = await fetch(`${BASE}/api/users`, { headers: { Cookie: adminIn.cookie.pair } });
    ok('and the admin pages refuse the old session', adminOnly.status === 403 || adminOnly.status === 401, `got ${adminOnly.status}`);
    { const u = usersDb(); u.prepare("UPDATE users SET role = 'super_admin' WHERE id = 1").run(); u.close(); }

    { const u = usersDb(); u.exec("INSERT INTO users (id, username, email, name, role) VALUES (21, 'leaver', 'leaver@lrparis.com', 'Leaver', 'user')"); u.close(); }
    const leaver = await webSignIn('leaver@lrparis.com', 21, '3m');
    eq('a colleague signs in', (await me(leaver.cookie.pair)).status, 200);
    { const u = usersDb(); u.prepare('DELETE FROM users WHERE id = 21').run(); u.close(); }
    eq('once their account is deleted, their session ends on the next request', (await me(leaver.cookie.pair)).status, 401);

    // -----------------------------------------------------------------------
    // 4. Passkey on the web sign-in page
    // -----------------------------------------------------------------------
    const margotKey = makePasskey();
    { const u = usersDb();
      u.prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_type, backed_up, nickname) VALUES (?, ?, ?, 0, ?, 1, ?)')
        .run(8, margotKey.id, margotKey.coseB64, 'multiDevice', 'Test Mac');
      u.close(); }
    const optRes = await fetch(`${BASE}/api/auth/passkey/auth-options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const opt = await optRes.json();
    const pre = sessionCookie(optRes);
    ok('the web page gets a passkey challenge', typeof opt.challenge === 'string' && !!pre, JSON.stringify(opt).slice(0, 200));
    eq('for this site', opt.rpId, RP_ID);
    const webPk = await fetch(`${BASE}/api/auth/passkey/auth-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pre.pair },
      body: JSON.stringify({ ...assertion(margotKey, opt.challenge, { userId: 8 }), rememberMe: '1w' }),
    });
    const webPkJson = await webPk.json().catch(() => null);
    eq('a passkey signs Margot in on the web', webPk.status, 200);
    eq('as Margot', webPkJson && webPkJson.user && webPkJson.user.id, 8);
    const pkCookie = sessionCookie(webPk);
    ok('with a session cookie', !!pkCookie);
    if (pkCookie) near('that lasts the week she chose', pkCookie.expiresAt - Date.now(), 7 * DAY);

    // One answer per challenge: a wrong answer burns it.
    const burnOpt = await fetch(`${BASE}/api/auth/passkey/auth-options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const burnJson = await burnOpt.json();
    const burnCookie = sessionCookie(burnOpt);
    const wrongWeb = await fetch(`${BASE}/api/auth/passkey/auth-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: burnCookie.pair },
      body: JSON.stringify(assertion(margotKey, burnJson.challenge, { origin: 'https://evil.example', userId: 8 })),
    });
    ok('a wrong answer on the web page is refused', wrongWeb.status === 400 || wrongWeb.status === 401, `got ${wrongWeb.status}`);
    const retryWeb = await fetch(`${BASE}/api/auth/passkey/auth-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: burnCookie.pair },
      body: JSON.stringify(assertion(margotKey, burnJson.challenge, { userId: 8 })),
    });
    eq('and the same challenge cannot be answered again', retryWeb.status, 400);

    const framedOpt = await fetch(`${BASE}/api/auth/passkey/auth-options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const framedJson = await framedOpt.json();
    const framed = await fetch(`${BASE}/api/auth/passkey/auth-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie(framedOpt).pair },
      body: JSON.stringify(assertion(margotKey, framedJson.challenge, { userId: 8, crossOrigin: true })),
    });
    eq('a passkey answer made inside another site\'s frame is refused', framed.status, 401);

    const noChoiceOpt = await fetch(`${BASE}/api/auth/passkey/auth-options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const noChoiceJson = await noChoiceOpt.json();
    const noChoiceCookie = sessionCookie(noChoiceOpt);
    const noChoice = await fetch(`${BASE}/api/auth/passkey/auth-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: noChoiceCookie.pair },
      body: JSON.stringify(assertion(margotKey, noChoiceJson.challenge, { userId: 8 })),
    });
    const noChoiceSession = sessionCookie(noChoice);
    eq('a passkey with no choice sent signs in too', noChoice.status, 200);
    if (noChoiceSession) near('for the same month an email code gets', noChoiceSession.expiresAt - Date.now(), 30 * DAY);

    // -----------------------------------------------------------------------
    // 5. Passkey on the connector sign-in page (/api/mcp/passkey)
    // -----------------------------------------------------------------------
    const unsigned = await callMcp(null, 'POST', '/api/mcp/passkey/options', {});
    ok('a browser cannot call the connector passkey routes', unsigned.status === 401 || unsigned.status === 403, `got ${unsigned.status}`);
    const asPerson = await callMcp(2, 'POST', '/api/mcp/passkey/options', {});
    eq('nor can a signed call that already names a person', asPerson.status, 403);

    const start = await callMcp(0, 'POST', '/api/mcp/passkey/options', {});
    eq('the tool server, as actor 0, gets a ceremony', start.status, 200);
    ok('with an id and a challenge for this site',
      typeof start.json?.ceremony === 'string' && typeof start.json?.options?.challenge === 'string' && start.json?.options?.rpId === RP_ID,
      JSON.stringify(start.json).slice(0, 200));
    ok('and no list of whose passkeys exist', !start.json?.options?.allowCredentials || start.json.options.allowCredentials.length === 0);

    const good = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: start.json.ceremony, response: assertion(margotKey, start.json.options.challenge, { userId: 8 }),
    });
    eq('Margot\'s passkey signs her in on the connector page', good.status, 200);
    eq('as Margot', good.json?.user?.id, 8);
    eq('with her address', good.json?.user?.email, 'm.drevno@lrparis.com');

    const replay = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: start.json.ceremony, response: assertion(margotKey, start.json.options.challenge, { userId: 8 }),
    });
    eq('a ceremony works once', replay.status, 401);

    const s2 = await callMcp(0, 'POST', '/api/mcp/passkey/options', {});
    const wrongOrigin = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: s2.json.ceremony, response: assertion(margotKey, s2.json.options.challenge, { origin: 'https://lrparisstore.com.evil.example', userId: 8 }),
    });
    eq('an answer signed for another site is refused', wrongOrigin.status, 401);

    const s3 = await callMcp(0, 'POST', '/api/mcp/passkey/options', {});
    const wrongChallenge = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: s3.json.ceremony, response: assertion(margotKey, b64url(crypto.randomBytes(32)), { userId: 8 }),
    });
    eq('an answer to a different challenge is refused', wrongChallenge.status, 401);

    const stranger = makePasskey();
    const s4 = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: (await callMcp(0, 'POST', '/api/mcp/passkey/options', {})).json.ceremony,
      response: assertion(stranger, b64url(crypto.randomBytes(32))),
    });
    eq('a passkey Launchpad has never seen is refused', s4.status, 401);
    eq('with the same words as every other failure', s4.json?.error?.message, wrongOrigin.json?.error?.message);

    const s6 = await callMcp(0, 'POST', '/api/mcp/passkey/options', {});
    const framedMcp = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: s6.json.ceremony, response: assertion(margotKey, s6.json.options.challenge, { userId: 8, crossOrigin: true }),
    });
    eq('on the connector page too', framedMcp.status, 401);

    const noCeremony = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: 'not-a-ceremony', response: assertion(margotKey, b64url(crypto.randomBytes(32)), { userId: 8 }),
    });
    eq('an unknown ceremony is refused', noCeremony.status, 401);

    const outsideKey = makePasskey();
    { const u = usersDb();
      u.prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter) VALUES (?, ?, ?, 0)').run(20, outsideKey.id, outsideKey.coseB64);
      u.close(); }
    const s5 = await callMcp(0, 'POST', '/api/mcp/passkey/options', {});
    const outside = await callMcp(0, 'POST', '/api/mcp/passkey/verify', {
      ceremony: s5.json.ceremony, response: assertion(outsideKey, s5.json.options.challenge, { userId: 20 }),
    });
    eq('a passkey on an account outside lrparis.com cannot use the connector', outside.status, 403);

    let used = null;
    { const u = usersDb(); used = u.prepare('SELECT counter, last_used_at FROM webauthn_credentials WHERE credential_id = ?').get(margotKey.id); u.close(); }
    ok('the passkey counter moved and the use was recorded', used && used.counter >= 3 && !!used.last_used_at, JSON.stringify(used));

    let audited = null;
    { const p = new Database(path.join(box.dataDir, 'platform.db'));
      try { audited = p.prepare("SELECT detail FROM audit_log WHERE action = 'mcp_sign_in' ORDER BY id DESC LIMIT 1").get(); } catch (err) { audited = { error: err.message }; }
      p.close(); }
    ok('the connector sign-in is in the audit trail as a passkey sign-in', audited && /"method":"passkey"/.test(audited.detail || ''), JSON.stringify(audited));

    // Registration asks for a passkey that can sign in without a username.
    const reg = await webSignIn('marc@lrparis.com', 2, '1d');
    const csrfRes = await fetch(`${BASE}/api/auth/csrf-token`, { headers: { Cookie: reg.cookie.pair } });
    const { csrfToken } = await csrfRes.json();
    const regOpt = await fetch(`${BASE}/api/auth/passkey/register-options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: reg.cookie.pair, 'x-csrf-token': csrfToken }, body: '{}',
    });
    const regJson = await regOpt.json();
    eq('new passkeys must be discoverable', regJson?.authenticatorSelection?.residentKey, 'required');

    // Last, because it spends actor 0's budget for a minute. Every signed call
    // comes from the one shuttle-mcp container; keyed by IP they shared one
    // bucket, so a flood of sign-in attempts made everyone's tool writes 429.
    let limited = 0;
    for (let i = 0; i < 245; i += 1) {
      const r = await callMcp(0, 'POST', '/api/mcp/passkey/options', {});
      if (r.status === 429) limited += 1;
    }
    ok('a flood of sign-in calls is rate limited', limited > 0, `no 429 in 245 calls`);
    const someoneElse = await callMcp(2, 'POST', '/api/mcp/passkey/options', {});
    eq('without using up the budget of a signed-in person', someoneElse.status, 403);
  } catch (err) {
    failures.push(`crashed: ${err.message}`);
    console.log(`FAIL  the test crashed: ${err.stack}`);
  } finally {
    child.kill();
    box.destroy();
  }

  console.log(failures.length === 0 ? `\nPASS  ${passed} check(s).` : `\nFAIL  ${failures.length} of ${passed + failures.length} check(s).`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
