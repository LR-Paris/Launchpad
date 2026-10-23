#!/usr/bin/env node
// ---------------------------------------------------------------------------
// self-signup.test.js — an LR Paris email gets its account at first sign in.
//
// Boots the real backend on a throwaway copy of the databases and checks the
// whole contract, with node's own test runner:
//
//   - a new @lrparis.com address (no SELF_SIGNUP_DOMAINS set at all) asks for a
//     code and gets the usual email with the usual answer; nothing is created.
//     The right code then creates the account (role user, no shops, cannot
//     create shops, created_by self-signup, "arnaud.messager" -> "Arnaud
//     Messager"), writes the audit event and signs the person in;
//   - a wrong code, five wrong codes, an expired code: no account;
//   - another domain, a look-alike domain, a subdomain, "+" aliases, and a
//     username: nothing is sent and nothing is stored, with the same answer;
//   - existing accounts sign in exactly as before, by email or username, in any
//     letter case, and never get a second account;
//   - one account under parallel verifies, parallel requests and two people
//     with the same name before the "@";
//   - per-address and per-IP brakes on codes for addresses with no account;
//   - access an owner granted before the account existed lands with it;
//   - Sign in with Launchpad: authorize -> sign in with a new address ->
//     authorize carries on to the app, and the token names a role "user";
//   - SELF_SIGNUP_DOMAINS: other domains, typos left out out loud, empty = off;
//   - the review's fixes, in sections 5 to 11 below: only the people LR Parrot says
//     work here can sign up (sso.js POST /members), a deleted or blocked address
//     cannot, a global budget for wrong first-sign-in codes pauses sign-ups and
//     emails the admin, an identifier spelled with a look-alike letter reaches the
//     account it spells, a code for an existing account dies after five wrong
//     tries, one switch for every self-enrolment, and a self-made account does not
//     see the shop list;
//   - NOBODY IS NOTIFIED. Every outgoing request of the backend is recorded by a
//     preload (Mailgun answers 200, anything else, Teams and Graph included, is
//     refused and counted). A first sign in sends exactly one email, the code,
//     to the person who asked, and creating the account sends none.
//
// The backend's clock is moved with a preload (as in sso.test.js) so expiry and
// cooldowns do not need real minutes. Nothing in src/ knows about it.
//
//   cd backend && node --test test/self-signup.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const sandbox = require('./_sandbox');

const { describe, it, before, after } = test;

const SESSION_SECRET = 'self-signup-test-session-secret-0123456789abcdef';
const MCP_SHARED_SECRET = 'self-signup-test-mcp-shared-secret-0123456789abcdef';
const ALERT_EMAIL = 'alerts@launchpad-test.invalid';
const SENT = 'If an account exists, a sign-in code has been sent to your email.';
const PARROT_SECRET = crypto.randomBytes(32).toString('hex');
const PARROT_CB = 'https://parrot.lrparis.com/auth/callback';
const SSO_CLIENTS = JSON.stringify({ parrot: { name: 'LR Parrot', secret: PARROT_SECRET, redirectUris: [PARROT_CB] } });

const otpHash = (code) => crypto.createHmac('sha256', SESSION_SECRET).update(String(code)).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Outgoing mail is fire and forget, so a check waits a moment before it counts.
const settle = () => wait(250);

// ---------------------------------------------------------------------------
// The preload: a movable clock, and a fence around every outgoing request.
// ---------------------------------------------------------------------------
const PRELOAD = `
const fs = require('fs');
const out = process.env.OUTBOUND_LOG;
let offset = 0;
const realNow = Date.now;
Date.now = () => realNow() + offset;
process.on('message', (m) => {
  if (m && typeof m.shiftClockMs === 'number') {
    offset += m.shiftClockMs;
    process.send({ clockOffsetMs: offset });
  }
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input.url || String(input)));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  const body = init && init.body;
  const field = (name) => (body && typeof body.get === 'function' ? body.get(name) : null);
  const kind = url.hostname === 'api.mailgun.net' ? 'mail' : url.hostname === 'ipwho.is' ? 'geo' : 'blocked';
  fs.appendFileSync(out, JSON.stringify({ kind, host: url.hostname, to: field('to'), subject: field('subject') }) + '\\n');
  if (kind === 'mail') return new Response('{"message":"Queued. Thank you."}', { status: 200, headers: { 'content-type': 'application/json' } });
  if (kind === 'geo') return new Response('{"success":false}', { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('outgoing request refused by the test: ' + url.hostname);
};
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// A backend on its own sandbox, and everything the tests want to look at in it.
async function boot(label, env = {}) {
  const box = sandbox.create({ label });
  const Database = require(path.join(box.backend, 'node_modules', 'better-sqlite3'));
  const preload = path.join(box.root, 'preload.js');
  const outbound = path.join(box.root, 'outbound.jsonl');
  fs.writeFileSync(preload, PRELOAD);
  fs.writeFileSync(outbound, '');

  const port = await freePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    SESSION_SECRET,
    MCP_SHARED_SECRET,
    NODE_ENV: 'test',
    MAILGUN_API_KEY: 'key-test',
    MAILGUN_DOMAIN: 'mg.launchpad-test.invalid',
    ALERT_EMAIL,
    OUTBOUND_LOG: outbound,
    FRONTEND_URL: `http://127.0.0.1:${port}`,
    ...env,
  };
  delete childEnv.PUBLIC_URL; delete childEnv.RP_ID; delete childEnv.BASE_DOMAIN; delete childEnv.OTP_PEPPER;
  delete childEnv.TURNSTILE_SITE_KEY; delete childEnv.TURNSTILE_SECRET_KEY;
  if (!('SELF_SIGNUP_DOMAINS' in env)) delete childEnv.SELF_SIGNUP_DOMAINS;
  if (!('SSO_CLIENTS' in env)) delete childEnv.SSO_CLIENTS;

  const child = spawn(process.execPath, ['--require', preload, path.join(box.backend, 'src', 'index.js')], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}:\n${log.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`backend never answered:\n${log.join('')}`);
    await wait(150);
  }

  const withDb = (file, fn) => { const d = new Database(file); try { return fn(d); } finally { d.close(); } };
  const usersDb = (fn) => withDb(box.usersDbPath, fn);
  const b = {
    box, base, child, log,
    asked: new Set(), // every address somebody asked a code for, in this run
    bootLog: () => log.join(''),
    // How far the backend's clock has been moved: a signed request has to carry the backend's time.
    clockOffsetMs: 0,
    shiftClock: (ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the backend did not move its clock')), 5000);
      child.once('message', (m) => { clearTimeout(timer); b.clockOffsetMs = m.clockOffsetMs; resolve(m); });
      child.send({ shiftClockMs: ms });
    }),
    calls: () => fs.readFileSync(outbound, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    mails: () => b.calls().filter((c) => c.kind === 'mail'),
    blocked: () => b.calls().filter((c) => c.kind === 'blocked'),
    codeMails: (to) => b.mails().filter((m) => m.to === to && /sign-in code$/.test(m.subject || '')),
    lastCode: (to) => { const m = b.codeMails(to).pop(); return m ? /^(\d{6}) /.exec(m.subject)[1] : null; },
    users: () => usersDb((d) => d.prepare('SELECT * FROM users ORDER BY id').all()),
    userByEmail: (email) => usersDb((d) => d.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email)),
    permissionRows: (userId) => usersDb((d) => d.prepare('SELECT * FROM user_shop_permissions WHERE user_id = ?').all(userId)),
    pending: () => usersDb((d) => d.prepare('SELECT * FROM pending_signups ORDER BY email').all()),
    sql: (statement, ...args) => usersDb((d) => d.prepare(statement).run(...args)),
    get: (statement, ...args) => usersDb((d) => d.prepare(statement).get(...args)),
    all: (statement, ...args) => usersDb((d) => d.prepare(statement).all(...args)),
    platformSql: (statement, ...args) => withDb(path.join(box.dataDir, 'platform.db'), (d) => d.prepare(statement).run(...args)),
    platformGet: (statement, ...args) => withDb(path.join(box.dataDir, 'platform.db'), (d) => d.prepare(statement).get(...args)),
    audit: () => {
      const file = path.join(box.dataDir, 'audit.log');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    },
    stop: () => { try { child.kill(); } catch { /* gone */ } box.destroy(); },
  };
  return b;
}

