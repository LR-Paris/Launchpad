// ---------------------------------------------------------------------------
// integration.test.js — boot the real backend and walk the whole ADR-001 flow
// over HTTP, exactly the way the MCP server will.
//
// Everything else in test/ exercises a module or a mounted router. This one
// starts `node src/index.js` as a process, against a throwaway copy of the
// databases built from the schema in CONTRACT.md, and then talks to it with
// signed requests. That is the only way to catch the class of bug that killed
// this integration the first time round: a router that loads fine on its own
// but is not mounted, a handler that forgets to await, a route the tool server
// calls that nobody built.
//
//   cd backend && node test/integration.test.js
//
// No docker, no droplet, no network beyond 127.0.0.1. Docker is absent in CI,
// so container state reads as "unknown" and a rebuild is a no-op; that is the
// one part of the flow this test cannot prove.
// ---------------------------------------------------------------------------
const assert = require('assert');
const crypto = require('crypto');

// Sign-in codes are stored as HMAC hashes (users.js hashOTP), so a test cannot
// read a mailed code back. It writes the hash of a known code over the newest one.
const KNOWN_CODE = '424242';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const sandbox = require('./_sandbox');

const SESSION_SECRET = 'integration-test-session-secret-0123456789';
const otpHash = (code) => crypto
  .createHmac('sha256', process.env.OTP_PEPPER || SESSION_SECRET)
  .update(String(code)).digest('hex');
const MCP_SHARED_SECRET = 'integration-test-mcp-shared-secret-0123456789';

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- the signing scheme, written out rather than imported -------------------
// The backend has its own copy in authz.js. If this one is wrong the test
// fails, which is the point: two independent implementations that agree is
// evidence, one shared helper that agrees with itself is not.
function sign(rawBody, actor, ts, method, target) {
  const material = `${String(method).toUpperCase()}\n${target}\n${rawBody}\n${actor}\n${ts}`;
  return crypto.createHmac('sha256', MCP_SHARED_SECRET).update(material).digest('hex');
}

let BASE = '';

async function callMcp(actor, method, routePath, { body, query, signed = true } = {}) {
  const url = new URL(BASE + routePath);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (signed) {
    const ts = String(Date.now());
    headers['X-Launchpad-Actor'] = String(actor);
    headers['X-Launchpad-Ts'] = ts;
    headers['X-Launchpad-Sig'] = sign(rawBody, actor, ts, method, `${url.pathname}${url.search}`);
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : rawBody });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

