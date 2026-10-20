#!/usr/bin/env node
// ---------------------------------------------------------------------------
// sso.test.js — "Sign in with Launchpad" for other LR Paris apps (sso.js).
//
// Boots the real backend on a throwaway copy of the databases, with two apps in
// SSO_CLIENTS, then checks every rule of the contract LR Parrot relies on:
//
//   - authorize: an unknown app or a redirect address that is not exactly a
//     registered one gets a plain 400 and no redirect, signed in or not;
//   - authorize, signed out: off to /login with a `next` that is this exact
//     authorize URL, and that `next` works once the person has signed in by
//     email code or by passkey;
//   - authorize, signed in: back to the app with a fresh one-time code and the
//     state unchanged; an account outside the app's domains gets a plain 403;
//   - token: the code and the client secret give the person; a wrong secret is
//     401 invalid_client; a used, unknown, expired or mismatched code is 400
//     invalid_grant; no cookie and no CSRF token are needed or touched;
//   - a signed tool-server request, which names a person without a browser,
//     never gets a code;
//   - the audit log has sso_authorize, sso_token and sso_denied with the client
//     id, and never a code or a secret;
//   - SSO_CLIENTS that is not JSON: logged once, no app can sign in, the rest of
//     Launchpad still starts.
//
// Codes live 60 seconds in the backend's memory. To check that without waiting
// a minute, the backend runs with a small preload that moves its Date.now()
// forward when this test asks over IPC. Nothing in src/ knows about it.
//
//   cd backend && node test/sso.test.js
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sandbox = require('./_sandbox');

const SESSION_SECRET = 'sso-test-session-secret-0123456789abcdef0123';
const MCP_SHARED_SECRET = 'sso-test-mcp-shared-secret-0123456789abcdef';
const KNOWN_CODE = '424242';
const RP_ID = 'lrparisstore.com';
const ORIGIN = 'https://lrparisstore.com';

const PARROT_SECRET = crypto.randomBytes(32).toString('hex');
const NOTES_SECRET = crypto.randomBytes(32).toString('hex');
const PARROT_CB = 'https://parrot.lrparis.com/auth/callback';
const PARROT_CB2 = 'https://parrot-staging.lrparis.com/auth/callback';
const NOTES_CB = 'https://notes.lrparis.com/callback';
const SSO_CLIENTS = JSON.stringify({
  // No allowedDomains: the default, lrparis.com only.
  parrot: { name: 'LR Parrot', secret: PARROT_SECRET, redirectUris: [PARROT_CB, PARROT_CB2] },
  notes: { name: 'LR Notes', secret: NOTES_SECRET, redirectUris: [NOTES_CB], allowedDomains: ['lrparis.com', 'Example.com'] },
  weak: { name: 'Weak', secret: 'too-short', redirectUris: ['https://weak.lrparis.com/cb'] },
});

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

// --- cookies ----------------------------------------------------------------
function sessionCookie(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const raw = all.find((c) => c.startsWith('__lp_sid='));
  return raw ? { pair: raw.split(';')[0], raw } : null;
}

// --- a software passkey (as in sign-in.test.js) ------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function cborBytes(buf) { return Buffer.concat([Buffer.from([0x58, buf.length]), buf]); }
function makePasskey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), cborBytes(x),
    Buffer.from([0x22]), cborBytes(y),
  ]);
  return { id: b64url(crypto.randomBytes(16)), privateKey, coseB64: cose.toString('base64'), counter: 0 };
}
function assertion(pk, challenge, userId) {
  pk.counter += 1;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(pk.counter);
  const authData = Buffer.concat([crypto.createHash('sha256').update(RP_ID).digest(), Buffer.from([0x05]), counter]);
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  return {
    id: pk.id,
    rawId: pk.id,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(crypto.sign('sha256', signed, pk.privateKey)),
      userHandle: b64url(Buffer.from(String(userId))),
    },
    clientExtensionResults: {},
  };
}

// --- server -----------------------------------------------------------------
// Moves the backend's Date.now() forward when the test sends {shiftClockMs}.
const CLOCK_PRELOAD = `
let offset = 0;
const realNow = Date.now;
Date.now = () => realNow() + offset;
process.on('message', (m) => {
  if (m && typeof m.shiftClockMs === 'number') {
    offset += m.shiftClockMs;
    process.send({ clockOffsetMs: offset });
  }
});
`;

