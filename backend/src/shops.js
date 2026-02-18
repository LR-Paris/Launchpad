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
    } else {
      execSync(`git clone ${TEMPLATE_REPO} ${shopDir}`, { stdio: 'pipe' });
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

    // Generate nginx config
    generateShopConfig(slug, port);

    // Register in database
    db.prepare(
      'INSERT INTO shops (slug, name, status, port, subdomain) VALUES (?, ?, ?, ?, ?)'
    ).run(slug, name, 'stopped', port, subdomain);

    // Start the container
    try {
      execSync(
        `docker compose -f ${path.join(shopDir, 'docker-compose.yml')} up -d`,
        { stdio: 'pipe' }
      );
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);
    } catch (err) {
      db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('error', slug);
    }

    // Reload nginx
    reloadNginx();

    const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
    res.status(201).json({ shop });
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
      try {
        execSync(`docker compose -f ${composeFile} down`, { stdio: 'pipe' });
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

    const composeFile = path.join(SHOPS_DIR, slug, 'docker-compose.yml');
    execSync(`docker compose -f ${composeFile} up -d`, { stdio: 'pipe' });
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);

    res.json({ message: `Shop "${slug}" started` });
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
    execSync(`docker compose -f ${composeFile} down`, { stdio: 'pipe' });
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('stopped', slug);

    res.json({ message: `Shop "${slug}" stopped` });
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
    execSync(`docker compose -f ${composeFile} restart`, { stdio: 'pipe' });
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);

    res.json({ message: `Shop "${slug}" restarted` });
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
    execSync(`docker compose -f ${composeFile} down`, { stdio: 'pipe' });
    execSync(`docker compose -f ${composeFile} up -d --build`, { stdio: 'pipe' });
    db.prepare('UPDATE shops SET status = ? WHERE slug = ?').run('running', slug);

    res.json({ message: `Shop "${slug}" redeployed` });
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
