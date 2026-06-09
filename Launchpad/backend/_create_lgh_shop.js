// Run INSIDE launchpad-backend-1 container
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const SLUG = 'legrandhotel';
const NAME = 'Le Grand Hôtel Paris';
const DESCRIPTION = 'Collection 2026 — appel d\'offre Christophe Cartei';
const TEMPLATE_REPO = 'https://github.com/LR-Paris/Shuttle.git';
const TEMPLATE_BRANCH = 'feat/product-variants-3.0.0';

const SHOPS_DIR = '/app/shops';
const TEMPLATES_DIR = '/app/templates';
const DB_PATH = '/app/data/shops.db';
const HOST_PROJECT_DIR = process.env.HOST_PROJECT_DIR;
const PORT = 8116;

const log = (m) => console.log('[create]', m);

if (fs.existsSync(path.join(SHOPS_DIR, SLUG))) {
  console.error('Shop dir already exists. Aborting.');
  process.exit(1);
}

// === Step 1: clone the STS-3.0.0 template branch
log(`Cloning ${TEMPLATE_REPO} branch ${TEMPLATE_BRANCH} → ${path.join(SHOPS_DIR, SLUG)}`);
execSync(`git clone --branch ${TEMPLATE_BRANCH} --depth 1 ${TEMPLATE_REPO} ${path.join(SHOPS_DIR, SLUG)}`, { stdio: 'inherit' });

// === Step 2: apply shop-overrides
const overridesDir = path.join(TEMPLATES_DIR, 'shop-overrides');
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}
if (fs.existsSync(overridesDir)) {
  copyDirSync(overridesDir, path.join(SHOPS_DIR, SLUG));
  log('Applied shop-overrides');
}

// === Step 3: load and call the existing patch helpers from shops.js
// Read shops.js and extract the patch functions, then eval them so we use the SAME logic.
const shopsSrc = fs.readFileSync('/app/src/shops.js', 'utf8');

function extractFn(name) {
  // crude but works: capture from "function NAME(" through matching close brace at column 0
  const re = new RegExp(`(function\\s+${name}\\s*\\([^)]*\\)\\s*\\{)`);
  const m = re.exec(shopsSrc);
  if (!m) return null;
  let i = m.index;
  let depth = 0;
  let start = -1;
  for (let j = i; j < shopsSrc.length; j++) {
    const c = shopsSrc[j];
    if (c === '{') { if (start === -1) start = j; depth++; }
    else if (c === '}') { depth--; if (depth === 0) return shopsSrc.slice(i, j+1); }
  }
  return null;
}
const fns = ['patchShopFetchCalls', 'patchShopPublicAssets', 'patchShopDynamicUrls',
             'patchShopImageUrls', 'patchShopCartKey', 'patchShopAnalytics'];
let evalBlob = '';
for (const fn of fns) {
  const src = extractFn(fn);
  if (src) evalBlob += '\n' + src + '\n';
  else log(`(skip) ${fn} not extractable`);
}
// Provide globals the functions expect
const ctx = {
  fs, path, console,
  require: (m) => require(m),
};
const f = new Function('fs', 'path', 'console', 'require', evalBlob + '\nreturn {' + fns.join(',') + '};');
const patches = f(fs, path, console, require);

const shopDir = path.join(SHOPS_DIR, SLUG);
let n;
n = patches.patchShopFetchCalls?.(shopDir);    log(`patched fetch calls: ${n}`);
n = patches.patchShopPublicAssets?.(shopDir, SLUG); log(`patched public assets: ${n}`);
n = patches.patchShopDynamicUrls?.(shopDir);   log(`patched dynamic urls: ${n}`);
n = patches.patchShopImageUrls?.(shopDir);     log(`patched image urls: ${n}`);
n = patches.patchShopCartKey?.(shopDir, SLUG); log(`patched cart key: ${n}`);
n = patches.patchShopAnalytics?.(shopDir);     log(`patched analytics: ${n}`);

// === Step 4: orders directory
fs.mkdirSync(path.join(shopDir, 'orders'), { recursive: true });
log('Created orders directory');

// === Step 5: presets (free shop)
const presetsDir = path.join(shopDir, 'DATABASE', 'Presets');
fs.mkdirSync(presetsDir, { recursive: true });
fs.writeFileSync(path.join(presetsDir, 'ShopType.txt'), 'type: free');
fs.writeFileSync(path.join(presetsDir, 'DataRequired.txt'),
  'address: true\ndetails: true\nextra_notes: true\nshipping_handler: false\nhotel_list: false');
log('Wrote presets');

// === Step 6: .env
const envContent = [
  `SHOP_NAME=${NAME}`,
  `SHOP_SLUG=${SLUG}`,
  `SHOP_PORT=${PORT}`,
  `BASE_PATH=/${SLUG}`,
  `PUBLIC_URL=/${SLUG}`,
  `NEXT_PUBLIC_BASE_PATH=/${SLUG}`,
  `LAUNCHPAD_API_URL=http://172.17.0.1:3001`,
  `NEXT_PUBLIC_LAUNCHPAD_API=http://172.17.0.1:3001`,
  '',
].join('\n');
fs.writeFileSync(path.join(shopDir, '.env'), envContent);
log('Wrote .env');

// === Step 7: docker-compose.yml
const tpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'shop-docker-compose.yml'), 'utf8');
const hostShopDir = path.join(HOST_PROJECT_DIR, 'shops', SLUG);
const composeFile = tpl
  .replace(/{PORT}/g, String(PORT))
  .replace(/{SHOP_DIR}/g, hostShopDir)
  .replace(/{SLUG}/g, SLUG);
fs.writeFileSync(path.join(shopDir, 'docker-compose.yml'), composeFile);
log(`Wrote docker-compose.yml (host shop dir: ${hostShopDir})`);

// === Step 8: nginx config
const { generateShopConfig, reloadNginx } = require('/app/src/nginx');
generateShopConfig(SLUG, PORT);
log('Generated nginx config');

// === Step 9: insert into DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const shopVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(shopDir, 'package.json'),'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
})();
db.prepare(
  'INSERT INTO shops (slug, name, description, status, port, subdomain, shuttle_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(SLUG, NAME, DESCRIPTION, 'stopped', PORT, SLUG, shopVersion);
log(`Inserted shop into DB (shuttle_version=${shopVersion})`);

// === Step 10: reload nginx
reloadNginx();
log('Triggered nginx reload');

console.log('\n=== DONE ===');
console.log(`Shop dir: ${shopDir}`);
console.log(`Port:     ${PORT}`);
console.log(`URL:      http://lrparisstore.com/${SLUG}/`);
console.log(`Next: drop in DATABASE folder, then docker compose up -d`);
