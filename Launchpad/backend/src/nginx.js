const fs = require('fs');
const path = require('path');

const NGINX_CONF_DIR = path.join(__dirname, '..', 'nginx', 'conf.d');
const SHOPS_LOCATIONS_FILE = path.join(NGINX_CONF_DIR, 'shops-locations.inc');
// Trigger file on the shared volume — host systemd path unit (nginx-reload.path)
// watches this and runs `nginx -t && systemctl reload nginx` when it changes.
const RELOAD_TRIGGER = path.join(__dirname, '..', '.nginx-reload-trigger');

// Generate a path-based location block for a shop and append to shops-locations.inc.
// Uses trailing-slash pattern so nginx strips the /<slug> prefix before proxying,
// consistent with the existing demo/michael-kors shop configs on this server.
// Next.js basePath handles client-side routing; the shop container receives bare paths.
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

  fs.appendFileSync(SHOPS_LOCATIONS_FILE, block);
}

// Remove a shop's location block from shops-locations.inc
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
    // Touching this file triggers the host systemd path unit which reloads nginx.
    fs.writeFileSync(RELOAD_TRIGGER, Date.now().toString());
    return true;
  } catch (err) {
    console.error('Failed to trigger nginx reload:', err.message);
    return false;
  }
}

module.exports = { generateShopConfig, removeShopConfig, reloadNginx };
