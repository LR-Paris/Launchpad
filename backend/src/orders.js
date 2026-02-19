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

module.exports = router;
