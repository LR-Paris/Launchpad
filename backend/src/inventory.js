const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');

const CSV_HEADERS = 'SKU,Product ID,Product Name,Collection,Stock,Last Updated,Notes';

function escapeCSVField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function inventoryCsvPath(slug) {
  return path.join(SHOPS_DIR, slug, 'DATABASE', 'Inventory', 'inventory.csv');
}

function readInventory(slug) {
  const csvPath = inventoryCsvPath(slug);
  if (!fs.existsSync(csvPath)) return [];

  const content = fs.readFileSync(csvPath, 'utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function writeInventory(slug, records) {
  const csvPath = inventoryCsvPath(slug);
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });

  const lines = [CSV_HEADERS];
  for (const r of records) {
    lines.push([
      escapeCSVField(r['SKU'] || r.sku || ''),
      escapeCSVField(r['Product ID'] || r.productId || ''),
      escapeCSVField(r['Product Name'] || r.productName || ''),
      escapeCSVField(r['Collection'] || r.collection || ''),
      escapeCSVField(r['Stock'] ?? r.stock ?? 0),
      escapeCSVField(r['Last Updated'] || r.lastUpdated || new Date().toISOString()),
      escapeCSVField(r['Notes'] || r.notes || ''),
    ].join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
}

// Build product catalog from ShopCollections
function buildCatalogFromFiles(slug) {
  const collectionsDir = path.join(SHOPS_DIR, slug, 'DATABASE', 'ShopCollections');
  if (!fs.existsSync(collectionsDir)) return [];

  const products = [];
  const collections = fs.readdirSync(collectionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const col of collections) {
    const colPath = path.join(collectionsDir, col.name);
    const items = fs.readdirSync(colPath, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const item of items) {
      const detailsDir = path.join(colPath, item.name, 'Details');
      let name = item.name;
      let sku = '';

      try {
        name = fs.readFileSync(path.join(detailsDir, 'Name.txt'), 'utf8').trim() || item.name;
      } catch {}
      try {
        sku = fs.readFileSync(path.join(detailsDir, 'SKU.txt'), 'utf8').trim();
      } catch {}

      // productId = Collection/DirName (unique)
      const productId = `${col.name}/${item.name}`;
      products.push({ productId, name, sku, collection: col.name });
    }
  }

  return products;
}

// GET /api/shops/:slug/inventory
router.get('/:slug/inventory', (req, res) => {
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const records = readInventory(slug);
  res.json({ inventory: records });
});

// GET /api/shops/:slug/inventory/summary — Lightweight fuel status overview
router.get('/:slug/inventory/summary', (req, res) => {
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const records = readInventory(slug);
  let nominal = 0, lowFuel = 0, depleted = 0;
  for (const r of records) {
    const stock = parseInt(r['Stock'], 10) || 0;
    if (stock === 0) depleted++;
    else if (stock <= 5) lowFuel++;
    else nominal++;
  }

  // Overall status: worst-case drives the status
  let status = 'nominal';
  if (depleted > 0) status = 'depleted';
  else if (lowFuel > 0) status = 'low-fuel';
  else if (records.length === 0) status = 'no-manifest';

  res.json({ total: records.length, nominal, lowFuel, depleted, status });
});

// POST /api/shops/:slug/inventory/seed — Seed inventory from catalog
router.post('/:slug/inventory/seed', (req, res) => {
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const catalog = buildCatalogFromFiles(slug);
  const existing = readInventory(slug);
  const existingIds = new Set(existing.map(r => r['Product ID']));

  let added = 0;
  const now = new Date().toISOString();
  for (const product of catalog) {
    if (!existingIds.has(product.productId)) {
      existing.push({
        'SKU': product.sku,
        'Product ID': product.productId,
        'Product Name': product.name,
        'Collection': product.collection,
        'Stock': '0',
        'Last Updated': now,
        'Notes': '',
      });
      added++;
    }
  }

  writeInventory(slug, existing);
  res.json({ message: `Cargo manifest updated — ${added} new item(s) loaded onto the manifest`, added, total: existing.length });
});

// PATCH /api/shops/:slug/inventory/bulk — Bulk update stock
router.patch('/:slug/inventory/bulk', (req, res) => {
  const { slug } = req.params;
  const { updates } = req.body;
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'updates must be an array' });
  }

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const records = readInventory(slug);
  const now = new Date().toISOString();
  let updated = 0;

  for (const upd of updates) {
    const record = records.find(r => r['Product ID'] === upd.productId);
    if (record) {
      if (upd.stock !== undefined) record['Stock'] = String(upd.stock);
      if (upd.notes !== undefined) record['Notes'] = upd.notes;
      record['Last Updated'] = now;
      updated++;
    }
  }

  writeInventory(slug, records);
  res.json({ success: true, message: `${updated} payload(s) updated`, updated });
});

// PATCH /api/shops/:slug/inventory/:productId — Update single item
router.patch('/:slug/inventory/:productId(*)', (req, res) => {
  const { slug, productId } = req.params;
  const { stock, notes } = req.body;

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  const records = readInventory(slug);
  const record = records.find(r => r['Product ID'] === productId);
  if (!record) {
    return res.status(404).json({ error: 'Item not found in cargo manifest' });
  }

  if (stock !== undefined) record['Stock'] = String(stock);
  if (notes !== undefined) record['Notes'] = notes;
  record['Last Updated'] = new Date().toISOString();

  writeInventory(slug, records);
  res.json({ success: true, item: record });
});

module.exports = router;
