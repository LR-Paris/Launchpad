const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'shops.db');

const CANCEL_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set — cannot generate cancel tokens.');
  }
  return secret;
}

function generateCancelToken(orderId, slug) {
  return crypto.createHmac('sha256', getSecret()).update(`${orderId}:${slug}:cancel`).digest('hex').slice(0, 32);
}

function verifyCancelToken(orderId, slug, token) {
  return token && generateCancelToken(orderId, slug) === token;
}

function shopExists(slug) {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const shop = db.prepare('SELECT id FROM shops WHERE slug = ?').get(slug);
    db.close();
    if (!shop) return false;
  } catch { /* proceed */ }
  return fs.existsSync(path.join(SHOPS_DIR, slug));
}

function findCsvPath(slug) {
  const candidates = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Orders', 'Orders.csv'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'orders', 'orders.csv'),
    path.join(SHOPS_DIR, slug, 'orders', 'orders.csv'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function escapeCSVField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getOrderById(csvPath, orderId) {
  if (!csvPath || !fs.existsSync(csvPath)) return null;
  const content = fs.readFileSync(csvPath, 'utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  return records.find(r =>
    (r['Order ID'] || r['order_id'] || r['Order #'] || r['Order Number'] || r['ID'] || r['id']) === orderId
  ) || null;
}

function isWithinCancelWindow(row) {
  const dateVal = row['Date'] || row['date'] || row['Order Date'] || row['Timestamp'] || '';
  if (!dateVal) return false;
  const orderTime = new Date(dateVal).getTime();
  if (isNaN(orderTime)) return false;
  return (Date.now() - orderTime) <= CANCEL_WINDOW_MS;
}

function removeOrderFromCsv(csvPath, orderId) {
  if (!csvPath || !fs.existsSync(csvPath)) return false;
  const content = fs.readFileSync(csvPath, 'utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  const before = records.length;
  const filtered = records.filter(r => {
    const id = r['Order ID'] || r['order_id'] || r['Order #'] || r['Order Number'] || r['ID'] || r['id'];
    return id !== orderId;
  });
  if (filtered.length === before) return false;

  const columns = Object.keys(records[0]);
  const headerLine = columns.map(escapeCSVField).join(',');
  const dataLines = filtered.map(r => columns.map(c => escapeCSVField(r[c])).join(','));
  fs.writeFileSync(csvPath, [headerLine, ...dataLines].join('\n') + '\n');
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/shops/:slug/orders/notify
// Unauthenticated — called by Shuttle containers after writing an order to CSV.
// ---------------------------------------------------------------------------
router.post('/:slug/orders/notify', (req, res) => {
  const { slug } = req.params;
  const { orderData } = req.body;

  if (!orderData || typeof orderData !== 'object' || Array.isArray(orderData)) {
    return res.status(400).json({ error: 'orderData must be a non-array object' });
  }

  // Validate and sanitize orderData fields — reject unexpected types
  const MAX_FIELD_LENGTH = 10000;
  for (const [key, value] of Object.entries(orderData)) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && !Array.isArray(value) && typeof value !== 'object') {
      return res.status(400).json({ error: `Invalid type for orderData field "${key}"` });
    }
    if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
      return res.status(400).json({ error: `orderData field "${key}" exceeds maximum length` });
    }
  }

  if (!shopExists(slug)) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  // Fire-and-forget email
  const { sendOrderConfirmation } = require('./email');
  sendOrderConfirmation(orderData, slug).catch(err => {
    console.error(`[notify] Email failed for ${slug}: ${err.message}`);
  });

  res.json({ message: 'Notification queued' });
});

// ---------------------------------------------------------------------------
// GET /api/shops/:slug/orders/:orderId/cancel?token=xxx
// Public page — renders a confirmation page for order cancellation.
// ---------------------------------------------------------------------------
router.get('/:slug/orders/:orderId/cancel', (req, res) => {
  const { slug, orderId } = req.params;
  const { token } = req.query;

  if (!verifyCancelToken(orderId, slug, token)) {
    return res.status(403).send(cancelPage({ error: 'Invalid or expired cancellation link.' }));
  }

  if (!shopExists(slug)) {
    return res.status(404).send(cancelPage({ error: 'Shop not found.' }));
  }

  const csvPath = findCsvPath(slug);
  const row = getOrderById(csvPath, orderId);

  if (!row) {
    return res.send(cancelPage({ error: 'Order not found. It may have already been cancelled.' }));
  }

  const status = (row['Status'] || row['status'] || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return res.send(cancelPage({ error: 'This order has already been cancelled.' }));
  }

  if (!isWithinCancelWindow(row)) {
    return res.send(cancelPage({ error: 'The 2-hour cancellation window has passed. Please contact us directly for assistance.' }));
  }

  // Read branding
  const { getShopBranding } = require('./email');
  const { companyName, primaryColor } = getShopBranding(slug);
  const customerName = row['Customer Name'] || row['Name'] || row['name'] || 'Customer';

  res.send(cancelPage({
    companyName,
    primaryColor,
    orderId,
    customerName,
    slug,
    token,
    showForm: true,
  }));
});

// ---------------------------------------------------------------------------
// POST /api/shops/:slug/orders/:orderId/cancel
// Public action — actually cancels the order (removes from CSV).
// ---------------------------------------------------------------------------
router.post('/:slug/orders/:orderId/cancel', (req, res) => {
  const { slug, orderId } = req.params;
  const token = req.body?.token || req.query?.token;

  if (!verifyCancelToken(orderId, slug, token)) {
    return res.status(403).send(cancelPage({ error: 'Invalid or expired cancellation link.' }));
  }

  if (!shopExists(slug)) {
    return res.status(404).send(cancelPage({ error: 'Shop not found.' }));
  }

  const csvPath = findCsvPath(slug);
  const row = getOrderById(csvPath, orderId);

  if (!row) {
    return res.send(cancelPage({ error: 'Order not found. It may have already been cancelled.' }));
  }

  const status = (row['Status'] || row['status'] || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return res.send(cancelPage({ error: 'This order has already been cancelled.' }));
  }

  if (!isWithinCancelWindow(row)) {
    return res.send(cancelPage({ error: 'The 2-hour cancellation window has passed. Please contact us directly for assistance.' }));
  }

  // Remove the order from CSV
  const removed = removeOrderFromCsv(csvPath, orderId);
  if (!removed) {
    return res.send(cancelPage({ error: 'Failed to cancel order. Please try again.' }));
  }

  console.log(`[cancel] Order ${orderId} cancelled for shop ${slug}`);

  // Send cancellation email
  const { sendCancellationEmail } = require('./email');
  sendCancellationEmail(row, slug).catch(err => {
    console.error(`[cancel] Email failed for ${slug}/${orderId}: ${err.message}`);
  });

  const { getShopBranding } = require('./email');
  const { companyName, primaryColor } = getShopBranding(slug);

  res.send(cancelPage({
    companyName,
    primaryColor,
    orderId,
    success: true,
  }));
});

// ---------------------------------------------------------------------------
// GET /api/shops/:slug/orders/email-image/:productId
// Public — serves product images for use in emails (no auth required).
// ---------------------------------------------------------------------------
router.get('/:slug/orders/email-image/:productId', (req, res) => {
  const { slug, productId } = req.params;
  const collectionsDir = path.join(SHOPS_DIR, slug, 'DATABASE', 'ShopCollections');

  if (!fs.existsSync(collectionsDir)) {
    return res.status(404).end();
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

        const files = fs.readdirSync(photosDir);
        const mainPhoto = files.find(f => /^main\.(jpg|jpeg|png|webp)$/i.test(f));
        const anyPhoto = files.find(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
        const photo = mainPhoto || anyPhoto;

        if (photo) {
          const photoPath = path.join(photosDir, photo);
          const ext = path.extname(photo).toLowerCase();
          const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return fs.createReadStream(photoPath).pipe(res);
        }
      }
    }
  } catch { /* directory unreadable */ }

  return res.status(404).end();
});