// --- HTTP -------------------------------------------------------------------
function sessionCookie(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const raw = all.find((c) => c.startsWith('__lp_sid='));
  return raw ? { pair: raw.split(';')[0], raw } : null;
}
async function post(b, route, body, headers = {}) {
  const res = await fetch(`${b.base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text, cookie: sessionCookie(res) };
}
const requestCode = (b, identifier, headers) => {
  if (typeof identifier === 'string') b.asked.add(identifier.trim().toLowerCase());
  return post(b, '/api/auth/login-request', { identifier }, headers);
};
const verify = (b, identifier, code, headers) => post(b, '/api/auth/login-verify', { identifier, code }, headers);
const me = (b, cookie) => fetch(`${b.base}/api/auth/me`, { headers: { Cookie: cookie.pair } });

// A code that is certainly not the real one.
const wrongCodeFor = (code) => (code === '000000' ? '000001' : '000000');

// ===========================================================================
// 1. The default: no SELF_SIGNUP_DOMAINS at all, so lrparis.com
// ===========================================================================
describe('self-signup, default domain', () => {
  let b;
  before(async () => { b = await boot('self-signup', { SSO_CLIENTS }); });
  after(() => b && b.stop());

  it('says at boot who gets an account', () => {
    assert.match(b.bootLog(), /\[self-signup\] Anyone with an @lrparis\.com email gets an account at their first sign in/);
  });

  it('a new @lrparis.com address gets the usual code and no account until the code comes back', async () => {
    const email = 'arnaud.messager@lrparis.com';
    const usersBefore = b.users().length;
    const mailsBefore = b.mails().length;

    const asked = await requestCode(b, email);
    assert.equal(asked.status, 200);
    assert.deepEqual(asked.json, { message: SENT });
    await settle();

    // One email: the code, to the person who asked.
    const sent = b.mails().slice(mailsBefore);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, email);
    assert.match(sent[0].subject, /^\d{6} — Your Launchpad sign-in code$/);
    // And nothing exists yet: no account, only a pending row holding a hash.
    assert.equal(b.userByEmail(email), undefined);
    assert.equal(b.users().length, usersBefore);
    const code = b.lastCode(email);
    const rows = b.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, email);
    assert.equal(rows[0].code, otpHash(code));
    assert.notEqual(rows[0].code, code);
    assert.ok(rows[0].expires_at - Date.now() <= 10 * 60 * 1000 + 1000 && rows[0].expires_at > Date.now());

    const verified = await verify(b, email, code);
    assert.equal(verified.status, 200);
    assert.ok(verified.cookie, 'a session cookie');
    assert.deepEqual(
      { ...verified.json.user, id: undefined },
      { id: undefined, username: 'arnaud.messager', email, name: 'Arnaud Messager', role: 'user', permissions: {} },
    );

    const row = b.userByEmail(email);
    assert.equal(row.role, 'user');
    assert.equal(row.can_create_shops, 0);
    assert.equal(row.created_by, 'self-signup');
    assert.equal(row.username, 'arnaud.messager');
    assert.equal(b.permissionRows(row.id).length, 0, 'no shop permissions');
    assert.equal(b.pending().length, 0, 'the pending code is spent');
    assert.equal(b.users().length, usersBefore + 1);

    const who = await me(b, verified.cookie);
    assert.equal(who.status, 200);
    assert.equal((await who.json()).user.email, email);

    // The audit log says it happened, and who it was.
    const created = b.audit().filter((e) => e.event === 'user_created' && e.details && e.details.userId === row.id);
    assert.equal(created.length, 1);
    assert.equal(created[0].actor, 'arnaud.messager');
    assert.deepEqual(created[0].details, { userId: row.id, username: 'arnaud.messager', role: 'user', via: 'self-signup' });
    assert.ok(b.audit().some((e) => e.event === 'login_success' && e.actor === 'arnaud.messager'));
    assert.ok(b.audit().some((e) => e.event === 'login_request' && e.details && e.details.email === email && e.details.self_signup === true));

    // Nobody was told: not the person (no welcome email), not an admin.
    await settle();
    const all = b.mails().slice(mailsBefore);
    assert.equal(all.length, 1, JSON.stringify(all));
    assert.equal(all.filter((m) => m.to === ALERT_EMAIL).length, 0);
    assert.deepEqual(b.blocked(), []);
  });

  it('is the same person with another letter case or spaces, never a second account', async () => {
    const asked = await requestCode(b, '  Julie.Martin@LRParis.COM ');
    assert.equal(asked.status, 200);
    await settle();
    const code = b.lastCode('julie.martin@lrparis.com');
    assert.ok(code, 'the code went to the lower-case address');
    const first = await verify(b, 'JULIE.MARTIN@lrparis.com', code);
    assert.equal(first.status, 200);
    assert.equal(first.json.user.email, 'julie.martin@lrparis.com');
    assert.equal(first.json.user.name, 'Julie Martin');
    await settle();
    const julieAlerts = () => b.mails().filter((m) => m.to === ALERT_EMAIL && /Launchpad sign-in: julie\.martin/.test(m.subject)).length;
    assert.equal(julieAlerts(), 0, 'the sign-in that made the account alerted nobody');

    await b.shiftClock(61 * 1000);
    const again = await requestCode(b, 'julie.martin@lrparis.com');
    assert.equal(again.status, 200);
    await settle();
    const second = await verify(b, 'julie.martin@lrparis.com', b.lastCode('julie.martin@lrparis.com'));
    assert.equal(second.status, 200);
    assert.equal(second.json.user.id, first.json.user.id, 'the second sign-in is the same account');
    assert.equal(b.users().filter((u) => u.email.toLowerCase() === 'julie.martin@lrparis.com').length, 1);
    assert.equal(b.audit().filter((e) => e.event === 'user_created' && e.details.userId === first.json.user.id).length, 1);
    // From here on she is an account like any other, and is alerted like one.
    await settle();
    assert.equal(julieAlerts(), 1, 'her later sign-ins are alerted as every account\'s are');
  });

  it('a wrong code makes no account, makes no alert, and the right code still works', async () => {
    const email = 'wrong.code@lrparis.com';
    const mailsBefore = b.mails().length;
    await requestCode(b, email);
    await settle();
    const code = b.lastCode(email);

    const bad = await verify(b, email, wrongCodeFor(code));
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.json, { error: 'Invalid or expired code' });
    assert.equal(b.userByEmail(email), undefined);
    assert.ok(b.audit().some((e) => e.event === 'login_failed' && e.details && e.details.email === email && e.details.reason === 'invalid_otp'));

    const good = await verify(b, email, code);
    assert.equal(good.status, 200);
    assert.equal(b.userByEmail(email).created_by, 'self-signup');
    await settle();
    // The failed attempt did not email an admin either.
    assert.deepEqual(b.mails().slice(mailsBefore).map((m) => m.to), [email]);
  });

  it('five wrong codes end the code: even the right one is refused, and a new code is needed', async () => {
    const email = 'five.wrong@lrparis.com';
    await requestCode(b, email);
    await settle();
    const code = b.lastCode(email);
    for (let i = 0; i < 5; i += 1) {
      const r = await verify(b, email, wrongCodeFor(code));
      assert.equal(r.status, 401);
    }
    assert.equal(b.pending()[0].attempts, 5);
    const tooLate = await verify(b, email, code);
    assert.equal(tooLate.status, 401);
    assert.deepEqual(tooLate.json, { error: 'Invalid or expired code' });
    assert.equal(b.userByEmail(email), undefined);
    assert.ok(b.audit().some((e) => e.event === 'login_failed' && e.details && e.details.email === email && e.details.reason === 'too_many_attempts'));

    await b.shiftClock(61 * 1000);
    await requestCode(b, email);
    await settle();
    const fresh = b.lastCode(email);
    assert.notEqual(fresh, code);
    assert.equal((await verify(b, email, fresh)).status, 200);
    assert.ok(b.userByEmail(email));
  });

  it('an expired code makes no account', async () => {
    const email = 'too.slow@lrparis.com';
    await requestCode(b, email);
    await settle();
    const code = b.lastCode(email);
    await b.shiftClock(10 * 60 * 1000 + 1000);
    const late = await verify(b, email, code);
    assert.equal(late.status, 401);
    assert.deepEqual(late.json, { error: 'Invalid or expired code' });
    assert.equal(b.userByEmail(email), undefined);
    assert.ok(b.audit().some((e) => e.event === 'login_failed' && e.details && e.details.email === email && e.details.reason === 'expired'));
  });

  it('an address with no code asked for gets nothing: 401, no account', async () => {
    const r = await verify(b, 'never.asked@lrparis.com', '123456');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'Invalid or expired code' });
    assert.equal(b.userByEmail('never.asked@lrparis.com'), undefined);
  });

  it('brakes codes per address: one a minute, five in fifteen minutes', async () => {
    const email = 'burst@lrparis.com';
    await requestCode(b, email);
    await settle();
    const again = await requestCode(b, email); // inside the minute
    assert.deepEqual(again.json, { message: SENT }, 'the same answer');
    await settle();
    assert.equal(b.codeMails(email).length, 1, 'no second email inside the minute');

    for (let i = 0; i < 4; i += 1) {
      await b.shiftClock(61 * 1000);
      await requestCode(b, email);
      await settle();
    }
    assert.equal(b.codeMails(email).length, 5);
    await b.shiftClock(61 * 1000);
    const sixth = await requestCode(b, email);
    assert.deepEqual(sixth.json, { message: SENT });
    await settle();
    assert.equal(b.codeMails(email).length, 5, 'no sixth email inside the fifteen minutes');
    assert.ok(b.audit().some((e) => e.event === 'login_request_throttled' && e.details && e.details.email === email && e.details.reason === 'too_many_codes'));

    await b.shiftClock(15 * 60 * 1000);
    await requestCode(b, email);
    await settle();
    assert.equal(b.codeMails(email).length, 6, 'a new window, a new code');
    assert.equal(b.userByEmail(email), undefined, 'none of this made an account');
  });

  it('a new code replaces the old one', async () => {
    const email = 'replaced@lrparis.com';
    await requestCode(b, email);
    await settle();
    const first = b.lastCode(email);
    await b.shiftClock(61 * 1000);
    await requestCode(b, email);
    await settle();
    const second = b.lastCode(email);
    assert.equal(b.pending().filter((r) => r.email === email).length, 1);
    if (first !== second) assert.equal((await verify(b, email, first)).status, 401);
    assert.equal((await verify(b, email, second)).status, 200);
  });

  it('other domains, look-alikes, subdomains, aliases and usernames get nothing, with the same answer', async () => {
    const mailsBefore = b.mails().length;
    const usersBefore = b.users().length;
    const pendingBefore = b.pending().length;
    const nope = [
      'someone@gmail.com',
      'x@lrparis.com.evil.example',
      'x@evil-lrparis.com',
      'x@notlrparis.com',
      'x@sub.lrparis.com',
      'x@lrparis.co',
      'x@lrparis.com@evil.example',
      'x+alias@lrparis.com',
      'x..y@lrparis.com',
      'x y@lrparis.com',
      '"x"@lrparis.com',
      'x@lrpаris.com', // a Cyrillic "a"
      'brand.new.person', // a username
      'lrparis.com',
      '@lrparis.com',
    ];
    for (const identifier of nope) {
      const r = await requestCode(b, identifier);
      assert.equal(r.status, 200, identifier);
      assert.deepEqual(r.json, { message: SENT }, identifier);
      const v = await verify(b, identifier, '123456');
      assert.equal(v.status, 401, identifier);
      assert.deepEqual(v.json, { error: 'Invalid or expired code' }, identifier);
    }
    await settle();
    assert.equal(b.users().length, usersBefore, 'no account');
    assert.equal(b.pending().length, pendingBefore, 'no pending code');
    const sent = b.mails().slice(mailsBefore);
    assert.equal(sent.filter((m) => /sign-in code$/.test(m.subject || '')).length, 0, 'no sign-in code was mailed to anyone');
    for (const identifier of nope) assert.equal(b.mails().filter((m) => m.to === identifier.toLowerCase()).length, 0, identifier);

    // Positive control for the "no alert" checks above: the alert path for an
    // unknown identifier is alive and unchanged, so an earlier silence was not
    // just a mailer that never works.
    assert.ok(sent.some((m) => m.to === ALERT_EMAIL && /failed login attempt/.test(m.subject)), JSON.stringify(sent));
  });

  it('existing accounts sign in exactly as before: by email or username, any case, no second account', async () => {
    const usersBefore = b.users();
    const mailsBefore = b.mails().length;

    // By email.
    await requestCode(b, 'marc@lrparis.com');
    await settle();
    assert.equal(b.pending().filter((r) => r.email === 'marc@lrparis.com').length, 0, 'no pending signup for an existing account');
    assert.equal(b.codeMails('marc@lrparis.com').length, 1);
    // The existing code is the one in otp_codes, not a signup code.
    b.sql('UPDATE otp_codes SET code = ? WHERE user_id = 2 AND used = 0', otpHash('424242'));
    const marc = await verify(b, 'marc@lrparis.com', '424242');
    assert.equal(marc.status, 200);
    assert.deepEqual({ ...marc.json.user }, { id: 2, username: 'marc', email: 'marc@lrparis.com', name: 'Marc', role: 'user', permissions: {} });

    // By username, in another case, after the per-account cooldown.
    await b.shiftClock(61 * 1000);
    b.asked.add('marc@lrparis.com');
    await requestCode(b, 'MARC');
    await settle();
    assert.equal(b.codeMails('marc@lrparis.com').length, 2, 'the code went to marc\'s own address');
    b.sql('UPDATE otp_codes SET code = ? WHERE user_id = 2 AND used = 0', otpHash('424242'));
    assert.equal((await verify(b, 'Marc', '424242')).status, 200);

    // An address typed in capitals reaches the account whose email is lower case.
    await requestCode(b, 'G.LUPO@LRPARIS.COM');
    await settle();
    assert.equal(b.codeMails('g.lupo@lrparis.com').length, 1);
    b.asked.add('g.lupo@lrparis.com');

    // None of that made, changed or duplicated an account.
    const usersAfter = b.users();
    assert.deepEqual(usersAfter, usersBefore);
    assert.equal(usersAfter.find((u) => u.id === 2).created_by, null);
    assert.equal(b.audit().filter((e) => e.event === 'user_created' && e.details && e.details.username === 'marc').length, 0);

    // The sign-in alert to the admin is as it always was for existing accounts.
    // (It is what self-signup's first sign in deliberately does not send.)
    const sent = b.mails().slice(mailsBefore);
    assert.ok(sent.some((m) => m.to === ALERT_EMAIL && /Launchpad sign-in: marc/.test(m.subject)), 'the existing sign-in alert still goes out for existing accounts');
  });

  it('answers with the very same bytes whatever the address is', async () => {
    const texts = [];
    for (const identifier of ['marc@lrparis.com', 'completely.new@lrparis.com', 'someone@gmail.com', 'nobody', 'completely.new@lrparis.com']) {
      const r = await requestCode(b, identifier);
      texts.push([r.status, r.text]);
    }
    assert.equal(new Set(texts.map((t) => JSON.stringify(t))).size, 1, JSON.stringify(texts));
  });

  it('parallel verifies of one code make one account and one sign-in', async () => {
    const email = 'racer@lrparis.com';
    await requestCode(b, email);
    await settle();
    const code = b.lastCode(email);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => verify(b, i % 2 ? email.toUpperCase() : email, code)));
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.filter((r) => r.status === 401).length, 5);
    assert.equal(b.users().filter((u) => u.email.toLowerCase() === email).length, 1);
    assert.equal(b.audit().filter((e) => e.event === 'user_created' && e.details && e.details.username === 'racer').length, 1);
  });

  it('parallel requests for one new address send one code', async () => {
    const email = 'twin@lrparis.com';
    const rs = await Promise.all(Array.from({ length: 5 }, () => requestCode(b, email)));
    assert.ok(rs.every((r) => r.status === 200 && r.json.message === SENT));
    await settle();
    assert.equal(b.codeMails(email).length, 1);
    assert.equal(b.pending().filter((r) => r.email === email).length, 1);
  });

  it('access an owner granted before the account existed lands with it, and tells nobody', async () => {
    const email = 'invited@lrparis.com';
    b.platformSql('INSERT INTO pending_grants (email, shop_slug, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)', email, 'serhant', 'viewer', 1, Date.now());
    const mailsBefore = b.mails().length;
    await requestCode(b, email);
    await settle();
    const v = await verify(b, email, b.lastCode(email));
    assert.equal(v.status, 200);
    assert.deepEqual(Object.keys(v.json.user.permissions), ['serhant']);
    assert.equal(b.permissionRows(v.json.user.id).length, 1);
    assert.equal(b.platformGet('SELECT COUNT(*) AS n FROM pending_grants WHERE email = ?', email).n, 0, 'the waiting grant is used up');
    await settle();
    assert.deepEqual(b.mails().slice(mailsBefore).map((m) => m.to), [email], 'only the code');
  });

  it('Sign in with Launchpad: authorize, sign in with a new address, authorize carries on to the app', async () => {
    const email = 'sso.person@lrparis.com';
    const ask = `/api/auth/sso/authorize?client_id=parrot&redirect_uri=${encodeURIComponent(PARROT_CB)}&state=st8`;
    const authorize = (cookie) => fetch(`${b.base}${ask}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie.pair } : {} });

    // LR Parrot sends the browser here: signed out, so off to the sign-in page, with a next.
    const out = await authorize(null);
    assert.equal(out.status, 302);
    const location = out.headers.get('location');
    assert.ok(location.startsWith('/login?next='), location);
    const next = new URLSearchParams(location.split('?')[1]).get('next');
    assert.equal(next, ask);

    // The sign-in page does what it always does: a code, then the code back.
    await requestCode(b, email);
    await settle();
    const signedIn = await verify(b, email, b.lastCode(email));
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.json.user.role, 'user');
    assert.equal(b.userByEmail(email).created_by, 'self-signup');

    // Then it follows next. The account is a plain "user" and that is enough.
    const back = await fetch(`${b.base}${next}`, { redirect: 'manual', headers: { Cookie: signedIn.cookie.pair } });
    assert.equal(back.status, 302);
    const to = new URL(back.headers.get('location'));
    assert.equal(`${to.origin}${to.pathname}`, PARROT_CB);
    assert.equal(to.searchParams.get('state'), 'st8');
    const code = to.searchParams.get('code');
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);

    const token = await fetch(`${b.base}/api/auth/sso/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'parrot', client_secret: PARROT_SECRET, code, redirect_uri: PARROT_CB }),
    });
    assert.equal(token.status, 200);
    assert.deepEqual((await token.json()).user, {
      id: signedIn.json.user.id, username: 'sso.person', email, name: 'Sso Person', role: 'user',
    });
    assert.ok(b.audit().some((e) => e.event === 'sso_authorize' && e.actor === 'sso.person'));
    assert.ok(b.audit().some((e) => e.event === 'sso_token' && e.actor === 'sso.person'));
  });

  it('one IP cannot ask for more than 60 new addresses an hour, and another IP is not affected', async () => {
    const ip = { 'X-Forwarded-For': '198.51.100.7' };
    let sentCount = 0;
    for (let i = 0; i < 61; i += 1) {
      const email = `sprayed${i}@lrparis.com`;
      const r = await requestCode(b, email, ip);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { message: SENT }, 'the same answer past the limit');
      await wait(15);
    }
    await settle();
    for (let i = 0; i < 61; i += 1) sentCount += b.codeMails(`sprayed${i}@lrparis.com`).length;
    assert.equal(sentCount, 60);
    assert.equal(b.codeMails('sprayed60@lrparis.com').length, 0, 'the 61st address got no email');
    assert.ok(b.audit().some((e) => e.event === 'login_request_throttled' && e.details && e.details.reason === 'new_addresses_per_ip'));

    await requestCode(b, 'elsewhere@lrparis.com', { 'X-Forwarded-For': '198.51.100.8' });
    await settle();
    assert.equal(b.codeMails('elsewhere@lrparis.com').length, 1);
    // Existing accounts are not counted against that budget.
    await b.shiftClock(61 * 1000);
    await requestCode(b, 'marc@lrparis.com', ip);
    await settle();
    assert.ok(b.codeMails('marc@lrparis.com').length >= 3);
  });

  it('nobody is ever emailed except the person who asked for a code, and no other service is called', async () => {
    const calls = b.calls();
    assert.deepEqual(b.blocked(), [], 'no outgoing call to anything but Mailgun (Teams and Graph included)');
    const mails = b.mails();
    assert.ok(mails.length > 0);
    for (const m of mails) {
      if (m.to === ALERT_EMAIL) continue; // the security alerts that predate self-signup
      assert.match(m.subject, /^\d{6} — Your Launchpad sign-in code$/, `${m.to}: ${m.subject}`);
      assert.ok(b.asked.has(m.to), `${m.to} was mailed a code nobody asked for`);
    }
    // No self-signup address ever got an admin alert about itself.
    const alertText = mails.filter((m) => m.to === ALERT_EMAIL).map((m) => m.subject).join('\n');
    for (const who of ['arnaud.messager', 'wrong.code', 'five.wrong', 'racer', 'invited', 'sso.person']) {
      assert.ok(!alertText.includes(who), `${who} appears in an admin alert`);
    }
    assert.ok(calls.length >= mails.length);
  });
});

// ===========================================================================
// 2. SELF_SIGNUP_DOMAINS set
// ===========================================================================
describe('self-signup, SELF_SIGNUP_DOMAINS set', () => {
  let b;
  before(async () => { b = await boot('self-signup-domains', { SELF_SIGNUP_DOMAINS: ' @Studio.Example.org , lrparis.fr,bad domain', SSO_CLIENTS }); });
  after(() => b && b.stop());

  it('says who gets an account, and which entry it left out', () => {
    assert.match(b.bootLog(), /\[self-signup\] Anyone with an @studio\.example\.org or @lrparis\.fr email gets an account at their first sign in/);
    assert.match(b.bootLog(), /\[self-signup\] SELF_SIGNUP_DOMAINS: "bad domain" is not a domain and is left out\./);
  });

  it('listed domains sign up, and the default no longer applies', async () => {
    const mailsBefore = b.mails().length;
    await requestCode(b, 'Lea@Studio.Example.org');
    await requestCode(b, 'lrparis.person@lrparis.com'); // not listed: nothing
    await settle();
    assert.equal(b.codeMails('lea@studio.example.org').length, 1);
    assert.equal(b.codeMails('lrparis.person@lrparis.com').length, 0);
    assert.equal((await verify(b, 'lea@studio.example.org', b.lastCode('lea@studio.example.org'))).status, 200);
    assert.equal(b.userByEmail('lea@studio.example.org').created_by, 'self-signup');
    assert.equal(b.userByEmail('lrparis.person@lrparis.com'), undefined);
    assert.equal(b.mails().slice(mailsBefore).filter((m) => m.to === 'lea@studio.example.org').length, 1);
  });

  it('two people with the same name before the @ get two accounts, in parallel', async () => {
    const a = 'sam@studio.example.org';
    const c = 'sam@lrparis.fr';
    await Promise.all([requestCode(b, a), requestCode(b, c)]);
    await settle();
    const [ra, rc] = await Promise.all([verify(b, a, b.lastCode(a)), verify(b, c, b.lastCode(c))]);
    assert.equal(ra.status, 200);
    assert.equal(rc.status, 200);
    assert.deepEqual([ra.json.user.username, rc.json.user.username].sort(), ['sam', 'sam2']);
    assert.notEqual(ra.json.user.id, rc.json.user.id);
  });

  it('a name already taken, in any case, gets a number', async () => {
    b.sql("INSERT INTO users (username, email, name, role) VALUES ('Kim', 'k@example.com', 'Kim', 'user')");
    await requestCode(b, 'kim@studio.example.org');
    await settle();
    const v = await verify(b, 'kim@studio.example.org', b.lastCode('kim@studio.example.org'));
    assert.equal(v.status, 200);
    assert.equal(v.json.user.username, 'kim2');
  });

  it('an app that accepts only lrparis.com still refuses a self-signed account from another domain', async () => {
    const email = 'outside.signup@studio.example.org';
    await requestCode(b, email);
    await settle();
    const v = await verify(b, email, b.lastCode(email));
    assert.equal(v.status, 200);
    const res = await fetch(`${b.base}/api/auth/sso/authorize?client_id=parrot&redirect_uri=${encodeURIComponent(PARROT_CB)}&state=s`, {
      redirect: 'manual', headers: { Cookie: v.cookie.pair },
    });
    assert.equal(res.status, 403);
    assert.ok(!res.headers.get('location'));
    assert.match(await res.text(), /only accepts @lrparis\.com accounts/);
  });
});

// ===========================================================================
// 3. SELF_SIGNUP_DOMAINS empty: off
// ===========================================================================
describe('self-signup, switched off', () => {
  let b;
  before(async () => { b = await boot('self-signup-off', { SELF_SIGNUP_DOMAINS: '' }); });
  after(() => b && b.stop());

  it('says it is off at boot', () => {
    assert.match(b.bootLog(), /\[self-signup\] Off: SELF_SIGNUP_DOMAINS is empty/);
  });

  it('an LR Paris address with no account gets the old answer and nothing else', async () => {
    const r = await requestCode(b, 'off.person@lrparis.com');
    assert.deepEqual(r.json, { message: SENT });
    await settle();
    assert.equal(b.codeMails('off.person@lrparis.com').length, 0);
    assert.equal(b.pending().length, 0);
    assert.equal((await verify(b, 'off.person@lrparis.com', '123456')).status, 401);
    assert.equal(b.userByEmail('off.person@lrparis.com'), undefined);
  });

  it('existing accounts still sign in', async () => {
    await requestCode(b, 'marc@lrparis.com');
    await settle();
    assert.equal(b.codeMails('marc@lrparis.com').length, 1);
  });
});

// ===========================================================================
// 4. The rules and the database, in process
// ===========================================================================
describe('self-signup rules and users.js, in process', () => {
  let box;
  let users;
  let selfSignup;
  let raw;
  const savedEnv = {};

  before(() => {
    for (const k of ['SESSION_SECRET', 'OTP_PEPPER', 'SELF_SIGNUP_DOMAINS']) savedEnv[k] = process.env[k];
    process.env.SESSION_SECRET = SESSION_SECRET;
    delete process.env.OTP_PEPPER;
    delete process.env.SELF_SIGNUP_DOMAINS;
    box = sandbox.create({ label: 'self-signup-unit' });
    const Database = require(path.join(box.backend, 'node_modules', 'better-sqlite3'));
    users = box.require('users');
    users.initUsersDb();
    selfSignup = box.require('self-signup');
    raw = new Database(box.usersDbPath);
  });
  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { raw.close(); } catch { /* gone */ }
    box.destroy();
  });

  it('knows which addresses qualify', () => {
    for (const [given, want] of [
      ['a.b@lrparis.com', 'a.b@lrparis.com'],
      ['  A.B@LRParis.com ', 'a.b@lrparis.com'],
      ["d'angelo@lrparis.com", "d'angelo@lrparis.com"],
      ['x-y_z9@lrparis.com', 'x-y_z9@lrparis.com'],
    ]) assert.equal(selfSignup.signupEmail(given), want, given);

    for (const given of [
      'arnaud.messager', 'a@b.c', 'a@gmail.com', 'a@lrparis.com.evil.com', 'a@evil-lrparis.com', 'a@sub.lrparis.com',
      'a@lrparis.co', 'a+b@lrparis.com', 'a..b@lrparis.com', '.a@lrparis.com', 'a.@lrparis.com', '"a b"@lrparis.com',
      'a b@lrparis.com', 'a@lrparis.com@x.com', 'a\n@lrparis.com', 'a@lrpаris.com', 'а@lrparis.com', '@lrparis.com', 'lrparis.com',
      `${'x'.repeat(65)}@lrparis.com`, `${'x'.repeat(250)}@lrparis.com`, '', '   ', null, undefined, 5, ['a@lrparis.com'], { toString: () => 'a@lrparis.com' },
    ]) assert.equal(selfSignup.signupEmail(given), null, JSON.stringify(given));
  });

  it('reads SELF_SIGNUP_DOMAINS: unset is lrparis.com, empty is off, typos are left out', () => {
    assert.deepEqual(selfSignup.parseDomains(undefined), { domains: ['lrparis.com'], ignored: [] });
    assert.deepEqual(selfSignup.parseDomains(''), { domains: [], ignored: [] });
    assert.deepEqual(selfSignup.parseDomains(' @LRParis.com , Studio.example.org ,lrparis.com, x y,lrparis,com ,'),
      { domains: ['lrparis.com', 'studio.example.org'], ignored: ['x y', 'lrparis', 'com'] });

    process.env.SELF_SIGNUP_DOMAINS = 'studio.example.org';
    assert.deepEqual(selfSignup.selfSignupDomains(), ['studio.example.org']);
    assert.equal(selfSignup.signupEmail('a@lrparis.com'), null);
    assert.equal(selfSignup.signupEmail('a@studio.example.org'), 'a@studio.example.org');
    process.env.SELF_SIGNUP_DOMAINS = '';
    assert.deepEqual(selfSignup.selfSignupDomains(), []);
    assert.equal(selfSignup.signupEmail('a@lrparis.com'), null);
    delete process.env.SELF_SIGNUP_DOMAINS;
    assert.deepEqual(selfSignup.selfSignupDomains(), ['lrparis.com']);
  });

  it('names the account from the address', () => {
    assert.equal(selfSignup.usernameBase('arnaud.messager@lrparis.com'), 'arnaud.messager');
    assert.equal(selfSignup.displayName('arnaud.messager@lrparis.com'), 'Arnaud Messager');
    assert.equal(selfSignup.usernameBase("d'angelo@lrparis.com"), 'dangelo');
    assert.equal(selfSignup.displayName("d'angelo@lrparis.com"), 'D Angelo');
    assert.equal(selfSignup.displayName('jean-luc_picard@lrparis.com'), 'Jean Luc Picard');
    assert.equal(selfSignup.displayName('marc@lrparis.com'), 'Marc');
    assert.equal(selfSignup.usernameBase(`${'x'.repeat(60)}@lrparis.com`).length, 40);
  });

  it('keeps the per-IP count for an hour, per IP', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < selfSignup.NEW_ADDRESS_MAX; i += 1) assert.equal(selfSignup.allowNewAddressCode('10.0.0.1', t0 + i), true);
    assert.equal(selfSignup.allowNewAddressCode('10.0.0.1', t0 + 100), false);
    assert.equal(selfSignup.allowNewAddressCode('10.0.0.2', t0 + 100), true);
    assert.equal(selfSignup.allowNewAddressCode('10.0.0.1', t0 + 60 * 60 * 1000 + 1), true);
  });

  it('stores only the hash of the code, and spends it once', () => {
    const email = 'unit.hash@lrparis.com';
    const code = users.issueSignupCode(email);
    assert.match(code, /^\d{6}$/);
    const row = raw.prepare('SELECT * FROM pending_signups WHERE email = ?').get(email);
    assert.equal(row.code, otpHash(code));
    assert.equal(row.attempts, 0);

    assert.equal(users.verifySignupCode(email, wrongCodeFor(code)).reason, 'invalid_otp');
    const made = users.verifySignupCode(email, code);
    assert.equal(made.created, true);
    assert.equal(made.user.role, 'user');
    assert.equal(made.user.created_by, 'self-signup');
    assert.equal(made.user.can_create_shops, 0);
    assert.equal(users.verifySignupCode(email, code).reason, 'no_pending_code', 'a code is good once');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email).n, 1);
  });

  it('numbers a username somebody has, in any letter case', () => {
    raw.prepare("INSERT INTO users (username, email, name, role) VALUES ('Pat', 'pat1@example.com', 'Pat', 'user')").run();
    raw.prepare("INSERT INTO users (username, email, name, role) VALUES ('PAT2', 'pat2@example.com', 'Pat', 'user')").run();
    const code = users.issueSignupCode('pat@lrparis.com');
    const made = users.verifySignupCode('pat@lrparis.com', code);
    assert.equal(made.user.username, 'pat3');
  });

  it('signs in as the account that appeared meanwhile, and makes no second one', () => {
    const email = 'meanwhile@lrparis.com';
    const code = users.issueSignupCode(email);
    users.createUser({ username: 'meanwhile-admin-made', email, name: 'Made By Admin', role: 'admin', created_by: 'admin' });
    const made = users.verifySignupCode(email, code);
    assert.equal(made.created, false);
    assert.equal(made.user.username, 'meanwhile-admin-made');
    assert.equal(made.user.role, 'admin');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = ?').get(email).n, 1);
  });

  it('finds the account by its email alone: a code for an address never opens an account that merely has that text as its username', () => {
    raw.prepare("INSERT INTO users (username, email, name, role) VALUES ('trick@lrparis.com', 'other.mailbox@example.com', 'Other', 'user')").run();
    const code = users.issueSignupCode('trick@lrparis.com');
    const made = users.verifySignupCode('trick@lrparis.com', code);
    assert.equal(made.created, true);
    assert.equal(made.user.email, 'trick@lrparis.com');
    assert.notEqual(made.user.username, 'trick@lrparis.com');
  });

  it('cleans up: a pending code nobody used is gone once its window is over', () => {
    const now = Date.now();
    const add = (email, createdAt) => raw.prepare(
      'INSERT INTO pending_signups (email, code, expires_at, attempts, created_at, window_start, requests) VALUES (?, ?, ?, 0, ?, ?, 1)',
    ).run(email, otpHash('111111'), createdAt + 10 * 60 * 1000, createdAt, createdAt);
    add('old@lrparis.com', now - 16 * 60 * 1000);
    add('older@lrparis.com', now - 3 * 60 * 60 * 1000);
    add('recent@lrparis.com', now - 5 * 60 * 1000);
    add('fresh@lrparis.com', now);
    users.cleanupExpiredOTPs();
    const left = raw.prepare("SELECT email FROM pending_signups WHERE email IN ('old@lrparis.com','older@lrparis.com','recent@lrparis.com','fresh@lrparis.com') ORDER BY email").all().map((r) => r.email);
    assert.deepEqual(left, ['fresh@lrparis.com', 'recent@lrparis.com']);
  });
});

// ===========================================================================
// The review's fixes. Shared by sections 5 to 11.
// ===========================================================================
const TWO_CLIENTS = JSON.stringify({
  parrot: { name: 'LR Parrot', secret: PARROT_SECRET, redirectUris: [PARROT_CB] },
  other: { name: 'Other app', secret: 'o'.repeat(40), redirectUris: ['https://other.example.org/cb'], allowedDomains: ['studio.example.org'] },
});

// Signs a request as the dev tool's server does (authz.js mcpActor): HMAC over method, target, body, actor, time.
async function mcpPost(b, route, body) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now() + b.clockOffsetMs);
  const sig = crypto.createHmac('sha256', MCP_SHARED_SECRET).update(`POST\n${route}\n${raw}\n0\n${ts}`).digest('hex');
  const res = await fetch(`${b.base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Launchpad-Actor': '0', 'X-Launchpad-Ts': ts, 'X-Launchpad-Sig': sig },
    body: raw,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

// The app's server sending the list of people who work here (what LR Parrot does after a directory sync).
const sendMembers = (b, body) => post(b, '/api/auth/sso/members', body);

// Signs in as a person who already has an account and makes the admin's calls with its CSRF token.
async function signInAs(b, email) {
  await b.shiftClock(61 * 1000);
  await requestCode(b, email);
  await settle();
  const v = await verify(b, email, b.lastCode(email));
  assert.equal(v.status, 200, `${email} signs in`);
  const csrf = await (await fetch(`${b.base}/api/auth/csrf-token`, { headers: { Cookie: v.cookie.pair } })).json();
  const call = async (method, route, body) => {
    const res = await fetch(`${b.base}${route}`, {
      method,
      headers: { Cookie: v.cookie.pair, 'x-csrf-token': csrf.csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  return { cookie: v.cookie, call, user: v.json.user };
}

// A person who signs up with the code mailed to them.
async function signUp(b, email, headers) {
  await requestCode(b, email, headers);
  await settle();
  return verify(b, email, b.lastCode(email.trim().toLowerCase()), headers);
}

const alertsTo = (b, pattern) => b.mails().filter((m) => m.to === ALERT_EMAIL && pattern.test(m.subject || ''));

// ===========================================================================
// 5. Only the people who work here (a list from LR Parrot's copy of the directory)
// ===========================================================================
describe('self-signup, only the people LR Paris has (list from LR Parrot)', () => {
  let b;
  before(async () => { b = await boot('self-signup-members', { SSO_CLIENTS: TWO_CLIENTS }); });
  after(() => b && b.stop());

  it('before any list is sent, nothing changes: an LR Paris address nobody checked still gets a code', async () => {
    await requestCode(b, 'invented.first@lrparis.com');
    await settle();
    assert.equal(b.codeMails('invented.first@lrparis.com').length, 1);
    assert.equal(b.get('SELECT COUNT(*) AS n FROM signup_members').n, 0);
  });

  it('the list needs the app\'s secret, a real list, and at least one address in the app\'s domains', async () => {
    const good = { client_id: 'parrot', client_secret: PARROT_SECRET, emails: ['someone@lrparis.com'] };
    assert.deepEqual((await sendMembers(b, { ...good, client_secret: 'wrong'.repeat(10) })).json, { error: 'invalid_client' });
    assert.equal((await sendMembers(b, { ...good, client_secret: undefined })).status, 401);
    assert.equal((await sendMembers(b, { ...good, client_id: 'nobody' })).status, 401);
    assert.equal((await sendMembers(b, { ...good, emails: 'someone@lrparis.com' })).status, 400);
    assert.equal((await sendMembers(b, { ...good, emails: undefined })).status, 400);
    // An empty list would mean "nobody works here" and must never open sign-up to everyone: refused.
    assert.equal((await sendMembers(b, { ...good, emails: [] })).status, 400);
    assert.equal((await sendMembers(b, { ...good, emails: ['x@gmail.com', 'not an address', 5, null] })).status, 400);
    assert.equal(b.get('SELECT COUNT(*) AS n FROM signup_members').n, 0, 'nothing was stored by any of these');
    assert.ok(b.audit().some((e) => e.event === 'sso_denied' && e.details.step === 'members' && e.details.reason === 'bad_secret'));
  });

  it('a good list is kept in lower case, only for the app\'s own domains, and nobody is emailed', async () => {
    const mailsBefore = b.mails().length;
    const r = await sendMembers(b, {
      client_id: 'parrot', client_secret: PARROT_SECRET,
      emails: ['Arnaud.Messager@lrparis.com', ' marie.dupont@lrparis.com ', 'new.hire@lrparis.com', 'x@gmail.com', 'bad', 5, 'arnaud.messager@lrparis.com'],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { accepted: 3 });
    assert.deepEqual(b.all("SELECT email, source FROM signup_members ORDER BY email"), [
      { email: 'arnaud.messager@lrparis.com', source: 'parrot' },
      { email: 'marie.dupont@lrparis.com', source: 'parrot' },
      { email: 'new.hire@lrparis.com', source: 'parrot' },
    ]);
    assert.ok(b.audit().some((e) => e.event === 'sso_members' && e.details.client === 'parrot' && e.details.accepted === 3));
    await settle();
    assert.equal(b.mails().length, mailsBefore, 'sending the list emailed nobody');
    assert.deepEqual(b.blocked(), []);
  });

  it('a listed address signs up as before; one that is not listed gets the same answer, no email, no code and no account', async () => {
    const ok = await signUp(b, 'Arnaud.Messager@lrparis.com');
    assert.equal(ok.status, 200);
    assert.equal(b.userByEmail('arnaud.messager@lrparis.com').created_by, 'self-signup');

    const mailsBefore = b.mails().length;
    const asked = await requestCode(b, 'invented.second@lrparis.com');
    assert.deepEqual(asked.json, { message: SENT }, 'the same answer as for an address that works');
    await settle();
    assert.equal(b.mails().length, mailsBefore, 'no email went to an address nobody has');
    assert.equal(b.pending().filter((p) => p.email === 'invented.second@lrparis.com').length, 0);
    const v = await verify(b, 'invented.second@lrparis.com', '123456');
    assert.equal(v.status, 401);
    assert.deepEqual(v.json, { error: 'Invalid or expired code' });
    assert.equal(b.userByEmail('invented.second@lrparis.com'), undefined);
    assert.ok(b.audit().some((e) => e.event === 'login_request_failed' && e.details.email === 'invented.second@lrparis.com' && e.details.reason === 'signup_not_a_member'));
    assert.ok(b.audit().some((e) => e.event === 'login_failed' && e.details.email === 'invented.second@lrparis.com' && e.details.reason === 'signup_not_a_member'));
  });

  it('even a code that was mailed before the list came is no good for an address the list does not have', async () => {
    // invented.first got a real code in the first test, before any list existed.
    const v = await verify(b, 'invented.first@lrparis.com', b.lastCode('invented.first@lrparis.com'));
    assert.equal(v.status, 401);
    assert.equal(b.userByEmail('invented.first@lrparis.com'), undefined);
  });

  it('accounts that exist sign in as before, listed or not', async () => {
    await requestCode(b, 'marc@lrparis.com');
    await settle();
    assert.equal(b.codeMails('marc@lrparis.com').length, 1);
    assert.equal((await verify(b, 'marc@lrparis.com', b.lastCode('marc@lrparis.com'))).status, 200);
  });

  it('the next list replaces the last one whole, so someone who left stops being able to sign up', async () => {
    const r = await sendMembers(b, { client_id: 'parrot', client_secret: PARROT_SECRET, emails: ['marie.dupont@lrparis.com'] });
    assert.deepEqual(r.json, { accepted: 1 });
    const mailsBefore = b.mails().length;
    await requestCode(b, 'new.hire@lrparis.com');
    await settle();
    assert.equal(b.mails().length, mailsBefore, 'new.hire is not listed any more');
    assert.equal((await signUp(b, 'marie.dupont@lrparis.com')).status, 200);
  });

  it('another app\'s list is its own: it is kept to that app\'s domains and does not touch the first app\'s', async () => {
    const r = await sendMembers(b, { client_id: 'other', client_secret: 'o'.repeat(40), emails: ['lea@studio.example.org', 'ignored@lrparis.com'] });
    assert.deepEqual(r.json, { accepted: 1 });
    assert.deepEqual(b.all("SELECT email, source FROM signup_members WHERE source = 'other'"), [{ email: 'lea@studio.example.org', source: 'other' }]);
    assert.equal(b.get("SELECT COUNT(*) AS n FROM signup_members WHERE source = 'parrot'").n, 1);
  });

  it('sending lists never emailed anybody but the people who asked for a code, and called nothing else', async () => {
    assert.deepEqual(b.blocked(), []);
    for (const m of b.mails()) {
      if (m.to === ALERT_EMAIL) continue;
      assert.match(m.subject, /^\d{6} — Your Launchpad sign-in code$/);
      assert.ok(b.asked.has(m.to), `${m.to} was mailed a code nobody asked for`);
    }
  });
});

// ===========================================================================
// 6. Deleting an account blocks the address; admins can block one too
// ===========================================================================
describe('self-signup, blocked addresses', () => {
  let b;
  let admin;
  before(async () => {
    b = await boot('self-signup-blocked', { SSO_CLIENTS });
    admin = await signInAs(b, 'g.lupo@lrparis.com');
  });
  after(() => b && b.stop());

  it('deleting a self-made account blocks its address: no code, no account, the same answer', async () => {
    const made = await signUp(b, 'leaver@lrparis.com');
    assert.equal(made.status, 200);
    const id = b.userByEmail('leaver@lrparis.com').id;

    const gone = await admin.call('DELETE', `/api/users/${id}`);
    assert.equal(gone.status, 200);
    assert.equal(b.userByEmail('leaver@lrparis.com'), undefined);
    const tomb = b.get('SELECT * FROM blocked_emails WHERE email = ?', 'leaver@lrparis.com');
    assert.equal(tomb.reason, 'account deleted');
    assert.equal(tomb.blocked_by, 'admin');

    const mailsBefore = b.mails().length;
    await b.shiftClock(2 * 60 * 1000);
    const again = await requestCode(b, 'leaver@lrparis.com');
    assert.deepEqual(again.json, { message: SENT });
    await settle();
    assert.equal(b.mails().length, mailsBefore, 'no code went out');
    assert.equal(b.pending().filter((p) => p.email === 'leaver@lrparis.com').length, 0);
    assert.equal((await verify(b, 'leaver@lrparis.com', '123456')).status, 401);
    assert.equal(b.userByEmail('leaver@lrparis.com'), undefined, 'typing the address again does not bring the account back');
    assert.ok(b.audit().some((e) => e.event === 'login_request_failed' && e.details.email === 'leaver@lrparis.com' && e.details.reason === 'signup_blocked'));
  });

  it('the dev tool\'s first sign in is held to the same list', async () => {
    const mailsBefore = b.mails().length;
    const start = await mcpPost(b, '/api/mcp/enroll', { email: 'leaver@lrparis.com' });
    assert.equal(start.status, 200);
    assert.equal(start.json.sent, true, 'the same answer as for an address that works');
    await settle();
    assert.equal(b.mails().length, mailsBefore, 'no code went out');
    assert.equal(b.platformGet('SELECT COUNT(*) AS n FROM pending_enrollments WHERE email = ?', 'leaver@lrparis.com').n, 0);
    const verified = await mcpPost(b, '/api/mcp/enroll/verify', { email: 'leaver@lrparis.com', code: '123456' });
    assert.equal(verified.status, 401);
    assert.equal(b.userByEmail('leaver@lrparis.com'), undefined);
  });

  it('an admin can see what is blocked, block a shared mailbox and let it go again', async () => {
    const list = await admin.call('GET', '/api/users/blocked');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.blocked.map((x) => x.email), ['leaver@lrparis.com']);

    assert.equal((await admin.call('POST', '/api/users/blocked', { email: 'not an address' })).status, 400);
    const added = await admin.call('POST', '/api/users/blocked', { email: ' Info@LRParis.com ', reason: 'shared mailbox' });
    assert.equal(added.status, 201);
    assert.ok(added.json.blocked.some((x) => x.email === 'info@lrparis.com' && x.reason === 'shared mailbox'));
    assert.ok(b.audit().some((e) => e.event === 'signup_blocked' && e.details.email === 'info@lrparis.com'));

    const mailsBefore = b.mails().length;
    await requestCode(b, 'info@lrparis.com');
    await settle();
    assert.equal(b.mails().length, mailsBefore, 'a shared mailbox gets no code');

    assert.equal((await admin.call('DELETE', '/api/users/blocked/info%40lrparis.com')).status, 200);
    assert.equal((await admin.call('DELETE', '/api/users/blocked/info%40lrparis.com')).status, 404);
    assert.equal((await signUp(b, 'info@lrparis.com')).status, 200, 'unblocked, it can sign up');
  });

  it('only a super admin may read or change the list', async () => {
    const plain = await signInAs(b, 'marc@lrparis.com');
    assert.equal((await plain.call('GET', '/api/users/blocked')).status, 403);
    assert.equal((await plain.call('POST', '/api/users/blocked', { email: 'x@lrparis.com' })).status, 403);
    assert.equal((await plain.call('DELETE', '/api/users/blocked/leaver%40lrparis.com')).status, 403);
  });

  it('an admin making the account by hand is the way back for a blocked address', async () => {
    const made = await admin.call('POST', '/api/users', { username: 'leaver', email: 'leaver@lrparis.com', name: 'Le Aver', role: 'user' });
    assert.equal(made.status, 201);
    assert.equal(b.get('SELECT COUNT(*) AS n FROM blocked_emails WHERE email = ?', 'leaver@lrparis.com').n, 0);
    await b.shiftClock(2 * 60 * 1000);
    await requestCode(b, 'leaver@lrparis.com');
    await settle();
    assert.equal((await verify(b, 'leaver@lrparis.com', b.lastCode('leaver@lrparis.com'))).status, 200);
  });
});

// ===========================================================================
// 7. A budget for wrong first-sign-in codes, across every address
// ===========================================================================
describe('self-signup, a global budget for wrong codes', () => {
  let b;
  before(async () => { b = await boot('self-signup-budget', { SSO_CLIENTS }); });
  after(() => b && b.stop());

  it('past the budget the admin gets one email and first sign ins pause, however many IPs and addresses are used', async () => {
    const max = 60;
    for (let i = 0; i < max; i += 1) {
      const ip = { 'X-Forwarded-For': `203.0.113.${(i % 250) + 1}` };
      const email = `guess${i}@lrparis.com`;
      await requestCode(b, email, ip);
      const r = await verify(b, email, wrongCodeFor(b.lastCode(email) || '000000'), ip);
      assert.equal(r.status, 401);
      if (i < max - 1) assert.equal(alertsTo(b, /guessing first sign-in codes/).length, 0, `no alert yet after ${i + 1}`);
    }
    await settle();
    assert.equal(alertsTo(b, /guessing first sign-in codes/).length, 1, 'exactly one email to the admin');
    assert.equal(b.users().filter((u) => /^guess\d+@/.test(u.email)).length, 0);

    // One more wrong code later does not send a second email in the same hour.
    const email = 'guess-more@lrparis.com';
    await requestCode(b, email, { 'X-Forwarded-For': '203.0.113.250' });
    await verify(b, email, '000000', { 'X-Forwarded-For': '203.0.113.250' });
    await settle();
    assert.equal(alertsTo(b, /guessing first sign-in codes/).length, 1);
  });

  it('while paused, even the right code makes no account (and the answer is the usual one)', async () => {
    const email = 'late.hire@lrparis.com';
    await requestCode(b, email, { 'X-Forwarded-For': '203.0.113.9' });
    await settle();
    const v = await verify(b, email, b.lastCode(email), { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(v.status, 401);
    assert.deepEqual(v.json, { error: 'Invalid or expired code' });
    assert.equal(b.userByEmail(email), undefined);
    assert.ok(b.audit().some((e) => e.event === 'login_failed' && e.details.email === email && e.details.reason === 'signup_paused'));
  });

  it('accounts that exist still sign in while it is paused', async () => {
    await requestCode(b, 'marc@lrparis.com');
    await settle();
    assert.equal((await verify(b, 'marc@lrparis.com', b.lastCode('marc@lrparis.com'))).status, 200);
  });

  it('an hour later first sign ins work again, and the alert can come again if it starts again', async () => {
    await b.shiftClock(61 * 60 * 1000);
    const email = 'late.hire@lrparis.com';
    await requestCode(b, email, { 'X-Forwarded-For': '203.0.113.9' });
    await settle();
    const v = await verify(b, email, b.lastCode(email), { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(v.status, 200);
    assert.equal(b.userByEmail(email).created_by, 'self-signup');
  });

  it('a few typos by people are far from the budget', async () => {
    const email = 'typo.person@lrparis.com';
    await requestCode(b, email, { 'X-Forwarded-For': '203.0.113.77' });
    await settle();
    const code = b.lastCode(email);
    await verify(b, email, wrongCodeFor(code), { 'X-Forwarded-For': '203.0.113.77' });
    assert.equal((await verify(b, email, code, { 'X-Forwarded-For': '203.0.113.77' })).status, 200);
  });
});

// ===========================================================================
// 8. An identifier spelled with a look-alike letter reaches the account it spells
// ===========================================================================
describe('self-signup, a Unicode identifier for an existing account', () => {
  let b;
  const KELVIN = '\u212Aevin@lrparis.com'; // the first letter is U+212A, the Kelvin sign: "K" to the eye
  before(async () => {
    b = await boot('self-signup-unicode', { SSO_CLIENTS });
    b.sql("INSERT INTO users (username, email, name, role) VALUES ('kevin', 'kevin@lrparis.com', 'Kevin Existing', 'user')");
  });
  after(() => b && b.stop());

  it('JavaScript folds that letter to an ASCII one and SQLite does not, which is how it used to get through', () => {
    assert.equal(KELVIN.toLowerCase(), 'kevin@lrparis.com');
    assert.equal(b.get('SELECT 1 AS x FROM users WHERE lower(email) = lower(?)', KELVIN), undefined);
  });

  it('asking for a code is the ordinary request for that account: its code, its limits, no pending signup', async () => {
    const r = await post(b, '/api/auth/login-request', { identifier: KELVIN });
    assert.deepEqual(r.json, { message: SENT });
    await settle();
    assert.equal(b.codeMails('kevin@lrparis.com').length, 1);
    assert.equal(b.pending().filter((p) => p.email === 'kevin@lrparis.com').length, 0, 'no first-sign-in code was made for an account that exists');
    assert.equal(b.get('SELECT COUNT(*) AS n FROM otp_codes').n, 1, 'one code, in the account\'s own table');
    assert.ok(b.audit().some((e) => e.event === 'login_request' && e.details.username === 'kevin' && !e.details.self_signup));
  });

  it('a wrong code is an ordinary failed sign in, with its alert, and the right one signs in to the one account', async () => {
    const code = b.lastCode('kevin@lrparis.com');
    const bad = await post(b, '/api/auth/login-verify', { identifier: KELVIN, code: wrongCodeFor(code) });
    assert.equal(bad.status, 401);
    assert.ok(b.audit().some((e) => e.event === 'login_failed' && e.details.username === 'kevin' && e.details.reason === 'invalid_otp'));
    await settle();
    assert.ok(alertsTo(b, /failed login attempt/).length >= 1, 'the failed-login alert fires, as for any account');

    const good = await post(b, '/api/auth/login-verify', { identifier: KELVIN, code });
    assert.equal(good.status, 200);
    assert.equal(good.json.user.username, 'kevin');
    assert.equal(b.users().filter((u) => u.email.toLowerCase() === 'kevin@lrparis.com').length, 1, 'no second account');
    assert.equal(b.users().filter((u) => u.created_by === 'self-signup').length, 0);
  });
});

// ===========================================================================
// 9. A code for an existing account has its own five tries, and one budget per account
// ===========================================================================
describe('sign in to an existing account, five tries per code', () => {
  let b;
  before(async () => { b = await boot('self-signup-otp-attempts', { SSO_CLIENTS }); });
  after(() => b && b.stop());

  it('the fifth wrong try burns the code: the right one is refused after that, and a new code works', async () => {
    await requestCode(b, 'marc@lrparis.com');
    await settle();
    const code = b.lastCode('marc@lrparis.com');
    for (let i = 0; i < 5; i += 1) assert.equal((await verify(b, 'marc@lrparis.com', wrongCodeFor(code))).status, 401);
    const row = b.get('SELECT attempts, used FROM otp_codes ORDER BY id DESC LIMIT 1');
    assert.deepEqual({ ...row }, { attempts: 5, used: 1 });
    assert.equal((await verify(b, 'marc@lrparis.com', code)).status, 401, 'the right code is no good any more');

    await b.shiftClock(61 * 1000);
    await requestCode(b, 'marc@lrparis.com');
    await settle();
    assert.equal((await verify(b, 'marc@lrparis.com', b.lastCode('marc@lrparis.com'))).status, 200);
  });

  it('four wrong tries and then the right code still signs in', async () => {
    await b.shiftClock(61 * 1000);
    await requestCode(b, 'm.drevno@lrparis.com');
    await settle();
    const code = b.lastCode('m.drevno@lrparis.com');
    for (let i = 0; i < 4; i += 1) await verify(b, 'm.drevno@lrparis.com', wrongCodeFor(code));
    assert.equal((await verify(b, 'm.drevno@lrparis.com', code)).status, 200);
  });

  it('a username and an email are one account, so they spend one budget, not two', async () => {
    // rachael: username "rachael", email r.loiseau@lrparis.com. The limit is 10 requests and verifies per IP and account.
    await requestCode(b, 'rachael');
    let statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await verify(b, 'rachael', '000000')).status);
    for (let i = 0; i < 4; i += 1) statuses.push((await verify(b, 'r.loiseau@lrparis.com', '000000')).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 401]);
    // That was 10 in all (1 request + 9). Before, each spelling had its own bucket and this would be a 401.
    const tenth = await verify(b, 'r.loiseau@lrparis.com', '000000');
    assert.equal(tenth.status, 429);
    const other = await verify(b, 'rachael', '000000');
    assert.equal(other.status, 429, 'the same account under its other name is stopped too');
    // Another IP is not stopped by it.
    assert.equal((await verify(b, 'rachael', '000000', { 'X-Forwarded-For': '198.51.100.99' })).status, 401);
  });
});

// ===========================================================================
// 10. One switch for every self-enrolment
// ===========================================================================
describe('self-signup, one switch for the sign-in page and the dev tool', () => {
  const saved = {};
  let selfSignup;
  let box;
  before(() => {
    for (const k of ['SELF_SIGNUP_DOMAINS', 'MCP_ENROLL_DOMAINS']) saved[k] = process.env[k];
    box = sandbox.create({ label: 'self-signup-switch' });
    selfSignup = box.require('self-signup');
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    box.destroy();
  });
  const withEnv = (self, mcp) => {
    if (self === undefined) delete process.env.SELF_SIGNUP_DOMAINS; else process.env.SELF_SIGNUP_DOMAINS = self;
    if (mcp === undefined) delete process.env.MCP_ENROLL_DOMAINS; else process.env.MCP_ENROLL_DOMAINS = mcp;
    return selfSignup.selfSignupDomains();
  };

  it('MCP_ENROLL_DOMAINS, the older name, still sets the list when SELF_SIGNUP_DOMAINS is not set', () => {
    assert.deepEqual(withEnv(undefined, undefined), ['lrparis.com']);
    assert.deepEqual(withEnv(undefined, 'Studio.Example.org, lrparis.com'), ['studio.example.org', 'lrparis.com']);
  });

  it('SELF_SIGNUP_DOMAINS wins, and an empty one turns both off', () => {
    assert.deepEqual(withEnv('lrparis.fr', 'studio.example.org'), ['lrparis.fr']);
    assert.deepEqual(withEnv('', 'lrparis.com'), []);
    withEnv(undefined, undefined);
  });

  it('with SELF_SIGNUP_DOMAINS empty the dev tool\'s first sign in is off too, and says an admin makes accounts', async () => {
    const b = await boot('self-signup-switch-off', { SELF_SIGNUP_DOMAINS: '' });
    try {
      const r = await mcpPost(b, '/api/mcp/enroll', { email: 'someone.new@lrparis.com' });
      assert.equal(r.status, 403);
      assert.equal(r.json.error.message, 'Accounts here are made by an admin.');
      await settle();
      assert.equal(b.codeMails('someone.new@lrparis.com').length, 0);
      assert.equal(b.platformGet('SELECT COUNT(*) AS n FROM pending_enrollments').n, 0);
    } finally { b.stop(); }
  });

  it('with only MCP_ENROLL_DOMAINS set, the sign-in page follows it', async () => {
    const b = await boot('self-signup-switch-mcp', { MCP_ENROLL_DOMAINS: 'studio.example.org' });
    try {
      await requestCode(b, 'lea@studio.example.org');
      await requestCode(b, 'lrparis.person@lrparis.com');
      await settle();
      assert.equal(b.codeMails('lea@studio.example.org').length, 1);
      assert.equal(b.codeMails('lrparis.person@lrparis.com').length, 0);
    } finally { b.stop(); }
  });

  it('the dev tool names a new account the way the sign-in page does', async () => {
    const b = await boot('self-signup-switch-name');
    try {
      const start = await mcpPost(b, '/api/mcp/enroll', { email: 'jean-luc_picard@lrparis.com' });
      assert.equal(start.status, 200);
      await settle();
      const done = await mcpPost(b, '/api/mcp/enroll/verify', { email: 'jean-luc_picard@lrparis.com', code: b.lastCode('jean-luc_picard@lrparis.com') });
      assert.equal(done.status, 201);
      assert.equal(done.json.user.name, selfSignup.displayName('jean-luc_picard@lrparis.com'));
      assert.equal(done.json.user.name, 'Jean Luc Picard');
    } finally { b.stop(); }
  });
});

// ===========================================================================
// 11. A self-made account does not see the shop list
// ===========================================================================
describe('self-made accounts and the shop list', () => {
  let b;
  before(async () => { b = await boot('self-signup-shops', { SSO_CLIENTS }); });
  after(() => b && b.stop());
  const shopSlugs = async (cookie) => {
    const res = await fetch(`${b.base}/api/shops`, { headers: { Cookie: cookie.pair } });
    assert.equal(res.status, 200);
    return (await res.json()).shops.map((s) => s.slug).sort();
  };

  it('an account made at first sign in sees no shop it has no role on', async () => {
    const v = await signUp(b, 'curious.intern@lrparis.com');
    assert.equal(v.status, 200);
    assert.deepEqual(await shopSlugs(v.cookie), []);
  });

  it('an account an admin made, and the admin, still see the list as before', async () => {
    const marc = await signInAs(b, 'marc@lrparis.com');
    assert.deepEqual(await shopSlugs(marc.cookie), ['michael-kors', 'serhant']);
    const admin = await signInAs(b, 'g.lupo@lrparis.com');
    assert.deepEqual(await shopSlugs(admin.cookie), ['michael-kors', 'serhant']);
  });

  it('a self-made account that an admin has promoted sees the list again, and one with a role on a shop sees that shop', async () => {
    const v = await signUp(b, 'promoted.person@lrparis.com');
    const id = b.userByEmail('promoted.person@lrparis.com').id;
    b.sql("INSERT INTO user_shop_permissions (user_id, shop_slug, can_view_orders, can_view_analytics) VALUES (?, 'serhant', 1, 1)", id);
    assert.deepEqual(await shopSlugs(v.cookie), ['serhant']);
    b.sql("UPDATE users SET role = 'admin' WHERE id = ?", id);
    assert.deepEqual(await shopSlugs(v.cookie), ['michael-kors', 'serhant']);
  });
});

// ===========================================================================
// 12. The sign-in page words
// ===========================================================================
describe('the sign-in page', () => {
  it('tells someone who typed an email that a code is on its way, not "if an account exists"', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Login.jsx'), 'utf8');
    assert.match(src, /typed\.includes\('@'\) \? `We sent a 6-digit code to \$\{typed\}\. It can take a minute\.` : data\.message/);
  });
});