function startServer(box, port, extraEnv = {}) {
  const preload = path.join(box.root, 'clock-preload.js');
  fs.writeFileSync(preload, CLOCK_PRELOAD);
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
  if (!('SSO_CLIENTS' in extraEnv)) delete env.SSO_CLIENTS;
  const child = spawn(process.execPath, ['--require', preload, path.join(box.backend, 'src', 'index.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
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
function shiftClock(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the backend did not move its clock')), 5000);
    child.once('message', (m) => { clearTimeout(timer); resolve(m); });
    child.send({ shiftClockMs: ms });
  });
}

// --- the two SSO routes -----------------------------------------------------
let BASE = '';
const issuedCodes = [];

function authorizeUrl(params) {
  const u = new URL(`${BASE}/api/auth/sso/authorize`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u;
}
async function authorize(target, cookie) {
  const url = typeof target === 'string' ? `${BASE}${target}` : authorizeUrl(target);
  const res = await fetch(url, { redirect: 'manual', headers: cookie ? { Cookie: cookie.pair } : {} });
  const text = await res.text();
  const location = res.headers.get('location');
  let back = null;
  if (location && /^https?:\/\//.test(location)) {
    const u = new URL(location);
    back = { to: `${u.origin}${u.pathname}`, code: u.searchParams.get('code'), state: u.searchParams.get('state'), hasState: u.searchParams.has('state'), params: [...u.searchParams.keys()] };
    if (back.code) issuedCodes.push(back.code);
  }
  return {
    status: res.status,
    location,
    back,
    text,
    type: res.headers.get('content-type') || '',
    cacheControl: res.headers.get('cache-control') || '',
  };
}
async function token(body, headers = {}) {
  const res = await fetch(`${BASE}/api/auth/sso/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [], cacheControl: res.headers.get('cache-control') || '' };
}
// A request signed the way shuttle-mcp signs them (authz.js mcpActor).
function signedGet(actor, target) {
  const url = typeof target === 'string' ? new URL(`${BASE}${target}`) : authorizeUrl(target);
  const ts = String(Date.now());
  const material = `GET\n${url.pathname}${url.search}\n\n${actor}\n${ts}`;
  const sig = crypto.createHmac('sha256', MCP_SHARED_SECRET).update(material).digest('hex');
  return fetch(url, { redirect: 'manual', headers: { 'X-Launchpad-Actor': String(actor), 'X-Launchpad-Ts': ts, 'X-Launchpad-Sig': sig } });
}
const parrotToken = (code, redirectUri = PARROT_CB) => token({ client_id: 'parrot', client_secret: PARROT_SECRET, code, redirect_uri: redirectUri });

async function main() {
  const box = sandbox.create({ label: 'sso' });
  const Database = require(path.join(box.backend, 'node_modules', 'better-sqlite3'));
  const usersDb = () => new Database(box.usersDbPath);
  const sql = (statement, ...args) => { const u = usersDb(); u.prepare(statement).run(...args); u.close(); };

  sql("INSERT INTO users (id, username, email, name, role) VALUES (20, 'outside', 'someone@example.com', 'Outside Person', 'user')");
  sql("INSERT INTO users (id, username, email, name, role) VALUES (21, 'leaver', 'leaver@lrparis.com', 'Leaver', 'user')");
  sql("INSERT INTO users (id, username, email, name, role) VALUES (22, 'mover', 'mover@lrparis.com', 'Mover', 'user')");

  const port = 4500 + Math.floor(Math.random() * 400);
  BASE = `http://127.0.0.1:${port}`;
  let server = startServer(box, port, { SSO_CLIENTS });

  async function webSignIn(identifier, userId) {
    sql('DELETE FROM otp_codes WHERE user_id = ?', userId);
    await fetch(`${BASE}/api/auth/login-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }),
    });
    { const u = usersDb();
      const row = u.prepare('SELECT id FROM otp_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
      if (row) u.prepare('UPDATE otp_codes SET code = ? WHERE id = ?').run(otpHash(KNOWN_CODE), row.id);
      u.close(); }
    const res = await fetch(`${BASE}/api/auth/login-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, code: KNOWN_CODE }),
    });
    const cookie = sessionCookie(res);
    if (res.status !== 200 || !cookie) throw new Error(`could not sign ${identifier} in: ${res.status}`);
    return cookie;
  }

  try {
    await waitForHealth(port, server.child, server.log);
    const bootLog = server.log.join('');
    ok('the boot log names the apps that can sign in',
      bootLog.includes('[sso] Sign in with Launchpad is on for: parrot (LR Parrot), notes (LR Notes)'), bootLog.slice(0, 600));
    ok('and says why a broken entry was left out', /\[sso\] SSO_CLIENTS: "weak" is left out: "secret" must be/.test(bootLog));

    const marc = await webSignIn('marc@lrparis.com', 2);

    // -----------------------------------------------------------------------
    // 1. Unknown app: a plain 400, never a redirect
    // -----------------------------------------------------------------------
    for (const [label, target] of [
      ['an unknown client_id', { client_id: 'nope', redirect_uri: PARROT_CB, state: 's' }],
      ['no client_id at all', { redirect_uri: PARROT_CB, state: 's' }],
      ['client_id=__proto__', { client_id: '__proto__', redirect_uri: PARROT_CB, state: 's' }],
      ['client_id=constructor', { client_id: 'constructor', redirect_uri: PARROT_CB, state: 's' }],
      ['an entry left out for a weak secret', { client_id: 'weak', redirect_uri: 'https://weak.lrparis.com/cb', state: 's' }],
    ]) {
      const r = await authorize(target, marc);
      ok(`${label} gets a plain 400 and no redirect`, r.status === 400 && !r.location && r.type.startsWith('text/plain'),
        `status ${r.status}, location ${r.location}, type ${r.type}`);
    }
    const twoClients = await authorize(`/api/auth/sso/authorize?client_id=parrot&client_id=notes&redirect_uri=${encodeURIComponent(PARROT_CB)}`, marc);
    ok('two client_ids at once are not a client', twoClients.status === 400 && !twoClients.location);
    const signedOutUnknown = await authorize({ client_id: 'nope', redirect_uri: PARROT_CB, state: 's' });
    ok('an unknown app is refused before anyone is asked to sign in', signedOutUnknown.status === 400 && !signedOutUnknown.location,
      `status ${signedOutUnknown.status}, location ${signedOutUnknown.location}`);

    // -----------------------------------------------------------------------
    // 2. Redirect address not EXACTLY a registered one: a plain 400
    // -----------------------------------------------------------------------
    for (const [label, uri] of [
      ['a trailing slash', `${PARROT_CB}/`],
      ['an extra query', `${PARROT_CB}?next=/x`],
      ['a fragment', `${PARROT_CB}#x`],
      ['a different case in the host', 'https://PARROT.lrparis.com/auth/callback'],
      ['http instead of https', 'http://parrot.lrparis.com/auth/callback'],
      ['a look-alike host', 'https://parrot.lrparis.com.evil.example/auth/callback'],
      ['another app\'s address', NOTES_CB],
      ['no address at all', undefined],
    ]) {
      const signedIn = await authorize({ client_id: 'parrot', redirect_uri: uri, state: 's' }, marc);
      ok(`${label} is refused with a plain 400 and no redirect`, signedIn.status === 400 && !signedIn.location,
        `status ${signedIn.status}, location ${signedIn.location}`);
    }
    const signedOutMismatch = await authorize({ client_id: 'parrot', redirect_uri: 'https://evil.example/cb', state: 's' });
    ok('a wrong address is refused before anyone is asked to sign in', signedOutMismatch.status === 400 && !signedOutMismatch.location);
    ok('in plain words', /not valid/.test(signedOutMismatch.text) && !/<html/i.test(signedOutMismatch.text), signedOutMismatch.text);
    const longState = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 'x'.repeat(2000) }, marc);
    ok('a state of 2000 characters is refused', longState.status === 400 && !longState.location);

    // -----------------------------------------------------------------------
    // 3. Signed out: to the sign-in page, and back through this exact URL
    // -----------------------------------------------------------------------
    const STATE = 'st@te with spaces & = / ? é';
    const askUrl = authorizeUrl({ client_id: 'parrot', redirect_uri: PARROT_CB, state: STATE });
    const asked = `${askUrl.pathname}${askUrl.search}`;
    const signedOut = await authorize(asked);
    eq('signed out, authorize redirects', signedOut.status, 302);
    ok('to the Launchpad sign-in page', (signedOut.location || '').startsWith('/login?next='), signedOut.location);
    const next = new URLSearchParams((signedOut.location || '').split('?')[1] || '').get('next');
    eq('with next = this exact authorize URL', next, asked);
    ok('which is the one next the sign-in page will follow', (next || '').startsWith('/api/auth/sso/authorize?'));
    ok('and is not cached', /no-store/.test(signedOut.cacheControl), signedOut.cacheControl);

    // After an email-code sign in, the page goes to `next`.
    const viaEmail = await authorize(next, marc);
    eq('after an email-code sign in, next sends the browser back to the app', viaEmail.status, 302);
    eq('to the registered address', viaEmail.back && viaEmail.back.to, PARROT_CB);
    ok('with a code of 32 random bytes, base64url', /^[A-Za-z0-9_-]{43}$/.test((viaEmail.back && viaEmail.back.code) || ''), viaEmail.back && viaEmail.back.code);
    eq('and the state exactly as the app sent it', viaEmail.back && viaEmail.back.state, STATE);
    ok('and nothing else', viaEmail.back && viaEmail.back.params.join(',') === 'code,state', viaEmail.back && viaEmail.back.params.join(','));
    ok('not cached', /no-store/.test(viaEmail.cacheControl), viaEmail.cacheControl);

    // After a passkey sign in, the same.
    const margotKey = makePasskey();
    sql('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_type, backed_up, nickname) VALUES (?, ?, ?, 0, ?, 1, ?)',
      8, margotKey.id, margotKey.coseB64, 'multiDevice', 'Test Mac');
    const optRes = await fetch(`${BASE}/api/auth/passkey/auth-options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const opt = await optRes.json();
    const pkRes = await fetch(`${BASE}/api/auth/passkey/auth-verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie(optRes).pair },
      body: JSON.stringify(assertion(margotKey, opt.challenge, 8)),
    });
    const margot = sessionCookie(pkRes);
    eq('Margot signs in with a passkey', pkRes.status, 200);
    const margotOut = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 'm1' });
    const margotNext = new URLSearchParams(margotOut.location.split('?')[1]).get('next');
    const viaPasskey = await authorize(margotNext, margot);
    ok('after a passkey sign in, next sends the browser back to the app with a code',
      viaPasskey.status === 302 && viaPasskey.back && viaPasskey.back.to === PARROT_CB && !!viaPasskey.back.code && viaPasskey.back.state === 'm1',
      `status ${viaPasskey.status}, location ${viaPasskey.location}`);
    const margotUser = await parrotToken(viaPasskey.back.code);
    eq('and the code names Margot', margotUser.json && margotUser.json.user && margotUser.json.user.email, 'm.drevno@lrparis.com');

    // -----------------------------------------------------------------------
    // 4. Signed in: a fresh code every time, state echoed or left out
    // -----------------------------------------------------------------------
    const a1 = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 'one' }, marc);
    const a2 = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 'one' }, marc);
    ok('every authorize gets a different code', a1.back.code !== a2.back.code);
    const second = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB2, state: 'two' }, marc);
    eq('a second registered address works too', second.back && second.back.to, PARROT_CB2);
    const noState = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB }, marc);
    ok('without a state, there is a code and no state', noState.status === 302 && !!noState.back.code && !noState.back.hasState);

    // A signed tool request names a person (actor 2 is Marc) with no browser
    // and no sign in. It is refused before anything else, never a code.
    const signed = await signedGet(2, { client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' });
    const signedText = await signed.text();
    ok('a signed tool request as Marc gets a plain 403, not a code',
      signed.status === 403 && !signed.headers.get('location') && (signed.headers.get('content-type') || '').startsWith('text/plain'),
      `status ${signed.status}, location ${signed.headers.get('location')}, body ${signedText.slice(0, 120)}`);
    const signedAnon = await signedGet(0, { client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' });
    ok('nor does one signed as nobody (actor 0) get sent to the sign-in page', signedAnon.status === 403 && !signedAnon.headers.get('location'),
      `status ${signedAnon.status}, location ${signedAnon.headers.get('location')}`);

    // -----------------------------------------------------------------------
    // 5. The account's domain must be one the app allows
    // -----------------------------------------------------------------------
    const outside = await webSignIn('someone@example.com', 20);
    const refused = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, outside);
    ok('an example.com account gets a plain 403 from an lrparis.com-only app', refused.status === 403 && !refused.location && refused.type.startsWith('text/plain'),
      `status ${refused.status}, location ${refused.location}, type ${refused.type}`);
    ok('that names the app and the domain it accepts', /LR Parrot/.test(refused.text) && /@lrparis\.com/.test(refused.text), refused.text);
    const otherApp = await authorize({ client_id: 'notes', redirect_uri: NOTES_CB, state: 's' }, outside);
    ok('an app that lists example.com lets the same account in', otherApp.status === 302 && otherApp.back && !!otherApp.back.code,
      `status ${otherApp.status}, text ${otherApp.text}`);
    const outsideUser = await token({ client_id: 'notes', client_secret: NOTES_SECRET, code: otherApp.back.code, redirect_uri: NOTES_CB });
    eq('and its code names that account', outsideUser.json && outsideUser.json.user && outsideUser.json.user.email, 'someone@example.com');

    const mover = await webSignIn('mover@lrparis.com', 22);
    sql("UPDATE users SET email = 'mover@example.com' WHERE id = 22");
    const moved = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, mover);
    eq('the rule reads the account as it is now, not as it was at sign in', moved.status, 403);

    // -----------------------------------------------------------------------
    // 6. Token: the app's server swaps the code for the person
    // -----------------------------------------------------------------------
    const t1 = await parrotToken(a1.back.code);
    eq('the code and the secret give the person', t1.status, 200);
    ok('Marc, with exactly id, username, email, name and role',
      JSON.stringify(t1.json) === JSON.stringify({ user: { id: 2, username: 'marc', email: 'marc@lrparis.com', name: 'Marc', role: 'user' } }),
      JSON.stringify(t1.json));
    ok('not cached', /no-store/.test(t1.cacheControl), t1.cacheControl);
    ok('with no cookie and no CSRF token sent, and no cookie set', t1.setCookie.length === 0, JSON.stringify(t1.setCookie));

    const reused = await parrotToken(a1.back.code);
    ok('a used code is refused with 400 invalid_grant', reused.status === 400 && reused.json && reused.json.error === 'invalid_grant', `${reused.status} ${reused.text}`);

    // Behind express-session and csrfProtection, a POST with a session cookie
    // and no x-csrf-token would be a 403, and the rolling session would send
    // the cookie back. In front of both, neither happens.
    const withCookie = await token({ client_id: 'parrot', client_secret: PARROT_SECRET, code: a2.back.code, redirect_uri: PARROT_CB }, { Cookie: marc.pair });
    eq('a session cookie on the token call changes nothing, and needs no CSRF token', withCookie.status, 200);
    ok('and that session is never read or renewed', withCookie.setCookie.length === 0, JSON.stringify(withCookie.setCookie));

    const forSecret = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    for (const [label, body] of [
      ['a wrong secret', { client_id: 'parrot', client_secret: 'f'.repeat(64), code: forSecret.back.code, redirect_uri: PARROT_CB }],
      ['another app\'s secret', { client_id: 'parrot', client_secret: NOTES_SECRET, code: forSecret.back.code, redirect_uri: PARROT_CB }],
      ['no secret', { client_id: 'parrot', code: forSecret.back.code, redirect_uri: PARROT_CB }],
      ['a secret that is not a string', { client_id: 'parrot', client_secret: [PARROT_SECRET], code: forSecret.back.code, redirect_uri: PARROT_CB }],
      ['an unknown client', { client_id: 'nope', client_secret: PARROT_SECRET, code: forSecret.back.code, redirect_uri: PARROT_CB }],
      ['client_id=__proto__', { client_id: '__proto__', client_secret: PARROT_SECRET, code: forSecret.back.code, redirect_uri: PARROT_CB }],
      ['an empty body', {}],
    ]) {
      const r = await token(body);
      ok(`${label} is refused with 401 invalid_client`, r.status === 401 && r.json && r.json.error === 'invalid_client', `${r.status} ${r.text}`);
    }
    const afterBadSecrets = await parrotToken(forSecret.back.code);
    eq('a caller without the secret cannot use up the code', afterBadSecrets.status, 200);

    const unknown = await parrotToken(b64url(crypto.randomBytes(32)));
    ok('a code Launchpad never issued is 400 invalid_grant', unknown.status === 400 && unknown.json.error === 'invalid_grant');
    const noCode = await token({ client_id: 'parrot', client_secret: PARROT_SECRET, redirect_uri: PARROT_CB });
    ok('no code at all is 400 invalid_grant', noCode.status === 400 && noCode.json.error === 'invalid_grant');

    const forRedirect = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    const wrongRedirect = await parrotToken(forRedirect.back.code, PARROT_CB2);
    ok('a code swapped with a different redirect_uri, even a registered one, is 400 invalid_grant',
      wrongRedirect.status === 400 && wrongRedirect.json.error === 'invalid_grant', `${wrongRedirect.status} ${wrongRedirect.text}`);
    eq('and that attempt used it up', (await parrotToken(forRedirect.back.code)).status, 400);
    const forNoRedirect = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    const noRedirect = await token({ client_id: 'parrot', client_secret: PARROT_SECRET, code: forNoRedirect.back.code });
    ok('a code swapped with no redirect_uri is 400 invalid_grant', noRedirect.status === 400 && noRedirect.json.error === 'invalid_grant');

    const forClient = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    const wrongClient = await token({ client_id: 'notes', client_secret: NOTES_SECRET, code: forClient.back.code, redirect_uri: PARROT_CB });
    ok('another app cannot swap Parrot\'s code, even with its own good secret',
      wrongClient.status === 400 && wrongClient.json.error === 'invalid_grant', `${wrongClient.status} ${wrongClient.text}`);
    eq('and that attempt used it up', (await parrotToken(forClient.back.code)).status, 400);

    const leaver = await webSignIn('leaver@lrparis.com', 21);
    const forLeaver = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, leaver);
    sql('DELETE FROM users WHERE id = 21');
    const gone = await parrotToken(forLeaver.back.code);
    ok('an account deleted between the two steps is 400 invalid_grant', gone.status === 400 && gone.json.error === 'invalid_grant');

    const forEmailChange = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    sql("UPDATE users SET email = 'marc@example.com' WHERE id = 2");
    const changed = await parrotToken(forEmailChange.back.code);
    sql("UPDATE users SET email = 'marc@lrparis.com' WHERE id = 2");
    ok('an account moved out of the app\'s domains between the two steps is 400 invalid_grant', changed.status === 400 && changed.json.error === 'invalid_grant');

    // -----------------------------------------------------------------------
    // 7. Codes last 60 seconds
    // -----------------------------------------------------------------------
    const early = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    const late = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
    await shiftClock(server.child, 59 * 1000);
    eq('a code 59 seconds old still works', (await parrotToken(early.back.code)).status, 200);
    await shiftClock(server.child, 2 * 1000);
    const expired = await parrotToken(late.back.code);
    ok('a code 61 seconds old is 400 invalid_grant', expired.status === 400 && expired.json && expired.json.error === 'invalid_grant', `${expired.status} ${expired.text}`);

    // -----------------------------------------------------------------------
    // 8. The audit trail
    // -----------------------------------------------------------------------
    const auditText = fs.existsSync(path.join(box.dataDir, 'audit.log')) ? fs.readFileSync(path.join(box.dataDir, 'audit.log'), 'utf8') : '';
    const audit = auditText.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const sso = audit.filter((e) => /^sso_/.test(e.event || ''));
    ok('sso_authorize is recorded with the client and the person',
      sso.some((e) => e.event === 'sso_authorize' && e.actor === 'marc' && e.details && e.details.client === 'parrot'));
    ok('sso_token is recorded with the client and the person',
      sso.some((e) => e.event === 'sso_token' && e.actor === 'marc' && e.details && e.details.client === 'parrot'));
    const denied = new Set(sso.filter((e) => e.event === 'sso_denied').map((e) => e.details && e.details.reason));
    for (const reason of ['unknown_client', 'redirect_uri_mismatch', 'domain_not_allowed', 'bad_secret', 'unknown_code',
      'expired_code', 'client_mismatch', 'account_removed', 'signed_tool_request']) {
      ok(`sso_denied is recorded for ${reason}`, denied.has(reason), [...denied].join(', '));
    }
    ok('every sso_ entry names a client', sso.length > 0 && sso.every((e) => e.details && 'client' in e.details));

    const serverLogs = server.log.join('')
      + (fs.existsSync(path.join(box.backend, 'logs', 'launchpad.log')) ? fs.readFileSync(path.join(box.backend, 'logs', 'launchpad.log'), 'utf8') : '');
    ok('codes were issued for the next check', issuedCodes.length >= 10, String(issuedCodes.length));
    const leaked = issuedCodes.filter((c) => auditText.includes(c) || serverLogs.includes(c));
    ok('no code appears in the audit log or the server log', leaked.length === 0, `${leaked.length} leaked`);
    ok('no secret appears in the audit log or the server log',
      ![PARROT_SECRET, NOTES_SECRET].some((s) => auditText.includes(s) || serverLogs.includes(s)));

    // -----------------------------------------------------------------------
    // 9. Rate limits, last, because they spend this IP's budget
    // -----------------------------------------------------------------------
    let tokenLimited = 0;
    for (let i = 0; i < 125; i += 1) {
      const r = await token({ client_id: 'parrot', client_secret: 'x', code: 'x', redirect_uri: PARROT_CB });
      if (r.status === 429) tokenLimited += 1;
    }
    ok('a flood of token calls is rate limited', tokenLimited > 0, 'no 429 in 125 calls');
    let authLimited = null;
    for (let i = 0; i < 65 && !authLimited; i += 1) {
      const r = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' }, marc);
      if (r.status === 429) authLimited = r;
    }
    ok('a flood of authorize calls is rate limited, with a plain page', authLimited && authLimited.type.startsWith('text/plain') && !authLimited.location,
      authLimited ? authLimited.type : 'no 429 in 65 calls');

    server.child.kill();

    // -----------------------------------------------------------------------
    // 10. SSO_CLIENTS that is not JSON
    // -----------------------------------------------------------------------
    // The quotes around the secret lost on the way, the classic env-file
    // mistake. Node's JSON error quotes the text around that spot, which here
    // is the start of the secret, so the log must not carry the parser's words.
    const LEAK = `k${crypto.randomBytes(24).toString('hex')}`;
    const brokenPort = port + 1;
    BASE = `http://127.0.0.1:${brokenPort}`;
    server = startServer(box, brokenPort, {
      SSO_CLIENTS: `{"parrot":{"name":"LR Parrot","secret":${LEAK},"redirectUris":["${PARROT_CB}"]}}`,
    });
    await waitForHealth(brokenPort, server.child, server.log);
    eq('with SSO_CLIENTS broken, the rest of Launchpad still starts', (await fetch(`${BASE}/api/health`)).status, 200);
    for (let i = 0; i < 3; i += 1) {
      const r = await authorize({ client_id: 'parrot', redirect_uri: PARROT_CB, state: 's' });
      if (i === 0) ok('no app is known: authorize is a plain 400 with no redirect', r.status === 400 && !r.location, `status ${r.status}, location ${r.location}`);
    }
    const brokenToken = await token({ client_id: 'parrot', client_secret: LEAK, code: 'x', redirect_uri: PARROT_CB });
    ok('and token is 401 invalid_client', brokenToken.status === 401 && brokenToken.json && brokenToken.json.error === 'invalid_client');
    await token({ client_id: 'parrot', client_secret: LEAK, code: 'x', redirect_uri: PARROT_CB });
    const brokenLog = server.log.join('');
    const said = brokenLog.split('[sso] SSO_CLIENTS is not valid JSON').length - 1;
    eq('the problem is logged once, not once per request', said, 1);
    ok('without quoting any of the secret from the broken value', !brokenLog.includes(LEAK.slice(0, 8)));
  } catch (err) {
    failures.push(`crashed: ${err.message}`);
    console.log(`FAIL  the test crashed: ${err.stack}`);
  } finally {
    server.child.kill();
    box.destroy();
  }

  console.log(failures.length === 0 ? `\nPASS  ${passed} check(s).` : `\nFAIL  ${failures.length} of ${passed + failures.length} check(s).`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
