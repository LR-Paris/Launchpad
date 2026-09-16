const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const { checkShopPermission } = require('./users');
const { requireUnlocked } = require('./lock');
const { audit } = require('./authz');

const router = express.Router();

// ---------------------------------------------------------------------------
// ADR-001. index.js mounts resolveShopAndRole and the viewer/editor/owner floor
// on every /api/shops/:slug path, which covers everything in this router:
// reading the manifest is viewer, every seed/bulk/patch is editor. Nothing here
// deserves owner, so there is nothing to raise.
// ---------------------------------------------------------------------------

const SHOPS_DIR = path.join(__dirname, '..', 'shops');

// Must match the slugify logic in Shuttle's catalog.ts so product IDs align
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

      // productId = slugified collection-item (matches catalog.ts format)
      const productId = `${slugify(col.name)}-${slugify(item.name)}`;
      products.push({ productId, name, sku, collection: col.name });
    }
  }

  return products;
}

// Migrate inventory.csv productIds from old "Collection/ItemName" format
// to new "collection-item-name" slugified format.
// Safe to run multiple times — only rewrites if old format is detected.
function migrateInventoryIds(slug) {
  const csvPath = inventoryCsvPath(slug);
  if (!fs.existsSync(csvPath)) return;

  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n');

  // Check if migration needed (any productId contains '/')
  const needsMigration = lines.slice(1).some(line => {
    const fields = line.split(',');
    return fields[1] && fields[1].includes('/');
  });
  if (!needsMigration) return;

  const migrated = lines.map((line, i) => {
    if (i === 0) return line; // header
    if (!line.trim()) return line;
    const fields = line.split(',');
    if (fields[1] && fields[1].includes('/')) {
      const parts = fields[1].split('/');
      fields[1] = `${slugify(parts[0])}-${slugify(parts[1] || '')}`;
    }
    return fields.join(',');
  });

  fs.writeFileSync(csvPath, migrated.join('\n'), 'utf-8');
  console.log(`[inventory] Migrated productIds for shop "${slug}"`);
}

// Rebuild productId for every row whose collection matches `oldCollectionName`,
// using the new collection name. Mirrors the slugify rules used everywhere else.
// Updates Collection column too. No-op if inventory.csv doesn't exist.
function renameCollectionInCsv(slug, oldCollectionName, newCollectionName) {
  const csvPath = inventoryCsvPath(slug);
  if (!fs.existsSync(csvPath)) return 0;
  const records = readInventory(slug);
  const oldSlug = slugify(oldCollectionName);
  const newSlug = slugify(newCollectionName);
  if (oldSlug === newSlug && oldCollectionName === newCollectionName) return 0;
  const now = new Date().toISOString();
  let count = 0;
  for (const r of records) {
    const pid = r['Product ID'] || '';
    if (pid.startsWith(`${oldSlug}-`)) {
      r['Product ID'] = newSlug + pid.slice(oldSlug.length);
      r['Collection'] = newCollectionName;
      r['Last Updated'] = now;
      count++;
    } else if ((r['Collection'] || '') === oldCollectionName) {
      // Defensive: row's productId didn't follow the slug pattern but
      // its Collection column matches — still update it.
      r['Collection'] = newCollectionName;
      r['Last Updated'] = now;
      count++;
    }
  }
  if (count > 0) writeInventory(slug, records);
  return count;
}

// Update the productId / Product Name / Collection for a single item rename
// or cross-collection move. Identifies the row by the OLD slugified productId.
function renameItemInCsv(slug, oldCollection, oldItem, newCollection, newItem) {
  const csvPath = inventoryCsvPath(slug);
  if (!fs.existsSync(csvPath)) return 0;
  const records = readInventory(slug);
  const oldId = `${slugify(oldCollection)}-${slugify(oldItem)}`;
  const newId = `${slugify(newCollection)}-${slugify(newItem)}`;
  if (oldId === newId) return 0;
  const now = new Date().toISOString();
  const row = records.find(r => r['Product ID'] === oldId);
  if (!row) return 0;
  row['Product ID'] = newId;
  if (oldItem !== newItem) row['Product Name'] = newItem;
  if (oldCollection !== newCollection) row['Collection'] = newCollection;
  row['Last Updated'] = now;
  writeInventory(slug, records);
  return 1;
}

// GET /api/shops/:slug/inventory
router.get('/:slug/inventory', (req, res) => {
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  migrateInventoryIds(slug);
  const records = readInventory(slug);

  // low_stock_only and paging exist for callers that pay per token. No limit
  // means the old answer, unchanged, because the catalog editor wants the lot.
  const lowOnly = req.query.low_stock_only === 'true' || req.query.low_stock_only === '1';
  const filtered = lowOnly
    ? records.filter((r) => (parseInt(r['Stock'], 10) || 0) <= 5)
    : records;

  const hasLimit = req.query.limit !== undefined;
  const limit = hasLimit ? Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500) : filtered.length;
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  res.json({
    inventory: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  });
});

// GET /api/shops/:slug/inventory/summary — Lightweight fuel status overview
router.get('/:slug/inventory/summary', (req, res) => {
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  migrateInventoryIds(slug);
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

// POST /api/shops/:slug/inventory/seed — Seed inventory from catalog (requires can_edit_items)
router.post('/:slug/inventory/seed', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_items')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  migrateInventoryIds(slug);
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
  const audit_id = audit(req, 'inventory_seeded', { slug, added });
  res.json({ message: `Cargo manifest updated — ${added} new item(s) loaded onto the manifest`, added, total: existing.length, audit_id });
});

// PATCH /api/shops/:slug/inventory/bulk — Bulk update stock (requires can_edit_items)
router.patch('/:slug/inventory/bulk', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_items')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const { updates } = req.body;
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'updates must be an array' });
  }

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  migrateInventoryIds(slug);
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
  const audit_id = audit(req, 'inventory_bulk_updated', { slug, updated });
  res.json({ success: true, message: `${updated} payload(s) updated`, updated, audit_id });
});

// PATCH /api/shops/:slug/inventory/:productId — Update single item (requires can_edit_items)
//
// The pattern used to be :productId(*), which matches slashes, so
// .../inventory/a/b/c arrived as one product id containing path separators.
// Nothing downstream joins it onto a path today, but a wildcard that swallows
// slashes on a route that takes a user-supplied identifier is one refactor away
// from being a traversal. Product ids are slugs: letters, digits, dot, dash,
// underscore, and nothing else.
router.patch('/:slug/inventory/:productId([A-Za-z0-9._-]+)', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_items')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug, productId } = req.params;
  const { stock, notes } = req.body;

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  migrateInventoryIds(slug);
  const records = readInventory(slug);
  const record = records.find(r => r['Product ID'] === productId);
  if (!record) {
    return res.status(404).json({ error: 'Item not found in cargo manifest' });
  }

  if (stock !== undefined) record['Stock'] = String(stock);
  if (notes !== undefined) record['Notes'] = notes;
  record['Last Updated'] = new Date().toISOString();

  writeInventory(slug, records);
  const audit_id = audit(req, 'inventory_updated', { slug, productId, stock, notes });
  res.json({ success: true, item: record, audit_id });
});

module.exports = { router, renameCollectionInCsv, renameItemInCsv };
