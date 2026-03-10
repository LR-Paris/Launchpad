const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const { parse } = require('csv-parse/sync');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const { LOG_DIR } = require('./logger');

function findCsvPath(slug) {
  const candidates = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'Orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'orders', 'orders.csv'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function getRecentOrders(slug, count = 5) {
  const csvPath = findCsvPath(slug);
  if (!csvPath) return [];
  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    return records.slice(-count).reverse().map(r => ({
      orderId: r['Order ID'] || r['order_id'] || r['Order #'] || r['ID'] || '',
      customer: r['Customer Name'] || r['Name'] || r['name'] || '',
      status: r['Status'] || r['status'] || 'Pending',
      date: r['Date'] || r['date'] || r['Order Date'] || '',
    }));
  } catch { return []; }
}

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

      const recentOrders = getRecentOrders(shop.slug, 5);

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
        recentOrders,
        orderCount: recentOrders.length,
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

// GET /api/mission-control/security — Security intelligence from audit log + sessions
router.get('/security', (req, res) => {
  const auditLogPath = path.join(DATA_DIR, 'audit.log');
  const sessionsDbPath = path.join(DATA_DIR, 'sessions.db');

  // 1. Parse audit log
  let entries = [];
  if (fs.existsSync(auditLogPath)) {
    try {
      const content = fs.readFileSync(auditLogPath, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());
      const tail = allLines.slice(-500);
      entries = tail.map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { /* file unreadable */ }
  }

  // 2. Recent events (last 20)
  const recentEvents = entries.slice(-20).reverse().map(e => ({
    timestamp: e.timestamp,
    event: e.event,
    actor: e.actor,
    ip: e.ip,
    details: e.details,
  }));

  // 3. Stats for last 24 hours
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const recent = entries.filter(e => new Date(e.timestamp).getTime() > oneDayAgo);

  const shopActionEvents = /^shop_(created|updated|deleted|started|stopped|restarted|deployed)$/;
  const fileOpEvents = /^(file_written|file_deleted|files_uploaded|file_replaced|zip_uploaded)$/;

  const stats24h = {
    totalEvents: recent.length,
    loginSuccess: recent.filter(e => e.event === 'login_success').length,
    loginFailed: recent.filter(e => e.event === 'login_failed').length,
    passwordChanges: recent.filter(e => e.event === 'password_changed').length,
    shopActions: recent.filter(e => shopActionEvents.test(e.event)).length,
    fileOperations: recent.filter(e => fileOpEvents.test(e.event)).length,
    uniqueIPs: new Set(recent.map(e => e.ip).filter(Boolean)).size,
  };

  // 4. Failed logins (last 24h, max 20)
  const failedLogins = recent
    .filter(e => e.event === 'login_failed')
    .slice(-20)
    .reverse()
    .map(e => ({ timestamp: e.timestamp, ip: e.ip, actor: e.details?.username || e.actor }));

  // 5. Active sessions count
  let activeSessions = 0;
  try {
    if (fs.existsSync(sessionsDbPath)) {
      const sessDb = new Database(sessionsDbPath, { readonly: true });
      const row = sessDb.prepare('SELECT COUNT(*) as count FROM sessions WHERE expired > ?').get(now);
      activeSessions = row?.count || 0;
      sessDb.close();
    }
  } catch { /* sessions db unavailable */ }

  // 6. Security score (0-100)
  let securityScore = 100;
  const failedLoginDeduction = Math.min(stats24h.loginFailed * 5, 40);
  const failedPwDeduction = Math.min(
    recent.filter(e => e.event === 'password_change_failed').length * 5, 20
  );
  const highIpDeduction = stats24h.uniqueIPs > 5 ? 10 : 0;
  securityScore = Math.max(0, securityScore - failedLoginDeduction - failedPwDeduction - highIpDeduction);

  res.json({
    recentEvents,
    stats24h,
    failedLogins,
    activeSessions,
    securityScore,
  });
});

module.exports = router;
