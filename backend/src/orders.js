const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');

// Must match the slugify logic in Shuttle's catalog.ts so product IDs align
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Locate the Orders directory for a shop (returns first existing path or null)
function findOrdersDir(slug) {
  const candidates = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'orders'),
    path.join(SHOPS_DIR, slug, 'orders'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// Find orders.csv for a shop (consolidates the fallback logic used by multiple handlers)
function findCsvPath(slug) {
  const candidates = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'Orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'orders', 'orders.csv'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// Escape a value for CSV output (matches the pattern in inventory.js)
function escapeCSVField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Lazily add Status and Tracking Number columns to an existing orders CSV.
// Idempotent: checks if columns already exist before modifying.
function backfillStatusColumns(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return;
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');
  if (lines.length === 0) return;

  const header = lines[0];
  if (/,Status(,|$)/.test(header)) return; // already has Status column

  const newLines = lines.map((line, i) => {
    if (!line.trim()) return line;
    if (i === 0) return line + ',Status,Tracking Number';
    return line + ',Pending,'; // backfill existing orders as Pending
  });

  fs.writeFileSync(csvPath, newLines.join('\n'));
  console.log(`[orders] Backfilled Status/Tracking columns: ${csvPath}`);
}

// Update a specific order's Status and Tracking Number by Order ID.
// Returns the updated row object, or null if not found.
function updateOrderStatus(csvPath, orderId, status, trackingNumber) {
  if (!csvPath || !fs.existsSync(csvPath)) return null;

  const content = fs.readFileSync(csvPath, 'utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  if (records.length === 0) return null;

  // Find matching order (check common ID column names)
  const row = records.find(r =>
    (r['Order ID'] || r['order_id'] || r['Order #'] || r['Order Number'] || r['ID'] || r['id']) === orderId
  );
  if (!row) return null;

  row['Status'] = status;
  if (trackingNumber !== undefined) {
    row['Tracking Number'] = trackingNumber;
  }

  // Rebuild CSV
  const columns = Object.keys(records[0]);
  const headerLine = columns.map(escapeCSVField).join(',');
  const dataLines = records.map(r =>
    columns.map(c => escapeCSVField(r[c])).join(',')
  );
  fs.writeFileSync(csvPath, [headerLine, ...dataLines].join('\n') + '\n');
  return row;
}

// Find a PO file by scanning the Orders directory for files matching the order ID.
// The CSV "PO File" column may contain:
//   - the exact filename: "ORD-123.pdf"
//   - a placeholder like "ORD-123 (see Orders folder)"
// In both cases we extract the ORD-xxx ID and search for a file with that prefix.
function findPoFile(slug, rawFilename) {
  const ordersDir = findOrdersDir(slug);
  if (!ordersDir) return null;

  // 1) Try exact match first (if it looks like an actual filename with extension)
  if (/\.\w{1,5}$/.test(rawFilename)) {
    const exact = path.join(ordersDir, path.basename(rawFilename));
    if (fs.existsSync(exact)) return exact;
  }

  // 2) Extract the order ID (ORD-<timestamp>-<random>) from the value
  const orderIdMatch = rawFilename.match(/(ORD-[\w-]+)/);
  if (!orderIdMatch) return null;
  const orderId = orderIdMatch[1];

  // 3) Scan the Orders directory for files starting with that order ID
  try {
    const files = fs.readdirSync(ordersDir);
    const match = files.find(f => {
      const name = path.parse(f).name;
      return name === orderId;
    });
    if (match) return path.join(ordersDir, match);
  } catch { /* directory unreadable */ }

  return null;
}

// GET /api/shops/:slug/orders
router.get('/:slug/orders', (req, res) => {
  const { slug } = req.params;
  const csvPath = findCsvPath(slug);

  if (!csvPath) {
    return res.json({ orders: [] });
  }

  // Lazy migration: ensure Status/Tracking columns exist
  backfillStatusColumns(csvPath);

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
  const csvPath = findCsvPath(slug);

  if (!csvPath) {
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

  const csvPath = findCsvPath(slug);

  if (!csvPath) {
    return res.status(404).json({ error: 'No orders file found' });
  }

  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const firstLine = content.split('\n')[0];
    // Write back just the header row
    fs.writeFileSync(csvPath, firstLine + '\n');
    req.app.locals.auditLog?.('orders_wiped', { req, details: { slug } });
    res.json({ message: 'Orders wiped. CSV header preserved.' });
  } catch (err) {
    console.error(`[orders] wipe ${slug} error:`, err.message);
    res.status(500).json({ error: 'Failed to wipe orders.' });
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
// Handles both exact filenames ("ORD-123.pdf") and Shuttle placeholder text
// ("ORD-123 (see Orders folder)") by extracting the order ID and scanning the dir.
router.get('/:slug/orders/po/:filename?', (req, res) => {
  const { slug } = req.params;
  const filename = req.params.filename || req.query.filename;

  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  // Block path traversal
  if (filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  // findPoFile handles both exact filenames and Shuttle placeholder text
  // like "ORD-xxx (see Orders folder)" by extracting the order ID
  let filePath = findPoFile(slug, filename);

  // Fallback: try recursive search with the basename
  if (!filePath) {
    const safeName = path.basename(filename);
    const ordersDir = path.join(shopDir, 'DATABASE', 'Orders');
    filePath = findFileRecursive(ordersDir, safeName);
  }

  if (!filePath) {
    return res.status(404).json({ error: 'PO file not found' });
  }

  // Ensure the resolved path is still inside the shop directory
  const realPath = fs.realpathSync(filePath);
  const realShopDir = fs.realpathSync(shopDir);
  if (!realPath.startsWith(realShopDir + path.sep)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  const resolvedName = path.basename(filePath);
  const ext = path.extname(resolvedName).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isInlineable = ['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.html'].includes(ext);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${isInlineable ? 'inline' : 'attachment'}; filename="${resolvedName}"`);
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

// GET /api/shops/:slug/orders/product-image/:productId — Serve product thumbnail
// Resolves a slugified productId (e.g. "jet-set-cafe-tumbler") back to its
// ShopCollections folder and returns the main photo.
router.get('/:slug/orders/product-image/:productId', (req, res) => {
  const { slug, productId } = req.params;
  const collectionsDir = path.join(SHOPS_DIR, slug, 'DATABASE', 'ShopCollections');

  if (!fs.existsSync(collectionsDir)) {
    return res.status(404).json({ error: 'Collections not found' });
  }

  try {
    const collections = fs.readdirSync(collectionsDir, { withFileTypes: true });

    for (const col of collections) {
      if (!col.isDirectory()) continue;

      const colPath = path.join(collectionsDir, col.name);
      const items = fs.readdirSync(colPath, { withFileTypes: true });

      for (const item of items) {
        if (!item.isDirectory()) continue;
        if (`${slugify(col.name)}-${slugify(item.name)}` !== productId) continue;

        const photosDir = path.join(colPath, item.name, 'Photos');
        if (!fs.existsSync(photosDir)) continue;

        // Prefer main.* then fall back to any image
        const files = fs.readdirSync(photosDir);
        const mainPhoto = files.find(f => /^main\.(jpg|jpeg|png|webp)$/i.test(f));
        const anyPhoto = files.find(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
        const photo = mainPhoto || anyPhoto;

        if (photo) {
          const photoPath = path.join(photosDir, photo);
          const ext = path.extname(photo).toLowerCase();
          const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          return fs.createReadStream(photoPath).pipe(res);
        }
      }
    }
  } catch { /* directory unreadable */ }

  return res.status(404).json({ error: 'Product image not found' });
});

// POST /api/shops/:slug/orders/:orderId/ship — Mark an order as shipped
router.post('/:slug/orders/:orderId/ship', (req, res) => {
  const { slug, orderId } = req.params;
  const { trackingNumber } = req.body;

  const csvPath = findCsvPath(slug);
  if (!csvPath) {
    return res.status(404).json({ error: 'No orders file found' });
  }

  // Ensure Status/Tracking columns exist before updating
  backfillStatusColumns(csvPath);

  const updatedRow = updateOrderStatus(csvPath, orderId, 'Shipped', trackingNumber || '');
  if (!updatedRow) {
    return res.status(404).json({ error: `Order ${orderId} not found` });
  }

  // Fire-and-forget shipped notification email
  const { sendShippedNotification } = require('./email');
  sendShippedNotification(updatedRow, trackingNumber || '', slug).catch(err => {
    console.error(`[ship] Email failed for ${slug}/${orderId}: ${err.message}`);
  });

  req.app.locals.auditLog?.('order_shipped', { req, details: { slug, orderId, trackingNumber } });
  res.json({ message: 'Order marked as shipped', order: updatedRow });
});

// POST /api/shops/:slug/orders/:orderId/cancel — Admin cancel (no time limit)
router.post('/:slug/orders/:orderId/cancel', (req, res) => {
  const { slug, orderId } = req.params;

  const csvPath = findCsvPath(slug);
  if (!csvPath) {
    return res.status(404).json({ error: 'No orders file found' });
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  const row = records.find(r =>
    (r['Order ID'] || r['order_id'] || r['Order #'] || r['Order Number'] || r['ID'] || r['id']) === orderId
  );

  if (!row) {
    return res.status(404).json({ error: `Order ${orderId} not found` });
  }

  // Remove order from CSV
  const filtered = records.filter(r => {
    const id = r['Order ID'] || r['order_id'] || r['Order #'] || r['Order Number'] || r['ID'] || r['id'];
    return id !== orderId;
  });

  const columns = Object.keys(records[0]);
  const headerLine = columns.map(escapeCSVField).join(',');
  const dataLines = filtered.map(r => columns.map(c => escapeCSVField(r[c])).join(','));
  fs.writeFileSync(csvPath, [headerLine, ...dataLines].join('\n') + '\n');

  // Fire-and-forget cancellation email
  const { sendCancellationEmail } = require('./email');
  sendCancellationEmail(row, slug).catch(err => {
    console.error(`[cancel] Email failed for ${slug}/${orderId}: ${err.message}`);
  });

  req.app.locals.auditLog?.('order_cancelled', { req, details: { slug, orderId } });
  res.json({ message: 'Order cancelled', order: row });
});

module.exports = router;
