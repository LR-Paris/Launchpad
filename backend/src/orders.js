const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');

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
};

// GET /api/shops/:slug/orders/po/:filename — Download/open a PO file
router.get('/:slug/orders/po/:filename', (req, res) => {
  const { slug, filename } = req.params;

  // Sanitize filename to prevent path traversal
  const safeName = path.basename(filename);
  if (safeName !== filename || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  // Try DATABASE/Orders/ first, then orders/
  let filePath = path.join(shopDir, 'DATABASE', 'Orders', safeName);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(shopDir, 'orders', safeName);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'PO file not found' });
  }

  const ext = path.extname(safeName).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isInlineable = ext === '.pdf' || ext === '.png' || ext === '.jpg' || ext === '.jpeg';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${isInlineable ? 'inline' : 'attachment'}; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
