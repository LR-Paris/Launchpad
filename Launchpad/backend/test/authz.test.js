#!/usr/bin/env node
// ---------------------------------------------------------------------------
// authz.test.js — the four refusals ADR-001 promises, exercised end to end
// against a throwaway copy of the backend. Never touches backend/data.
//
//   1. a non-member gets NOT_A_MEMBER, and is told who to ask
//   2. a viewer trying to mutate gets ROLE_TOO_LOW
//   3. an admin over MCP gets ADMIN_ONLY on set_stage in_production
//   4. the second caller during a lock gets SHOP_BUSY
//
// No test framework: run it with plain node. Non-zero exit means broken.
//   node backend/test/authz.test.js
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sandbox = require('./_sandbox');

const MCP_SECRET = 'm'.repeat(48);

let passed = 0;
let failed = 0;
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    say(`ok    ${name}`);
  } else {
    failed++;
    say(`FAIL  ${name}`);
    if (detail !== undefined) say(`      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}

// ---------------------------------------------------------------------------
// Signed tool request, exactly as the MCP server will send it.
// ---------------------------------------------------------------------------
function mcpFetch(base, method, url, actorId, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  // Method + request target + body + actor + timestamp. The target is the path
  // and query exactly as they go on the wire (security review S4).
  const material = `${method.toUpperCase()}\n${url}\n${raw}\n${actorId}\n${ts}`;
  const sig = crypto.createHmac('sha256', MCP_SECRET).update(material).digest('hex');
  const headers = {
    'X-Launchpad-Actor': String(actorId),
    'X-Launchpad-Sig': sig,
    'X-Launchpad-Ts': ts,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + url, { method, headers, body: body === undefined ? undefined : raw });
}

// ---------------------------------------------------------------------------
// Real OTP login, so the web half is tested through the door everyone uses.
// Mailgun is not configured in the sandbox, so the code is read straight out of
// the sandbox's own otp_codes table.
// ---------------------------------------------------------------------------
async function webLogin(base, box, identifier) {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  await fetch(`${base}/api/auth/login-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });

  const udb = new Database(box.usersDbPath, { readonly: true });
  const user = udb.prepare('SELECT id FROM users WHERE username = ?').get(identifier);
  const row = udb.prepare('SELECT code FROM otp_codes WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(user.id);
  udb.close();

  const res = await fetch(`${base}/api/auth/login-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, code: row.code }),
  });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

  const csrfRes = await fetch(`${base}/api/auth/csrf-token`, { headers: { Cookie: cookie } });
  const { csrfToken } = await csrfRes.json();

  const call = (method, url, body) => fetch(base + url, {
    method,
    headers: {
      Cookie: cookie,
      'x-csrf-token': csrfToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { cookie, csrfToken, call, loggedIn: res.status === 200 };
}

async function main() {
  const box = sandbox.create({ label: 'adr001-authz' });
  let server = null;

  try {
    process.env.SESSION_SECRET = 's'.repeat(48);
    process.env.MCP_SHARED_SECRET = MCP_SECRET;
    process.env.PORT = '0';
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECURE = 'false';

    const app = require(path.join(box.src, 'index.js'));
    const authz = require(path.join(box.src, 'authz.js'));

    // Fixtures. Rachael owns serhant, Marc can only look, Gio owns it too (so
    // the admin gate is reached rather than the membership gate), and Margot
    // has nothing.
    authz.setShopRole(7, 'serhant', 'owner', 1);
    authz.setShopRole(2, 'serhant', 'viewer', 7);
    authz.setShopRole(1, 'serhant', 'owner', 1);

    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // -- 1. non-member ------------------------------------------------------
    {
      const res = await mcpFetch(base, 'GET', '/api/shops/serhant', 8);
      const body = await res.json();
      ok('non-member GET is 403', res.status === 403, res.status);
      ok('non-member gets NOT_A_MEMBER', body.error?.code === 'NOT_A_MEMBER', body);
      ok('message names the shop', /serhant/.test(body.error?.message || ''), body.error?.message);
      ok('resolution offers request_access', /request_access/.test(body.error?.resolution || ''), body.error?.resolution);
      ok('resolution names a person', /Gio/.test(body.error?.resolution || ''), body.error?.resolution);
      ok('possible is false', body.error?.possible === false, body.error);
      // S2: it must NOT name the owners of a shop the caller cannot see. That
      // was the difference between "this shop exists" and "it does not".
      ok('resolution does not leak who the owners are',
        !/Rachael/.test(body.error?.resolution || ''), body.error?.resolution);
    }

    // -- 2. viewer trying to mutate ----------------------------------------
    {
      const res = await mcpFetch(base, 'PATCH', '/api/shops/serhant', 2, { description: 'nope' });
      const body = await res.json();
      ok('viewer mutation is 403', res.status === 403, res.status);
      ok('viewer mutation gets ROLE_TOO_LOW', body.error?.code === 'ROLE_TOO_LOW', body);
      ok('message says which role they have', /is viewer/.test(body.error?.message || ''), body.error?.message);
      ok('message says which role is needed', /needs editor/.test(body.error?.message || ''), body.error?.message);
    }
    {
      // ... and the same viewer can still read.
      const res = await mcpFetch(base, 'GET', '/api/shops/serhant', 2);
      ok('viewer can still read', res.status === 200, res.status);
    }

    // -- 3. admin over MCP is not an admin ---------------------------------
    // set_stage is PUT /:slug/stage, owned by golive.js. shops.js raises the
    // whole path to owner at the router level; golive.js gates in_production on
    // a real super_admin on the web.
    {
      const res = await mcpFetch(base, 'PUT', '/api/shops/serhant/stage', 1, { stage: 'in_production' });
      const body = await res.json();
      ok('admin over MCP is refused', res.status === 403, res.status);
      ok('admin over MCP gets ADMIN_ONLY', body.error?.code === 'ADMIN_ONLY', body);
      ok('ADMIN_ONLY points at Launchpad', /Launchpad/i.test(body.error?.resolution || ''), body.error?.resolution);
    }
    {
      // An owner-level stage change over MCP is fine, so the gate is on the
      // value and not on the route.
      const res = await mcpFetch(base, 'PUT', '/api/shops/serhant/stage', 1, { stage: 'in_testing' });
      ok('owner over MCP may set a non-production stage', res.status === 200, `${res.status} ${await res.text()}`);
    }
    {
      // The same admin, on the web, may do it.
      const gio = await webLogin(base, box, 'admin');
      ok('OTP login works', gio.loggedIn === true, gio.loggedIn);
      const res = await gio.call('PUT', '/api/shops/serhant/stage', { stage: 'in_production' });
      ok('admin on the web may set in_production', res.status === 200, `${res.status} ${await res.text()}`);

      const me = await (await gio.call('GET', '/api/me')).json();
      ok('/api/me reports is_admin', me.is_admin === true, me);
      ok('/api/me lists shops with roles', Array.isArray(me.shops) && me.shops.every((s) => !!s.role), me.shops);
      ok('/api/me has first_login', typeof me.first_login === 'boolean', me.first_login);

      // Admin bypass means every shop, but only over the web.
      const overMcp = await (await mcpFetch(base, 'GET', '/api/me', 1)).json();
      ok('/api/me over MCP drops the admin bypass',
        overMcp.shops.length < me.shops.length && overMcp.shops.every((s) => s.slug === 'serhant'),
        { web: me.shops.map((s) => s.slug), mcp: overMcp.shops.map((s) => s.slug) });
    }

    // -- S2: a non-member cannot tell a real shop from an invented one ------
    {
      // Margot (8) is a member of nothing. serhant exists, not-a-shop does not.
      const real = await mcpFetch(base, 'GET', '/api/shops/serhant', 8);
      const realBody = await real.json();
      const fake = await mcpFetch(base, 'GET', '/api/shops/not-a-shop', 8);
      const fakeBody = await fake.json();
      ok('a shop that exists and one that does not answer with the same status',
        real.status === fake.status && real.status === 403, `${real.status} vs ${fake.status}`);
      ok('and with the same code and resolution',
        realBody.error?.code === fakeBody.error?.code
        && realBody.error?.resolution === fakeBody.error?.resolution
        && realBody.error?.possible === fakeBody.error?.possible,
        { real: realBody.error, fake: fakeBody.error });
      ok('the only thing that differs is the slug the caller typed',
        realBody.error?.message.replace('serhant', 'X') === fakeBody.error?.message.replace('not-a-shop', 'X'),
        { real: realBody.error?.message, fake: fakeBody.error?.message });
      ok('nothing in the refusal says the shop is real',
        !/exist/i.test(JSON.stringify(realBody)) && !/exist/i.test(JSON.stringify(fakeBody)),
        { real: realBody, fake: fakeBody });
    }
    {
      // Gio over MCP is not an admin either, so he gets the same uniform answer.
      const res = await mcpFetch(base, 'GET', '/api/shops/not-a-shop', 1);
      const body = await res.json();
      ok('an admin over MCP gets the same refusal as anyone else',
        res.status === 403 && body.error?.code === 'NOT_A_MEMBER', body);
    }
    {
      // ... but an admin in a browser still gets the honest 404, because they
      // can see every shop anyway and a typo should say so.
      const gio = await webLogin(base, box, 'admin');
      const res = await gio.call('GET', '/api/shops/not-a-shop');
      const body = await res.json();
      ok('an admin on the web still gets 404 NO_SUCH_SHOP',
        res.status === 404 && body.error?.code === 'NO_SUCH_SHOP', `${res.status} ${JSON.stringify(body)}`);
    }

    // -- signature checks ---------------------------------------------------
    {
      const res = await fetch(`${base}/api/shops/serhant`, {
        headers: { 'X-Launchpad-Actor': '1', 'X-Launchpad-Sig': 'deadbeef', 'X-Launchpad-Ts': String(Date.now()) },
      });
      ok('a bad signature is rejected', res.status === 401, res.status);
    }
    {
      const raw = '';
      const ts = String(Date.now() - 5 * 60 * 1000); // outside the 60s window
      const sig = crypto.createHmac('sha256', MCP_SECRET).update(`GET\n/api/shops/serhant\n${raw}\n1\n${ts}`).digest('hex');
      const res = await fetch(`${base}/api/shops/serhant`, {
        headers: { 'X-Launchpad-Actor': '1', 'X-Launchpad-Sig': sig, 'X-Launchpad-Ts': ts },
      });
      ok('a replayed request is rejected', res.status === 401, res.status);
    }

    // -- 4. locking ---------------------------------------------------------
    {
      let secondError = null;
      let firstRan = false;
      await authz.withShopLock('serhant', 7, 'apply_database', async () => {
        firstRan = true;
        try {
          await authz.withShopLock('serhant', 2, 'launch', async () => {});
        } catch (err) {
          secondError = err;
        }
      });
      ok('the first caller runs', firstRan === true);
      ok('the second caller gets SHOP_BUSY', secondError?.code === 'SHOP_BUSY', secondError?.code);
      ok('SHOP_BUSY names who holds it', /Rachael Loiseau/.test(secondError?.message || ''), secondError?.message);
      ok('SHOP_BUSY carries held_by', !!secondError?.held_by, secondError?.held_by);
      ok('SHOP_BUSY carries the action', secondError?.action === 'apply_database', secondError?.action);
      ok('SHOP_BUSY carries since', typeof secondError?.since === 'number', secondError?.since);
      ok('the lock is released afterwards', authz.currentLock('serhant') === null, authz.currentLock('serhant'));
    }
    {
      // Released even when the body throws, otherwise one bad apply wedges the
      // shop for ten minutes.
      let thrown = null;
      try {
        await authz.withShopLock('serhant', 7, 'apply_database', async () => { throw new Error('boom'); });
      } catch (err) { thrown = err; }
      ok('a throwing body still propagates', thrown?.message === 'boom', thrown?.message);
      ok('a throwing body still releases the lock', authz.currentLock('serhant') === null, authz.currentLock('serhant'));
    }
    {
      // A launch in progress (lock.js's .db.lock file) counts as held, so a
      // launch and a DATABASE apply can never overlap.
      const lockFile = path.join(box.shopsDir, 'serhant', '.db.lock');
      fs.writeFileSync(lockFile, JSON.stringify({ acquired_at: Date.now(), by_user_id: 2 }));
      let err = null;
      try {
        await authz.withShopLock('serhant', 7, 'apply_database', async () => {});
      } catch (e) { err = e; }
      ok('a live .db.lock blocks an apply', err?.code === 'SHOP_BUSY', err?.code);
      ok('the launch lock is reported as a launch', err?.action === 'launch', err?.action);
      fs.unlinkSync(lockFile);

      let ran = false;
      await authz.withShopLock('serhant', 7, 'apply_database', async () => { ran = true; });
      ok('the apply proceeds once the launch lock is gone', ran === true);
    }
    {
      // A lock older than ten minutes belongs to a request that died. Steal it,
      // and audit the theft.
      const { db: platformDb } = require(path.join(box.src, 'platform-db.js'));
      platformDb.prepare('INSERT INTO shop_locks (shop_slug, held_by, held_by_name, action, since, token) VALUES (?, ?, ?, ?, ?, ?)')
        .run('serhant', 2, 'Marc', 'apply_database', Date.now() - 11 * 60 * 1000, 'stale-token');
      let ran = false;
      await authz.withShopLock('serhant', 7, 'launch', async () => { ran = true; });
      ok('a stale lock is stolen', ran === true);
      const theft = platformDb.prepare("SELECT * FROM audit_log WHERE action = 'lock_stolen' ORDER BY id DESC LIMIT 1").get();
      ok('the theft is audited', !!theft && theft.shop_slug === 'serhant', theft);
    }

    // -- audit --------------------------------------------------------------
    {
      const { db: platformDb } = require(path.join(box.src, 'platform-db.js'));
      await mcpFetch(base, 'GET', '/api/shops/serhant/orders', 2);
      const row = platformDb.prepare("SELECT * FROM audit_log WHERE action = 'read_orders' ORDER BY id DESC LIMIT 1").get();
      ok('an order read is audited as read_orders', !!row, row);
      ok('the audit row records the shop', row?.shop_slug === 'serhant', row?.shop_slug);
      ok('the audit row records the user', row?.user_id === 2, row?.user_id);
      ok('the audit row records via=mcp', row?.via === 'mcp', row?.via);
      ok('the legacy audit.log is still written',
        fs.existsSync(path.join(box.dataDir, 'audit.log'))
          && fs.readFileSync(path.join(box.dataDir, 'audit.log'), 'utf8').includes('read_orders'));
    }

    // -- membership writes both representations -----------------------------
    {
      const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
      const udb = new Database(box.usersDbPath, { readonly: true });
      const row = udb.prepare('SELECT * FROM user_shop_permissions WHERE user_id = 2 AND shop_slug = ?').get('serhant');
      udb.close();
      ok('a viewer row keeps the legacy booleans in sync',
        row.role === 'viewer' && row.can_delete === 0 && row.can_edit_ui === 0 && row.can_view_orders === 1, row);
      ok('a grant records who and when', row.granted_by === 7 && typeof row.granted_at === 'number', row);
    }

    // -- request access -----------------------------------------------------
    {
      const res = await mcpFetch(base, 'POST', '/api/shops/serhant/access-requests', 8, { role: 'editor', reason: 'Building the catalog' });
      const body = await res.json();
      ok('a non-member may ask for access', res.status === 201, `${res.status} ${JSON.stringify(body)}`);
      ok('the answer names who was asked', /Rachael Loiseau/.test(body.message || ''), body.message);

      const dup = await mcpFetch(base, 'POST', '/api/shops/serhant/access-requests', 8, { role: 'editor' });
      const dupBody = await dup.json();
      ok('a second ask does not spam the owners', dupBody.already === true, dupBody);

      const list = await (await mcpFetch(base, 'GET', '/api/shops/serhant/access-requests', 7)).json();
      ok('an owner sees the request', list.requests?.length === 1, list);

      const id = list.requests[0].id;
      const decided = await mcpFetch(base, 'POST', `/api/shops/serhant/access-requests/${id}/decide`, 7, { decision: 'grant', role: 'editor' });
      ok('an owner can grant it', decided.status === 200, decided.status);
      ok('the grant took effect', authz.membershipRole(8, 'serhant') === 'editor', authz.membershipRole(8, 'serhant'));

      const notOwner = await mcpFetch(base, 'GET', '/api/shops/serhant/access-requests', 2);
      const notOwnerBody = await notOwner.json();
      ok('a viewer cannot read the request queue', notOwnerBody.error?.code === 'ROLE_TOO_LOW', notOwnerBody);
    }

    // -- health -------------------------------------------------------------
    {
      const res = await mcpFetch(base, 'GET', '/api/shops/serhant/health', 2);
      const body = await res.json();
      ok('health answers for a viewer', res.status === 200, res.status);
      const ids = (body.checks || []).map((c) => c.id);
      ok('health has every check',
        ['database_present', 'unfulfilled_orders', 'stage_unset', 'variants_ok', 'sts_current', 'legacy'].every((id) => ids.includes(id)), ids);
      ok('every check has the full shape',
        (body.checks || []).every((c) => 'ok' in c && c.title && c.why && Array.isArray(c.how) && 'tool' in c && 'role_needed' in c), body.checks);
      ok('you_can is filtered to the viewer', body.you_can.every((c) => ['read_health', 'read_catalog', 'read_orders'].includes(c.id)), body.you_can);
      ok('you_cannot says who to ask', body.you_cannot.every((c) => !!c.reason && !!c.ask), body.you_cannot);
      ok('ready_for_review is wired to the go-live preflight',
        body.ready_for_review?.available === true && Array.isArray(body.ready_for_review.checks),
        body.ready_for_review);
      ok('health reports the stage', body.stage === 'in_production', body.stage);
      ok('health reports container state without shelling out', typeof body.container?.status === 'string', body.container);
    }

    // -- security review M2: a signed request never reaches the admin routers -
    {
      // Actor 1 is a super_admin. Over MCP that must buy nothing at all on the
      // three routers that predate the ADR and gate on the account role.
      const before = (() => {
        const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
        const u = new Database(box.usersDbPath, { readonly: true });
        const n = u.prepare('SELECT count(*) AS n FROM users').get().n;
        u.close();
        return n;
      })();

      const probes = [
        ['GET', '/api/users'],
        ['GET', '/api/users/2'],
        ['PUT', '/api/users/2/permissions'],
        ['DELETE', '/api/users/2'],
        ['GET', '/api/mission-control/overview'],
        ['GET', '/api/mission-control/logs/shop/serhant'],
        ['GET', '/api/system/version'],
        ['POST', '/api/system/update'],
      ];
      const leaks = [];
      for (const [method, url] of probes) {
        const res = await mcpFetch(base, method, url, 1, method === 'GET' ? undefined : {});
        const body = await res.json().catch(() => null);
        if (res.status !== 403 || body?.error?.code !== 'ADMIN_ONLY') {
          leaks.push(`${method} ${url} -> ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
        }
      }
      ok('every legacy admin route refuses a signed request with ADMIN_ONLY',
        leaks.length === 0, leaks.join('\n        '));

      const created = await mcpFetch(base, 'POST', '/api/users', 1, {
        username: 'backdoor', email: 'backdoor@lrparis.com', name: 'Backdoor', role: 'super_admin',
      });
      ok('creating a super_admin over MCP is refused', created.status === 403, created.status);

      const after = (() => {
        const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
        const u = new Database(box.usersDbPath, { readonly: true });
        const n = u.prepare('SELECT count(*) AS n FROM users').get().n;
        u.close();
        return n;
      })();
      ok('and no user row was written', after === before, `${before} -> ${after}`);

      // The same admin in a browser still administers, so the block is on how
      // the request arrived and not on the route.
      const gio = await webLogin(base, box, 'admin');
      const web = await gio.call('GET', '/api/users');
      ok('an admin on the web still reaches /api/users', web.status === 200, web.status);
    }

    // -- security review S3: an actor id is a decimal integer, nothing else ---
    {
      const strange = ['01', '1.0', '+1', '1e0', ' 1', '0x1'];
      const accepted = [];
      for (const actor of strange) {
        const res = await mcpFetch(base, 'GET', '/api/mcp/whoami', actor);
        if (res.status === 200) accepted.push(actor);
      }
      ok('a padded or decimal actor is not user 1', accepted.length === 0, accepted.join(', '));
      const plain = await mcpFetch(base, 'GET', '/api/mcp/whoami', 1);
      ok('and a plain integer actor still works', plain.status === 200, plain.status);
    }

    // -- security review S4: a signature is bound to method, path and query ---
    {
      const ts = String(Date.now());
      const material = `GET\n/api/shops/serhant\n\n2\n${ts}`;
      const headers = {
        'X-Launchpad-Actor': '2',
        'X-Launchpad-Ts': ts,
        'X-Launchpad-Sig': crypto.createHmac('sha256', MCP_SECRET).update(material).digest('hex'),
      };
      const first = await fetch(`${base}/api/shops/serhant`, { headers });
      ok('the signed call itself works', first.status === 200, first.status);

      const elsewhere = await fetch(`${base}/api/shops/michael-kors`, { headers });
      ok('the same headers on another path are refused', elsewhere.status === 401, elsewhere.status);

      const otherMethod = await fetch(`${base}/api/shops/serhant`, { method: 'DELETE', headers });
      ok('the same headers on another method are refused', otherMethod.status === 401, otherMethod.status);

      const withQuery = await fetch(`${base}/api/shops/serhant?force=true`, { headers });
      ok('the same headers with a query string bolted on are refused', withQuery.status === 401, withQuery.status);
    }
    {
      // A signed request may not carry a body the signature cannot cover.
      const ts = String(Date.now());
      const target = '/api/shops/serhant/files/upload-zip?path=DATABASE';
      const material = `POST\n${target}\n\n2\n${ts}`;
      const boundary = '----authztest';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\nPK\r\n--${boundary}--\r\n`;
      const res = await fetch(base + target, {
        method: 'POST',
        headers: {
          'X-Launchpad-Actor': '2',
          'X-Launchpad-Ts': ts,
          'X-Launchpad-Sig': crypto.createHmac('sha256', MCP_SECRET).update(material).digest('hex'),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      ok('a signed request carrying a body outside the signature is refused', res.status === 401, res.status);
    }

    // -- security review M1: upload-zip cannot reach out of the shop folder ---
    {
      const AdmZip = require(path.join(__dirname, '..', 'node_modules', 'adm-zip'));
      const zip = new AdmZip();
      zip.addFile('hello.txt', Buffer.from('pwned'));
      const zipBytes = zip.toBuffer();
      const gio = await webLogin(base, box, 'admin'); // owner of serhant in this fixture

      const post = async (query) => {
        const boundary = '----zipupload';
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\nContent-Type: application/zip\r\n\r\n`),
          zipBytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        return fetch(`${base}/api/shops/serhant/files/upload-zip${query}`, {
          method: 'POST',
          headers: {
            Cookie: gio.cookie,
            'x-csrf-token': gio.csrfToken,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });
      };

      const usersDbBefore = fs.readFileSync(box.usersDbPath);
      const traversal = await post('?path=..%2F..%2Fdata');
      const tbody = await traversal.json().catch(() => null);
      ok('upload-zip refuses a path outside the shop', traversal.status === 400, `${traversal.status} ${JSON.stringify(tbody)}`);
      ok('and refuses it in the contract shape', tbody?.error?.code === 'NOT_PERMITTED', tbody);
      ok('the backend data directory is untouched',
        fs.existsSync(box.usersDbPath) && fs.readFileSync(box.usersDbPath).equals(usersDbBefore));
      ok('and the other shop is untouched',
        fs.existsSync(path.join(box.shopsDir, 'michael-kors', 'DATABASE')));

      const otherShop = await post('?path=..%2Fmichael-kors');
      ok('upload-zip refuses another shop by name', otherShop.status === 400, otherShop.status);
      ok('michael-kors still has its DATABASE',
        fs.existsSync(path.join(box.shopsDir, 'michael-kors', 'DATABASE')));

      const wholeShop = await post('?path=.');
      ok('upload-zip refuses the shop folder itself', wholeShop.status === 400, wholeShop.status);
      ok('the shop folder survives', fs.existsSync(path.join(box.shopsDir, 'serhant', 'DATABASE')));

      const staging = await post('?path=.staging');
      ok('upload-zip refuses the staging folder', staging.status === 400, staging.status);

      // The file browser cannot delete the backups either, since that is the
      // way back from a bad apply.
      const delBackups = await gio.call('DELETE', '/api/shops/serhant/files?path=.backups');
      const delBody = await delBackups.json().catch(() => null);
      ok('the file browser cannot delete .backups', delBackups.status === 400 && delBody?.error?.code === 'NOT_PERMITTED',
        `${delBackups.status} ${JSON.stringify(delBody)}`);

      // ... and the ordinary upload the catalog editor does still works.
      const good = await post('?path=DATABASE/Uploads');
      ok('a normal upload into the shop still works', good.status === 200, `${good.status} ${await good.text()}`);
      ok('and the file landed where it was asked to',
        fs.existsSync(path.join(box.shopsDir, 'serhant', 'DATABASE', 'Uploads', 'hello.txt')));
    }
  } catch (err) {
    failed++;
    say(`FAIL  threw: ${err.stack || err.message}`);
  } finally {
    if (server) server.close();
    box.destroy();
  }

  say('');
  say(failed === 0 ? `PASS  ${passed} assertion(s).` : `FAIL  ${failed} of ${passed + failed} assertion(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
