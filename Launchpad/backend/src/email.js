const fs = require('fs');
const path = require('path');

const SHOPS_DIR = path.join(__dirname, '..', 'shops');

// ---------------------------------------------------------------------------
// Mailgun transport — uses built-in fetch + FormData, zero npm deps
// ---------------------------------------------------------------------------

async function sendMail({ to, from, subject, html, inline }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) {
    console.warn('[email] MAILGUN_API_KEY or MAILGUN_DOMAIN not set — skipping send');
    return;
  }

  const form = new FormData();
  form.append('from', from || `Orders <noreply@${domain}>`);
  form.append('to', to);
  form.append('subject', subject);
  form.append('html', html);

  // Inline (cid:) attachments. Mail clients block remote images by default,
  // so a hot-linked product shot is reliably invisible however correct its URL
  // is; an embedded one always renders. Mailgun keys the cid off the filename.
  for (const att of inline || []) {
    try {
      form.append(
        'inline',
        new Blob([att.buffer], { type: att.contentType || 'image/jpeg' }),
        att.filename,
      );
    } catch (e) {
      console.warn(`[email] could not inline ${att.filename}: ${e.message}`);
    }
  }

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
      },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[email] Mailgun ${res.status}: ${text}`);
    } else {
      console.log(`[email] Sent "${subject}" → ${to}`);
    }
  } catch (err) {
    console.error(`[email] Send failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Per-shop branding helpers
// ---------------------------------------------------------------------------

