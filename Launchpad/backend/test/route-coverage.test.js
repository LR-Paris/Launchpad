#!/usr/bin/env node
// ---------------------------------------------------------------------------
// route-coverage.test.js — ADR-001's one non-optional test.
//
// It builds the real app (index.js, in a throwaway copy of the backend) and
// walks the Express route table. Every route whose path carries a :slug must
// have a requireShopAccess guard somewhere in the chain that reaches it. A new
// shop route added next year fails this test until somebody decides, out loud,
// what access it needs.
//
// No test framework: run it with plain node. Non-zero exit means broken.
//   node backend/test/route-coverage.test.js
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const sandbox = require('./_sandbox');

// ---------------------------------------------------------------------------
// Deliberately unauthenticated. These are mounted before requireAuth on purpose
// and must keep working: the Shuttle containers post orders to the first one
// and customers click a signed link for the others.
//
// `unguarded` is the number of registrations that may legitimately have no
// guard. A second unguarded copy of the same path fails the test, so the
// authenticated twin of the cancel route cannot quietly lose its guard.
// ---------------------------------------------------------------------------
const PUBLIC_ROUTES = [
  { method: 'post', path: '/api/shops/:slug/orders/notify', unguarded: 1, why: 'Shuttle container order webhook' },
  { method: 'get', path: '/api/shops/:slug/orders/:orderId/cancel', unguarded: 1, why: 'signed customer cancellation link' },
  { method: 'post', path: '/api/shops/:slug/orders/:orderId/cancel', unguarded: 1, why: 'signed customer cancellation link (falls through to the guarded admin route when unsigned)' },
  { method: 'get', path: '/api/shops/:slug/orders/email-image/:productId', unguarded: 1, why: 'product image in an order email' },
  { method: 'get', path: '/api/shops/:slug/orders/logo', unguarded: 1, why: 'shop logo in an order email' },
  { method: 'post', path: '/api/shops/:slug/analytics/track', unguarded: 1, why: 'storefront analytics beacon' },
];

// Not shop routes at all. These live outside /api/shops and are already behind
// an admin-only router, so shop membership is not the right question for them.
// Listing them here is deliberate: a new one has to be argued for.
const ADMIN_ONLY_ROUTES = [
  { method: 'get', path: '/api/mission-control/logs/shop/:slug', why: 'mission-control is super_admin only (requireRole in mission-control.js)' },
];

// ---------------------------------------------------------------------------
// Express keeps mount paths only as regular expressions. Rebuild the path from
// the regexp source plus the param keys.
// ---------------------------------------------------------------------------
function layerPath(layer) {
  if (!layer.regexp) return '';
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^/, '');
  src = src.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  src = src.replace(/\\\/\?\$$/, '');
  src = src.replace(/\$$/, '');

  let i = 0;
  const keys = layer.keys || [];
  // Param groups look like (?:\/([^/]+?)) with an optional trailing ?
  src = src.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)\??/g, () => {
    const key = keys[i++];
    return `/:${key ? key.name : 'param'}`;
  });
  src = src.replace(/\(\[\^\/\]\+\?\)/g, () => {
    const key = keys[i++];
    return `:${key ? key.name : 'param'}`;
  });
  src = src.replace(/\\\//g, '/');
  return src;
}

