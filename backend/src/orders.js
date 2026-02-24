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

// GET /api/shops/:slug/orders/po/:filename — Download a PO file (PDF)
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

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