function startServer(backendDir, port) {
  const child = spawn(process.execPath, [path.join(backendDir, 'src', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      SESSION_SECRET,
      MCP_SHARED_SECRET,
      NODE_ENV: 'test',
      // Never let a test send mail, and never let it reach a real Mailgun.
      MAILGUN_API_KEY: '',
      MAILGUN_DOMAIN: '',
      FRONTEND_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  return { child, log };
}

async function waitForHealth(port, child, log) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the backend exited with code ${child.exitCode} before it answered:\n${log.join('')}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the backend never answered /api/health:\n${log.join('')}`);
}

// A real DATABASE folder, small enough to build in memory, valid enough to
// pass staging's structure checks.
function buildDatabaseZip(AdmZip, products) {
  const zip = new AdmZip();
  zip.addFile('Design/Details/Colors.txt', Buffer.from('#021E42\n#F7F6F3\n'));
  zip.addFile('Design/Details/Fonts.txt', Buffer.from('Helvetica\n'));
  for (const p of products) {
    const base = `ShopCollections/Spring/${p.name}`;
    zip.addFile(`${base}/Details/SKU.txt`, Buffer.from(p.sku));
    zip.addFile(`${base}/Details/Name.txt`, Buffer.from(p.name));
    zip.addFile(`${base}/Details/Cost.txt`, Buffer.from('10'));
    zip.addFile(`${base}/Photos/front.jpg`, Buffer.from('not-really-a-jpeg'));
  }
  return zip.toBuffer();
}

async function main() {
  const box = sandbox.create({ label: 'adr001-integration' });
  const port = 3400 + Math.floor(Math.random() * 400);
  BASE = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
    const AdmZip = require(path.join(__dirname, '..', 'node_modules', 'adm-zip'));

    // ---------------------------------------------------------------------
    // 1. The migration, on a database shaped like the live one
    // ---------------------------------------------------------------------
    // The sandbox seeds the CONTRACT.md schema, which has no role column, so
    // this is the same upgrade the droplet will run.
    {
      const u = new Database(box.usersDbPath);
      // Rachael owns serhant through the legacy booleans alone. After the
      // migration she must be an owner, without anyone touching her row by hand.
      u.prepare(`INSERT INTO user_shop_permissions
        (user_id, shop_slug, can_delete, can_edit_ui, can_edit_items, can_view_orders, can_view_analytics)
        VALUES (7, 'serhant', 1, 1, 1, 1, 1)`).run();
      u.close();
    }

    const migrate = require('child_process').spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'migrate-adr001.js')],
      { env: { ...process.env, LAUNCHPAD_DATA_DIR: box.dataDir }, encoding: 'utf8' },
    );
    eq('migrate-adr001.js exits clean', migrate.status, 0);

    {
      const u = new Database(box.usersDbPath, { readonly: true });
      const row = u.prepare("SELECT role FROM user_shop_permissions WHERE user_id = 7 AND shop_slug = 'serhant'").get();
      u.close();
      eq('the migration backfilled can_delete=1 to owner', row && row.role, 'owner');
    }

    // Running it twice must be a no-op, because somebody always runs it twice.
    const again = require('child_process').spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'migrate-adr001.js')],
      { env: { ...process.env, LAUNCHPAD_DATA_DIR: box.dataDir }, encoding: 'utf8' },
    );
    eq('migrate-adr001.js is safe to run twice', again.status, 0);

    // A shop tree staging can actually work on.
    const serhantDir = path.join(box.shopsDir, 'serhant');
    fs.mkdirSync(path.join(serhantDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(serhantDir, 'lib', 'version.ts'), "export const VERSION = 'STS-4.2.0';\n");
    fs.mkdirSync(path.join(serhantDir, 'DATABASE', 'ShopCollections', 'Spring', 'Tote', 'Details'), { recursive: true });
    fs.writeFileSync(path.join(serhantDir, 'DATABASE', 'ShopCollections', 'Spring', 'Tote', 'Details', 'SKU.txt'), 'TOTE-1');
    fs.mkdirSync(path.join(serhantDir, 'DATABASE', 'Design', 'Details'), { recursive: true });
    fs.writeFileSync(path.join(serhantDir, 'DATABASE', 'Design', 'Details', 'Colors.txt'), '#021E42\n');
    fs.writeFileSync(path.join(serhantDir, 'DATABASE', 'Design', 'Details', 'Fonts.txt'), 'Helvetica\n');

    // ---------------------------------------------------------------------
    // 2. Boot the real server
    // ---------------------------------------------------------------------
    server = startServer(box.backend, port);
    await waitForHealth(port, server.child, server.log);
    ok('the backend boots and answers /api/health', true);
    ok('signed tool access is enabled at boot',
      server.log.join('').includes('[mcp] Signed tool access is enabled'),
      server.log.join(''));

    // ---------------------------------------------------------------------
    // 3. Enroll a new person, as the tool server does: actor 0, signed
    // ---------------------------------------------------------------------
    // Mailgun is not configured in this sandbox, so the code never leaves the
    // process. Read it the way the web login test does: straight out of the
    // database it was written to.
    const platformDbPath = path.join(box.dataDir, 'platform.db');
    const countUsers = (email) => {
      const u = new Database(box.usersDbPath, { readonly: true });
      const row = u.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower(?)').get(email);
      u.close();
      return row.n;
    };
    const pendingCode = (email) => {
      const pdb = new Database(platformDbPath, { readonly: true });
      const row = pdb.prepare('SELECT code FROM pending_enrollments WHERE email = ?').get(email);
      pdb.close();
      return row && row.code;
    };
    const mailedCode = (email) => {
      const u = new Database(box.usersDbPath);
      const row = u.prepare(`SELECT c.id FROM otp_codes c JOIN users usr ON usr.id = c.user_id
        WHERE lower(usr.email) = lower(?) AND c.used = 0 ORDER BY c.id DESC LIMIT 1`).get(email);
      if (row) u.prepare('UPDATE otp_codes SET code = ? WHERE id = ?').run(otpHash(KNOWN_CODE), row.id);
      u.close();
      return row ? KNOWN_CODE : undefined;
    };

    const bad = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'nobody@gmail.com' } });
    eq('an off-domain address cannot enroll', bad.status, 403);
    eq('and it is refused with a code, not a stack trace', bad.json?.error?.code, 'NOT_PERMITTED');
    eq('the domain check ran before anything was written', pendingCode('nobody@gmail.com'), undefined);
    eq('and before any account existed', countUsers('nobody@gmail.com'), 0);

    // The defect this section exists for: submitting an address used to create
    // the users row, so anyone who could reach the login page could write rows
    // into the user admin. It must now create nothing at all.
    const started = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'n.hire@lrparis.com' } });
    eq('submitting an address is accepted', started.status, 200);
    ok('and says only that a code went out', started.json?.sent === true);
    ok('it hands back no user id', started.json?.user === undefined);
    eq('NO account row exists before the code is verified', countUsers('n.hire@lrparis.com'), 0);
    const firstCode = pendingCode('n.hire@lrparis.com');
    ok('the claim on the address is pending, not a user', typeof firstCode === 'string');

    // An address nobody has ever used and a real colleague's address must be
    // indistinguishable, or this route answers "does this person work here".
    const knownStart = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'r.loiseau@lrparis.com' } });
    const strangerStart = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'no.such.person@lrparis.com' } });
    eq('a known address and an unknown one answer with the same status', knownStart.status, strangerStart.status);
    eq('and with the same body', knownStart.text, strangerStart.text);
    eq('the unknown one still created no account', countUsers('no.such.person@lrparis.com'), 0);

    const wrong = await callMcp(0, 'POST', '/api/mcp/enroll/verify', { body: { email: 'n.hire@lrparis.com', code: '000000' } });
    eq('a wrong code is refused', wrong.status, 401);
    eq('a wrong code creates no account', countUsers('n.hire@lrparis.com'), 0);

    // A wrong code for an address that has no pending claim at all has to look
    // the same as a wrong code for one that does.
    const wrongUnknown = await callMcp(0, 'POST', '/api/mcp/enroll/verify', { body: { email: 'never.asked@lrparis.com', code: '000000' } });
    eq('and an unknown address is refused the same way', wrongUnknown.status, wrong.status);
    eq('with the same body', wrongUnknown.text, wrong.text);

    const enroll = await callMcp(0, 'POST', '/api/mcp/enroll/verify', { body: { email: 'n.hire@lrparis.com', code: firstCode } });
    eq('a new colleague is signed in by the right code', enroll.status, 201);
    ok('and only now is the account created', enroll.json?.created === true);
    const newUser = enroll.json?.user?.id;
    ok('and it handed back a user id', Number.isInteger(newUser));
    eq('the account exists exactly once', countUsers('n.hire@lrparis.com'), 1);
    eq('the pending claim is consumed', pendingCode('n.hire@lrparis.com'), undefined);

    // Second time round the same person is an ordinary OTP user: the code is
    // written to otp_codes by Launchpad's own generateOTP, not to a pending row.
    const again2 = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'n.hire@lrparis.com' } });
    eq('a returning person gets the same answer as a new one', again2.text, started.text);
    eq('and no second pending claim is opened', pendingCode('n.hire@lrparis.com'), undefined);
    const second = await callMcp(0, 'POST', '/api/mcp/enroll/verify', {
      body: { email: 'n.hire@lrparis.com', code: mailedCode('n.hire@lrparis.com') },
    });
    eq('signing in twice does not create a second account', second.json?.user?.id, newUser);
    eq('and says so', second.json?.created, false);
    eq('still exactly one row', countUsers('n.hire@lrparis.com'), 1);

    const unsigned = await fetch(`${BASE}/api/mcp/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Launchpad-Actor': '0' },
      body: JSON.stringify({ email: 'n.hire@lrparis.com' }),
    });
    eq('an unsigned enrollment is refused', unsigned.status, 401);

    // ---------------------------------------------------------------------
    // 3b. cleanup-probe-users.js, on a row of the kind the old ordering left
    // ---------------------------------------------------------------------
    {
      // Exactly what the broken route used to write: a users row for an address
      // nobody ever proved, with no code verified and no membership.
      const u = new Database(box.usersDbPath);
      u.prepare(`INSERT INTO users (username, email, name, role, created_by, can_create_shops)
        VALUES ('probe.person', 'probe.person@lrparis.com', 'Probe Person', 'user', 'mcp-enroll', 0)`).run();
      u.close();

      const cleanup = path.join(__dirname, '..', 'scripts', 'cleanup-probe-users.js');
      const dry = require('child_process').spawnSync(process.execPath, [cleanup], {
        env: { ...process.env, LAUNCHPAD_DATA_DIR: box.dataDir }, encoding: 'utf8',
      });
      eq('cleanup-probe-users exits clean', dry.status, 0);
      ok('it defaults to a dry run', /DRY RUN/.test(dry.stdout), dry.stdout);
      ok('and names the row it would delete', /probe\.person@lrparis\.com/.test(dry.stdout), dry.stdout);
      ok('and does not delete it yet', countUsers('probe.person@lrparis.com') === 1);
      // n.hire signed in for real a moment ago, through the same route, with the
      // same created_by. Nothing but the verified sign in separates them.
      ok('it keeps the colleague who actually signed in',
        !/n\.hire@lrparis\.com/.test(dry.stdout.split('Would delete')[1] || ''), dry.stdout);
      ok('and never considers a row created by admin or migration',
        /never considered/.test(dry.stdout), dry.stdout);

      const applied = require('child_process').spawnSync(process.execPath, [cleanup, '--apply'], {
        env: { ...process.env, LAUNCHPAD_DATA_DIR: box.dataDir }, encoding: 'utf8',
      });
      eq('--apply exits clean', applied.status, 0);
      eq('the probe row is gone', countUsers('probe.person@lrparis.com'), 0);
      eq('and the real account is untouched', countUsers('n.hire@lrparis.com'), 1);
      eq('as is every account that predates the dev tool', countUsers('r.loiseau@lrparis.com'), 1);
      ok('it wrote a backup of users.db before deleting',
        fs.readdirSync(box.dataDir).some((f) => f.startsWith('users.db.pre-cleanup-')),
        fs.readdirSync(box.dataDir).join(' '));
    }

    // ---------------------------------------------------------------------
    // 4. A fresh account sees nothing, and is told who to ask
    // ---------------------------------------------------------------------
    const mine = await callMcp(newUser, 'GET', '/api/mcp/my-shops');
    eq('list_my_shops answers for a brand new account', mine.status, 200);
    eq('and it is empty', mine.json?.shops?.length, 0);
    eq('with a total of zero', mine.json?.total, 0);

    const denied = await callMcp(newUser, 'GET', '/api/shops/serhant');
    eq('a named shop refuses a non-member', denied.status, 403);
    eq('with NOT_A_MEMBER', denied.json?.error?.code, 'NOT_A_MEMBER');
    // S2: the refusal points at request_access and at Gio, and says nothing that
    // a shop the caller cannot see would not also say. Naming the owners here
    // was how a non-member could tell a real slug from an invented one.
    ok('the refusal points at a way forward',
      /request_access/.test(denied.json?.error?.resolution || '')
      && /Gio/.test(denied.json?.error?.resolution || ''),
      denied.json?.error?.resolution);
    const invented = await callMcp(newUser, 'GET', '/api/shops/not-a-real-shop');
    ok('and a shop that does not exist answers exactly the same way',
      invented.status === denied.status
      && invented.json?.error?.code === denied.json?.error?.code
      && invented.json?.error?.resolution === denied.json?.error?.resolution,
      { real: denied.json?.error, invented: invented.json?.error });
    eq('and says the rule will not clear on its own', denied.json?.error?.possible, false);

    const ask = await callMcp(newUser, 'POST', '/api/mcp/access-requests', {
      body: { shop_slug: 'serhant', role: 'editor', reason: 'Fulfilling orders this week.' },
    });
    eq('a non-member can still ask for access', ask.status, 201);
    ok('and the ask returns an audit id', Number.isInteger(ask.json?.audit_id));

    const nowhere = await callMcp(newUser, 'POST', '/api/mcp/access-requests', {
      body: { shop_slug: 'no-such-shop', role: 'editor', reason: 'x' },
    });
    eq('asking about a shop that does not exist says so', nowhere.json?.error?.code, 'NO_SUCH_SHOP');

    // ---------------------------------------------------------------------
    // 5. The owner grants it, over MCP, as an ordinary owner
    // ---------------------------------------------------------------------
    const grant = await callMcp(7, 'POST', '/api/shops/serhant/members', {
      body: { email: 'n.hire@lrparis.com', role: 'editor' },
    });
    eq('the owner can grant access over MCP', grant.status, 200);
    eq('the granted role comes back', grant.json?.role, 'editor');
    ok('and the grant returns an audit id', Number.isInteger(grant.json?.audit_id));

    const mineNow = await callMcp(newUser, 'GET', '/api/mcp/my-shops');
    eq('the shop now shows up in list_my_shops', mineNow.json?.shops?.length, 1);
    eq('with the role that was granted', mineNow.json?.shops?.[0]?.role, 'editor');

    const shop = await callMcp(newUser, 'GET', '/api/shops/serhant');
    eq('and the shop itself is readable', shop.status, 200);
    eq('the response carries the caller role', shop.json?.role, 'editor');
    ok('and a URL, so a tool can hand back a link', typeof shop.json?.url === 'string' && shop.json.url.endsWith('/serhant/'));

    const who = await callMcp(newUser, 'GET', '/api/mcp/whoami');
    eq('whoami lists the membership', who.json?.memberships?.length, 1);
    eq('whoami names the shop', who.json?.memberships?.[0]?.shop_slug, 'serhant');

    // ---------------------------------------------------------------------
    // 5b. Access for someone who has never signed in waits for them
    // ---------------------------------------------------------------------
    const invite = await callMcp(7, 'POST', '/api/shops/serhant/members', {
      body: { email: 'S.Sacks@lrparis.com', role: 'viewer' },
    });
    eq('an owner can give access to a colleague who never signed in', invite.status, 200);
    ok('and is told it waits for their first sign in', invite.json?.invited === true, JSON.stringify(invite.json));
    eq('with the role that will apply', invite.json?.role, 'viewer');
    ok('the invitation is audited', Number.isInteger(invite.json?.audit_id));
    eq('and no account row is written for an address nobody proved', countUsers('s.sacks@lrparis.com'), 0);
    const waiting = await callMcp(7, 'GET', '/api/shops/serhant/members');
    ok('the owner sees it waiting',
      (waiting.json?.pending || []).some((p) => p.email === 's.sacks@lrparis.com' && p.role === 'viewer'),
      JSON.stringify(waiting.json?.pending));
    const offDomain = await callMcp(7, 'POST', '/api/shops/serhant/members', {
      body: { email: 'someone@gmail.com', role: 'viewer' },
    });
    eq('an address outside lrparis.com cannot be given access', offDomain.status, 403);
    eq('and is refused with a code', offDomain.json?.error?.code, 'NOT_PERMITTED');

    await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 's.sacks@lrparis.com' } });
    const sacksSignIn = await callMcp(0, 'POST', '/api/mcp/enroll/verify', {
      body: { email: 's.sacks@lrparis.com', code: pendingCode('s.sacks@lrparis.com') },
    });
    eq('her first sign in creates the account', sacksSignIn.status, 201);
    const sacksWho = await callMcp(sacksSignIn.json?.user?.id, 'GET', '/api/mcp/whoami');
    ok('and the access was waiting for her',
      (sacksWho.json?.memberships || []).some((m) => m.shop_slug === 'serhant' && m.role === 'viewer'),
      JSON.stringify(sacksWho.json?.memberships));
    const afterSignIn = await callMcp(7, 'GET', '/api/shops/serhant/members');
    ok('and it is no longer listed as waiting',
      !(afterSignIn.json?.pending || []).some((p) => p.email === 's.sacks@lrparis.com'));

    const memberTrail = await callMcp(7, 'GET', '/api/shops/serhant/audit', { query: { limit: 50 } });
    ok('the audit trail names people by email, not only by username',
      (memberTrail.json?.entries || []).some((e) => e.actor_email === 'r.loiseau@lrparis.com' && e.actor.includes('<r.loiseau@lrparis.com>')),
      JSON.stringify((memberTrail.json?.entries || []).slice(0, 3)));
    ok('and records that the waiting access was applied',
      (memberTrail.json?.entries || []).some((e) => e.action === 'member_invite_applied'));

    // ---------------------------------------------------------------------
    // 6. Health, the call the agent makes every turn
    // ---------------------------------------------------------------------
    const health = await callMcp(newUser, 'GET', '/api/shops/serhant/health');
    eq('health answers', health.status, 200);
    ok('health reports a stage', typeof health.json?.stage === 'string');
    ok('health returns checks', Array.isArray(health.json?.checks) && health.json.checks.length > 0);
    ok('every check carries a reason a person can read',
      (health.json?.checks || []).every((c) => typeof c.name === 'string' && 'ok' in c && typeof c.detail === 'string'),
      JSON.stringify(health.json?.checks?.[0]));
    ok('health returns suggestions computed by the backend', Array.isArray(health.json?.suggestions));
    ok('health gives the whole shop one word', typeof health.json?.status === 'string');
    {
      // The Shuttle template ships ShopType.txt with a comment block above
      // the value. The checkout check used to report that block as the type.
      const presetsDir = path.join(box.shopsDir, 'serhant', 'DATABASE', 'Presets');
      fs.mkdirSync(presetsDir, { recursive: true });
      fs.writeFileSync(path.join(presetsDir, 'ShopType.txt'),
        '# Shop Type Configuration\n# Options:\n#   free   - Basic free shop.\n#   po     - Purchase Order shop.\n\ntype: po\n');
      const commented = await callMcp(newUser, 'GET', '/api/shops/serhant/health');
      const review = commented.json?.ready_for_review?.checks || [];
      const checkoutCheck = review.find((c) => c.id === 'checkout');
      ok('the checkout check reads the shop type past the template comments',
        checkoutCheck && /fits a po shop/.test(checkoutCheck.detail || ''), JSON.stringify(checkoutCheck));
      const skuCheck = review.find((c) => c.id === 'skus');
      eq('the SKU check says what it checks', skuCheck && skuCheck.label, 'Every product has its own SKU');
      fs.rmSync(presetsDir, { recursive: true, force: true });
    }
    ok('every suggestion says why and what to do next',
      (health.json?.suggestions || []).every((sg) => typeof sg.why === 'string' && typeof sg.do === 'string'),
      JSON.stringify(health.json?.suggestions?.[0]));

    // ---------------------------------------------------------------------
    // 7. The DATABASE round trip: ticket, upload, stage, apply, roll back
    // ---------------------------------------------------------------------
    const ticket = await callMcp(newUser, 'POST', '/api/shops/serhant/database/upload-ticket', { body: {} });
    eq('an editor can request an upload ticket', ticket.status, 200);
    const rawTicket = ticket.json?.ticket;
    ok('the ticket is the credential, a string', typeof rawTicket === 'string' && rawTicket.length === 64);
    ok('the ticket issue is audited', Number.isInteger(ticket.json?.audit_id));
    eq('the upload link is a whole address a person can open', ticket.json?.upload_url, `${BASE}/api/upload/${rawTicket}`);
    eq('and it says how long it lasts', ticket.json?.expires_in_minutes, 15);

    const zip = buildDatabaseZip(AdmZip, [
      { name: 'Tote', sku: 'TOTE-1' },
      { name: 'Scarf', sku: 'SCARF-1' },
    ]);
    const upload = await fetch(`${BASE}/api/upload/${rawTicket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zip,
    });
    const uploadJson = await upload.json();
    eq('the upload stages in the same request', upload.status, 200);
    ok('and returns a staging id', typeof uploadJson.staging_id === 'string' && uploadJson.staging_id.length > 0,
      JSON.stringify(uploadJson));
    ok('and the ADR 4b diff, not the catalog',
      uploadJson.diff && uploadJson.diff.products && Array.isArray(uploadJson.diff.blocking),
      JSON.stringify(uploadJson.diff));
    eq('nothing blocks this upload', uploadJson.diff?.blocking?.length, 0);
    ok('the diff promises where the backup will go', typeof uploadJson.diff?.will_backup_to === 'string');
    ok('staging is audited', Number.isInteger(uploadJson.audit_id));

    const replay = await fetch(`${BASE}/api/upload/${rawTicket}`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip,
    });
    ok('a ticket cannot be used twice', replay.status === 401, `got ${replay.status}`);

    const before = fs.readdirSync(path.join(serhantDir, 'DATABASE', 'ShopCollections', 'Spring'));
    eq('the live shop is untouched until apply', before.length, 1);

    const apply = await callMcp(newUser, 'POST', '/api/shops/serhant/database/apply', {
      body: { staging_id: uploadJson.staging_id },
    });
    eq('apply succeeds', apply.status, 200);
    ok('apply returns the backup to roll back to', typeof apply.json?.backup_id === 'string', JSON.stringify(apply.json));
    ok('apply is audited', Number.isInteger(apply.json?.audit_id));

    const after = fs.readdirSync(path.join(serhantDir, 'DATABASE', 'ShopCollections', 'Spring')).sort();
    assert.ok(after.length >= 2);
    eq('the new catalog is live', after.join(','), 'Scarf,Tote');

    const rollback = await callMcp(newUser, 'POST', '/api/shops/serhant/database/rollback', {
      body: { backup_id: apply.json.backup_id },
    });
    eq('rollback succeeds', rollback.status, 200);
    ok('rollback takes its own backup, so it can be undone',
      typeof rollback.json?.backup_id === 'string' && rollback.json.backup_id !== apply.json.backup_id);
    ok('rollback is audited', Number.isInteger(rollback.json?.audit_id));

    const restored = fs.readdirSync(path.join(serhantDir, 'DATABASE', 'ShopCollections', 'Spring'));
    eq('the shop is back to what it was', restored.join(','), 'Tote');

    const backups = await callMcp(newUser, 'GET', '/api/shops/serhant/database/backups');
    ok('the backups are listed', (backups.json?.backups || []).length >= 2);

    const trail = await callMcp(newUser, 'GET', '/api/shops/serhant/audit', { query: { limit: 50 } });
    eq('the audit trail reads back', trail.status, 200);
    ok('and it has the apply in it',
      (trail.json?.entries || []).some((e) => e.action === 'database_applied'),
      JSON.stringify((trail.json?.entries || []).map((e) => e.action)));
    ok('the audit ids match what apply returned',
      (trail.json?.entries || []).some((e) => e.id === apply.json.audit_id));

    // ---------------------------------------------------------------------
    // 8. The cap that the whole ADR rests on
    // ---------------------------------------------------------------------
    // Rachael is an owner but not an admin.
    const ownerProd = await callMcp(7, 'PUT', '/api/shops/serhant/stage', { body: { stage: 'in_production' } });
    eq('an owner cannot put a shop in production over MCP', ownerProd.status, 403);
    eq('and the code says why', ownerProd.json?.error?.code, 'ADMIN_ONLY');

    // Gio is a super_admin. Over MCP he is not.
    const adminProd = await callMcp(1, 'PUT', '/api/shops/serhant/stage', { body: { stage: 'in_production' } });
    eq('nor can an admin, over MCP', adminProd.status, 403);
    eq('ADMIN_ONLY holds for Gio too', adminProd.json?.error?.code, 'ADMIN_ONLY');
    eq('and it is not a right-now problem', adminProd.json?.error?.possible, false);

    const testing = await callMcp(7, 'PUT', '/api/shops/serhant/stage', { body: { stage: 'in_testing' } });
    eq('but an owner can move a shop to in_testing', testing.status, 200);
    eq('the stage comes back', testing.json?.stage, 'in_testing');
    eq('and so does the one it came from', testing.json?.previous_stage, 'no_status');
    ok('the stage change is audited', Number.isInteger(testing.json?.audit_id));

    // The same hole, on the older route.
    const backDoor = await callMcp(7, 'PATCH', '/api/shops/serhant', { body: { lifecycle_status: 'active' } });
    eq('PATCH is not a back door to production', backDoor.status, 403);
    eq('and it refuses with the same code', backDoor.json?.error?.code, 'ADMIN_ONLY');

    // ---------------------------------------------------------------------
    // 9. Shop creation: the permission, and the reserved slugs
    // ---------------------------------------------------------------------
    const whoBefore = await callMcp(newUser, 'GET', '/api/mcp/whoami');
    eq('whoami says when someone cannot create shops', whoBefore.json?.can_create_shops, false);
    const cannot = await callMcp(newUser, 'POST', '/api/shops', { body: { name: 'New Client' } });
    eq('a person without can_create_shops cannot create one', cannot.status, 403);
    eq('and is told which permission is missing', cannot.json?.error?.code, 'NOT_PERMITTED');
    ok('and who turns it on', /Gio/.test(cannot.json?.error?.resolution || ''));
    const adminCannot = await callMcp(1, 'POST', '/api/shops', { body: { name: 'Admin Shop' } });
    eq('over MCP an admin needs the switch too', adminCannot.status, 403);
    ok('and is pointed at their own account instead of being told to ask Gio',
      /your own account/i.test(adminCannot.json?.error?.resolution || ''), JSON.stringify(adminCannot.json));

    {
      const u = new Database(box.usersDbPath);
      u.prepare('UPDATE users SET can_create_shops = 1 WHERE id = ?').run(newUser);
      u.close();
    }
    const whoAfter = await callMcp(newUser, 'GET', '/api/mcp/whoami');
    eq('and says so once it is on', whoAfter.json?.can_create_shops, true);

    const takenMine = await callMcp(newUser, 'POST', '/api/shops', { body: { name: 'Serhant', slug: 'serhant' } });
    eq('an address that is taken is refused', takenMine.status, 409);
    eq('with a code, not a platform fault', takenMine.json?.error?.code, 'NOT_PERMITTED');
    ok('a member is told to carry on with the shop they already have',
      /you are its editor/.test(takenMine.json?.error?.message || '') && /get_shop/.test(takenMine.json?.error?.resolution || ''),
      JSON.stringify(takenMine.json));
    const takenOther = await callMcp(newUser, 'POST', '/api/shops', { body: { name: 'Michael Kors', slug: 'michael-kors' } });
    eq('another shop\'s address is refused with the same code', takenOther.json?.error?.code, 'NOT_PERMITTED');
    ok('and points at request_access', /request_access/.test(takenOther.json?.error?.resolution || ''),
      JSON.stringify(takenOther.json));
    const reserved = await callMcp(newUser, 'POST', '/api/shops', { body: { name: 'MCP', slug: 'mcp' } });
    eq('the slug "mcp" is refused', reserved.status, 409);
    ok('because it would break the nginx config for everyone',
      /reserved/i.test(reserved.json?.error?.message || ''), JSON.stringify(reserved.json));
    for (const slug of ['api', 'review']) {
      const r = await callMcp(newUser, 'POST', '/api/shops', { body: { name: slug, slug } });
      eq(`the slug "${slug}" is refused too`, r.status, 409);
    }
    ok('and no directory was created for a reserved slug', !fs.existsSync(path.join(box.shopsDir, 'mcp')));

    // ---------------------------------------------------------------------
    // 10. The things that must not have regressed
    // ---------------------------------------------------------------------
    const checkout = await callMcp(newUser, 'GET', '/api/shops/serhant/checkout/schema');
    eq('the checkout schema answers on the path the frontend calls', checkout.status, 200);
    ok('and returns a schema', Array.isArray(checkout.json?.sections));

    const doubled = await fetch(`${BASE}/api/shops/shops/serhant/checkout/schema`);
    ok('the old doubled path is gone', doubled.status === 404 || doubled.status === 401, `got ${doubled.status}`);

    const orders = await callMcp(newUser, 'GET', '/api/shops/serhant/orders', { query: { limit: 5, view: 'summary' } });
    eq('the orders list answers with a total', orders.status, 200);
    ok('and a total field', typeof orders.json?.total === 'number');

    const inv = await callMcp(newUser, 'GET', '/api/shops/serhant/inventory', { query: { limit: 5 } });
    eq('the inventory list answers with a total', inv.status, 200);
    ok('and a total field', typeof inv.json?.total === 'number');

    const skew = await (async () => {
      const ts = String(Date.now() - 120000);
      return fetch(`${BASE}/api/mcp/whoami`, {
        headers: {
          'X-Launchpad-Actor': String(newUser),
          'X-Launchpad-Ts': ts,
          'X-Launchpad-Sig': sign('', newUser, ts, 'GET', '/api/mcp/whoami'),
        },
      });
    })();
    eq('a stale signature is refused', skew.status, 401);

    const forged = await fetch(`${BASE}/api/mcp/whoami`, {
      headers: {
        'X-Launchpad-Actor': String(newUser),
        'X-Launchpad-Ts': String(Date.now()),
        'X-Launchpad-Sig': 'a'.repeat(64),
      },
    });
    eq('a forged signature is refused', forged.status, 401);

    const browser = await fetch(`${BASE}/api/mcp/whoami`);
    ok('a browser cannot reach the tool routes', browser.status === 401 || browser.status === 403, `got ${browser.status}`);

    // ---------------------------------------------------------------------
    // 11. The web console, which is NOT what this ADR is scoped to change
    // ---------------------------------------------------------------------
    // Sign in for real, over the OTP route the console uses, and check that the
    // shop list still answers the way it always has. The tool path is filtered;
    // this one is not, because several people have no membership row yet and
    // narrowing it would open their dashboard to nothing.
    // Start each sign-in fresh. The per-account brake (60 s cooldown, 5 codes
    // per 15 min) would otherwise hold back a second code for the same user.
    {
      const db = new Database(box.usersDbPath);
      db.prepare('DELETE FROM otp_codes WHERE user_id = ?').run(newUser);
      db.close();
    }
    const askCode = await fetch(`${BASE}/api/auth/login-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'n.hire@lrparis.com' }),
    });
    eq('the OTP route answers', askCode.status, 200);

    let code = null;
    {
      const u = new Database(box.usersDbPath);
      const row = u.prepare('SELECT id FROM otp_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(newUser);
      if (row) u.prepare('UPDATE otp_codes SET code = ? WHERE id = ?').run(otpHash(KNOWN_CODE), row.id);
      u.close();
      code = row ? KNOWN_CODE : null;
    }
    ok('a sign-in code was issued', typeof code === 'string' && code.length > 0);

    const verify = await fetch(`${BASE}/api/auth/login-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'n.hire@lrparis.com', code }),
    });
    eq('the code signs them in', verify.status, 200);
    const cookie = (verify.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    ok('and a session cookie comes back', cookie.length > 0);

    const webList = await fetch(`${BASE}/api/shops`, { headers: { Cookie: cookie } });
    const webJson = await webList.json();
    eq('the web shop list answers', webList.status, 200);
    ok('and still shows every shop, as the console has always done',
      (webJson.shops || []).length >= 2, JSON.stringify((webJson.shops || []).map((x) => x.slug)));
    ok('while carrying the caller role on each entry, so the UI can tell them apart',
      (webJson.shops || []).some((x) => x.slug === 'serhant' && x.role === 'editor'));

    // The same person over MCP sees only what they are a member of.
    const toolList = await callMcp(newUser, 'GET', '/api/mcp/my-shops');
    eq('while the tool path shows only their memberships', toolList.json?.shops?.length, 1);

    // The OTP limiter is keyed by address as well as address-plus-IP, so one
    // person burning their ten tries cannot lock out the next person. Every
    // request here comes from 127.0.0.1, which is the shape that was broken.
    for (let i = 0; i < 11; i += 1) {
      await fetch(`${BASE}/api/auth/login-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'n.hire@lrparis.com' }),
      });
    }
    const otherPerson = await fetch(`${BASE}/api/auth/login-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'r.loiseau@lrparis.com' }),
    });
    eq('one person hitting the OTP limit does not lock out the next', otherPerson.status, 200);

    const sameAgain = await fetch(`${BASE}/api/auth/login-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'n.hire@lrparis.com' }),
    });
    eq('but their own bucket is still enforced', sameAgain.status, 429);
    // ---------------------------------------------------------------------
    // 12. Every route the tool server calls actually exists here
    // ---------------------------------------------------------------------
    // The failure this catches is silent and expensive: a tool that reaches a
    // path nobody built gets a 404, which the tool server reports as a platform
    // fault rather than a refusal, so the person is told to tell Gio about a
    // bug that is really a missing route. Skipped when the MCP repo is not
    // checked out next to this one, because the backend must build alone.
    const mcpSrc = path.join(__dirname, '..', '..', '..', '..', 'mcp', 'src');
    if (fs.existsSync(mcpSrc)) {
      const wanted = [];
      const walkSrc = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, entry.name);
          if (entry.isDirectory()) walkSrc(f);
          else if (f.endsWith('.js')) {
            const text = fs.readFileSync(f, 'utf8');
            const re = /call\(\s*[^,]+,\s*'(GET|POST|PUT|PATCH|DELETE)',\s*[`']([^`']+)[`']/g;
            let m;
            while ((m = re.exec(text))) wanted.push({ method: m[1], raw: m[2], file: path.basename(f) });
          }
        }
      };
      walkSrc(mcpSrc);

      const dead = [];
      for (const w of wanted) {
        // Substitute something harmless for every template slot and ask for it.
        const probe = w.raw.replace(/\$\{[^}]+\}/g, 'serhant');
        const res = await callMcp(newUser, w.method, probe, {
          body: w.method === 'GET' ? undefined : {},
        });
        // A mounted route always answers JSON, even when it answers "no such
        // order". An unmounted one falls through to Express's own handler,
        // which answers HTML. That is the difference this is looking for.
        if (res.status === 404 && res.json === null) {
          dead.push(`${w.method} ${w.raw} (${w.file})`);
        }
      }
      ok(`every one of the ${wanted.length} routes the tool server calls is mounted`,
        dead.length === 0, dead.join('\n        '));
    } else {
      console.log('skip  the MCP route cross-check (no mcp/src next to this repo)');
    }

    // ---------------------------------------------------------------------
    // 13. The security review's findings, against the real server process
    // ---------------------------------------------------------------------
    // M2: the tool server holds the shared secret. That must buy it nothing on
    // the routers that predate ADR-001, even acting as a super_admin (actor 1).
    {
      const adminRoutes = [
        ['GET', '/api/users'],
        ['POST', '/api/users'],
        ['GET', '/api/mission-control/overview'],
        ['GET', '/api/system/version'],
        ['POST', '/api/system/update'],
      ];
      const reached = [];
      for (const [method, url] of adminRoutes) {
        const res = await callMcp(1, method, url, { body: method === 'GET' ? undefined : { username: 'backdoor', email: 'backdoor@lrparis.com', name: 'B', role: 'super_admin' } });
        if (res.status !== 403 || res.json?.error?.code !== 'ADMIN_ONLY') reached.push(`${method} ${url} -> ${res.status}`);
      }
      ok('a signed super_admin reaches none of the legacy admin routers', reached.length === 0, reached.join(', '));

      const users = new Database(box.usersDbPath, { readonly: true });
      const backdoor = users.prepare("SELECT id FROM users WHERE username = 'backdoor'").get();
      users.close();
      ok('and no backdoor account exists', !backdoor, backdoor);
    }

    // S3: the actor string that is signed and the id that is resolved are the
    // same bytes, so "01" and "1.0" are not user 1.
    {
      const padded = await callMcp('01', 'GET', '/api/mcp/whoami');
      const decimal = await callMcp('1.0', 'GET', '/api/mcp/whoami');
      ok('a zero-padded actor is refused', padded.status === 401, padded.status);
      ok('a decimal actor is refused', decimal.status === 401, decimal.status);
    }

    // S4: one captured set of headers is good for exactly one method, path and
    // query string, not for anything else inside the window.
    {
      const ts = String(Date.now());
      const headers = {
        'X-Launchpad-Actor': String(newUser),
        'X-Launchpad-Ts': ts,
        'X-Launchpad-Sig': sign('', newUser, ts, 'GET', '/api/mcp/whoami'),
      };
      const own = await fetch(`${BASE}/api/mcp/whoami`, { headers });
      eq('the signed call works on the route it was signed for', own.status, 200);
      const moved = await fetch(`${BASE}/api/mcp/my-shops`, { headers });
      eq('the same headers on another path are refused', moved.status, 401);
      const queried = await fetch(`${BASE}/api/mcp/whoami?limit=9999`, { headers });
      eq('the same headers with a query string added are refused', queried.status, 401);
    }

    // ---------------------------------------------------------------------
    // 14. S1: a broken platform.db degrades the dev tool, it does not take the
    //     backend down. Every shop's admin console lives behind this process.
    // ---------------------------------------------------------------------
    {
      const broken = sandbox.create({ label: 'adr001-degraded' });
      const brokenPort = port + 1;
      let brokenServer = null;
      try {
        fs.writeFileSync(path.join(broken.dataDir, 'platform.db'),
          'this is not a sqlite database at all, it is garbage'.repeat(40));
        brokenServer = startServer(broken.backend, brokenPort);
        await waitForHealth(brokenPort, brokenServer.child, brokenServer.log);
        const health = await (await fetch(`http://127.0.0.1:${brokenPort}/api/health`)).json();
        ok('the backend still boots with a corrupt platform.db', health.status === 'ok', health);
        ok('and says out loud that it came up degraded', health.platform_db === 'degraded', health);
        ok('and the log says why, and what to do',
          /DEGRADED/.test(brokenServer.log.join('')) && /Tell Gio/.test(brokenServer.log.join('')),
          brokenServer.log.join('').slice(0, 400));

        // The pre-ADR half of the server is still doing its job.
        const shops = await fetch(`http://127.0.0.1:${brokenPort}/api/shops`);
        ok('and the rest of the API answers rather than 500ing', shops.status === 401 || shops.status === 200, shops.status);
      } finally {
        if (brokenServer) {
          brokenServer.child.kill('SIGKILL');
          await new Promise((r) => setTimeout(r, 200));
        }
        broken.destroy();
      }
    }
  } finally {
    if (server) {
      server.child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
    }
    box.destroy();
  }

  console.log('');
  if (failures.length) {
    console.log(`FAIL  ${failures.length} of ${passed + failures.length} assertion(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS  ${passed} assertion(s), end to end over HTTP against a real backend process.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
