const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', '..', 'shops');

function findDatabases(shopDir) {
  const files = [];
  function scan(dir, depth) {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full, depth + 1);
      } else if (/\.(db|sqlite|sqlite3)$/i.test(entry.name)) {
        files.push(path.relative(shopDir, full));
      }
    }
  }
  scan(shopDir, 0);
  return files;
}

function safeQuote(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// GET /api/shops/:slug/db — List database files
router.get('/:slug/db', (req, res) => {
  const shopDir = path.join(SHOPS_DIR, req.params.slug);
  if (!fs.existsSync(shopDir)) return res.status(404).json({ error: 'Shop not found' });
  res.json({ databases: findDatabases(shopDir) });
});

// GET /api/shops/:slug/db/tables — List tables
router.get('/:slug/db/tables', (req, res) => {
  const { file } = req.query;
  if (!file) return res.status(400).json({ error: 'file parameter required' });

  const dbPath = path.join(SHOPS_DIR, req.params.slug, file);
  if (!dbPath.startsWith(path.join(SHOPS_DIR, req.params.slug))) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    res.json({ tables: tables.map(t => t.name) });
  } finally {
    db.close();
  }
});

// GET /api/shops/:slug/db/rows — Get rows from a table
router.get('/:slug/db/rows', (req, res) => {
  const { file, table } = req.query;
  if (!file || !table) return res.status(400).json({ error: 'file and table parameters required' });

  const dbPath = path.join(SHOPS_DIR, req.params.slug, file);
  if (!dbPath.startsWith(path.join(SHOPS_DIR, req.params.slug))) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

  const db = new Database(dbPath, { readonly: true });
  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!tableCheck) return res.status(404).json({ error: 'Table not found' });

    const columns = db.prepare(`PRAGMA table_info(${safeQuote(table)})`).all();
    const rows = db.prepare(`SELECT rowid, * FROM ${safeQuote(table)}`).all();

    res.json({ columns, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/shops/:slug/db/rows — Insert a row
router.post('/:slug/db/rows', (req, res) => {
  const { file, table, data } = req.body;
  if (!file || !table || !data) return res.status(400).json({ error: 'file, table, and data required' });

  const dbPath = path.join(SHOPS_DIR, req.params.slug, file);
  if (!dbPath.startsWith(path.join(SHOPS_DIR, req.params.slug))) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

  const db = new Database(dbPath);
  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!tableCheck) return res.status(404).json({ error: 'Table not found' });

    const keys = Object.keys(data);
    const cols = keys.map(k => safeQuote(k)).join(', ');
    const placeholders = keys.map(() => '?').join(', ');

    const stmt = db.prepare(`INSERT INTO ${safeQuote(table)} (${cols}) VALUES (${placeholders})`);
    const result = stmt.run(...keys.map(k => data[k]));

    res.json({ rowid: Number(result.lastInsertRowid), changes: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// PUT /api/shops/:slug/db/rows/:rowid — Update a row
router.put('/:slug/db/rows/:rowid', (req, res) => {
  const { file, table, data } = req.body;
  const { rowid } = req.params;
  if (!file || !table || !data) return res.status(400).json({ error: 'file, table, and data required' });

  const dbPath = path.join(SHOPS_DIR, req.params.slug, file);
  if (!dbPath.startsWith(path.join(SHOPS_DIR, req.params.slug))) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

  const db = new Database(dbPath);
  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!tableCheck) return res.status(404).json({ error: 'Table not found' });

    const keys = Object.keys(data);
    const sets = keys.map(k => `${safeQuote(k)} = ?`).join(', ');

    const stmt = db.prepare(`UPDATE ${safeQuote(table)} SET ${sets} WHERE rowid = ?`);
    const result = stmt.run(...keys.map(k => data[k]), Number(rowid));

    res.json({ changes: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// DELETE /api/shops/:slug/db/rows/:rowid — Delete a row
router.delete('/:slug/db/rows/:rowid', (req, res) => {
  const { file, table } = req.query;
  const { rowid } = req.params;
  if (!file || !table) return res.status(400).json({ error: 'file and table parameters required' });

  const dbPath = path.join(SHOPS_DIR, req.params.slug, file);
  if (!dbPath.startsWith(path.join(SHOPS_DIR, req.params.slug))) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

  const db = new Database(dbPath);
  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!tableCheck) return res.status(404).json({ error: 'Table not found' });

    const stmt = db.prepare(`DELETE FROM ${safeQuote(table)} WHERE rowid = ?`);
    const result = stmt.run(Number(rowid));

    res.json({ changes: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

module.exports = router;
