const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');

// POST /api/shops/:slug/orders/notify
// Unauthenticated — called by Shuttle containers after writing an order to CSV.
// Validates that the shop exists in the DB and on disk before sending email.
router.post('/:slug/orders/notify', (req, res) => {
  const { slug } = req.params;
  const { orderData } = req.body;

  if (!orderData || typeof orderData !== 'object') {
    return res.status(400).json({ error: 'orderData is required' });
  }

  // Validate: shop must exist in the database
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const shop = db.prepare('SELECT id FROM shops WHERE slug = ?').get(slug);
    db.close();
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }
  } catch (err) {
    console.error(`[notify] DB check failed for ${slug}: ${err.message}`);
  }

  // Validate: shop directory must exist on disk
  const shopDir = path.join(SHOPS_DIR, slug);
  if (!fs.existsSync(shopDir)) {
    return res.status(404).json({ error: 'Shop directory not found' });
  }

  // Fire-and-forget email
  const { sendOrderConfirmation } = require('./email');
  sendOrderConfirmation(orderData, slug).catch(err => {
    console.error(`[notify] Email failed for ${slug}: ${err.message}`);
  });

  res.json({ message: 'Notification queued' });
});

module.exports = router;
