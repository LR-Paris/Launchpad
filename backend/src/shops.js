const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const slugify = require('slugify');
const { generateShopConfig, removeShopConfig, reloadNginx } = require('./nginx');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const DB_PATH = path.join(DATA_DIR, 'shops.db');
const TEMPLATE_REPO = 'https://github.com/LR-Paris/Shuttle';
const BASE_PORT = 8100;

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
      status TEXT DEFAULT 'stopped',
      created_at TEXT DEFAULT (datetime('now')),
      port INTEGER NOT NULL,
      subdomain TEXT NOT NULL
    )
  `);

  return db;
}

function getNextPort(db) {
  const row = db.prepare('SELECT MAX(port) as max_port FROM shops').get();
  return row.max_port ? row.max_port + 1 : BASE_PORT;
}

function getContainerStatus(slug) {
  try {
    const result = execSync(
      `docker compose -f ${path.join(SHOPS_DIR, slug, 'docker-compose.yml')} ps --format json`,
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

function runCmd(cmd, opts = {}) {
  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts });
    return { ok: true, output: output || '' };
  } catch (err) {
    return { ok: false, output: (err.stdout || '') + (err.stderr || '') || err.message };
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
  const { name, folderPath } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Shop name is required' });
  }

  const slug = slugify(name, { lower: true, strict: true });
  if (!slug) {
    return res.status(400).json({ error: 'Invalid shop name' });
  }

  const shopDir = path.join(SHOPS_DIR, slug);
  if (fs.existsSync(shopDir)) {
    return res.status(409).json({ error: 'Shop with this slug already exists' });
  }

  const db = getDb();
  const logs = [];

  try {
    const existing = db.prepare('SELECT id FROM shops WHERE slug = ?').get(slug);
    if (existing) {
      return res.status(409).json({ error: 'Shop with this slug already exists' });
    }

    const port = getNextPort(db);
    const subdomain = slug;

    // Clone or copy shop files
    if (folderPath) {
      if (!fs.existsSync(folderPath)) {
        return res.status(400).json({ error: 'Source folder not found' });
      }
      copyDirSync(folderPath, shopDir);
      logs.push(`> Copied files from ${folderPath}`);
    } else {
      logs.push(`> Cloning template from ${TEMPLATE_REPO}...`);
      const clone = runCmd(`git clone ${TEMPLATE_REPO} ${shopDir}`);
      logs.push(clone.output);
      if (!clone.ok) {
        throw new Error(`Git clone failed: ${clone.output}`);
      }
      logs.push('> Template cloned successfully');
    }

    // Create orders directory
    fs.mkdirSync(path.join(shopDir, 'orders'), { recursive: true });

    // Write .env for shop
    const envContent = `SHOP_NAME=${name}\nSHOP_SLUG=${slug}\nSHOP_PORT=${port}\n`;
    fs.writeFileSync(path.join(shopDir, '.env'), envContent);

    // Copy and configure docker-compose.yml
    const template = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'shop-docker-compose.yml'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(shopDir, 'docker-compose.yml'),
      template.replace(/{PORT}/g, String(port))
    );
    logs.push(`> Configuration written (port ${port})`);

    // Generate nginx config
    generateShopConfig(slug, port);
    logs.push(`> Nginx config generated for ${slug}.localhost`);

    // Register in database
    db.prepare(
      'INSERT INTO shops (slug, name, status, port, subdomain) VALUES (?, ?, ?, ?, ?)'
    ).run(slug, name, 'stopped', port, subdomain);

    // Start the container
    logs.push('> Starting container...');
    const composeFile = path.join(shopDir, 'docker-compose.yml');
    const start = runCmd(`docker compose -f ${composeFile} up -d --build`);
    logs.push(start.output);
    if (start.ok) {
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
      logs.push('> Container started successfully');
    } else {
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      logs.push('> Container failed to start');
    }

    // Reload nginx
    const reload = runCmd('docker exec nginx-proxy nginx -s reload');
    if (reload.ok) {
      logs.push('> Nginx reloaded');
    }

    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    res.status(201).json({ shop, logs: logs.join('\n') });
  } catch (err) {
    // Cleanup on failure
    if (fs.existsSync(shopDir)) {
      fs.rmSync(shopDir, { recursive: true, force: true });
    }
    logs.push(`> Error: ${err.message}`);
    res.status(500).json({ error: err.message, logs: logs.join('\n') });
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

    // Stop container
    const composeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
    if (fs.existsSync(composeFile)) {
      runCmd(`docker compose -f ${composeFile} down`);
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

    const composeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
    const result = runCmd(`docker compose -f ${composeFile} up -d --build`);
    if (!result.ok) {
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      return res.status(500).json({ error: `Failed to start: ${result.output}` });
    }

    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    res.json({ message: `Shop "${slug}" started`, output: result.output });
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

    const composeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
    const result = runCmd(`docker compose -f ${composeFile} down`);
    if (!result.ok) {
      return res.status(500).json({ error: `Failed to stop: ${result.output}` });
    }

    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('stopped', slug);
    res.json({ message: `Shop "${slug}" stopped`, output: result.output });
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

    const composeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');

    // Bring down then up — `docker compose restart` doesn't start stopped containers
    runCmd(`docker compose -f ${composeFile} down`);
    const result = runCmd(`docker compose -f ${composeFile} up -d --build`);
    if (!result.ok) {
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      return res.status(500).json({ error: `Failed to restart: ${result.output}` });
    }

    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    res.json({ message: `Shop "${slug}" restarted`, output: result.output });
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
    const composeFile = path.join(shopDir, 'docker-compose.yml');

    // Pull latest if it's a git repo
    if (fs.existsSync(path.join(shopDir, '.git'))) {
      execSync('git pull', { cwd: shopDir, stdio: 'pipe' });
    }

    // Rebuild container
    runCmd(`docker compose -f ${composeFile} down`);
    const result = runCmd(`docker compose -f ${composeFile} up -d --build`);
    if (!result.ok) {
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
      return res.status(500).json({ error: result.output });
    }

    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    res.json({ message: `Shop "${slug}" redeployed`, output: result.output });
  } catch (err) {
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/logs — Container logs
router.get('/:slug/logs', (req, res) => {
  const { slug } = req.params;
  const composeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');

  if (!fs.existsSync(composeFile)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const result = runCmd(`docker compose -f ${composeFile} logs --tail=200 2>&1`);
  res.json({ logs: result.output || 'No logs available.' });
});

function initDb() {
  const db = getDb();
  db.close();
}

module.exports = router;
module.exports.router = router;
module.exports.initDb = initDb;
