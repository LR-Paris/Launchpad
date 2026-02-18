const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NGINX_CONF_DIR = path.join(__dirname, '..', '..', 'nginx', 'conf.d');

function generateShopConfig(slug, port) {
  const conf = `server {
    listen 80;
    server_name ${slug}.localhost;

    location / {
        proxy_pass http://host.docker.internal:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;

  if (!fs.existsSync(NGINX_CONF_DIR)) {
    fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
  }

  fs.writeFileSync(path.join(NGINX_CONF_DIR, `${slug}.conf`), conf);
}

function removeShopConfig(slug) {
  const confPath = path.join(NGINX_CONF_DIR, `${slug}.conf`);
  if (fs.existsSync(confPath)) {
    fs.unlinkSync(confPath);
  }
}

function reloadNginx() {
  try {
    execSync('docker exec nginx-proxy nginx -s reload', { stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error('Failed to reload nginx:', err.message);
    return false;
  }
}

module.exports = { generateShopConfig, removeShopConfig, reloadNginx };
