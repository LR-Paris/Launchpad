const express = require('express');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const slugify = require('slugify');
const { generateShopConfig, removeShopConfig, reloadNginx } = require('./nginx');

const { checkShopPermission, isAdminOrAbove } = require('./users');
const { acquire: lockAcquire, release: lockRelease, isLocked } = require('./lock');
const { requireShopAccess, audit, membershipRole, setShopRole, refuse, currentLock } = require('./authz');
const {
  injectStageBanner, applyShopStage, effectiveStage,
} = require('./golive');

// Shop-to-launchpad gateway IP — same value the shop containers use to reach
// the launchpad in their generated .env file. Docker default bridge gateway.
const HOST_GATEWAY = '172.17.0.1';

// Shops where is_building=1 stay flagged until either an HTTP probe succeeds
// or this many ms elapse since build_started_at (defensive timeout).
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

const router = express.Router();

// ---------------------------------------------------------------------------
// ADR-001. index.js mounts resolveShopAndRole + a viewer/editor/owner floor on
// every /api/shops/:slug path before any of these routers see the request.
// What follows only RAISES that floor for the handful of actions that deserve
// more than "an editor may do it". Mounted on paths, not decorated onto
// handlers, so a new method on the same path inherits the same bar.
// ---------------------------------------------------------------------------
router.use('/:slug/update-template', requireShopAccess('owner'));
router.use('/:slug/upgrade', requireShopAccess('owner'));
// Stage changes live in golive.js (PUT /:slug/stage), which also syncs
// lifecycle_status and rebuilds the shop so the internal-only banner moves with
// it. The raise here covers that path at the router level whatever method it
// grows next; golive.js gates in_production on a real admin itself.
router.use('/:slug/stage', requireShopAccess('owner'));
router.use('/:slug/deploy', requireShopAccess('owner'));

const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------------------------------------------------------------------------
// Slugs that are already routed at the host level, and so can never be a shop.
//
// A shop's slug becomes `location /<slug>/` in nginx, appended to
// shops-locations.inc by generateShopConfig. Creating a shop called "mcp" would
// append a SECOND `location /mcp/` next to the tool server's own block, and
// nginx -t would then fail. That does not break one shop, it breaks every later
// reload on the whole platform, including the one that would undo it. Cheaper
// to refuse the name.
//
// Keep this list in step with whatever the lrparisstore.com server block routes
// by hand. Everything under /api and the SPA's own paths are here for the same
// reason: a shop that shadows them is a shop that eats the console.
// ---------------------------------------------------------------------------
const RESERVED_SLUGS = new Set([
  'mcp',           // the Shuttle dev tool (deploy/mcp-locations.inc)
  'api',           // the Launchpad backend
  'review',        // the client review page, /review/:token
  'well-known',    // OAuth discovery lives at /.well-known/...
  '_next',         // Next.js build output
  'assets', 'static', 'public',
  'login', 'logout', 'shops', 'users', 'settings', 'profile',
  'launchpad', 'admin', 'health', 'upload', 'system', 'mission-control',
]);

function reservedSlugError(slug) {
  if (!RESERVED_SLUGS.has(slug)) return null;
  return `"${slug}" is reserved for the platform and cannot be a shop URL. Pick another URL path.`;
}

// Where a shop actually answers, so a tool can hand back a link rather than a
// slug. Shops are path-routed under the Launchpad host: lrparisstore.com/<slug>/
function shopUrl(slug) {
  const base = (process.env.SHOP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  return base ? `${base}/${slug}/` : `/${slug}/`;
}

// Creating a shop is gated on users.can_create_shops, a column that has been on
// the user row since February and was never read. Admins are implicitly allowed.
function canCreateShops(req) {
  const user = req.session?.user;
  if (!user) return false;
  // Admin is a web-console fact. Over MCP even Gio is judged by the column, the
  // same as everyone else.
  if (req.via !== 'mcp' && (user.role === 'super_admin' || user.role === 'admin')) return true;
  try {
    const udb = new Database(path.join(DATA_DIR, 'users.db'), { readonly: true });
    try {
      const row = udb.prepare('SELECT can_create_shops FROM users WHERE id = ?').get(user.id);
      return !!(row && row.can_create_shops);
    } finally {
      udb.close();
    }
  } catch (err) {
    console.error(`[shops] can_create_shops lookup failed: ${err.message}`);
    return false;
  }
}
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const DB_PATH = path.join(DATA_DIR, 'shops.db');
const TEMPLATE_REPO = 'https://github.com/LR-Paris/Shuttle';
const BASE_PORT = 8100;

// When running inside Docker, docker compose needs HOST-side paths for volumes/files.
// HOST_PROJECT_DIR is injected by docker-compose.yml via environment and should be
// the ACTUAL host filesystem path (e.g. /home/user/Launchpad), NOT a container path.
// This is critical because docker compose communicates with the host Docker daemon
// via the socket, and bind-mount source paths must exist on the host.

// Path used for docker compose -f (must be readable from inside this container)
function getComposeFilePath(slug) {
  if (fs.existsSync('/host/project')) {
    return path.join('/host/project/shops', slug, 'docker-compose.yml');
  }
  return path.join(SHOPS_DIR, slug, 'docker-compose.yml');
}

// Actual host-side path for a shop directory (used in volume mounts so the
// host Docker daemon can find the files)
function getHostShopDir(slug) {
  if (process.env.HOST_PROJECT_DIR) {
    return path.join(process.env.HOST_PROJECT_DIR, 'shops', slug);
  }
  return path.join(SHOPS_DIR, slug);
}

// Read and return the shop's package.json version.  After a git pull or
// template sync this reflects the template's latest version, which drives
// the version-aware build guard in the shop's docker-compose command.
function readShopVersion(shopDir) {
  try {
    const pkgPath = path.join(shopDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// Ensure the shop's package.json version matches a given template version.
// This makes the version-aware build guard detect a source change and rebuild.
function syncShopVersion(shopDir, slug, templateVersion) {
  if (!templateVersion) return;
  const pkgPath = path.join(shopDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== templateVersion) {
      pkg.version = templateVersion;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`[${slug}] Bumped package.json version to ${templateVersion}`);
    }
  } catch (err) {
    console.error(`[${slug}] Could not sync package.json version: ${err.message}`);
  }
}

// Clear stale .next/ build cache so the container always rebuilds on next boot.
// This prevents serving an outdated bundle after source files have been updated.
function clearBuildCache(shopDir, slug) {
  const nextDir = path.join(shopDir, '.next');
  if (fs.existsSync(nextDir)) {
    fs.rmSync(nextDir, { recursive: true, force: true });
    console.log(`[${slug}] Cleared stale .next/ build cache`);
  }
}

function getDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'stopped',
      created_at TEXT DEFAULT (datetime('now')),
      port INTEGER NOT NULL,
      subdomain TEXT NOT NULL
    )
  `);

  // Migrate: add description column if missing (existing databases)
  const cols = db.pragma('table_info(shops)').map(c => c.name);
  if (!cols.includes('description')) {
    db.exec("ALTER TABLE shops ADD COLUMN description TEXT DEFAULT ''");
  }
  if (!cols.includes('shuttle_version')) {
    db.exec("ALTER TABLE shops ADD COLUMN shuttle_version TEXT DEFAULT NULL");
  }
  if (!cols.includes('lifecycle_status')) {
    db.exec("ALTER TABLE shops ADD COLUMN lifecycle_status TEXT DEFAULT 'none'");
  }
  // 4.0 additions — backwards compatible: existing rows default to 0/'en'
  if (!cols.includes('is_building')) {
    db.exec('ALTER TABLE shops ADD COLUMN is_building INTEGER DEFAULT 0');
  }
  if (!cols.includes('build_started_at')) {
    db.exec('ALTER TABLE shops ADD COLUMN build_started_at INTEGER DEFAULT 0');
  }
  if (!cols.includes('language')) {
    db.exec("ALTER TABLE shops ADD COLUMN language TEXT DEFAULT 'en'");
  }

  return db;
}

function getNextPort(db) {
  const row = db.prepare('SELECT MAX(port) as max_port FROM shops').get();
  return row.max_port ? row.max_port + 1 : BASE_PORT;
}

function getContainerStatus(slug) {
  try {
    const composeFile = getComposeFilePath(slug);
    const result = execSync(
      `docker compose -f ${composeFile} ps --format json`,
      { stdio: 'pipe', encoding: 'utf8' }
    );
    if (result.trim()) {
      const containers = result.trim().split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      if (containers.length > 0 && containers[0].State === 'running') {
        return 'running';
      }
    }
    return 'stopped';
  } catch {
    return 'stopped';
  }
}

// Async TCP probe — resolves true if the shop's port accepts connections.
// Used by the background poller to clear is_building once Next.js is ready.
function probeShopPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: HOST_GATEWAY, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// Resolve a shop's effective live status, taking is_building into account.
// Backwards-compatible: shops with NULL/0 is_building get the legacy behavior.
function resolveLiveStatus(shop) {
  const containerStatus = getContainerStatus(shop.slug);
  if (containerStatus !== 'running') return containerStatus; // stopped or error

  const buildingFlag = Number(shop.is_building) || 0;
  if (!buildingFlag) return 'running';

  const startedAt = Number(shop.build_started_at) || 0;
  if (startedAt && Date.now() - startedAt > BUILD_TIMEOUT_MS) {
    // Timed out — defensively clear and treat as running
    try {
      const db = getDb();
      try {
        db.prepare('UPDATE shops SET is_building = 0 WHERE slug = ?').run(shop.slug);
      } finally { db.close(); }
    } catch { /* ignore */ }
    return 'running';
  }
  return 'building';
}

// Background poller: every 10s, sweep all shops with is_building=1 and clear
// the flag when their port accepts connections. Runs once on module init.
let _builderPollerStarted = false;
function startBuildingPoller() {
  if (_builderPollerStarted) return;
  _builderPollerStarted = true;

  const tick = async () => {
    try {
      const db = getDb();
      let buildingShops;
      try {
        buildingShops = db.prepare(
          'SELECT slug, port, build_started_at FROM shops WHERE is_building = 1'
        ).all();
      } finally { db.close(); }

      for (const s of buildingShops) {
        const ready = await probeShopPort(s.port);
        if (ready) {
          const db2 = getDb();
          try {
            db2.prepare('UPDATE shops SET is_building = 0 WHERE slug = ?').run(s.slug);
          } finally { db2.close(); }
          lockRelease(s.slug);
          console.log(`[shops] ${s.slug} is now reachable — cleared is_building flag`);
        }
      }
    } catch (err) {
      console.error('[shops] building poller error:', err.message);
    }
  };
  setInterval(tick, 10 * 1000);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Recursively find files matching a pattern (e.g. page.tsx) under a directory
function findFilesSync(dir, filename) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
      results.push(...findFilesSync(full, filename));
    } else if (entry.name === filename) {
      results.push(full);
    }
  }
  return results;
}

// Insert an import line into file content, respecting 'use client' / 'use server'
// directives which must remain the very first statement in Next.js App Router files.
function insertImport(content, importLine) {
  const directivePattern = /^(\s*(['"`])use (client|server)\2[;\s]*\n)/;
  const match = content.match(directivePattern);
  if (match) {
    // Insert after the directive line
    return match[1] + importLine + '\n' + content.slice(match[1].length);
  }
  return importLine + '\n' + content;
}

