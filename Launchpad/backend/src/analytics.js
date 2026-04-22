const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let geoip;
try { geoip = require('geoip-lite'); } catch { geoip = null; }

const trackRouter = express.Router();
const queryRouter = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');
const SHOPS_DIR = path.join(__dirname, '..', 'shops');

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------
function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function initAnalyticsTables() {
  const db = getDb();
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_slug TEXT NOT NULL,
        path TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        ip TEXT,
        country TEXT,
        city TEXT,
        referrer TEXT,
        screen_w INTEGER,
        product_slug TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pv_shop_date ON page_views(shop_slug, created_at);
      CREATE INDEX IF NOT EXISTS idx_pv_product ON page_views(shop_slug, product_slug);
      CREATE INDEX IF NOT EXISTS idx_pv_visitor ON page_views(shop_slug, visitor_id);
    `);
  } finally {
    db.close();
  }
}

// Initialize tables on load
initAnalyticsTables();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function visitorId(ip, userAgent) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${ip}|${userAgent}|${day}`).digest('hex').slice(0, 16);
}

function rangeToDate(range) {
  const now = new Date();
  switch (range) {
    case '24h': return new Date(now - 24 * 60 * 60 * 1000);
    case '7d':  return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case '90d': return new Date(now - 90 * 24 * 60 * 60 * 1000);
    case 'all': return new Date('2000-01-01');
    default:    return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

function rangeToInterval(range) {
  switch (range) {
    case '24h': return 'hour';
    case '7d':  return 'day';
    case '30d': return 'day';
    case '90d': return 'week';
    default:    return 'day';
  }
}

// SQLite date grouping expressions
function dateGroupExpr(interval) {
  switch (interval) {
    case 'hour':
      return "strftime('%Y-%m-%d %H:00', created_at)";
    case 'week':
      return "strftime('%Y-W%W', created_at)";
    case 'day':
    default:
      return "date(created_at)";
  }
}

// Country code → flag emoji
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// Load product names from inventory CSV
function getProductNames(slug) {
  const { parse } = require('csv-parse/sync');
  const candidates = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Inventory', 'inventory.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Inventory', 'Inventory.csv'),
  ];
  const csvPath = candidates.find(p => fs.existsSync(p));
  if (!csvPath) return {};
  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    const map = {};
    for (const r of records) {
      const name = r['Product Name'] || r['product_name'] || r['Name'] || r['name'] || '';
      const id = r['Product ID'] || r['product_id'] || r['ID'] || r['Slug'] || r['slug'] || '';
      if (id) map[id.toLowerCase()] = name || id;
    }
    return map;
  } catch { return {}; }
}

