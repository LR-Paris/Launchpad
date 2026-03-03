const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');

// GET /api/shops/:slug/orders
router.get('/:slug/orders', (req, res) => {
  const { slug } = req.params;
  // Try DATABASE/Orders/orders.csv first, then fallbacks
  let csvPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'orders.csv');
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'Orders.csv');
  }
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'orders', 'orders.csv');
  }
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(SHOPS_DIR, slug, 'orders', 'orders.csv');
  }

  if (!fs.existsSync(csvPath)) {
    return res.json({ orders: [] });
  }

  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    res.json({ orders: records });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse orders CSV' });
  }
});

// GET /api/shops/:slug/orders/download
router.get('/:slug/orders/download', (req, res) => {
  const { slug } = req.params;
  let csvPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'orders.csv');
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'Orders.csv');
  }
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(SHOPS_DIR, slug, 'DATABASE', 'orders', 'orders.csv');
  }
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(SHOPS_DIR, slug, 'orders', 'orders.csv');
  }

  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'No orders file found' });
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-orders.csv"`);
  fs.createReadStream(csvPath).pipe(res);
});

// POST /api/shops/:slug/orders/wipe — Replace orders CSV with header-only file
router.post('/:slug/orders/wipe', (req, res) => {
  const { slug } = req.params;

  // Protection: Active shops cannot have orders wiped
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const shop = db.prepare('SELECT lifecycle_status FROM shops WHERE slug = ?').get(slug);
    db.close();
    if (shop && shop.lifecycle_status === 'active') {
      return res.status(403).json({ error: 'Cannot wipe orders on an Active shop. Change its status first.' });
    }
  } catch { /* proceed if DB check fails */ }

  // Find the existing CSV to preserve its header
  const candidates = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'Orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'orders', 'orders.csv'),
  ];

  let csvPath = candidates.find(p => fs.existsSync(p));

  if (!csvPath) {
    return res.status(404).json({ error: 'No orders file found' });
  }

  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const firstLine = content.split('\n')[0];
    // Write back just the header row
    fs.writeFileSync(csvPath, firstLine + '\n');
    res.json({ message: 'Orders wiped. CSV header preserved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Content-Type mapping for common PO file formats
const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.html': 'text/html',
};

// Recursively search a directory for a file by name
function findFileRecursive(dir, targetName, maxDepth = 3) {
  if (maxDepth <= 0 || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (!entry.isDirectory() && entry.name === targetName) return fullPath;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findFileRecursive(path.join(dir, entry.name), targetName, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

// GET /api/shops/:slug/orders/po/:filename — Download/open a PO file
// Also supports query param: /api/shops/:slug/orders/po?filename=...
router.get('/:slug/orders/po/:filename?', (req, res) => {
  const { slug } = req.params;
  const filename = req.params.filename || req.query.filename;

  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  // Sanitize: extract basename and block path traversal
  if (filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const safeName = path.basename(filename);

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  // Try common locations first, then search recursively
  const ordersDir = path.join(shopDir, 'DATABASE', 'Orders');
  let filePath = path.join(ordersDir, safeName);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ordersDir, 'POs', safeName);
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ordersDir, 'PO', safeName);
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(shopDir, 'orders', safeName);
  }
  // Recursive search within DATABASE/Orders as last resort
  if (!fs.existsSync(filePath)) {
    filePath = findFileRecursive(ordersDir, safeName) || filePath;
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'PO file not found' });
  }

  // Ensure the resolved path is still inside the shop directory
  const realPath = fs.realpathSync(filePath);
  const realShopDir = fs.realpathSync(shopDir);
  if (!realPath.startsWith(realShopDir + path.sep)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  const ext = path.extname(safeName).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isInlineable = ['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.html'].includes(ext);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${isInlineable ? 'inline' : 'attachment'}; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/shops/:slug/orders/catalog-photos — Return product names → photo paths for order enrichment
router.get('/:slug/orders/catalog-photos', (req, res) => {
  const { slug } = req.params;
  const collectionsDir = path.join(SHOPS_DIR, slug, 'DATABASE', 'ShopCollections');
  if (!fs.existsSync(collectionsDir)) {
    return res.json({ products: {} });
  }

  const products = {};
  try {
    const collections = fs.readdirSync(collectionsDir, { withFileTypes: true }).filter(e => e.isDirectory());
    for (const col of collections) {
      const colPath = path.join(collectionsDir, col.name);
      const items = fs.readdirSync(colPath, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const item of items) {
        const detailsDir = path.join(colPath, item.name, 'Details');
        const photosDir = path.join(colPath, item.name, 'Photos');
        let name = item.name;
        let sku = '';
        let price = '';
        let photoFile = null;

        try { name = fs.readFileSync(path.join(detailsDir, 'Name.txt'), 'utf8').trim() || item.name; } catch {}
        try { sku = fs.readFileSync(path.join(detailsDir, 'SKU.txt'), 'utf8').trim(); } catch {}
        try { price = fs.readFileSync(path.join(detailsDir, 'ItemCost.txt'), 'utf8').trim(); } catch {}

        if (fs.existsSync(photosDir)) {
          try {
            const photos = fs.readdirSync(photosDir).filter(f => /\.(jpe?g|png|gif|webp|avif)$/i.test(f));
            const main = photos.find(f => f.toLowerCase().startsWith('main'));
            photoFile = main || photos[0] || null;
          } catch {}
        }

        const photoPath = photoFile
          ? `DATABASE/ShopCollections/${col.name}/${item.name}/Photos/${photoFile}`
          : null;

        products[name.toLowerCase()] = { name, sku, price, collection: col.name, photoPath };
        // Also index by SKU if available
        if (sku) products[sku.toLowerCase()] = { name, sku, price, collection: col.name, photoPath };
      }
    }
  } catch { /* ignore */ }

  res.json({ products });
});

module.exports = router;
