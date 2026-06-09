const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const SLUG = 'legrandhotel';
const NAME = 'Le Grand Hôtel Paris';
const DESCRIPTION = "Collection 2026 — appel d'offre Christophe Cartei";
const TEMPLATE_REPO = 'https://github.com/LR-Paris/Shuttle.git';
const TEMPLATE_BRANCH = 'feat/product-variants-3.0.0';
const PORT = 8117;
const SHOPS_DIR = '/app/shops';
const TEMPLATES_DIR = '/app/templates';
const DB_PATH = '/app/data/shops.db';
const HOST_PROJECT_DIR = process.env.HOST_PROJECT_DIR;
const log = (m) => console.log('[create]', m);

const shopDir = path.join(SHOPS_DIR, SLUG);
if (fs.existsSync(shopDir)) {
  log('Cleaning previous partial clone');
  fs.rmSync(shopDir, { recursive: true, force: true });
}

log(`Cloning ${TEMPLATE_REPO}#${TEMPLATE_BRANCH} → ${shopDir}`);
execSync(`git clone --branch ${TEMPLATE_BRANCH} --depth 1 ${TEMPLATE_REPO} ${shopDir}`, { stdio: 'inherit' });

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name);
    const dp = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSync(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}
const overridesDir = path.join(TEMPLATES_DIR, 'shop-overrides');
if (fs.existsSync(overridesDir)) {
  copyDirSync(overridesDir, shopDir);
  log('Applied shop-overrides');
}

// patchShopCartKey: namespace cart localStorage key per shop
function patchCart(dir, slug) {
  let count = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e.name)) {
        let s = fs.readFileSync(p, 'utf8');
        const before = s;
        s = s.replace(/(['"`])cart\1/g, `$1cart-${slug}$1`);
        s = s.replace(/(['"`])cart-items\1/g, `$1cart-items-${slug}$1`);
        if (s !== before) { fs.writeFileSync(p, s); count++; }
      }
    }
  }
  walk(dir);
  return count;
}
log(`patched cart key in ${patchCart(shopDir, SLUG)} files`);

fs.mkdirSync(path.join(shopDir, 'orders'), { recursive: true });

// Don't pre-write Presets — DATABASE folder we drop in will include them

const env = [
  `SHOP_NAME=${NAME}`,
  `SHOP_SLUG=${SLUG}`,
  `SHOP_PORT=${PORT}`,
  `BASE_PATH=/${SLUG}`,
  `PUBLIC_URL=/${SLUG}`,
  `NEXT_PUBLIC_BASE_PATH=/${SLUG}`,
  `LAUNCHPAD_API_URL=http://172.17.0.1:3001`,
  `NEXT_PUBLIC_LAUNCHPAD_API=http://172.17.0.1:3001`,
  ''
].join('\n');
fs.writeFileSync(path.join(shopDir, '.env'), env);
log('Wrote .env');

const tpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'shop-docker-compose.yml'), 'utf8');
const hostShopDir = path.join(HOST_PROJECT_DIR, 'shops', SLUG);
fs.writeFileSync(path.join(shopDir, 'docker-compose.yml'),
  tpl.replace(/{PORT}/g, String(PORT))
     .replace(/{SHOP_DIR}/g, hostShopDir)
     .replace(/{SLUG}/g, SLUG));
log(`Wrote docker-compose.yml (port ${PORT})`);

const { generateShopConfig, reloadNginx } = require('/app/src/nginx');
generateShopConfig(SLUG, PORT);
log('Generated nginx config');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const shopVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(shopDir, 'package.json'),'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
})();
// Delete any prior leftover row
db.prepare('DELETE FROM shops WHERE slug = ?').run(SLUG);
db.prepare(
  'INSERT INTO shops (slug, name, description, status, port, subdomain, shuttle_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(SLUG, NAME, DESCRIPTION, 'stopped', PORT, SLUG, shopVersion);
log(`DB inserted (shuttle_version=${shopVersion})`);

reloadNginx();
log('nginx reload triggered');
console.log('\n=== SHOP CREATED ===');