// ---------------------------------------------------------------------------
// TRACKING — Unauthenticated (called by shop frontends)
// ---------------------------------------------------------------------------
// POST /api/shops/:slug/analytics/track
trackRouter.post('/:slug/analytics/track', express.json({ limit: '1kb' }), (req, res) => {
  const { slug } = req.params;
  const { path: pagePath, referrer, screenWidth, productSlug } = req.body || {};

  if (!pagePath || typeof pagePath !== 'string') {
    return res.status(400).end();
  }

  const ip = req.ip || req.connection?.remoteAddress || '';
  const ua = req.get('user-agent') || '';
  const vid = visitorId(ip, ua);

  // GeoIP lookup
  let country = null;
  let city = null;
  if (geoip) {
    const cleanIp = ip.replace(/^::ffff:/, '');
    const geo = geoip.lookup(cleanIp);
    if (geo) {
      country = geo.country || null;
      city = geo.city || null;
    }
  }

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO page_views (shop_slug, path, visitor_id, ip, country, city, referrer, screen_w, product_slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slug,
      pagePath.slice(0, 500),
      vid,
      ip.slice(0, 45),
      country,
      city,
      (referrer || '').slice(0, 500),
      typeof screenWidth === 'number' ? screenWidth : null,
      productSlug ? String(productSlug).slice(0, 200) : null
    );
  } catch { /* best effort */ }
  finally { db.close(); }

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// QUERY ENDPOINTS — Authenticated (admin dashboard)
// ---------------------------------------------------------------------------

// GET /api/shops/:slug/analytics/overview?range=7d
queryRouter.get('/:slug/analytics/overview', (req, res) => {
  const { slug } = req.params;
  const range = req.query.range || '7d';
  const since = rangeToDate(range).toISOString();
  const interval = rangeToInterval(range);
  const groupExpr = dateGroupExpr(interval);

  const db = getDb();
  try {
    // Verify shop exists
    const shop = db.prepare('SELECT slug FROM shops WHERE slug = ?').get(slug);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    // Total views + unique visitors
    const totals = db.prepare(`
      SELECT COUNT(*) as totalViews, COUNT(DISTINCT visitor_id) as uniqueVisitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ?
    `).get(slug, since);

    // Time series
    const timeseries = db.prepare(`
      SELECT ${groupExpr} as period,
             COUNT(*) as views,
             COUNT(DISTINCT visitor_id) as visitors
      FROM page_views
      WHERE shop_slug = ? AND created_at >= ?
      GROUP BY period ORDER BY period
    `).all(slug, since);

    // Top pages
    const topPages = db.prepare(`
      SELECT path, COUNT(*) as views, COUNT(DISTINCT visitor_id) as uniqueVisitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ?
      GROUP BY path ORDER BY views DESC LIMIT 10
    `).all(slug, since);

    // Top countries
    const topCountries = db.prepare(`
      SELECT country, COUNT(*) as views, COUNT(DISTINCT visitor_id) as visitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ? AND country IS NOT NULL
      GROUP BY country ORDER BY views DESC LIMIT 15
    `).all(slug, since);

    const totalViews = totals.totalViews || 0;
    const countriesWithFlags = topCountries.map(c => ({
      ...c,
      flag: countryFlag(c.country),
      percentage: totalViews > 0 ? Math.round((c.views / totalViews) * 100) : 0,
    }));

    // Top products
    const topProducts = db.prepare(`
      SELECT product_slug as productSlug, COUNT(*) as views, COUNT(DISTINCT visitor_id) as uniqueVisitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ? AND product_slug IS NOT NULL
      GROUP BY product_slug ORDER BY views DESC LIMIT 10
    `).all(slug, since);

    // Cross-reference product names
    const productNames = getProductNames(slug);
    const productsWithNames = topProducts.map(p => ({
      ...p,
      name: productNames[p.productSlug?.toLowerCase()] || p.productSlug,
    }));

    // Device breakdown by screen width
    const devices = db.prepare(`
      SELECT
        SUM(CASE WHEN screen_w < 768 THEN 1 ELSE 0 END) as mobile,
        SUM(CASE WHEN screen_w >= 768 AND screen_w < 1024 THEN 1 ELSE 0 END) as tablet,
        SUM(CASE WHEN screen_w >= 1024 THEN 1 ELSE 0 END) as desktop,
        COUNT(*) as total
      FROM page_views WHERE shop_slug = ? AND created_at >= ? AND screen_w IS NOT NULL
    `).get(slug, since);

    // Referrer breakdown
    const topReferrers = db.prepare(`
      SELECT referrer, COUNT(*) as views
      FROM page_views WHERE shop_slug = ? AND created_at >= ? AND referrer IS NOT NULL AND referrer != ''
      GROUP BY referrer ORDER BY views DESC LIMIT 10
    `).all(slug, since);

    // Days in range for avg calculation
    const msInRange = Date.now() - new Date(since).getTime();
    const daysInRange = Math.max(1, Math.ceil(msInRange / (24 * 60 * 60 * 1000)));

    res.json({
      totalViews,
      uniqueVisitors: totals.uniqueVisitors || 0,
      avgViewsPerDay: Math.round(totalViews / daysInRange),
      timeseries,
      topPages,
      topCountries: countriesWithFlags,
      topProducts: productsWithNames,
      devices: {
        mobile: devices?.mobile || 0,
        tablet: devices?.tablet || 0,
        desktop: devices?.desktop || 0,
        total: devices?.total || 0,
      },
      topReferrers,
      range,
      since,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/analytics/timeseries?range=7d&interval=day
queryRouter.get('/:slug/analytics/timeseries', (req, res) => {
  const { slug } = req.params;
  const range = req.query.range || '7d';
  const interval = req.query.interval || rangeToInterval(range);
  const since = rangeToDate(range).toISOString();
  const groupExpr = dateGroupExpr(interval);

  const db = getDb();
  try {
    const points = db.prepare(`
      SELECT ${groupExpr} as period,
             COUNT(*) as views,
             COUNT(DISTINCT visitor_id) as visitors
      FROM page_views
      WHERE shop_slug = ? AND created_at >= ?
      GROUP BY period ORDER BY period
    `).all(slug, since);

    res.json({ points, range, interval });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/analytics/countries?range=7d
queryRouter.get('/:slug/analytics/countries', (req, res) => {
  const { slug } = req.params;
  const range = req.query.range || '7d';
  const since = rangeToDate(range).toISOString();

  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT country, COUNT(*) as views, COUNT(DISTINCT visitor_id) as visitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ? AND country IS NOT NULL
      GROUP BY country ORDER BY views DESC
    `).all(slug, since);

    const total = rows.reduce((s, r) => s + r.views, 0);
    const result = rows.map(r => ({
      ...r,
      flag: countryFlag(r.country),
      percentage: total > 0 ? Math.round((r.views / total) * 100) : 0,
    }));

    res.json({ countries: result, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/analytics/pages?range=7d
queryRouter.get('/:slug/analytics/pages', (req, res) => {
  const { slug } = req.params;
  const range = req.query.range || '7d';
  const since = rangeToDate(range).toISOString();

  const db = getDb();
  try {
    const pages = db.prepare(`
      SELECT path, COUNT(*) as views, COUNT(DISTINCT visitor_id) as uniqueVisitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ?
      GROUP BY path ORDER BY views DESC LIMIT 50
    `).all(slug, since);

    res.json({ pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/analytics/products?range=7d
queryRouter.get('/:slug/analytics/products', (req, res) => {
  const { slug } = req.params;
  const range = req.query.range || '7d';
  const since = rangeToDate(range).toISOString();

  const db = getDb();
  try {
    const products = db.prepare(`
      SELECT product_slug as productSlug, COUNT(*) as views, COUNT(DISTINCT visitor_id) as uniqueVisitors
      FROM page_views WHERE shop_slug = ? AND created_at >= ? AND product_slug IS NOT NULL
      GROUP BY product_slug ORDER BY views DESC LIMIT 20
    `).all(slug, since);

    const productNames = getProductNames(slug);
    const result = products.map(p => ({
      ...p,
      name: productNames[p.productSlug?.toLowerCase()] || p.productSlug,
    }));

    res.json({ products: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

module.exports = { trackRouter, queryRouter };
