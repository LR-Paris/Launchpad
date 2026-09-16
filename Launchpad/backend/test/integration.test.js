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
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const sandbox = require('./_sandbox');

const SESSION_SECRET = 'integration-test-session-secret-0123456789';
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
    const bad = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'nobody@gmail.com' } });
    eq('an off-domain address cannot enroll', bad.status, 403);
    eq('and it is refused with a code, not a stack trace', bad.json?.error?.code, 'NOT_PERMITTED');

    const enroll = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'n.hire@lrparis.com' } });
    eq('a new colleague enrolls on first sign in', enroll.status, 201);
    ok('the enrollment created the account', enroll.json?.created === true);
    const newUser = enroll.json?.user?.id;
    ok('and it handed back a user id', Number.isInteger(newUser));

    const second = await callMcp(0, 'POST', '/api/mcp/enroll', { body: { email: 'n.hire@lrparis.com' } });
    eq('enrolling twice does not create a second account', second.json?.user?.id, newUser);
    eq('and says so', second.json?.created, false);

    const unsigned = await fetch(`${BASE}/api/mcp/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Launchpad-Actor': '0' },
      body: JSON.stringify({ email: 'n.hire@lrparis.com' }),
    });
    eq('an unsigned enrollment is refused', unsigned.status, 401);

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
    const cannot = await callMcp(newUser, 'POST', '/api/shops', { body: { name: 'New Client' } });
    eq('a person without can_create_shops cannot create one', cannot.status, 403);
    eq('and is told which permission is missing', cannot.json?.error?.code, 'NOT_PERMITTED');
    ok('and who turns it on', /Gio/.test(cannot.json?.error?.resolution || ''));

    {
      const u = new Database(box.usersDbPath);
      u.prepare('UPDATE users SET can_create_shops = 1 WHERE id = ?').run(newUser);
      u.close();
    }
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
    const askCode = await fetch(`${BASE}/api/auth/login-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'n.hire@lrparis.com' }),
    });
    eq('the OTP route answers', askCode.status, 200);

    let code = null;
    {
      const u = new Database(box.usersDbPath, { readonly: true });
      const row = u.prepare('SELECT code FROM otp_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(newUser);
      u.close();
      code = row && row.code;
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