function readShopFile(slug, filename) {
  const filePath = path.join(SHOPS_DIR, slug, 'DATABASE', 'Design', 'Details', filename);
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

/**
 * Read one named colour out of a Colors.txt, ignoring comments.
 *
 * Keyed lookup rather than "first hex in the file", which picked up hexes
 * mentioned in comments. Falls back to the first hex on a non-comment line so
 * a file with no explicit key still yields something, and rejects a colour too
 * pale to read against the white e-mail body.
 */
function pickColor(raw, key) {
  const usable = String(raw || '').split('\n').filter(l => !l.trim().startsWith('#'));
  const from = (line) => {
    const m = line && line.match(/#[0-9a-fA-F]{3,8}/);
    return m ? m[0] : '';
  };
  const keyed = usable.find(l => new RegExp('^\\s*' + key + '\\s*:', 'i').test(l));
  const hex = from(keyed) || from(usable.find(l => /#[0-9a-fA-F]{3,8}/.test(l)));
  if (!hex) return '';
  // Too pale to read as text or a rule on white.
  const n = hex.slice(1);
  const full = n.length === 3 ? n.split('').map(c => c + c).join('') : n.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.85 ? '' : hex;
}

function getShopBranding(slug) {
  const companyName = readShopFile(slug, 'CompanyName.txt') || slug;
  const colorsRaw = readShopFile(slug, 'Colors.txt');
  const primaryColor = pickColor(colorsRaw, 'primary') || '#00b4d8';
  return { companyName, primaryColor };
}

function getAdminEmail(slug) {
  const shopAdmin = readShopFile(slug, 'AdminEmail.txt');
  return shopAdmin || process.env.FALLBACK_ADMIN_EMAIL || '';
}

function getFromAddress(companyName) {
  const domain = process.env.MAILGUN_DOMAIN || '';
  return `${companyName} <noreply@${domain}>`;
}

function getBaseUrl() {
  return process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3001}`;
}

function getProductImageUrl(slug, productId) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/email-image/${encodeURIComponent(productId)}`;
}

function getLogoUrl(slug) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/logo`;
}

/**
 * Does this shop hide prices? Mirrors Shuttle's Presets/Display.txt.
 *
 * A price-hidden shop is an approvals portal: the requestor never sees a figure
 * on the site, so putting unit prices and a total in the confirmation e-mail
 * contradicts the storefront and exposes rate card pricing over e-mail.
 */
function shopHidesPrices(slug) {
  // Not readShopFile: that helper is hardcoded to DATABASE/Design/Details, and
  // the display preset lives in DATABASE/Presets.
  let content = '';
  try {
    content = fs.readFileSync(
      path.join(SHOPS_DIR, slug, 'DATABASE', 'Presets', 'Display.txt'), 'utf8');
  } catch { return false; }
  if (!content) return false;
  for (const line of String(content).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, v] = t.split(':').map(s => (s || '').trim());
    if (k === 'show_prices') return v === 'false';
  }
  return false;
}

function shopHasLogo(slug) {
  // Same directory bug as the route that serves it — logos are in Design/Logos.
  const detailsDir = [
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Design', 'Logos'),
    path.join(SHOPS_DIR, slug, 'DATABASE', 'Design', 'Details'),
  ].find(d => fs.existsSync(d)) || '';
  try {
    const files = fs.readdirSync(detailsDir);
    return files.some(f => /^logo\.(png|jpe?g|webp|svg)$/i.test(f));
  } catch { return false; }
}

function getCancelUrl(slug, orderId, token) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/${encodeURIComponent(orderId)}/cancel?token=${token}`;
}

function getPoUrl(slug, filename) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/po?filename=${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// Custom checkout fields
// ---------------------------------------------------------------------------

/**
 * Present an estimated budget as money.
 *
 * The field is free text because requestors give ranges as often as figures,
 * so "15000", "$15,000" and "15-20k" all arrive. A bare number is formatted;
 * anything the requestor shaped themselves is left alone.
 */
function formatBudget(val) {
  const raw = String(val || '').trim();
  if (!raw) return '';
  if (!/^[0-9][0-9,\s.]*$/.test(raw)) return raw;
  const n = Number(raw.replace(/[,\s]/g, ''));
  if (!isFinite(n) || n <= 0) return raw;
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Read a value the schema-driven checkout stored in the `Custom Fields` column.
 *
 * Any checkout field whose id is outside Shuttle's standard set is collected
 * into that one column as JSON, so brand, in-hands date, estimated budget, PO
 * number and artwork link are all in there rather than in columns of their own.
 * Both e-mails were looking for top-level columns and finding nothing.
 *
 * Falls back to a real column of the same name, so a shop that does have one
 * keeps working.
 */
function customField(row, ...keys) {
  const raw = col(row, 'Custom Fields', 'custom_fields', 'customFields');
  let parsed = {};
  if (raw) {
    try {
      const val = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (val && typeof val === 'object' && !Array.isArray(val)) parsed = val;
    } catch { /* not JSON — fall through to the column lookup */ }
  }
  for (const k of keys) {
    if (parsed[k] != null && String(parsed[k]).trim() !== '') return String(parsed[k]).trim();
  }
  const direct = col(row, ...keys);
  return direct || '';
}

// ---------------------------------------------------------------------------
// Inline image attachments
// ---------------------------------------------------------------------------

const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
};

/** Must match orders-webhook's slugify, since productIds are built with it. */
function slugifyName(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Locate a product's photo on disk, or null.
 *
 * Photos live at ShopCollections/<Collection>/<Item>/Photos/, and a productId
 * is `slugify(collection)-slugify(item)`, so the folder cannot be derived from
 * the id directly — the tree has to be walked. Same resolution as the
 * email-image route it replaces.
 */
function findProductPhoto(slug, productId) {
  if (!slug || !productId) return null;
  const collectionsDir = path.join(SHOPS_DIR, slug, 'DATABASE', 'ShopCollections');
  let collections;
  try {
    collections = fs.readdirSync(collectionsDir, { withFileTypes: true });
  } catch { return null; }

  for (const col of collections) {
    if (!col.isDirectory()) continue;
    const colPath = path.join(collectionsDir, col.name);
    let items;
    try { items = fs.readdirSync(colPath, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (`${slugifyName(col.name)}-${slugifyName(item.name)}` !== productId) continue;
      const photosDir = path.join(colPath, item.name, 'Photos');
      let files;
      try { files = fs.readdirSync(photosDir); } catch { return null; }
      const photos = files.filter(f => PHOTO_EXT.includes(path.extname(f).toLowerCase()));
      const main = photos.find(f => /^main\./i.test(f));
      const photo = main || photos.sort()[0];
      return photo ? path.join(photosDir, photo) : null;
    }
  }
  return null;
}

/** The LR Paris letterhead mark, as an inline attachment, or null. */
function lrParisLetterhead() {
  const file = path.join(__dirname, '..', 'assets', 'lrparis-logo.png');
  try {
    return { filename: 'lrparis-logo.png', buffer: fs.readFileSync(file), contentType: 'image/png' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function col(row, ...names) {
  for (const n of names) {
    if (row[n] != null && String(row[n]).trim()) return String(row[n]).trim();
  }
  return '';
}

function getCustomerEmail(row) {
  return col(row, 'Email', 'email', 'E-mail', 'E-Mail', 'Customer Email');
}

function getCustomerName(row) {
  return col(row, 'Customer Name', 'Name', 'Full Name', 'name', 'Buyer') || 'Customer';
}

function getOrderId(row) {
  return col(row, 'Order ID', 'order_id', 'orderId', 'Order #', 'Order Number', 'ID', 'id');
}

function getOrderDate(row) {
  return col(row, 'Date', 'date', 'Order Date', 'Timestamp');
}

function getTotal(row) {
  return col(row, 'Total', 'total', 'Order Total', 'Amount Due', 'Price');
}

// Format a raw value as proper money: "$284.00"
function formatMoney(val) {
  if (!val) return '';
  const str = String(val).trim();
  // Strip existing $ and commas, parse as number
  const num = parseFloat(str.replace(/[$,]/g, ''));
  if (isNaN(num)) return str; // not a number, return as-is
  return '$' + num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Format a raw date string to human-readable: "March 4, 2026"
function formatDate(val) {
  if (!val) return '';
  const str = String(val).trim();
  const d = new Date(str);
  if (isNaN(d.getTime())) return str; // unparseable, return as-is
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Receipt builder — itemized receipt with product images
// ---------------------------------------------------------------------------

function buildReceipt(row, primaryColor, slug, inline) {
  const hidePrices = shopHidesPrices(slug);
  // Robust Items extraction — handles both string JSON and already-parsed arrays
  let items = [];
  const itemKeys = ['Items', 'items', 'Products', 'products'];
  for (const key of itemKeys) {
    const val = row[key];
    if (val == null) continue;
    if (Array.isArray(val)) { items = val; break; }
    if (typeof val === 'object' && !Array.isArray(val)) { items = [val]; break; }
    const str = String(val).trim();
    if (str) {
      try {
        const parsed = JSON.parse(str);
        items = Array.isArray(parsed) ? parsed : [parsed];
        break;
      } catch { /* not JSON, continue */ }
    }
  }

  const total = getTotal(row);

  if (items.length > 0) {
    let subtotal = 0;
    const rows = items.map(it => {
      const name = esc(it.productName || it.name || 'Item');
      const sku = it.sku ? `<span style="color:#999;font-size:10px;display:block;margin-top:2px;">SKU: ${esc(it.sku)}</span>` : '';
      const qty = it.quantity || 1;
      const unitPrice = it.boxCost != null ? Number(it.boxCost) : 0;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;
      const units = it.unitsPerBox ? `<span style="color:#999;font-size:10px;display:block;">${qty * it.unitsPerBox} units</span>` : '';

      // Product image, embedded rather than hot-linked — see sendMail.
      let imgSrc = '';
      const photo = findProductPhoto(slug, it.productId);
      if (photo && Array.isArray(inline)) {
        const cid = `p${inline.length}${path.extname(photo).toLowerCase()}`;
        try {
          inline.push({
            filename: cid,
            buffer: fs.readFileSync(photo),
            contentType: CONTENT_TYPES[path.extname(photo).toLowerCase()] || 'image/jpeg',
          });
          imgSrc = `cid:${cid}`;
        } catch { /* unreadable file — fall back to the grey placeholder */ }
      } else if (slug && it.productId) {
        imgSrc = getProductImageUrl(slug, it.productId);
      }
      const imgCell = imgSrc
        ? `<td style="padding:12px 8px 12px 12px;border-bottom:1px solid #f0f0f0;width:52px;vertical-align:top;">
             <img src="${imgSrc}" alt="${name}" width="44" height="44" style="border-radius:6px;object-fit:cover;display:block;border:1px solid #eee;" />
           </td>`
        : `<td style="padding:12px 8px 12px 12px;border-bottom:1px solid #f0f0f0;width:52px;vertical-align:top;">
             <div style="width:44px;height:44px;border-radius:6px;background:#f5f5f5;border:1px solid #eee;"></div>
           </td>`;

      return `<tr>
        ${imgCell}
        <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;">
          <span style="font-size:13px;font-weight:600;color:#111;display:block;">${name}</span>
          ${sku}
        </td>
        <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:top;">
          <span style="font-size:13px;color:#333;">${qty}</span>
          ${units}
        </td>
        ${hidePrices ? '' : `
        <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;color:#555;">${unitPrice ? '$' + unitPrice.toFixed(2) : ''}</span>
        </td>
        <td style="padding:12px 12px 12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;font-weight:600;color:#111;">${lineTotal ? '$' + lineTotal.toFixed(2) : ''}</span>
        </td>`}
      </tr>`;
    }).join('');

    const displayTotal = formatMoney(total) || (subtotal ? '$' + subtotal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '');

    return `
      <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #eee;border-radius:8px;overflow:hidden;">
        <tr style="background:#fafafa;">
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;" colspan="2">Item</th>
          <th style="padding:10px 8px;text-align:center;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
          ${hidePrices ? '' : `
          <th style="padding:10px 8px;text-align:right;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Unit Price</th>
          <th style="padding:10px 12px;text-align:right;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Line Total</th>`}
        </tr>
        ${rows}
        ${(!hidePrices && displayTotal) ? `
        <tr style="background:#fafafa;">
          <td colspan="4" style="padding:14px 12px;text-align:right;font-weight:700;font-size:14px;color:#333;">Total Cost</td>
          <td style="padding:14px 12px;text-align:right;font-weight:700;font-size:18px;color:${primaryColor};">${esc(displayTotal)}</td>
        </tr>
        ` : ''}
        ${hidePrices ? `
        <tr style="background:#fafafa;">
          <td colspan="2" style="padding:14px 12px;font-weight:700;font-size:13px;color:#333;">${items.length} item${items.length === 1 ? '' : 's'}</td>
          <td style="padding:14px 8px;text-align:center;font-weight:700;font-size:13px;color:${primaryColor};">${items.reduce((s, i) => s + (i.quantity || 1), 0)}</td>
        </tr>
        ` : ''}
      </table>
    `;
  }

  // Fallback for flat item columns
  const itemName = col(row, 'Item', 'Product', 'Item Name', 'Product Name');
  const qty = col(row, 'Qty', 'Quantity', 'Amount');
  if (itemName || total) {
    let html = '<div style="margin:16px 0;padding:16px;background:#fafafa;border-radius:8px;border:1px solid #eee;">';
    if (itemName) html += `<p style="margin:0 0 4px;font-size:13px;"><strong>Item:</strong> ${esc(itemName)}${qty ? ' &times; ' + esc(qty) : ''}</p>`;
    if (total && !hidePrices) html += `<p style="margin:4px 0 0;font-size:16px;font-weight:700;color:${primaryColor};">Total Cost: ${esc(formatMoney(total))}</p>`;
    html += '</div>';
    return html;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Detailed info block — shipping, contact, notes, freight
// ---------------------------------------------------------------------------

function buildInfoBlock(row) {
  const fields = [];
  const company = col(row, 'Company', 'company', 'Company Name');
  const address = col(row, 'Shipping Address', 'Address', 'shipping_address');
  const billing = col(row, 'Billing Address', 'billing_address');
  const phone = col(row, 'Phone', 'phone', 'Telephone', 'Mobile');
  const freight = col(row, 'Freight Option', 'freight_option', 'Shipping Method');
  const freightCo = col(row, 'Freight Company', 'freight_company');
  const notes = col(row, 'Order Notes', 'Notes', 'notes', 'Comments', 'Special Instructions');
  const hotel = col(row, 'Hotel', 'hotel', 'Hotel Name', 'Hotel Selection', 'Accommodation');
  const inHand = customField(row, 'inHandDate', 'In Hand Date', 'in_hand_date');
  const artLink = customField(row, 'artLink', 'Art Link', 'art_link');
  const po = customField(row, 'poNumber', 'PO Number', 'po_number');
  const brand = customField(row, 'brand', 'Brand');
  const budget = customField(row, 'estimatedBudget', 'Estimated Budget', 'estimated_budget');

  // A shop with the freight selector switched off never asked the requestor to
  // choose a carrier, but the order row still carried a default. Showing it as
  // "Shipping Method" told ELC they had picked something they never saw.
  const freightWasChosen = freight && !/^(lr paris|none|n\/a)$/i.test(String(freight).trim());

  if (company) fields.push(['Company', company]);
  if (brand) fields.push(['Brand', brand]);
  if (address) fields.push(['Ship To', address]);
  if (billing && billing !== address) fields.push(['Bill To', billing]);
  if (inHand) fields.push(['In Hand Date', formatDate(inHand) || inHand]);
  if (budget) fields.push(['Estimated Budget', formatBudget(budget)]);
  if (po) fields.push(['PO Number', po]);
  if (freightWasChosen) fields.push(['Freight', freight]);
  if (freightWasChosen && freightCo) fields.push(['Carrier', freightCo]);
  if (hotel) fields.push(['Hotel', hotel]);
  if (phone) fields.push(['Phone', phone]);
  if (artLink) fields.push(['Custom Artwork', artLink]);
  if (notes) fields.push(['Notes', notes]);

  if (!fields.length) return '';

  const rows = fields.map(([label, val]) =>
    `<tr>
      <td style="padding:6px 12px 6px 0;color:#999;font-size:11px;width:100px;vertical-align:top;text-transform:uppercase;letter-spacing:0.3px;">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:#333;">${esc(val)}</td>
    </tr>`
  ).join('');

  return `
    <div style="margin:20px 0;padding:16px;background:#fafafa;border-radius:8px;border:1px solid #eee;">
      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Details</p>
      <table style="width:100%;">${rows}</table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Email shell — company-branded wrapper
// ---------------------------------------------------------------------------

function emailShell({ companyName, primaryColor, body, slug, inline }) {
  // LR Paris leads the letterhead: LRP is the supplier of record and the
  // confirmation PDF already opens with the same mark. The client's own name
  // stays as the heading underneath, so it is clear which programme this is.
  let logoHtml = '';
  const mark = Array.isArray(inline) ? lrParisLetterhead() : null;
  if (mark) {
    inline.push(mark);
    logoHtml = `<img src="cid:${mark.filename}" alt="LR Paris" width="150" style="width:150px;max-width:150px;margin-bottom:14px;display:inline-block;" /><br>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;padding:26px 24px 20px;text-align:center;border-radius:12px 12px 0 0;border-bottom:3px solid ${primaryColor};">
      ${logoHtml}
      <h1 style="color:#111;margin:0;font-size:17px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;">${esc(companyName)}</h1>
    </div>
    <div style="background:#fff;padding:28px 32px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      ${body}
    </div>
    <div style="text-align:center;padding:20px 0;">
      <p style="color:#bbb;font-size:11px;margin:0;">&copy; ${new Date().getFullYear()} ${esc(companyName)}. All rights reserved.</p>
      <p style="color:#ccc;font-size:10px;margin:8px 0 0;">Powered by <span style="font-weight:600;color:#aaa;">LR Paris</span></p>
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Public: sendOrderConfirmation — detailed receipt email with product images
// ---------------------------------------------------------------------------

async function sendOrderConfirmation(orderData, shopSlug) {
  const inline = [];
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const fromAddress = getFromAddress(companyName);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);
  const orderDate = getOrderDate(orderData);
  const total = getTotal(orderData);
  const email = getCustomerEmail(orderData);
  const hidePrices = shopHidesPrices(shopSlug);
  const brand = col(orderData, 'Brand', 'brand');
  const budget = col(orderData, 'Estimated Budget', 'estimated_budget');

  // Generate cancel token
  const { generateCancelToken } = require('./orders-webhook');
  const cancelToken = orderId ? generateCancelToken(orderId, shopSlug) : '';
  const cancelUrl = (orderId && cancelToken) ? getCancelUrl(shopSlug, orderId, cancelToken) : '';

  // Order header with ID, date, and status
  const prettyDate = formatDate(orderDate);
  const prettyTotal = formatMoney(total);
  const orderHeader = `
    <div style="margin:20px 0;padding:16px 20px;background:#fafafa;border-radius:8px;border:1px solid #eee;">
      <table style="width:100%;border-collapse:collapse;">
        ${orderId ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Order Number</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:15px;font-weight:700;color:${primaryColor};">${esc(orderId)}</span></td>
        </tr>` : ''}
        ${prettyDate ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Order Date</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:13px;color:#333;">${esc(prettyDate)}</span></td>
        </tr>` : ''}
        <tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Status</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:12px;font-weight:600;color:#d97706;background:#fef3c7;padding:2px 10px;border-radius:12px;">Pending</span></td>
        </tr>
        ${email ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Email</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:13px;color:#333;">${esc(email)}</span></td>
        </tr>` : ''}
        ${brand ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Brand</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:13px;color:#333;">${esc(brand)}</span></td>
        </tr>` : ''}
        ${budget ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Estimated Budget</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:13px;color:#333;">${esc(budget)}</span></td>
        </tr>` : ''}
        ${(prettyTotal && !hidePrices) ? `<tr>
          <td style="padding:8px 0 0;border-top:1px solid #eee;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Total Cost</span></td>
          <td style="padding:8px 0 0;text-align:right;border-top:1px solid #eee;"><span style="font-size:18px;font-weight:700;color:${primaryColor};">${esc(prettyTotal)}</span></td>
        </tr>` : ''}
      </table>
    </div>
  `;

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">${hidePrices ? 'Request Received' : 'Order Confirmation'}${orderId ? ' — ' + esc(orderId) : ''}</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">${hidePrices
      ? `Hi ${esc(customerName)}, thank you for your request${companyName ? ' to <strong>' + esc(companyName) + '</strong>' : ''}. We have it and are reviewing it now. This is not an order confirmation &mdash; nothing is produced or shipped until we confirm specifications, pricing and lead time in writing.`
      : `Hi ${esc(customerName)}, thank you for your order${companyName ? ' with <strong>' + esc(companyName) + '</strong>' : ''}. We've received it and are processing it now.`}</p>
    ${orderHeader}
    <p style="margin:24px 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Items</p>
    ${buildReceipt(orderData, primaryColor, shopSlug, inline)}
    ${buildInfoBlock(orderData)}
    ${cancelUrl ? `
    <div style="margin:24px 0;padding:16px 20px;background:#fefce8;border-radius:8px;border:1px solid #fde68a;">
      <table style="width:100%;"><tr>
        <td style="vertical-align:middle;">
          <p style="margin:0;font-size:13px;color:#92400e;font-weight:600;">Need to cancel?</p>
          <p style="margin:4px 0 0;font-size:12px;color:#a16207;">You have 2 hours from order placement to cancel.</p>
        </td>
        <td style="text-align:right;vertical-align:middle;width:140px;">
          <a href="${cancelUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:12px;font-weight:600;">Cancel Order</a>
        </td>
      </tr></table>
    </div>
    ` : ''}
    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;">${hidePrices
      ? 'A member of the team will follow up with pricing and lead time.'
      : "You'll receive a shipping notification with tracking details when your order is on its way."}</p>
  `;

  const html = emailShell({ companyName, primaryColor, body, slug: shopSlug, inline });
  const subject = `${hidePrices ? 'Request Received' : 'Order Confirmation'}${orderId ? ' — ' + orderId : ''} | ${companyName}`;

  if (customerEmail) {
    sendMail({ to: customerEmail, from: fromAddress, subject, html, inline }).catch(() => {});
  }

  // --- Admin email: detailed with ALL order data + PO link ---
  const adminEmail = getAdminEmail(shopSlug);
  if (adminEmail) {
    sendAdminOrderEmail(orderData, shopSlug, companyName, primaryColor, fromAddress, adminEmail);
  }
}

// ---------------------------------------------------------------------------
// Admin order email — shows everything including PO attachment link
// ---------------------------------------------------------------------------

function sendAdminOrderEmail(orderData, shopSlug, companyName, primaryColor, fromAddress, adminEmail) {
  const inline = [];
  const hidePrices = shopHidesPrices(shopSlug);
  const customerName = getCustomerName(orderData);
  const customerEmail = getCustomerEmail(orderData);
  const orderId = getOrderId(orderData);
  const orderDate = getOrderDate(orderData);
  const total = getTotal(orderData);
  const phone = col(orderData, 'Phone', 'phone', 'Telephone', 'Mobile');
  const company = col(orderData, 'Company', 'company', 'Company Name');
  const address = col(orderData, 'Shipping Address', 'Address', 'shipping_address');
  const freight = col(orderData, 'Freight Option', 'freight_option', 'Shipping Method');
  const freightCo = col(orderData, 'Freight Company', 'freight_company');
  const notes = col(orderData, 'Order Notes', 'Notes', 'notes', 'Comments', 'Special Instructions');
  const hotel = col(orderData, 'Hotel', 'hotel', 'Hotel Name', 'Hotel Selection');
  const poFile = col(orderData, 'PO File', 'Purchase Order', 'PO', 'po_file');

  // Customer contact card
  // Brand and budget belong at the top of the internal e-mail: they are the two
  // things the team needs before anything else to route and quote a request.
  const adminBrand = customField(orderData, 'brand', 'Brand');
  const adminBudget = customField(orderData, 'estimatedBudget', 'Estimated Budget', 'estimated_budget');
  const adminInHand = customField(orderData, 'inHandDate', 'In Hand Date', 'in_hand_date');
  const adminPo = customField(orderData, 'poNumber', 'PO Number', 'po_number');
  const adminArt = customField(orderData, 'artLink', 'Art Link', 'art_link');

  const contactRows = [];
  contactRows.push(['Customer', customerName]);
  if (customerEmail) contactRows.push(['Email', `<a href="mailto:${esc(customerEmail)}" style="color:${primaryColor};text-decoration:none;">${esc(customerEmail)}</a>`]);
  if (phone) contactRows.push(['Phone', `<a href="tel:${esc(phone)}" style="color:${primaryColor};text-decoration:none;">${esc(phone)}</a>`]);
  if (company) contactRows.push(['Company', company]);
  if (adminBrand) contactRows.push(['Brand', adminBrand]);
  if (adminBudget) contactRows.push(['Budget', formatBudget(adminBudget)]);
  if (adminInHand) contactRows.push(['In Hand', formatDate(adminInHand) || adminInHand]);
  if (adminPo) contactRows.push(['PO Number', adminPo]);
  if (adminArt) contactRows.push(['Custom Artwork', `<a href="${esc(adminArt)}" style="color:${primaryColor};">${esc(adminArt)}</a>`]);
  if (orderDate) contactRows.push(['Date', formatDate(orderDate)]);

  const contactCard = `
    <div style="margin:16px 0;padding:16px;background:${primaryColor}08;border-radius:8px;border-left:4px solid ${primaryColor};">
      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Customer Information</p>
      <table style="width:100%;">
        ${contactRows.map(([label, val]) => `
          <tr>
            <td style="padding:4px 0;color:#999;font-size:11px;width:80px;text-transform:uppercase;vertical-align:top;">${label}</td>
            <td style="padding:4px 0;font-size:13px;color:#111;font-weight:${label === 'Customer' ? '700' : '400'};">${typeof val === 'string' && val.includes('<a') ? val : esc(val)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;

  // Shipping details
  const shipFields = [];
  // Same gate as buildInfoBlock. A shop with the freight step switched off
  // never asked for a carrier, so reporting the default back as the customer's
  // "Shipping Method" is inventing a choice they never made.
  const adminFreightChosen = freight && !/^(lr paris|none|n\/a)$/i.test(String(freight).trim());
  if (address) shipFields.push(['Ship To', address]);
  if (adminFreightChosen) shipFields.push(['Freight', freight]);
  if (adminFreightChosen && freightCo) shipFields.push(['Carrier', freightCo]);
  if (hotel) shipFields.push(['Hotel', hotel]);

  const shippingCard = shipFields.length > 0 ? `
    <div style="margin:16px 0;padding:16px;background:#fafafa;border-radius:8px;border:1px solid #eee;">
      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Shipping Information</p>
      <table style="width:100%;">
        ${shipFields.map(([label, val]) => `
          <tr>
            <td style="padding:4px 0;color:#999;font-size:11px;width:100px;text-transform:uppercase;vertical-align:top;">${label}</td>
            <td style="padding:4px 0;font-size:13px;color:#333;">${esc(val)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  ` : '';

  // Notes
  const notesCard = notes ? `
    <div style="margin:16px 0;padding:16px;background:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
      <p style="margin:0 0 4px;font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Notes</p>
      <p style="margin:0;font-size:13px;color:#78350f;line-height:1.5;">${esc(notes)}</p>
    </div>
  ` : '';

  // PO file link
  const poCard = poFile ? `
    <div style="margin:16px 0;padding:16px;background:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
      <table style="width:100%;"><tr>
        <td style="vertical-align:middle;">
          <p style="margin:0;font-size:11px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Purchase Order Attached</p>
          <p style="margin:4px 0 0;font-size:13px;color:#1e3a8a;font-weight:500;">${esc(poFile)}</p>
        </td>
        <td style="text-align:right;vertical-align:middle;width:120px;">
          <a href="${getPoUrl(shopSlug, poFile)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:600;">View PO</a>
        </td>
      </tr></table>
    </div>
  ` : '';

  // All raw fields table (everything from the CSV row)
  const allFieldRows = Object.entries(orderData)
    .filter(([k, v]) => v && String(v).trim() && !/^(items|products)$/i.test(k))
    .map(([k, v]) => {
      const val = String(v).trim();
      if (val.length > 200) return ''; // skip very long fields (JSON etc)
      return `<tr>
        <td style="padding:3px 8px 3px 0;color:#999;font-size:10px;width:120px;vertical-align:top;text-transform:uppercase;letter-spacing:0.3px;border-bottom:1px solid #f5f5f5;">${esc(k)}</td>
        <td style="padding:3px 0;font-size:12px;color:#333;border-bottom:1px solid #f5f5f5;">${esc(val)}</td>
      </tr>`;
    })
    .filter(Boolean)
    .join('');

  // The "All Order Fields" dump repeated everything already laid out above it,
  // so it is gone. allFieldRows is retained only so the block above keeps
  // compiling if someone reintroduces a debug view.
  void allFieldRows;
  const allFieldsCard = '';

  const adminBody = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">${hidePrices ? 'New Request' : 'New Order'}${orderId ? ' — ' + esc(orderId) : ''}${(total && !hidePrices) ? ' <span style="color:' + primaryColor + ';">' + esc(formatMoney(total)) + '</span>' : ''}</h2>
    ${contactCard}
    <p style="margin:24px 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Items</p>
    ${buildReceipt(orderData, primaryColor, shopSlug, inline)}
    ${shippingCard}
    ${notesCard}
    ${poCard}
    ${allFieldsCard}
  `;

  const adminHtml = emailShell({ companyName, primaryColor, body: adminBody, slug: shopSlug, inline });
  const adminSubject = `[${hidePrices ? 'New Request' : 'New Order'}] ${orderId || 'Order'} from ${customerName}${(total && !hidePrices) ? ' — ' + formatMoney(total) : ''} | ${companyName}`;
  sendMail({ to: adminEmail, from: fromAddress, subject: adminSubject, html: adminHtml, inline }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Public: sendShippedNotification
// ---------------------------------------------------------------------------

async function sendShippedNotification(orderData, trackingNumber, shopSlug) {
  const inline = [];
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const fromAddress = getFromAddress(companyName);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);

  if (!customerEmail) {
    console.warn(`[email] No customer email for order ${orderId} — skipping shipped notification`);
    return;
  }

  const trackingHtml = trackingNumber
    ? `<div style="margin:20px 0;padding:16px 20px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
         <p style="margin:0 0 4px;font-size:11px;color:#15803d;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Tracking Number</p>
         <p style="margin:0;font-size:18px;font-weight:700;color:#166534;letter-spacing:0.5px;">${esc(trackingNumber)}</p>
       </div>`
    : '';

  // Order summary header
  const orderHeader = orderId ? `
    <div style="margin:16px 0;padding:12px 16px;background:#fafafa;border-radius:8px;border:1px solid #eee;">
      <table style="width:100%;"><tr>
        <td><span style="font-size:10px;color:#999;text-transform:uppercase;">Order</span><br><span style="font-size:14px;font-weight:700;color:${primaryColor};">${esc(orderId)}</span></td>
        <td style="text-align:right;"><span style="font-size:12px;font-weight:600;color:#059669;background:#d1fae5;padding:2px 10px;border-radius:12px;">Shipped</span></td>
      </tr></table>
    </div>` : '';

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">Your order has shipped!</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">Hi ${esc(customerName)}, great news — your order is on its way.</p>
    ${orderHeader}
    ${trackingHtml}
    <p style="margin:24px 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">What You Ordered</p>
    ${buildReceipt(orderData, primaryColor, shopSlug, inline)}
    ${buildInfoBlock(orderData)}
  `;

  const html = emailShell({ companyName, primaryColor, body, slug: shopSlug, inline });
  const subject = `Your order has shipped${orderId ? ' — ' + orderId : ''} | ${companyName}`;
  sendMail({ to: customerEmail, from: fromAddress, subject, html, inline }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Public: sendCancellationEmail — confirms cancellation to customer + admin
// ---------------------------------------------------------------------------

async function sendCancellationEmail(orderData, shopSlug, opts = {}) {
  // One attachment list per message: a shared list accumulates, so the
  // second e-mail carried the first one's photo and two logos under the same
  // filename, which makes the cid ambiguous.
  const inlineCustomer = [];
  const inlineAdmin = [];
  const hidePricesCancel = shopHidesPrices(shopSlug);
  const { cancelledBy = 'customer', reason = '' } = opts;
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const fromAddress = getFromAddress(companyName);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);
  const total = getTotal(orderData);
  const prettyTotal = formatMoney(total);

  const reasonHtml = reason
    ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Reason</td><td style="padding:4px 0;font-size:13px;color:#333;">${esc(reason)}</td></tr>`
    : '';

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">Order Cancelled</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">Hi ${esc(customerName)}, your order${orderId ? ' <strong>' + esc(orderId) + '</strong>' : ''} has been cancelled.</p>
    <div style="margin:20px 0;padding:16px 20px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
      <table style="width:100%;">
        ${orderId ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;width:100px;text-transform:uppercase;">Order</td><td style="padding:4px 0;font-size:14px;font-weight:700;color:#991b1b;">${esc(orderId)}</td></tr>` : ''}
        ${(prettyTotal && !hidePricesCancel) ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Total Cost</td><td style="padding:4px 0;font-size:14px;color:#333;">${esc(prettyTotal)}</td></tr>` : ''}
        <tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Status</td><td style="padding:4px 0;font-size:12px;font-weight:600;color:#dc2626;">Cancelled</td></tr>
        ${reasonHtml}
      </table>
    </div>
    ${buildReceipt(orderData, primaryColor, shopSlug, inlineCustomer)}
  `;

  const html = emailShell({ companyName, primaryColor, body, slug: shopSlug, inline: inlineCustomer });
  const subject = `Order Cancelled${orderId ? ' — ' + orderId : ''} | ${companyName}`;

  if (customerEmail) {
    sendMail({ to: customerEmail, from: fromAddress, subject, html, inline: inlineCustomer }).catch(() => {});
  }

  // Notify admin
  const adminEmail = getAdminEmail(shopSlug);
  if (adminEmail) {
    const actionText = cancelledBy === 'admin'
      ? `Cancelled by Admin${reason ? ': ' + reason : ''}`
      : `Customer self-cancelled within 2-hour window${reason ? ': ' + reason : ''}`;

    const adminBody = `
      <h2 style="margin-top:0;font-size:20px;color:#dc2626;">Order Cancelled — ${esc(orderId || 'Unknown')}</h2>
      <div style="margin:16px 0;padding:16px;background:#fef2f2;border-radius:8px;border-left:4px solid #dc2626;">
        <table style="width:100%;">
          <tr><td style="padding:4px 0;color:#999;font-size:11px;width:80px;text-transform:uppercase;">Customer</td><td style="padding:4px 0;font-size:14px;font-weight:700;color:#111;">${esc(customerName)}</td></tr>
          ${customerEmail ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Email</td><td style="padding:4px 0;font-size:13px;">${esc(customerEmail)}</td></tr>` : ''}
          ${(prettyTotal && !hidePricesCancel) ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Total Cost</td><td style="padding:4px 0;font-size:14px;font-weight:600;">${esc(prettyTotal)}</td></tr>` : ''}
          <tr><td style="padding:4px 0;color:#999;font-size:11px;">Action</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:#dc2626;">${esc(actionText)}</td></tr>
        </table>
      </div>
      ${buildReceipt(orderData, primaryColor, shopSlug, inlineAdmin)}
    `;
    const adminHtml = emailShell({ companyName, primaryColor, body: adminBody, slug: shopSlug, inline: inlineAdmin });
    const adminSubject = `[Cancelled] ${orderId || 'Order'} from ${customerName} | ${companyName}`;
    sendMail({ to: adminEmail, from: fromAddress, subject: adminSubject, html: adminHtml, inline: inlineAdmin }).catch(() => {});
  }
}

module.exports = {
  sendOrderConfirmation,
  sendShippedNotification,
  sendCancellationEmail,
  getAdminEmail,
  getShopBranding,
  esc,
};
