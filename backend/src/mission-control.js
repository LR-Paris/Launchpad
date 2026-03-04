const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const { LOG_DIR } = require('./logger');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function getComposeFilePath(slug) {
  if (fs.existsSync('/host/project')) {
    return path.join('/host/project/shops', slug, 'docker-compose.yml');
  }
  return path.join(SHOPS_DIR, slug, 'docker-compose.yml');
}

function getContainerStatus(slug) {
  try {
    const composeFile = getComposeFilePath(slug);
    const result = execSync(
      `docker compose -f ${composeFile} ps --format json`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 5000 }
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

// GET /api/mission-control/overview — All shops with status + recent errors
router.get('/overview', (req, res) => {
  const db = getDb();
  try {
    const shops = db.prepare('SELECT slug, name, status, lifecycle_status, port, subdomain, created_at FROM shops ORDER BY name').all();

    const results = shops.map(shop => {
      const containerStatus = getContainerStatus(shop.slug);
      let recentErrors = [];

      // Check for errors in shop's Docker logs
      try {
        const composeFile = getComposeFilePath(shop.slug);
        const logs = execSync(
          `docker compose -f ${composeFile} logs --tail=200 2>&1`,
          { stdio: 'pipe', encoding: 'utf8', timeout: 5000 }
        );
        // Extract error lines
        const errorLines = logs.split('\n').filter(line =>
          /error|ERR|FATAL|uncaught|unhandled|ENOENT|ECONNREFUSED|crash/i.test(line)
          && !/node_modules/i.test(line)
        );
        recentErrors = errorLines.slice(-10).map(line => line.trim());
      } catch { /* no logs available */ }

      return {
        slug: shop.slug,
        name: shop.name,
        containerStatus,
        lifecycleStatus: shop.lifecycle_status || 'none',
        port: shop.port,
        subdomain: shop.subdomain,
        createdAt: shop.created_at,
        errorCount: recentErrors.length,
        recentErrors,
      };
    });

    res.json({ shops: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/mission-control/logs/system — Read the Launchpad backend log file
router.get('/logs/system', (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 200;
  const logFile = path.join(LOG_DIR, 'launchpad.log');

  if (!fs.existsSync(logFile)) {
    return res.json({ logs: '', lines: 0 });
  }

  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-lines).join('\n');
    res.json({ logs: tail, lines: allLines.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mission-control/logs/shop/:slug — Get recent Docker logs for a specific shop
router.get('/logs/shop/:slug', (req, res) => {
  const { slug } = req.params;
  const lines = parseInt(req.query.lines, 10) || 100;

  const db = getDb();
  try {
    const shop = db.prepare('SELECT slug FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const composeFile = getComposeFilePath(slug);
    let logs = '';
    try {
      logs = execSync(
        `docker compose -f ${composeFile} logs --tail=${lines} 2>&1`,
        { stdio: 'pipe', encoding: 'utf8', timeout: 10000 }
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

// GET /api/mission-control/logs/all — Get recent Docker logs from ALL running shops
router.get('/logs/all', (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 50;
  const db = getDb();
  try {
    const shops = db.prepare('SELECT slug, name FROM shops ORDER BY name').all();
    const allLogs = [];

    for (const shop of shops) {
      const status = getContainerStatus(shop.slug);
      if (status !== 'running') continue;

      try {
        const composeFile = getComposeFilePath(shop.slug);
        const logs = execSync(
          `docker compose -f ${composeFile} logs --tail=${lines} --timestamps 2>&1`,
          { stdio: 'pipe', encoding: 'utf8', timeout: 5000 }
        );
        if (logs.trim()) {
          allLogs.push({ slug: shop.slug, name: shop.name, logs: logs.trim() });
        }
      } catch { /* skip unavailable shops */ }
    }

    res.json({ shops: allLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/mission-control/errors — Aggregated errors across all shops + system
router.get('/errors', (req, res) => {
  const errors = [];

  // 1. System log errors
  const logFile = path.join(LOG_DIR, 'launchpad.log');
  if (fs.existsSync(logFile)) {
    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n');
      const errorLines = lines.filter(l => /\[(ERROR|FATAL|WARN)\]/.test(l)).slice(-20);
      errorLines.forEach(line => {
        errors.push({ source: 'system', slug: null, message: line.trim(), type: 'system' });
      });
    } catch { /* ignore */ }
  }

  // 2. Shop-level errors (stopped containers that should be running, etc.)
  const db = getDb();
  try {
    const shops = db.prepare('SELECT slug, name, lifecycle_status FROM shops ORDER BY name').all();
    for (const shop of shops) {
      const status = getContainerStatus(shop.slug);
      // Flag shops that are "active" but container is stopped
      if ((shop.lifecycle_status === 'active' || shop.lifecycle_status === 'testing') && status === 'stopped') {
        errors.push({
          source: 'shop',
          slug: shop.slug,
          name: shop.name,
          message: `Container is stopped but lifecycle is "${shop.lifecycle_status}"`,
          type: 'container_down',
        });
      }
    }
  } catch { /* ignore */ } finally {
    db.close();
  }

  res.json({ errors, count: errors.length });
});

module.exports = router;