function fullPath(prefix, layer) {
  const own = layer.route ? layer.route.path : layerPath(layer);
  const joined = `${prefix}${own}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

// Segment-aligned prefix match with every :param treated as a wildcard, which
// is exactly how Express decides whether a use() layer runs for a path.
function normalize(p) {
  return p.split('/').map((seg) => (seg.startsWith(':') ? '*' : seg)).join('/');
}

function covers(guardPath, routePath) {
  if (!guardPath || guardPath === '/') return true;
  const g = normalize(guardPath).split('/');
  const r = normalize(routePath).split('/');
  if (g.length > r.length) return false;
  return g.every((seg, i) => seg === r[i] || seg === '*');
}

function isGuard(fn) {
  return !!(fn && (fn.__requireShopAccess || fn.__requireAdmin));
}

// Security review M2. These three mounts predate ADR-001 and decide on the
// account role alone, so a signed tool request carrying a super_admin's id used
// to get all of them, up to creating another super_admin. denyMcp keeps the tool
// server out of the mount entirely. If somebody re-mounts one of these without
// it, this test says so before a deploy does.
const MCP_FORBIDDEN_MOUNTS = ['/api/users', '/api/system', '/api/mission-control'];

// ---------------------------------------------------------------------------
// health.js names a tool beside every check and every suggestion, and an agent
// reads those names out loud and then calls them. A name that is not a tool is
// a dead end in front of the person being helped, which is how `get_catalog`
// and `get_orders` shipped. The list of real tools lives in exactly one place,
// `health.MCP_TOOLS`; a tool added to the server is added there and nowhere
// else, and this test fails on any other name.
//
// Two forms carry a tool name: the `tool:` property in CAPABILITIES and in
// buildSuggestions, and the sixth positional argument of check(). Both are
// read off the source rather than off a payload, so a branch that only a broken
// shop reaches is checked too.
// ---------------------------------------------------------------------------

// Split a call's arguments at top-level commas, honoring quotes, comments and
// nesting, so check(id, ok, title, why, how, tool, role) can be read without a
// parser.
function callArgs(src, openParen) {
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  for (let i = openParen + 1; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && next === '*') { i = src.indexOf('*/', i) + 1; if (i < 1) break; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' && depth === 0) { args.push(src.slice(start, i)); return args; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (ch === ',' && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return args;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// Every tool name health.js hands to an agent, with the line it sits on.
function toolNamesIn(src) {
  const found = [];
  const literal = /^\s*(?:'([^']*)'|"([^"]*)")\s*$/;

  const prop = /\btool:\s*(null|'([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = prop.exec(src))) {
    if (m[1] === 'null') continue;
    found.push({ line: lineOf(src, m.index), name: m[2] !== undefined ? m[2] : m[3] });
  }

  const call = /\bcheck\(/g;
  while ((m = call.exec(src))) {
    const args = callArgs(src, m.index + m[0].length - 1);
    const sixth = args[5];
    if (sixth === undefined) continue;
    const lit = literal.exec(sixth);
    if (lit) found.push({ line: lineOf(src, m.index), name: lit[1] !== undefined ? lit[1] : lit[2] });
  }

  return found;
}

const routes = [];

function walk(stack, prefix, inherited) {
  const carried = inherited.slice();
  for (const layer of stack) {
    const p = fullPath(prefix, layer);

    if (layer.route) {
      const own = layer.route.stack.map((l) => l.handle).filter(isGuard);
      const applicable = carried.filter((g) => covers(g.path, p));
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method,
          path: p,
          guards: [...applicable.map((g) => g.path), ...own.map(() => p)],
        });
      }
      continue;
    }

    if (layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, p, carried);
      continue;
    }

    if (isGuard(layer.handle)) carried.push({ path: p, fn: layer.handle });
  }
}

// ---------------------------------------------------------------------------
function main() {
  const box = sandbox.create({ label: 'adr001-routes' });
  let failures = 0;
  const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);

  try {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);
    process.env.PORT = '0';
    process.env.NODE_ENV = 'test';

    const app = require(path.join(box.src, 'index.js'));
    const router = app._router || (app.router && app.router.stack ? app.router : null);
    if (!router || !router.stack) throw new Error('Could not read the Express route table off the app.');

    walk(router.stack, '', []);

    const slugRoutes = routes.filter((r) => /(^|\/):slug(\/|$)/.test(r.path));
    if (slugRoutes.length === 0) throw new Error('Found no :slug routes at all, which means this test is not looking at the real app.');

    say(`Walked ${routes.length} route(s); ${slugRoutes.length} carry a :slug.\n`);

    const unguarded = slugRoutes.filter((r) => r.guards.length === 0);
    const byKey = new Map();
    for (const r of unguarded) {
      const key = `${r.method} ${r.path}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);
    }

    for (const [key, count] of byKey) {
      const [method, p] = key.split(' ');
      const admin = ADMIN_ONLY_ROUTES.find((x) => x.method === method && x.path === p);
      if (admin) {
        say(`ok    ${method.toUpperCase().padEnd(6)} ${p}  (admin only: ${admin.why})`);
        continue;
      }
      const allowed = PUBLIC_ROUTES.find((x) => x.method === method && x.path === p);
      if (!allowed) {
        say(`FAIL  ${method.toUpperCase().padEnd(6)} ${p}`);
        say('      reaches a handler with no requireShopAccess in its chain.');
        failures++;
      } else if (count > allowed.unguarded) {
        say(`FAIL  ${method.toUpperCase().padEnd(6)} ${p}`);
        say(`      ${count} unguarded registrations, expected ${allowed.unguarded} (${allowed.why}).`);
        failures++;
      } else {
        say(`ok    ${method.toUpperCase().padEnd(6)} ${p}  (public on purpose: ${allowed.why})`);
      }
    }

    const guarded = slugRoutes.filter((r) => r.guards.length > 0);
    for (const r of guarded) say(`ok    ${r.method.toUpperCase().padEnd(6)} ${r.path}`);

    // A public route that disappears is also a problem: it means the allowlist
    // is stale and is now hiding something.
    for (const allowed of PUBLIC_ROUTES) {
      const key = `${allowed.method} ${allowed.path}`;
      if (!byKey.has(key)) {
        say(`FAIL  ${allowed.method.toUpperCase().padEnd(6)} ${allowed.path}`);
        say('      is on the public allowlist but no longer exists unguarded. Remove it from PUBLIC_ROUTES.');
        failures++;
      }
    }

    // -- M2: the admin mounts a signed request may never enter ---------------
    {
      const denied = [];
      const walkDeny = (stack, prefix) => {
        for (const layer of stack) {
          const p = fullPath(prefix, layer);
          if (layer.handle && layer.handle.__denyMcp) denied.push(p);
          if (layer.handle && layer.handle.stack) walkDeny(layer.handle.stack, p);
        }
      };
      walkDeny(router.stack, '');
      for (const mount of MCP_FORBIDDEN_MOUNTS) {
        if (denied.includes(mount)) {
          say(`ok    ${mount} is closed to signed tool requests`);
        } else {
          say(`FAIL  ${mount} has no denyMcp guard: a signed request reaches the admin router.`);
          failures++;
        }
      }
    }

    // -- M3: nothing on an extract path may trust the zip's own sizes ---------
    {
      for (const file of ['staging.js', 'files.js']) {
        const src = fs.readFileSync(path.join(box.src, file), 'utf8');
        if (/\.getData\(/.test(src)) {
          say(`FAIL  ${file} calls entry.getData(), which allocates from the size the zip declares.`);
          failures++;
        } else if (!/require\('\.\/safe-zip'\)/.test(src)) {
          say(`FAIL  ${file} does not read zip entries through safe-zip.js.`);
          failures++;
        } else {
          say(`ok    ${file} reads zip entries with a real output cap`);
        }
      }
    }

    // -- every tool health.js names is a tool that exists --------------------
    {
      const healthPath = path.join(box.src, 'health.js');
      const health = require(healthPath);
      const tools = health.MCP_TOOLS;
      if (!Array.isArray(tools) || tools.length === 0) {
        say('FAIL  health.js exports no MCP_TOOLS, so nothing ties the names it reads out to the real tool server.');
        failures++;
      } else {
        const named = toolNamesIn(fs.readFileSync(healthPath, 'utf8'));
        if (named.length === 0) {
          say('FAIL  found no tool names in health.js at all, which means this test is not reading the real file.');
          failures++;
        }
        const bad = named.filter((n) => !tools.includes(n.name));
        for (const n of bad) {
          say(`FAIL  health.js line ${n.line} names "${n.name}", which is not a tool.`);
          say(`      Use one of the ${tools.length} in health.MCP_TOOLS, or set tool: null and say in the text who does it.`);
          failures++;
        }
        if (bad.length === 0) {
          say(`ok    all ${named.length} tool name(s) in health.js are real tools`);
        }
      }
    }

    say('');
    say(failures === 0
      ? `PASS  every :slug route is behind requireShopAccess (${guarded.length} guarded, ${byKey.size} public by design), the admin mounts are closed to MCP, no extract path trusts a declared size, and health.js names only real tools.`
      : `FAIL  ${failures} problem(s).`);
  } catch (err) {
    say(`FAIL  ${err.stack || err.message}`);
    failures++;
  } finally {
    box.destroy();
  }

  // index.js starts background pollers, so exit rather than waiting for them.
  process.exit(failures === 0 ? 0 : 1);
}

main();