// Ensure a named export is imported from '@/lib/api'.  If the file has no
// import from that module yet, add a fresh import line (respecting 'use client').
// If one exists but is missing the requested name, append it to the specifier list.
function ensureApiImport(content, name) {
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/api['"]/;
  const match = content.match(importPattern);

  if (!match) {
    return insertImport(content, `import { ${name} } from '@/lib/api';`);
  }

  // Check whether this name is already in the import specifiers
  const specifiers = match[1].split(',').map(s => s.trim());
  if (specifiers.includes(name)) return content;

  // Append the name to the existing import
  return content.replace(importPattern, (m, existing) => {
    return `import {${existing}, ${name} } from '@/lib/api'`;
  });
}

// After cloning a shop, replace all fetch('/api/...') calls with apiFetch()
// so path-based routing works correctly behind the nginx reverse proxy.
// Scans all .tsx/.ts/.jsx files in app/ and components/ (not just page.tsx)
// so that layout.tsx, Header.tsx, checkout, etc. are all covered.
function patchShopFetchCalls(shopDir) {
  const appDir = path.join(shopDir, 'app');
  const componentsDir = path.join(shopDir, 'components');
  const sourceFiles = [
    ...findFilesByExtSync(appDir, ['.tsx', '.ts', '.jsx']),
    ...findFilesByExtSync(componentsDir, ['.tsx', '.ts', '.jsx']),
  ];
  let patched = 0;

  for (const file of sourceFiles) {
    let content = fs.readFileSync(file, 'utf8');

    // Skip files that don't use fetch('/api/
    if (!content.includes("fetch('/api/") && !content.includes('fetch("/api/') && !content.includes('fetch(`/api/')) {
      continue;
    }

    // Replace fetch('/api/...' with apiFetch('/...'
    content = content
      .replace(/fetch\('\/api\//g, "apiFetch('/")
      .replace(/fetch\("\/api\//g, 'apiFetch("/')
      .replace(/fetch\(`\/api\//g, "apiFetch(`/");

    // Add the import if not already present
    if (!content.includes('apiFetch')) {
      // Shouldn't happen after replacement, but guard anyway
      continue;
    }
    content = ensureApiImport(content, 'apiFetch');

    fs.writeFileSync(file, content);
    patched++;
  }

  return patched;
}

// Recursively find files matching any of the given extensions under a directory
function findFilesByExtSync(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
      results.push(...findFilesByExtSync(full, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

// After cloning a shop, replace literal public asset paths (e.g. src="/logo.png")
// with basePath-prefixed template literals so they resolve under path-based routing.
function patchShopPublicAssets(shopDir, slug) {
  const appDir = path.join(shopDir, 'app');
  const componentsDir = path.join(shopDir, 'components');
  let patched = 0;

  // ── 1. Patch TSX/JSX files ──────────────────────────────
  const tsxFiles = [
    ...findFilesByExtSync(appDir, ['.tsx', '.jsx']),
    ...findFilesByExtSync(componentsDir, ['.tsx', '.jsx']),
  ];

  // Asset extensions typically in /public
  const assetExts = '(?:png|jpg|jpeg|svg|ico|gif|webp|woff2?|otf|ttf|eot|css)';
  const srcPattern = new RegExp(`(src=)"(\\/[^"]+\\.${assetExts})"`, 'g');
  const hrefPattern = new RegExp(`(href=)"(\\/[^"]+\\.${assetExts})"`, 'g');

  for (const file of tsxFiles) {
    let content = fs.readFileSync(file, 'utf8');
    const origContent = content;

    // src="/foo.png" → src={`${basePath}/foo.png`}
    content = content.replace(srcPattern, (match, attr, assetPath) => {
      return `${attr}{\`\${basePath}${assetPath}\`}`;
    });

    // href="/styles.css" → href={`${basePath}/styles.css`}
    content = content.replace(hrefPattern, (match, attr, assetPath) => {
      return `${attr}{\`\${basePath}${assetPath}\`}`;
    });

    if (content !== origContent) {
      content = ensureApiImport(content, 'basePath');
      fs.writeFileSync(file, content);
      patched++;
    }
  }

  // ── 2. Patch CSS files ──────────────────────────────────
  // CSS can't use JS vars, so replace url('/...) with url('/slug/...') literally
  const cssFiles = findFilesByExtSync(shopDir, ['.css']);

  for (const file of cssFiles) {
    let content = fs.readFileSync(file, 'utf8');
    const origContent = content;

    // url('/  → url('/slug/   (but not url('// for protocol-relative)
    content = content.replace(/url\(\s*'\/(?!\/)/g, `url('/${slug}/`);
    content = content.replace(/url\(\s*"\/(?!\/)/g, `url("/${slug}/`);

    if (content !== origContent) {
      fs.writeFileSync(file, content);
      patched++;
    }
  }

  return patched;
}

// Patch dynamic font/asset URL references in layout.tsx files.
// The Shuttle template uses href={design.fonts.titleFontUrl} which can be a local
// path like "/fonts/kors-sans.css" or an external URL like "https://fonts.googleapis.com/...".
// We wrap these with assetUrl() so local paths get the basePath prefix automatically.
function patchShopDynamicUrls(shopDir) {
  const appDir = path.join(shopDir, 'app');
  const layoutFiles = findFilesSync(appDir, 'layout.tsx');
  let patched = 0;

  for (const file of layoutFiles) {
    let content = fs.readFileSync(file, 'utf8');
    const origContent = content;

    // Match href={something.somethingUrl} or href={something.somethingUrl || ...}
    // and wrap with assetUrl():  href={assetUrl(something.somethingUrl)} etc.
    // Covers patterns like: href={design.fonts.titleFontUrl}
    content = content.replace(
      /href=\{([^}]+(?:Url|url|URL)[^}]*)\}/g,
      (match, expr) => {
        // Don't double-wrap if already using assetUrl
        if (expr.includes('assetUrl')) return match;
        return `href={assetUrl(${expr.trim()})}`;
      }
    );

    if (content !== origContent) {
      content = ensureApiImport(content, 'assetUrl');
      fs.writeFileSync(file, content);
      patched++;
    }
  }

  return patched;
}

// Add BASE_PATH prefix to image URLs in the Shuttle template's lib/design.ts
// and lib/catalog.ts so that images resolve correctly when the shop is deployed
// to a subdirectory (e.g. /michael-kors/api/images/...).
function patchShopImageUrls(shopDir) {
  let patched = 0;

  // ── lib/design.ts ───────────────────────────────────────
  const designPath = path.join(shopDir, 'lib', 'design.ts');
  if (fs.existsSync(designPath)) {
    let content = fs.readFileSync(designPath, 'utf8');
    const orig = content;

    // Logo URLs:  `/api/images/logos/${filename}`  →  `${BASE_PATH}/api/images/logos/${filename}`
    content = content.replace(
      /`\/api\/images\/logos\//g,
      '`${BASE_PATH}/api/images/logos/'
    );

    // Showcase/hero images:  `/api/images/showcase/${file}`  →  `${BASE_PATH}/api/images/showcase/${file}`
    content = content.replace(
      /`\/api\/images\/showcase\//g,
      '`${BASE_PATH}/api/images/showcase/'
    );

    // Ensure BASE_PATH is defined at the top of the file
    if (content !== orig) {
      if (!content.includes("const BASE_PATH") && !content.includes("let BASE_PATH")) {
        content = "const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';\n" + content;
      }
      fs.writeFileSync(designPath, content);
      patched++;
    }
  }

  // ── lib/catalog.ts ──────────────────────────────────────
  const catalogPath = path.join(shopDir, 'lib', 'catalog.ts');
  if (fs.existsSync(catalogPath)) {
    let content = fs.readFileSync(catalogPath, 'utf8');
    const orig = content;

    // Product images:  `/api/images/products/${productId}/${file}`  →  `${BASE_PATH}/api/images/products/${productId}/${file}`
    content = content.replace(
      /`\/api\/images\/products\//g,
      '`${BASE_PATH}/api/images/products/'
    );

    // Ensure BASE_PATH is defined
    if (content !== orig) {
      if (!content.includes("const BASE_PATH") && !content.includes("let BASE_PATH")) {
        content = "const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';\n" + content;
      }
      fs.writeFileSync(catalogPath, content);
      patched++;
    }
  }

  return patched;
}

// Namespace the cart localStorage key with the shop slug so carts don't
// bleed between shops sharing the same domain (path-based routing).
function patchShopCartKey(shopDir, slug) {
  const cartPath = path.join(shopDir, 'lib', 'cart.ts');
  if (!fs.existsSync(cartPath)) return 0;

  let content = fs.readFileSync(cartPath, 'utf8');
  if (!content.includes("const CART_KEY = 'b2b_cart'")) return 0;

  content = content.replace(
    "const CART_KEY = 'b2b_cart';",
    `const CART_KEY = 'b2b_cart_${slug}';`
  );

  fs.writeFileSync(cartPath, content);
  return 1;
}

function patchShopAnalytics(shopDir) {
  // Write the Analytics tracker component if it doesn't exist
  const componentsDir = path.join(shopDir, 'components');
  fs.mkdirSync(componentsDir, { recursive: true });
  const analyticsComponentPath = path.join(componentsDir, 'Analytics.tsx');
  if (!fs.existsSync(analyticsComponentPath)) {
    fs.writeFileSync(analyticsComponentPath, `'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

export default function AnalyticsTracker() {
  const pathname = usePathname();
  const sent = useRef<string>('');

  useEffect(() => {
    if (sent.current === pathname) return;
    sent.current = pathname;

    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    const slug = basePath.replace(/^\//, '');
    const apiBase = process.env.NEXT_PUBLIC_LAUNCHPAD_API || '';

    const productMatch = pathname.match(/\/products?\/([^/?#]+)/);

    const payload = JSON.stringify({
      path: pathname,
      referrer: document.referrer || null,
      screenWidth: window.innerWidth,
      productSlug: productMatch?.[1] || null,
    });

    const url = \`\${apiBase}/api/shops/\${slug}/analytics/track\`;

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
      }).catch(() => {});
    }
  }, [pathname]);

  return null;
}
`);
  }

  const layoutPath = path.join(shopDir, 'app', 'layout.tsx');
  if (!fs.existsSync(layoutPath)) return 0;

  let content = fs.readFileSync(layoutPath, 'utf8');

  // Already patched
  if (content.includes('AnalyticsTracker')) return 0;

  // Add import at top (after last import statement)
  const importLine = "import AnalyticsTracker from '@/components/Analytics';";
  const lastImportIdx = content.lastIndexOf('\nimport ');
  if (lastImportIdx >= 0) {
    const lineEnd = content.indexOf('\n', lastImportIdx + 1);
    content = content.slice(0, lineEnd + 1) + importLine + '\n' + content.slice(lineEnd + 1);
  } else {
    content = importLine + '\n' + content;
  }

  // Insert <AnalyticsTracker /> right after <body...>
  content = content.replace(
    /(<body[^>]*>)/,
    '$1\n        <AnalyticsTracker />'
  );

  fs.writeFileSync(layoutPath, content);
  return 1;
}

// POST /api/shops — Create new shop (admin only)
router.post('/', (req, res) => {
  // Admin-only was the old rule, and it made create_shop dead on arrival: an
  // MCP request is never admin, so nobody could ever create a shop through the
  // dev tool, including Gio. The real permission already exists as a column on
  // the user row, so that is what gates it now. Admins keep the ability by
  // virtue of being admins.
  if (!canCreateShops(req)) {
    return refuse(res, 403, 'NOT_PERMITTED',
      'You are not set up to create shops.',
      'Ask Gio to turn on "can create shops" for your account in Launchpad.', false);
  }
  const { name, folderPath, description, shopType, dataRequired, hotelList } = req.body;
  let { slug: customSlug } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Shop name is required' });
  }

  // Use custom slug if provided, otherwise generate from name
  const slug = customSlug
    ? slugify(customSlug, { lower: true, strict: true })
    : slugify(name, { lower: true, strict: true });
  if (!slug) {
    return res.status(400).json({ error: 'Invalid shop name / URL path' });
  }
  const reserved = reservedSlugError(slug);
  if (reserved) {
    return refuse(res, 409, 'NOT_PERMITTED', reserved, 'Pick a different URL path for the shop.', false);
  }

  const shopDir = path.join(SHOPS_DIR, slug);
  if (fs.existsSync(shopDir)) {
    return res.status(409).json({ error: 'Shop with this slug already exists' });
  }

  const db = getDb();

  try {
    const existing = db.prepare('SELECT id FROM shops WHERE slug = ?').get(slug);
    if (existing) {
      return res.status(409).json({ error: 'Shop with this slug already exists' });
    }

    const port = getNextPort(db);
    const subdomain = slug;
    const log = [];

    // Clone or copy shop files
    if (folderPath) {
      if (!fs.existsSync(folderPath)) {
        return res.status(400).json({ error: 'Source folder not found' });
      }
      copyDirSync(folderPath, shopDir);
      log.push(`Copied files from ${folderPath}`);
    } else {
      log.push(`Cloning template from ${TEMPLATE_REPO}...`);
      try {
        const cloneOut = execSync(`git clone ${TEMPLATE_REPO} ${shopDir} 2>&1`, {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        log.push(cloneOut || 'Clone complete.');
      } catch (cloneErr) {
        const msg = cloneErr.stderr?.toString() || cloneErr.stdout?.toString() || cloneErr.message;
        log.push(`Clone error: ${msg}`);
        throw new Error(`git clone failed: ${msg}`);
      }
    }

    // Apply path-based routing overrides (next.config.js, lib/api.ts, etc.)
    const overridesDir = path.join(TEMPLATES_DIR, 'shop-overrides');
    if (fs.existsSync(overridesDir)) {
      copyDirSync(overridesDir, shopDir);
      log.push('Applied path-based routing overrides.');
    }

    // Patch fetch('/api/...') → apiFetch('/...') in all page files
    const patchedCount = patchShopFetchCalls(shopDir);
    if (patchedCount > 0) {
      log.push(`Patched ${patchedCount} page file(s) to use apiFetch().`);
    }

    // Patch public asset paths (images, fonts, CSS) to include basePath
    const assetPatchCount = patchShopPublicAssets(shopDir, slug);
    if (assetPatchCount > 0) {
      log.push(`Patched ${assetPatchCount} file(s) with basePath for public assets.`);
    }

    // Patch dynamic URL references (e.g. font URLs in layout.tsx) to use assetUrl()
    const dynamicPatchCount = patchShopDynamicUrls(shopDir);
    if (dynamicPatchCount > 0) {
      log.push(`Patched ${dynamicPatchCount} layout file(s) with assetUrl() for dynamic URLs.`);
    }

    // Rewrite image URLs from path-based to query-param-based so Next.js
    // doesn't cache them as static 404s (file extensions in URLs trick the router)
    const imagePatchCount = patchShopImageUrls(shopDir);
    if (imagePatchCount > 0) {
      log.push(`Patched ${imagePatchCount} lib file(s) with query-param image URLs.`);
    }

    // Namespace cart localStorage key per shop
    const cartPatchCount = patchShopCartKey(shopDir, slug);
    if (cartPatchCount > 0) {
      log.push('Patched cart localStorage key for shop isolation.');
    }

    // Inject analytics tracker into layout
    const analyticsPatchCount = patchShopAnalytics(shopDir);
    if (analyticsPatchCount > 0) {
      log.push('Injected analytics tracker into shop layout.');
    }

    // Render the internal-only banner and the robots tag from the layout, so no
    // page can leave them out. New shops start unapproved.
    const stageBannerPatched = injectStageBanner(shopDir);
    if (stageBannerPatched > 0) {
      log.push('Injected stage banner into shop layout.');
    }

    // Create orders directory
    fs.mkdirSync(path.join(shopDir, 'orders'), { recursive: true });
    log.push('Created orders directory.');

    // Write STS-2.01 preset files if shop type specified
    if (shopType) {
      fs.mkdirSync(path.join(shopDir, 'DATABASE', 'Presets'), { recursive: true });

      fs.writeFileSync(
        path.join(shopDir, 'DATABASE', 'Presets', 'ShopType.txt'),
        `type: ${shopType}`
      );

      const dr = dataRequired || {};
      const drContent = [
        `address: ${dr.address !== false}`,
        `details: ${dr.details !== false}`,
        `extra_notes: ${dr.extra_notes !== false}`,
        `shipping_handler: ${dr.shipping_handler !== false}`,
        `hotel_list: ${dr.hotel_list === true}`,
      ].join('\n');
      fs.writeFileSync(
        path.join(shopDir, 'DATABASE', 'Presets', 'DataRequired.txt'),
        drContent
      );

      if (dr.hotel_list && hotelList) {
        fs.mkdirSync(path.join(shopDir, 'DATABASE', 'Design', 'Details'), { recursive: true });
        fs.writeFileSync(
          path.join(shopDir, 'DATABASE', 'Design', 'Details', 'Hotels.txt'),
          hotelList
        );
      }

      log.push(`Configured shop presets: type=${shopType}.`);
    }

    // Write .env for shop (includes base path vars for path-based routing)
    const launchpadPort = process.env.PORT || 3001;
    const envContent = `SHOP_NAME=${name}\nSHOP_SLUG=${slug}\nSHOP_PORT=${port}\nBASE_PATH=/${slug}\nPUBLIC_URL=/${slug}\nNEXT_PUBLIC_BASE_PATH=/${slug}\nLAUNCHPAD_API_URL=http://172.17.0.1:${launchpadPort}\nNEXT_PUBLIC_LAUNCHPAD_API=\n`;
    fs.writeFileSync(path.join(shopDir, '.env'), envContent);
    log.push('Wrote shop .env file.');

    // Copy and configure docker-compose.yml from template
    const templatePath = path.join(TEMPLATES_DIR, 'shop-docker-compose.yml');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found at ${templatePath}. Check that the templates directory is mounted.`);
    }
    const template = fs.readFileSync(templatePath, 'utf8');
    const hostShopDir = getHostShopDir(slug);
    fs.writeFileSync(
      path.join(shopDir, 'docker-compose.yml'),
      template
        .replace(/{PORT}/g, String(port))
        .replace(/{SHOP_DIR}/g, hostShopDir)
        .replace(/{SLUG}/g, slug)
        .replace(/{STAGE}/g, 'no_status')
    );
    log.push(`Configured shop docker-compose.yml on port ${port}.`);

    // Generate nginx config
    generateShopConfig(slug, port);
    log.push('Generated nginx config.');

    // Register in database
    const shopVersion = readShopVersion(shopDir) || 'unknown';
    db.prepare(
      'INSERT INTO shops (slug, name, description, status, port, subdomain, shuttle_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(slug, name, description || '', 'stopped', port, subdomain, shopVersion);

    // Start the container using container-readable path
    const hostComposeFile = getComposeFilePath(slug);
    log.push(`Starting container with: docker compose -f ${hostComposeFile} up -d`);
    try {
      const upOut = execSync(
        `docker compose -f ${hostComposeFile} up -d 2>&1`,
        { stdio: 'pipe', encoding: 'utf8' }
      );
      log.push(upOut || 'Container started.');
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    } catch (upErr) {
      const msg = upErr.stderr?.toString() || upErr.stdout?.toString() || upErr.message;
      log.push(`Container start error: ${msg}`);
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
    }

    // Reload nginx
    reloadNginx();
    log.push('Nginx reloaded.');

    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);

    // A shop with no owner is a shop nobody can grant access to, and every
    // refusal on it would have to name an admin instead of a person. The
    // creator owns what they create.
    try {
      if (req.session?.user?.id) setShopRole(req.session.user.id, slug, 'owner', req.session.user.id);
    } catch (roleErr) {
      console.error(`[shops] could not set creator as owner of ${slug}: ${roleErr.message}`);
    }

    const audit_id = audit(req, 'shop_created', { slug, name });
    res.status(201).json({ shop, url: shopUrl(slug), role: 'owner', audit_id, log: log.join('\n') });
  } catch (err) {
    // Cleanup on failure
    console.error(`[shops] create ${slug} error:`, err.message);
    if (fs.existsSync(shopDir)) {
      fs.rmSync(shopDir, { recursive: true, force: true });
    }
    res.status(500).json({ error: 'Failed to create shop.' });
  } finally {
    db.close();
  }
});

// GET /api/shops — the shop list.
//
// TWO ANSWERS, DELIBERATELY.
//
// Over MCP this is membership filtered for everybody, admins included: the
// admin bypass is off there, so an agent acting as Gio lists exactly the shops
// Gio was granted and the tool never widens anyone. That is the rule the ADR
// cares about, and /api/mcp/my-shops is the route the dev tool actually calls.
//
// On the web it still returns every shop to every signed-in user, because the
// Launchpad SPA has always shown the full list and narrowing it is a change to
// a product this ADR is not scoped to touch. Several people have no
// user_shop_permissions row at all today, and they would open the console to an
// empty dashboard with no way to ask for anything. Set
// LAUNCHPAD_STRICT_SHOP_LIST=true to filter the web list too, once every person
// who should see a shop has a row for it (run scripts/migrate-adr001.js first,
// then check). Each entry carries `role`, so the UI can already tell the
// difference between a shop you own and one you are only looking at.
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const shops = db.prepare('SELECT * FROM shops ORDER BY created_at DESC').all();

    const user = req.session?.user;
    const viaMcp = req.via === 'mcp';
    const strictWeb = process.env.LAUNCHPAD_STRICT_SHOP_LIST === 'true';
    const seeEverything = !viaMcp && (user?.role === 'super_admin' || !strictWeb);

    const visible = seeEverything
      ? shops.map(shop => ({
        ...shop,
        role: user?.role === 'super_admin' ? 'owner' : (membershipRole(user.id, shop.slug) || null),
      }))
      : shops
        .map(shop => ({ shop, role: user ? membershipRole(user.id, shop.slug) : null }))
        .filter(({ role }) => !!role)
        .map(({ shop, role }) => ({ ...shop, role }));

    // Update live status (honors is_building flag with HTTP-port probe via poller)
    const updatedShops = visible.map(shop => ({
      ...shop,
      status: resolveLiveStatus(shop),
      locked: isLocked(shop.slug),
    }));

    res.json({ shops: updatedShops });
  } catch (err) {
    console.error('[shops] list error:', err.message);
    res.status(500).json({ error: 'Failed to list shops.' });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug — Get single shop
router.get('/:slug', (req, res) => {
  const { slug } = req.params;
  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json({
      shop: {
        ...shop,
        status: resolveLiveStatus(shop),
        locked: isLocked(slug),
        // The two things a caller always wants next: where it answers, and what
        // they may do to it. req.shopRole is set by resolveShopAndRole.
        url: shopUrl(slug),
        role: req.shopRole || null,
      },
      url: shopUrl(slug),
      role: req.shopRole || null,
    });
  } catch (err) {
    console.error(`[shops] get ${slug} error:`, err.message);
    res.status(500).json({ error: 'Failed to get shop details.' });
  } finally {
    db.close();
  }
});

// Valid lifecycle statuses and their protection rules
const LIFECYCLE_STATUSES = ['none', 'development', 'testing', 'active', 'closed'];
const LIFECYCLE_LABELS = {
  none: 'No Status', development: 'Development', testing: 'In Testing', active: 'Active', closed: 'Closed',
};

// PATCH /api/shops/:slug — Update shop fields in the database (requires can_edit_ui)
router.patch('/:slug', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const { name, description, lifecycle_status, language } = req.body;
  let { slug: newSlugRaw } = req.body;
  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    // Validate lifecycle_status if provided
    if (lifecycle_status !== undefined && !LIFECYCLE_STATUSES.includes(lifecycle_status)) {
      return res.status(400).json({ error: `Invalid lifecycle status. Must be one of: ${LIFECYCLE_STATUSES.join(', ')}` });
    }

    // -----------------------------------------------------------------------
    // THE HOLE THIS ADR EXISTS TO CLOSE.
    //
    // Until now anyone with can_edit_ui could set lifecycle_status to 'active'
    // through this route, from the settings page, with no admin check and no
    // confirmation. 'active' is the live stage: it puts the shop in production,
    // takes the internal-only banner off it and lets search engines index it.
    // That is precisely the accident the ADR is about, and it was never on a
    // new route, it was on this one.
    //
    // Gated exactly like golive.js's PUT /:slug/stage, and only for a real
    // CHANGE: a PATCH that resends the value a shop already has is a no-op and
    // must not start failing for the people who edit a name or a description.
    // -----------------------------------------------------------------------
    if (lifecycle_status !== undefined && lifecycle_status !== (shop.lifecycle_status || 'none')) {
      if (req.shopRole !== 'owner') {
        return refuse(res, 403, 'ROLE_TOO_LOW',
          `Changing the stage of "${slug}" needs owner access.`,
          'Ask an owner of this shop to change the stage, or call request_access.', false);
      }
      if (lifecycle_status === 'active') {
        if (req.via === 'mcp') {
          return refuse(res, 403, 'ADMIN_ONLY',
            'Moving a shop to production has to be done in Launchpad, in a browser.',
            'Open the shop settings page in Launchpad and use the Stage control there.', false);
        }
        if (req.session?.user?.role !== 'super_admin') {
          return refuse(res, 403, 'ADMIN_ONLY',
            'Only a super admin can move a shop to production.',
            'Ask Giovanni Lupo or Arnaud Aubert to make the change.', false);
        }
      }
    }

    const newName = name !== undefined ? String(name).trim() : shop.name;
    const newDescription = description !== undefined ? String(description).trim() : (shop.description || '');
    const newLifecycle = lifecycle_status !== undefined ? lifecycle_status : (shop.lifecycle_status || 'none');

    // Language: only 'en' or 'fr' allowed for now (Shuttle storefront support)
    let newLanguage = shop.language || 'en';
    if (language !== undefined) {
      if (!['en', 'fr'].includes(language)) {
        return res.status(400).json({ error: "Language must be 'en' or 'fr'" });
      }
      newLanguage = language;
    }

    if (!newName) return res.status(400).json({ error: 'Name cannot be empty' });

    // Handle slug (URL path) rename
    const newSlug = newSlugRaw !== undefined
      ? slugify(String(newSlugRaw).trim(), { lower: true, strict: true })
      : slug;

    if (!newSlug) return res.status(400).json({ error: 'Invalid URL path' });

    const reservedNew = newSlug !== slug ? reservedSlugError(newSlug) : null;
    if (reservedNew) {
      return refuse(res, 409, 'NOT_PERMITTED', reservedNew, 'Pick a different URL path for the shop.', false);
    }

    if (newSlug !== slug) {
      // Check uniqueness
      const conflict = db.prepare('SELECT id FROM shops WHERE slug = ?').get(newSlug);
      if (conflict) return res.status(409).json({ error: `URL path "/${newSlug}" is already taken` });

      const oldDir = path.join(SHOPS_DIR, slug);
      const newDir = path.join(SHOPS_DIR, newSlug);

      // Stop container
      const oldCompose = getComposeFilePath(slug);
      if (fs.existsSync(path.join(oldDir, 'docker-compose.yml'))) {
        try { execSync(`docker compose -f ${oldCompose} down 2>&1`, { stdio: 'pipe' }); } catch { /* ok */ }
      }

      // Rename directory
      if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
      }

      // Update docker-compose.yml volume path inside the shop
      const composeInShop = path.join(newDir, 'docker-compose.yml');
      if (fs.existsSync(composeInShop)) {
        let compose = fs.readFileSync(composeInShop, 'utf8');
        const oldHostDir = getHostShopDir(slug);
        const newHostDir = getHostShopDir(newSlug);
        compose = compose.replace(oldHostDir, newHostDir);
        fs.writeFileSync(composeInShop, compose);
      }

      // Update shop .env
      const envPath = path.join(newDir, '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent
          .replace(/^SHOP_SLUG=.*/m, `SHOP_SLUG=${newSlug}`)
          .replace(/^BASE_PATH=.*/m, `BASE_PATH=/${newSlug}`)
          .replace(/^PUBLIC_URL=.*/m, `PUBLIC_URL=/${newSlug}`)
          .replace(/^NEXT_PUBLIC_BASE_PATH=.*/m, `NEXT_PUBLIC_BASE_PATH=/${newSlug}`);
        fs.writeFileSync(envPath, envContent);
      }

      // Update nginx: remove old, add new
      removeShopConfig(slug);
      generateShopConfig(newSlug, shop.port);
      reloadNginx();

      // Clear stale build cache and restart container
      const newDir2 = path.join(SHOPS_DIR, newSlug);
      clearBuildCache(newDir2, newSlug);
      const newCompose = getComposeFilePath(newSlug);
      try { execSync(`docker compose -f ${newCompose} up -d 2>&1`, { stdio: 'pipe' }); } catch { /* ok */ }
    }

    db.prepare(
      'UPDATE shops SET slug = ?, name = ?, description = ?, subdomain = ?, lifecycle_status = ?, language = ? WHERE slug = ?'
    ).run(newSlug, newName, newDescription, newSlug, newLifecycle, newLanguage, slug);

    // A lifecycle change is a stage change, and the banner is compiled into the
    // shop, so the compose env has to be rewritten and the shop rebuilt. The
    // settings UI goes through PUT /:slug/stage, which rebuilds itself; this is
    // for every other caller of PATCH.
    if (newLifecycle !== (shop.lifecycle_status || 'none')) {
      applyShopStage(newSlug, effectiveStage({ lifecycle_status: newLifecycle }), { rebuild: true });
    }

    // If language changed and the docker-compose.yml exists, regenerate the
    // SHUTTLE_LANG env line so the running shop picks it up on next restart.
    if (newLanguage !== (shop.language || 'en')) {
      const composeInShop = path.join(SHOPS_DIR, newSlug, 'docker-compose.yml');
      if (fs.existsSync(composeInShop)) {
        let compose = fs.readFileSync(composeInShop, 'utf8');
        if (compose.includes('SHUTTLE_LANG=')) {
          compose = compose.replace(/SHUTTLE_LANG=\w+/g, `SHUTTLE_LANG=${newLanguage}`);
        } else {
          // Inject SHUTTLE_LANG after BASE_PATH= line within the environment block
          compose = compose.replace(
            /(- BASE_PATH=[^\n]*\n)/,
            `$1      - SHUTTLE_LANG=${newLanguage}\n`
          );
        }
        fs.writeFileSync(composeInShop, compose);
      }
    }

    const updated = db.prepare('SELECT * FROM shops WHERE slug = ?').get(newSlug);
    const audit_id = audit(req, 'shop_updated', { slug, newSlug, name: newName, lifecycle_status: newLifecycle, language: newLanguage });
    res.json({ shop: updated, url: shopUrl(newSlug), audit_id });
  } catch (err) {
    console.error(`[shops] patch ${slug} error:`, err.message);
    res.status(500).json({ error: 'Failed to update shop.' });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/logs — Get recent docker compose logs
router.get('/:slug/logs', (req, res) => {
  const { slug } = req.params;
  // Capped at 200. Uncapped, one `?lines=500000` turns a log read into a
  // several-megabyte JSON response, which is bad for a browser and ruinous for
  // an agent paying by the token.
  const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 100, 1), 200);
  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const hostComposeFile = getComposeFilePath(slug);
    let logs = '';
    try {
      logs = execSync(
        `docker compose -f ${hostComposeFile} logs --tail=${lines} 2>&1`,
        { stdio: 'pipe', encoding: 'utf8' }
      );
    } catch (logErr) {
      logs = logErr.stdout?.toString() || logErr.stderr?.toString() || logErr.message;
    }
    res.json({ logs });
  } catch (err) {
    console.error(`[shops] logs ${slug} error:`, err.message);
    res.status(500).json({ error: 'Failed to retrieve logs.' });
  } finally {
    db.close();
  }
});

// DELETE /api/shops/:slug (requires can_delete)
router.delete('/:slug', (req, res) => {
  if (!checkShopPermission(req, 'can_delete')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const deleteFiles = req.query.deleteFiles === 'true';
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    // Protection: Active and In Testing shops cannot be deleted
    const ls = shop.lifecycle_status || 'none';
    if (ls === 'active') {
      return res.status(403).json({ error: 'Cannot delete an Active shop. Change its status first.' });
    }
    if (ls === 'testing') {
      return res.status(403).json({ error: 'Cannot delete a shop that is In Testing. Change its status first.' });
    }

    // Stop container using host-side path
    const hostComposeFile = getComposeFilePath(slug);
    const localComposeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
    if (fs.existsSync(localComposeFile)) {
      try {
        execSync(`docker compose -f ${hostComposeFile} down 2>&1`, { stdio: 'pipe' });
      } catch { /* container may not be running */ }
    }

    // Remove nginx config
    removeShopConfig(slug);
    reloadNginx();

    // Delete files if requested
    if (deleteFiles) {
      const shopDir = path.join(SHOPS_DIR, slug);
      if (fs.existsSync(shopDir)) {
        fs.rmSync(shopDir, { recursive: true, force: true });
      }
    }

    // Remove from database
    db.prepare('DELETE FROM shops WHERE slug = ?').run(slug);

    const audit_id = audit(req, 'shop_deleted', { slug, deleteFiles });
    res.json({ message: `Shop "${slug}" removed`, audit_id });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/start?force=true (requires can_edit_ui)
//
// Production protection: shops with lifecycle_status='active' do NOT clear
// the build cache or pick up template changes on launch unless the caller
// explicitly passes ?force=true. This prevents an idle "Launch" click from
// silently rolling out unreviewed updates to a live shop.
router.post('/:slug/start', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const force = req.query.force === 'true';
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const isActive = (shop.lifecycle_status || 'none') === 'active';
    const skipUpdate = isActive && !force;

    if (!skipUpdate) {
      // Clear stale build cache so container rebuilds with current source
      clearBuildCache(path.join(SHOPS_DIR, slug), slug);
    }

    // Lock catalog mutations + flag building until the port is reachable
    lockAcquire(slug, req.session?.user?.id);
    db.prepare(
      'UPDATE shops SET is_building = 1, build_started_at = ? WHERE slug = ?'
    ).run(Date.now(), slug);

    const hostComposeFile = getComposeFilePath(slug);
    let out = '';
    try {
      out = execSync(`docker compose -f ${hostComposeFile} up -d 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const msg = err.stdout?.toString() || err.stderr?.toString() || err.message;
      console.error(`[shops] start ${slug} failed:`, msg);
      lockRelease(slug);
      db.prepare(
        'UPDATE shops SET status = ?, is_building = 0 WHERE slug = ?'
      ).run('error', slug);
      return res.status(500).json({ error: 'Failed to start shop container.' });
    }
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    const audit_id = audit(req, 'shop_started', { slug, force, skippedUpdate: skipUpdate });
    res.json({
      audit_id,
      message: `Shop "${slug}" started`,
      log: out,
      skippedUpdate: skipUpdate,
      building: !skipUpdate,
    });
  } catch (err) {
    console.error(`[shops] start ${slug} error:`, err.message);
    lockRelease(slug);
    res.status(500).json({ error: 'Failed to start shop.' });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/stop (requires can_edit_ui)
router.post('/:slug/stop', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const hostComposeFile = getComposeFilePath(slug);
    let out = '';
    try {
      out = execSync(`docker compose -f ${hostComposeFile} down 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const msg = err.stdout?.toString() || err.stderr?.toString() || err.message;
      console.error(`[shops] stop ${slug} failed:`, msg);
      return res.status(500).json({ error: 'Failed to stop shop container.' });
    }
    lockRelease(slug);
    db.prepare(
      'UPDATE shops SET status = ?, is_building = 0 WHERE slug = ?'
    ).run('stopped', slug);
    const audit_id = audit(req, 'shop_stopped', { slug });
    res.json({ message: `Shop "${slug}" stopped`, log: out, audit_id });
  } catch (err) {
    console.error(`[shops] stop ${slug} error:`, err.message);
    res.status(500).json({ error: 'Failed to stop shop.' });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/restart?force=true (requires can_edit_ui)
// Same production protection as /start: active shops do not clear the build
// cache unless ?force=true is passed.
router.post('/:slug/restart', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  // A restart in the middle of a launch stomps the launch's own lock and can
  // leave a half-built container. Refuse it with the shape every other refusal
  // uses, and name who is holding it, so an agent can say "Marc started a
  // launch four minutes ago" rather than "it failed". possible: true, because
  // this one clears on its own.
  const busy = currentLock(slug);
  if (busy) {
    return refuse(res, 409, 'SHOP_BUSY',
      `"${slug}" is busy: ${busy.held_by_name || 'someone'} is running ${busy.action}.`,
      { held_by: busy.held_by_name || null, action: busy.action, since: busy.since }, true);
  }
  const force = req.query.force === 'true';
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const isActive = (shop.lifecycle_status || 'none') === 'active';
    const skipUpdate = isActive && !force;

    if (!skipUpdate) {
      clearBuildCache(path.join(SHOPS_DIR, slug), slug);
    }

    lockAcquire(slug, req.session?.user?.id);
    db.prepare(
      'UPDATE shops SET is_building = 1, build_started_at = ? WHERE slug = ?'
    ).run(Date.now(), slug);

    const hostComposeFile = getComposeFilePath(slug);
    let out = '';
    try {
      // Try restart first; if it fails (container not created), fall back to up -d
      out = execSync(`docker compose -f ${hostComposeFile} restart 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch {
      try {
        out = execSync(`docker compose -f ${hostComposeFile} up -d 2>&1`, {
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (upErr) {
        const msg = upErr.stdout?.toString() || upErr.stderr?.toString() || upErr.message;
        console.error(`[shops] restart ${slug} failed:`, msg);
        lockRelease(slug);
        db.prepare(
          'UPDATE shops SET status = ?, is_building = 0 WHERE slug = ?'
        ).run('error', slug);
        return res.status(500).json({ error: 'Failed to restart shop container.' });
      }
    }
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    const audit_id = audit(req, 'shop_restarted', { slug, force, skippedUpdate: skipUpdate });
    res.json({
      audit_id,
      message: `Shop "${slug}" restarted`,
      log: out,
      skippedUpdate: skipUpdate,
      building: !skipUpdate,
    });
  } catch (err) {
    console.error(`[shops] restart ${slug} error:`, err.message);
    lockRelease(slug);
    res.status(500).json({ error: 'Failed to restart shop.' });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/deploy — Redeploy (requires can_edit_ui)
router.post('/:slug/deploy', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  {
    const busy = currentLock(req.params.slug);
    if (busy) {
      return refuse(res, 409, 'SHOP_BUSY',
        `"${req.params.slug}" is busy: ${busy.held_by_name || 'someone'} is running ${busy.action}.`,
        { held_by: busy.held_by_name || null, action: busy.action, since: busy.since }, true);
    }
  }
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const shopDir = path.join(SHOPS_DIR, slug);
    const hostComposeFile = getComposeFilePath(slug);
    const log = [];

    // Back up DATABASE folder before git operations so user data is preserved
    const dbDir = path.join(shopDir, 'DATABASE');
    const dbBackup = path.join(shopDir, '_DATABASE_BACKUP');
    if (fs.existsSync(dbDir)) {
      if (fs.existsSync(dbBackup)) fs.rmSync(dbBackup, { recursive: true, force: true });
      copyDirSync(dbDir, dbBackup);
      // Remove from working tree so git pull doesn't conflict on tracked DATABASE files
      fs.rmSync(dbDir, { recursive: true, force: true });
      log.push('Backed up DATABASE folder.');
    }

    // Pull latest if it's a git repo
    if (fs.existsSync(path.join(shopDir, '.git'))) {
      try {
        const pullOut = execSync('git pull 2>&1', { cwd: shopDir, stdio: 'pipe', encoding: 'utf8' });
        log.push(pullOut || 'git pull complete.');
      } catch (pullErr) {
        log.push(`git pull error: ${pullErr.message}`);
      }
    }

    // Restore DATABASE folder from backup
    if (fs.existsSync(dbBackup)) {
      if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
      fs.renameSync(dbBackup, dbDir);
      log.push('Restored DATABASE folder.');
    }

    // Clear stale build cache so container rebuilds with current source
    // (Deploy is always an explicit update — no production-protection skip here.)
    clearBuildCache(shopDir, slug);

    lockAcquire(slug, req.session?.user?.id);
    db.prepare(
      'UPDATE shops SET is_building = 1, build_started_at = ? WHERE slug = ?'
    ).run(Date.now(), slug);

    // Rebuild container
    try {
      execSync(`docker compose -f ${hostComposeFile} down 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
      const upOut = execSync(`docker compose -f ${hostComposeFile} up -d --build 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      log.push(upOut || 'Container rebuilt.');
    } catch (buildErr) {
      const msg = buildErr.stdout?.toString() || buildErr.stderr?.toString() || buildErr.message;
      console.error(`[shops] deploy ${slug} build failed:`, msg);
      log.push('Build error: container rebuild failed.');
      lockRelease(slug);
      db.prepare(
        'UPDATE shops SET status = ?, is_building = 0 WHERE slug = ?'
      ).run('error', slug);
      return res.status(500).json({ error: 'Container rebuild failed.', log: log.join('\n') });
    }

    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    const audit_id = audit(req, 'shop_deployed', { slug });
    res.json({ message: `Shop "${slug}" redeployed`, log: log.join('\n'), audit_id });
  } catch (err) {
    console.error(`[shops] deploy ${slug} error:`, err.message);
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
    res.status(500).json({ error: 'Deploy failed.' });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/check-update — Check if the Shuttle template has a newer version
router.get('/:slug/check-update', (req, res) => {
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);

  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const hasGit = fs.existsSync(path.join(shopDir, '.git'));
  if (!hasGit) {
    return res.json({ updateAvailable: false, reason: 'Shop is not a git repository' });
  }

  try {
    // Get the local HEAD commit
    const localCommit = execSync('git rev-parse HEAD', {
      cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
    }).trim();

    const localCommitShort = localCommit.slice(0, 7);

    // Get the local commit date for display
    const localDate = execSync('git log -1 --format=%ci', {
      cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
    }).trim();

    // Fetch latest from remote without modifying working tree
    try {
      execSync('git fetch origin 2>&1', { cwd: shopDir, stdio: 'pipe', encoding: 'utf8' });
    } catch {
      return res.json({
        updateAvailable: false,
        localCommit: localCommitShort,
        localDate,
        reason: 'Could not reach remote repository',
      });
    }

    // Get the remote HEAD commit
    const remoteCommit = execSync('git rev-parse origin/HEAD 2>/dev/null || git rev-parse origin/main 2>/dev/null || git rev-parse origin/master', {
      cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
    }).trim();

    const remoteCommitShort = remoteCommit.slice(0, 7);

    // Count commits behind
    let commitsBehind = 0;
    try {
      const count = execSync(`git rev-list HEAD..${remoteCommit} --count`, {
        cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
      }).trim();
      commitsBehind = parseInt(count, 10) || 0;
    } catch { /* ignore */ }

    const remoteDate = execSync(`git log -1 --format=%ci ${remoteCommit}`, {
      cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
    }).trim();

    const updateAvailable = localCommit !== remoteCommit;

    res.json({
      updateAvailable,
      localCommit: localCommitShort,
      localDate,
      remoteCommit: remoteCommitShort,
      remoteDate,
      commitsBehind,
    });
  } catch (err) {
    console.error('[shops] error:', err.message);
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
});

// GET /api/shops/:slug/version — Check shop's Shuttle version + git info
router.get('/:slug/version', (req, res) => {
  const { slug } = req.params;
  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const shopDir = path.join(SHOPS_DIR, slug);
    const actualVersion = readShopVersion(shopDir);

    const result = {
      dbVersion: shop.shuttle_version || null,
      currentVersion: actualVersion || shop.shuttle_version || null,
      latestAvailable: actualVersion || shop.shuttle_version || null,
    };

    // Include git commit info so the frontend can display it immediately
    if (fs.existsSync(path.join(shopDir, '.git'))) {
      try {
        result.localCommit = execSync('git rev-parse --short HEAD', {
          cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
        }).trim();
        result.localDate = execSync('git log -1 --format=%ci', {
          cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
        }).trim();
      } catch { /* git info is best-effort */ }
    }

    res.json(result);
  } catch (err) {
    console.error('[shops] error:', err.message);
    res.status(500).json({ error: 'An unexpected error occurred.' });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/update-template — Pull latest Shuttle, re-apply patches, rebuild (requires can_edit_ui)
router.post('/:slug/update-template', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const shopDir = path.join(SHOPS_DIR, slug);
    const hostComposeFile = getComposeFilePath(slug);
    const log = [];

    // 1. Pull latest from Shuttle template
    if (!fs.existsSync(path.join(shopDir, '.git'))) {
      return res.status(400).json({ error: 'Shop is not a git repository — cannot update.' });
    }

    // Back up DATABASE folder before git operations so user data is preserved
    const dbDir = path.join(shopDir, 'DATABASE');
    const dbBackup = path.join(shopDir, '_DATABASE_BACKUP');
    if (fs.existsSync(dbDir)) {
      if (fs.existsSync(dbBackup)) fs.rmSync(dbBackup, { recursive: true, force: true });
      copyDirSync(dbDir, dbBackup);
      // Remove from working tree so git pull doesn't conflict on tracked DATABASE files
      fs.rmSync(dbDir, { recursive: true, force: true });
      log.push('Backed up DATABASE folder.');
    }

    try {
      // Stash any local changes (patches) before pulling
      const stash = execSync('git stash 2>&1', {
        cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
      });
      log.push(`git stash: ${stash.trim()}`);
    } catch (e) {
      log.push(`git stash warning: ${e.message}`);
    }

    try {
      const pull = execSync('git pull origin main 2>&1 || git pull origin master 2>&1', {
        cwd: shopDir, stdio: 'pipe', encoding: 'utf8', shell: true,
      });
      log.push(`git pull: ${pull.trim()}`);
    } catch (pullErr) {
      const msg = pullErr.stderr?.toString() || pullErr.stdout?.toString() || pullErr.message;
      log.push(`git pull error: ${msg}`);
      // Try to pop stash back
      try { execSync('git stash pop 2>&1', { cwd: shopDir, stdio: 'pipe' }); } catch { /* ok */ }
      // Restore DATABASE backup on failure
      if (fs.existsSync(dbBackup)) {
        if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
        fs.renameSync(dbBackup, dbDir);
        log.push('Restored DATABASE folder from backup.');
      }
      return res.status(500).json({ error: `Failed to pull latest: ${msg}`, log: log.join('\n') });
    }

    // Restore DATABASE folder from backup (overwrite anything git may have changed)
    if (fs.existsSync(dbBackup)) {
      if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
      fs.renameSync(dbBackup, dbDir);
      log.push('Restored DATABASE folder from backup.');
    }

    // Don't pop stash — we'll re-apply all patches fresh below

    // 2. Re-apply path-based routing overrides
    const overridesDir = path.join(TEMPLATES_DIR, 'shop-overrides');
    if (fs.existsSync(overridesDir)) {
      copyDirSync(overridesDir, shopDir);
      log.push('Re-applied path-based routing overrides.');
    }

    // 3. Re-apply all patches
    const fetchPatchCount = patchShopFetchCalls(shopDir);
    if (fetchPatchCount > 0) log.push(`Patched ${fetchPatchCount} file(s) with apiFetch().`);

    const assetPatchCount = patchShopPublicAssets(shopDir, slug);
    if (assetPatchCount > 0) log.push(`Patched ${assetPatchCount} file(s) with basePath for assets.`);

    const dynamicPatchCount = patchShopDynamicUrls(shopDir);
    if (dynamicPatchCount > 0) log.push(`Patched ${dynamicPatchCount} layout file(s) with assetUrl().`);

    const imagePatchCount = patchShopImageUrls(shopDir);
    if (imagePatchCount > 0) log.push(`Patched ${imagePatchCount} lib file(s) with BASE_PATH image URLs.`);

    const cartPatchCount = patchShopCartKey(shopDir, slug);
    if (cartPatchCount > 0) log.push('Patched cart localStorage key for shop isolation.');

    const analyticsPatchCount2 = patchShopAnalytics(shopDir);
    if (analyticsPatchCount2 > 0) log.push('Injected analytics tracker into shop layout.');

    // Ensure shop package.json version reflects the updated template
    const templateVer = readShopVersion(shopDir);
    if (templateVer) {
      syncShopVersion(shopDir, slug, templateVer);
      log.push(`Shop version synced to ${templateVer}.`);
    }

    // 4. Clear stale build cache and rebuild container
    clearBuildCache(shopDir, slug);
    log.push('Rebuilding container...');
    try {
      execSync(`docker compose -f ${hostComposeFile} down 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
      const upOut = execSync(`docker compose -f ${hostComposeFile} up -d --build 2>&1`, {
        stdio: 'pipe', encoding: 'utf8',
      });
      log.push(upOut || 'Container rebuilt and started.');
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    } catch (buildErr) {
      const msg = buildErr.stdout?.toString() || buildErr.stderr?.toString() || buildErr.message;
      log.push(`Build error: ${msg}`);
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      return res.status(500).json({ error: msg, log: log.join('\n') });
    }

    // Get the new commit info and update version in DB
    let newCommit = '';
    try {
      newCommit = execSync('git rev-parse --short HEAD', {
        cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
      }).trim();
    } catch { /* ignore */ }

    const updatedVersion = readShopVersion(shopDir) || 'unknown';
    db.prepare('UPDATE shops SET shuttle_version = ? WHERE slug = ?').run(updatedVersion, slug);

    log.push(`Update complete. Now at ${updatedVersion} (commit ${newCommit}).`);
    const audit_id = audit(req, 'shop_template_updated', { slug, version: updatedVersion, commit: newCommit });
    res.json({ message: `Shop "${slug}" updated to ${updatedVersion}`, commit: newCommit, log: log.join('\n'), audit_id });
  } catch (err) {
    console.error('[shops] error:', err.message);
    res.status(500).json({ error: 'An unexpected error occurred.' });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/upgrade — Opt-in Shuttle upgrade (alias with confirmation, requires can_edit_ui)
router.post('/:slug/upgrade', (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const { confirm } = req.body;

  if (!confirm) {
    return res.status(400).json({ error: 'Upgrade requires confirmation. Send { confirm: true }.' });
  }

  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const shopDir = path.join(SHOPS_DIR, slug);
    const hostComposeFile = getComposeFilePath(slug);
    const log = [];

    // Pull latest from Shuttle repo
    if (!fs.existsSync(path.join(shopDir, '.git'))) {
      return res.status(400).json({ error: 'Shop directory is not a git repo — cannot upgrade.' });
    }

    // Back up DATABASE folder before git operations so user data is preserved
    const dbDir = path.join(shopDir, 'DATABASE');
    const dbBackup = path.join(shopDir, '_DATABASE_BACKUP');
    if (fs.existsSync(dbDir)) {
      if (fs.existsSync(dbBackup)) fs.rmSync(dbBackup, { recursive: true, force: true });
      copyDirSync(dbDir, dbBackup);
      // Remove from working tree so git pull doesn't conflict on tracked DATABASE files
      fs.rmSync(dbDir, { recursive: true, force: true });
      log.push('Backed up DATABASE folder.');
    }

    try {
      const stash = execSync('git stash 2>&1', {
        cwd: shopDir, stdio: 'pipe', encoding: 'utf8',
      });
      log.push(`git stash: ${stash.trim()}`);
    } catch (e) {
      log.push(`git stash warning: ${e.message}`);
    }

    try {
      const pullOut = execSync('git pull origin main 2>&1 || git pull origin master 2>&1', {
        cwd: shopDir, stdio: 'pipe', encoding: 'utf8', shell: true,
      });
      log.push(pullOut || 'git pull complete.');
    } catch (pullErr) {
      const msg = pullErr.stderr?.toString() || pullErr.stdout?.toString() || pullErr.message;
      log.push(`git pull error: ${msg}`);
      try { execSync('git stash pop 2>&1', { cwd: shopDir, stdio: 'pipe' }); } catch { /* ok */ }
      // Restore DATABASE backup on failure
      if (fs.existsSync(dbBackup)) {
        if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
        fs.renameSync(dbBackup, dbDir);
        log.push('Restored DATABASE folder from backup.');
      }
      return res.status(500).json({ error: 'git pull failed', log: log.join('\n') });
    }

    // Restore DATABASE folder from backup (overwrite anything git may have changed)
    if (fs.existsSync(dbBackup)) {
      if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
      fs.renameSync(dbBackup, dbDir);
      log.push('Restored DATABASE folder from backup.');
    }

    // Re-apply path-based routing overrides
    const overridesDir = path.join(TEMPLATES_DIR, 'shop-overrides');
    if (fs.existsSync(overridesDir)) {
      copyDirSync(overridesDir, shopDir);
      log.push('Re-applied path-based routing overrides.');
    }

    // Re-apply all patches
    const fetchPatchCount = patchShopFetchCalls(shopDir);
    if (fetchPatchCount > 0) log.push(`Patched ${fetchPatchCount} file(s) with apiFetch().`);

    const assetPatchCount = patchShopPublicAssets(shopDir, slug);
    if (assetPatchCount > 0) log.push(`Patched ${assetPatchCount} file(s) with basePath for assets.`);

    const dynamicPatchCount = patchShopDynamicUrls(shopDir);
    if (dynamicPatchCount > 0) log.push(`Patched ${dynamicPatchCount} layout file(s) with assetUrl().`);

    const imagePatchCount = patchShopImageUrls(shopDir);
    if (imagePatchCount > 0) log.push(`Patched ${imagePatchCount} lib file(s) with BASE_PATH image URLs.`);

    const cartPatchCount = patchShopCartKey(shopDir, slug);
    if (cartPatchCount > 0) log.push('Patched cart localStorage key for shop isolation.');

    const analyticsPatchCount3 = patchShopAnalytics(shopDir);
    if (analyticsPatchCount3 > 0) log.push('Injected analytics tracker into shop layout.');

    // Ensure shop package.json version reflects the updated template
    const templateVer = readShopVersion(shopDir);
    if (templateVer) {
      syncShopVersion(shopDir, slug, templateVer);
      log.push(`Shop version synced to ${templateVer}.`);
    }

    // Clear stale build cache and rebuild container
    clearBuildCache(shopDir, slug);
    try {
      execSync(`docker compose -f ${hostComposeFile} down 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
      const upOut = execSync(`docker compose -f ${hostComposeFile} up -d --build 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      log.push(upOut || 'Container rebuilt.');
    } catch (buildErr) {
      const msg = buildErr.stdout?.toString() || buildErr.stderr?.toString() || buildErr.message;
      log.push(`Build error: ${msg}`);
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      return res.status(500).json({ error: msg, log: log.join('\n') });
    }

    // Update version in DB
    const upgradedVersion = readShopVersion(shopDir) || 'unknown';
    db.prepare('UPDATE shops SET shuttle_version = ?, status = ? WHERE slug = ?').run(upgradedVersion, 'running', slug);
    log.push(`Updated shop version to ${upgradedVersion}.`);

    const audit_id = audit(req, 'shop_upgraded', { slug, version: upgradedVersion });
    res.json({ message: `Shop "${slug}" upgraded to ${upgradedVersion}`, log: log.join('\n'), audit_id });
  } catch (err) {
    console.error('[shops] error:', err.message);
    res.status(500).json({ error: 'An unexpected error occurred.' });
  } finally {
    db.close();
  }
});

function initDb() {
  const db = getDb();
  db.close();
  startBuildingPoller();
}

module.exports = router;
module.exports.router = router;
module.exports.initDb = initDb;
