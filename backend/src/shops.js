const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const slugify = require('slugify');
const { generateShopConfig, removeShopConfig, reloadNginx } = require('./nginx');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const DB_PATH = path.join(DATA_DIR, 'shops.db');
const TEMPLATE_REPO = 'https://github.com/LR-Paris/Shuttle';
const BASE_PORT = 8100;

// When running inside Docker, docker compose needs HOST-side paths for volumes/files.
// HOST_PROJECT_DIR is injected by docker-compose.yml via environment and should be
// the ACTUAL host filesystem path (e.g. /home/user/Launchpad), NOT a container path.
// This is critical because docker-compose communicates with the host Docker daemon
// via the socket, and bind-mount source paths must exist on the host.

// Path used for docker-compose -f (must be readable from inside this container)
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
      `docker-compose -f ${composeFile} ps --format json`,
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

// POST /api/shops — Create new shop
router.post('/', (req, res) => {
  const { name, folderPath, description } = req.body;
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

    // Create orders directory
    fs.mkdirSync(path.join(shopDir, 'orders'), { recursive: true });
    log.push('Created orders directory.');

    // Write .env for shop (includes base path vars for path-based routing)
    const envContent = `SHOP_NAME=${name}\nSHOP_SLUG=${slug}\nSHOP_PORT=${port}\nBASE_PATH=/${slug}\nPUBLIC_URL=/${slug}\nNEXT_PUBLIC_BASE_PATH=/${slug}\n`;
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
    );
    log.push(`Configured shop docker-compose.yml on port ${port}.`);

    // Generate nginx config
    generateShopConfig(slug, port);
    log.push('Generated nginx config.');

    // Register in database
    db.prepare(
      'INSERT INTO shops (slug, name, description, status, port, subdomain) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(slug, name, description || '', 'stopped', port, subdomain);

    // Start the container using container-readable path
    const hostComposeFile = getComposeFilePath(slug);
    log.push(`Starting container with: docker-compose -f ${hostComposeFile} up -d`);
    try {
      const upOut = execSync(
        `docker-compose -f ${hostComposeFile} up -d 2>&1`,
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
    res.status(201).json({ shop, log: log.join('\n') });
  } catch (err) {
    // Cleanup on failure
    if (fs.existsSync(shopDir)) {
      fs.rmSync(shopDir, { recursive: true, force: true });
    }
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops — List all shops
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const shops = db.prepare('SELECT * FROM shops ORDER BY created_at DESC').all();

    // Update live status
    const updatedShops = shops.map(shop => ({
      ...shop,
      status: getContainerStatus(shop.slug),
    }));

    res.json({ shops: updatedShops });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.json({ shop: { ...shop, status: getContainerStatus(slug) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// PATCH /api/shops/:slug — Update shop fields in the database
router.patch('/:slug', (req, res) => {
  const { slug } = req.params;
  const { name, description } = req.body;
  let { slug: newSlugRaw } = req.body;
  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const newName = name !== undefined ? String(name).trim() : shop.name;
    const newDescription = description !== undefined ? String(description).trim() : (shop.description || '');

    if (!newName) return res.status(400).json({ error: 'Name cannot be empty' });

    // Handle slug (URL path) rename
    const newSlug = newSlugRaw !== undefined
      ? slugify(String(newSlugRaw).trim(), { lower: true, strict: true })
      : slug;

    if (!newSlug) return res.status(400).json({ error: 'Invalid URL path' });

    if (newSlug !== slug) {
      // Check uniqueness
      const conflict = db.prepare('SELECT id FROM shops WHERE slug = ?').get(newSlug);
      if (conflict) return res.status(409).json({ error: `URL path "/${newSlug}" is already taken` });

      const oldDir = path.join(SHOPS_DIR, slug);
      const newDir = path.join(SHOPS_DIR, newSlug);

      // Stop container
      const oldCompose = getComposeFilePath(slug);
      if (fs.existsSync(path.join(oldDir, 'docker-compose.yml'))) {
        try { execSync(`docker-compose -f ${oldCompose} down 2>&1`, { stdio: 'pipe' }); } catch { /* ok */ }
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

      // Restart container
      const newCompose = getComposeFilePath(newSlug);
      try { execSync(`docker-compose -f ${newCompose} up -d 2>&1`, { stdio: 'pipe' }); } catch { /* ok */ }
    }

    db.prepare(
      'UPDATE shops SET slug = ?, name = ?, description = ?, subdomain = ? WHERE slug = ?'
    ).run(newSlug, newName, newDescription, newSlug, slug);

    const updated = db.prepare('SELECT * FROM shops WHERE slug = ?').get(newSlug);
    res.json({ shop: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/logs — Get recent docker compose logs
router.get('/:slug/logs', (req, res) => {
  const { slug } = req.params;
  const lines = parseInt(req.query.lines, 10) || 100;
  const db = getDb();
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const hostComposeFile = getComposeFilePath(slug);
    let logs = '';
    try {
      logs = execSync(
        `docker-compose -f ${hostComposeFile} logs --tail=${lines} 2>&1`,
        { stdio: 'pipe', encoding: 'utf8' }
      );
    } catch (logErr) {
      logs = logErr.stdout?.toString() || logErr.stderr?.toString() || logErr.message;
    }
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// DELETE /api/shops/:slug
router.delete('/:slug', (req, res) => {
  const { slug } = req.params;
  const deleteFiles = req.query.deleteFiles === 'true';
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    // Stop container using host-side path
    const hostComposeFile = getComposeFilePath(slug);
    const localComposeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
    if (fs.existsSync(localComposeFile)) {
      try {
        execSync(`docker-compose -f ${hostComposeFile} down 2>&1`, { stdio: 'pipe' });
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

    res.json({ message: `Shop "${slug}" removed` });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/start
router.post('/:slug/start', (req, res) => {
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const hostComposeFile = getComposeFilePath(slug);
    let out = '';
    try {
      out = execSync(`docker-compose -f ${hostComposeFile} up -d 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const msg = err.stdout?.toString() || err.stderr?.toString() || err.message;
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      return res.status(500).json({ error: msg });
    }
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    res.json({ message: `Shop "${slug}" started`, log: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/stop
router.post('/:slug/stop', (req, res) => {
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const hostComposeFile = getComposeFilePath(slug);
    let out = '';
    try {
      out = execSync(`docker-compose -f ${hostComposeFile} down 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const msg = err.stdout?.toString() || err.stderr?.toString() || err.message;
      return res.status(500).json({ error: msg });
    }
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('stopped', slug);
    res.json({ message: `Shop "${slug}" stopped`, log: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/restart
router.post('/:slug/restart', (req, res) => {
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const hostComposeFile = getComposeFilePath(slug);
    let out = '';
    try {
      // Try restart first; if it fails (container not created), fall back to up -d
      out = execSync(`docker-compose -f ${hostComposeFile} restart 2>&1`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch {
      try {
        out = execSync(`docker-compose -f ${hostComposeFile} up -d 2>&1`, {
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (upErr) {
        const msg = upErr.stdout?.toString() || upErr.stderr?.toString() || upErr.message;
        db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
        return res.status(500).json({ error: msg });
      }
    }
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    res.json({ message: `Shop "${slug}" restarted`, log: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/deploy — Redeploy
router.post('/:slug/deploy', (req, res) => {
  const { slug } = req.params;
  const db = getDb();

  try {
    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const shopDir = path.join(SHOPS_DIR, slug);
    const hostComposeFile = getComposeFilePath(slug);
    const log = [];

    // Pull latest if it's a git repo
    if (fs.existsSync(path.join(shopDir, '.git'))) {
      try {
        const pullOut = execSync('git pull 2>&1', { cwd: shopDir, stdio: 'pipe', encoding: 'utf8' });
        log.push(pullOut || 'git pull complete.');
      } catch (pullErr) {
        log.push(`git pull error: ${pullErr.message}`);
      }
    }

    // Rebuild container
    try {
      execSync(`docker-compose -f ${hostComposeFile} down 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
      const upOut = execSync(`docker-compose -f ${hostComposeFile} up -d --build 2>&1`, {
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

    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    res.json({ message: `Shop "${slug}" redeployed`, log: log.join('\n') });
  } catch (err) {
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

function initDb() {
  const db = getDb();
  db.close();
}

module.exports = router;
module.exports.router = router;
module.exports.initDb = initDb;