// ---------------------------------------------------------------------------
// Cancel page HTML renderer
// ---------------------------------------------------------------------------
function cancelPage({ error, companyName, primaryColor, orderId, customerName, slug, token, showForm, success }) {
  const { esc } = require('./email');
  const brand = /^#[0-9a-fA-F]{3,8}$/.test(primaryColor || '') ? primaryColor : '#00b4d8';
  const name = esc(companyName || 'Store');
  const safeOrderId = esc(orderId || '');
  const safeName = esc(customerName || '');
  const safeToken = esc(token || '');

  let body = '';
  if (error) {
    body = `
      <div style="text-align:center;padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">&#10060;</div>
        <h2 style="margin:0 0 8px;font-size:20px;color:#111;">Cannot Cancel Order</h2>
        <p style="color:#666;font-size:14px;line-height:1.5;max-width:400px;margin:0 auto;">${esc(error)}</p>
      </div>`;
  } else if (success) {
    body = `
      <div style="text-align:center;padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">&#9989;</div>
        <h2 style="margin:0 0 8px;font-size:20px;color:#111;">Order Cancelled</h2>
        <p style="color:#666;font-size:14px;line-height:1.5;">Order <strong>${safeOrderId}</strong> has been successfully cancelled.</p>
        <p style="color:#999;font-size:12px;margin-top:12px;">You will receive a confirmation email shortly.</p>
      </div>`;
  } else if (showForm) {
    body = `
      <div style="text-align:center;padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">&#9888;&#65039;</div>
        <h2 style="margin:0 0 8px;font-size:20px;color:#111;">Cancel Order ${safeOrderId}?</h2>
        <p style="color:#666;font-size:14px;line-height:1.5;max-width:400px;margin:0 auto;">
          Hi ${safeName}, are you sure you want to cancel this order? This action cannot be undone.
        </p>
        <form method="POST" style="margin-top:24px;">
          <input type="hidden" name="token" value="${safeToken}" />
          <button type="submit" style="background:#dc2626;color:#fff;border:none;padding:12px 32px;font-size:14px;font-weight:600;border-radius:8px;cursor:pointer;letter-spacing:0.3px;">
            Yes, Cancel My Order
          </button>
        </form>
        <p style="color:#bbb;font-size:11px;margin-top:16px;">This cancellation window closes 2 hours after your order was placed.</p>
      </div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Order Cancellation — ${name}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:500px;margin:40px auto;padding:0 16px;">
    <div style="background:${brand};padding:20px;text-align:center;border-radius:12px 12px 0 0;">
      <h1 style="color:#fff;margin:0;font-size:18px;font-weight:700;">${name}</h1>
    </div>
    <div style="background:#fff;padding:0;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      ${body}
    </div>
    <p style="text-align:center;color:#bbb;font-size:11px;margin-top:16px;">${name}</p>
  </div>
</body></html>`;
}

module.exports = router;
module.exports.generateCancelToken = generateCancelToken;
