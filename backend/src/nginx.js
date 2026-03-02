const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NGINX_CONF_DIR = path.join(__dirname, '..', 'nginx', 'conf.d');
const SHOPS_LOCATIONS_FILE = path.join(NGINX_CONF_DIR, 'shops-locations.inc');

// Generate a path-based location block for a shop and append it to the
// shared shops-locations.inc file.  Shops are reachable at domain.com/<slug>/
// Next.js is configured with basePath=/<slug> so the full path is passed through.
function generateShopConfig(slug, port) {
  const block = `
# Shop: ${slug}
location /${slug}/ {
    proxy_pass http://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
`;

  if (!fs.existsSync(NGINX_CONF_DIR)) {
    fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
  }

  // Append to the shared locations file (created if missing)
  fs.appendFileSync(SHOPS_LOCATIONS_FILE, block);
}

// Remove a shop's location blocks from shops-locations.inc
function removeShopConfig(slug) {
  if (!fs.existsSync(SHOPS_LOCATIONS_FILE)) return;

  const content = fs.readFileSync(SHOPS_LOCATIONS_FILE, 'utf8');
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\n# Shop: ${escaped}\\nlocation /${escaped}/[\\s\\S]*?\\n}\\n`,
    'g'
  );
  const updated = content.replace(pattern, '');
  fs.writeFileSync(SHOPS_LOCATIONS_FILE, updated);
}

function reloadNginx() {
  try {
    execSync('nginx -t && systemctl reload nginx', { stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error('Failed to reload nginx:', err.message);
    return false;
  }
}

module.exports = { generateShopConfig, removeShopConfig, reloadNginx };
