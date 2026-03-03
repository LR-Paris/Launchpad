const fs = require('fs');
const path = require('path');

const SHOPS_DIR = path.join(__dirname, '..', 'shops');

// ---------------------------------------------------------------------------
// Mailgun transport — uses built-in fetch + FormData, zero npm deps
// ---------------------------------------------------------------------------

async function sendMail({ to, subject, html }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) {
    console.warn('[email] MAILGUN_API_KEY or MAILGUN_DOMAIN not set — skipping send');
    return;
  }

  const form = new FormData();
  form.append('from', `Orders <noreply@${domain}>`);
  form.append('to', to);
  form.append('subject', subject);
  form.append('html', html);

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

function getShopBranding(slug) {
  const companyName = readShopFile(slug, 'CompanyName.txt') || slug;
  const colorsRaw = readShopFile(slug, 'Colors.txt');
  // Try to extract a primary/accent hex color from Colors.txt content
  const hexMatch = colorsRaw.match(/#[0-9a-fA-F]{3,8}/);
  const primaryColor = hexMatch ? hexMatch[0] : '#00b4d8';
  return { companyName, primaryColor };
}

function getAdminEmail(slug) {
  const shopAdmin = readShopFile(slug, 'AdminEmail.txt');
  return shopAdmin || process.env.FALLBACK_ADMIN_EMAIL || '';
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

// Flexible column name lookup — CSV headers vary per shop
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
  return col(row, 'Order ID', 'order_id', 'Order #', 'Order Number', 'ID', 'id');
}

function buildItemsTable(row) {
  const itemsRaw = col(row, 'Items', 'items', 'Products', 'products');
  let items = [];
  if (itemsRaw) {
    try { items = JSON.parse(itemsRaw); } catch { /* not JSON */ }
    if (!Array.isArray(items)) items = [];
  }

  if (items.length > 0) {
    const rows = items.map(it => {
      const name = esc(it.productName || it.name || 'Item');
      const qty = it.quantity || 1;
      const cost = it.boxCost != null ? '$' + (Number(it.boxCost) * qty).toFixed(2) : '';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${cost}</td>
      </tr>`;
    }).join('');

    return `<table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr style="background:#f8f8f8;">
        <th style="padding:8px 12px;text-align:left;font-size:13px;">Item</th>
        <th style="padding:8px 12px;text-align:center;font-size:13px;">Qty</th>
        <th style="padding:8px 12px;text-align:right;font-size:13px;">Total</th>
      </tr>
      ${rows}
    </table>`;
  }

  // Fallback for flat item columns
  const itemName = col(row, 'Item', 'Product', 'Item Name', 'Product Name');
  const qty = col(row, 'Qty', 'Quantity', 'Amount');
  if (itemName) {
    return `<p style="margin:12px 0;"><strong>Item:</strong> ${esc(itemName)}${qty ? ' &times; ' + esc(qty) : ''}</p>`;
  }
  return '';
}

function buildDetailRows(row) {
  const fields = [];
  const total = col(row, 'Total', 'total', 'Order Total', 'Amount Due', 'Price');
  const address = col(row, 'Shipping Address', 'Address', 'shipping_address');
  const phone = col(row, 'Phone', 'phone', 'Telephone', 'Mobile');
  const company = col(row, 'Company', 'company', 'Company Name');
  const notes = col(row, 'Order Notes', 'Notes', 'notes', 'Comments', 'Special Instructions');
  const date = col(row, 'Date', 'date', 'Order Date', 'Timestamp');

  if (date) fields.push(['Date', date]);
  if (total) fields.push(['Total', total]);
  if (address) fields.push(['Ship To', address]);
  if (company) fields.push(['Company', company]);
  if (phone) fields.push(['Phone', phone]);
  if (notes) fields.push(['Notes', notes]);

  if (!fields.length) return '';
  return fields.map(([label, val]) =>
    `<tr><td style="padding:4px 0;color:#888;font-size:13px;width:100px;">${label}</td><td style="padding:4px 0;font-size:13px;">${esc(val)}</td></tr>`
  ).join('');
}

// ---------------------------------------------------------------------------
// Email template wrapper
// ---------------------------------------------------------------------------

function emailShell({ companyName, primaryColor, body }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:${primaryColor};padding:24px;text-align:center;border-radius:12px 12px 0 0;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700;">${esc(companyName)}</h1>
    </div>
    <div style="background:#fff;padding:24px 28px;border-radius:0 0 12px 12px;">
      ${body}
    </div>
    <p style="text-align:center;color:#aaa;font-size:11px;margin-top:16px;">${esc(companyName)}</p>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Public: sendOrderConfirmation
// ---------------------------------------------------------------------------

async function sendOrderConfirmation(orderData, shopSlug) {
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);

  const body = `
    <h2 style="margin-top:0;font-size:18px;">Thank you for your order${customerName !== 'Customer' ? ', ' + esc(customerName) : ''}!</h2>
    <p style="color:#555;">We've received your order${orderId ? ' <strong>' + esc(orderId) + '</strong>' : ''} and are processing it now.</p>
    ${buildItemsTable(orderData)}
    <table style="width:100%;margin:16px 0;">${buildDetailRows(orderData)}</table>
    <p style="color:#888;font-size:13px;margin-top:24px;">You'll receive another email when your order ships.</p>
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Order Confirmation${orderId ? ' — ' + orderId : ''} | ${companyName}`;

  // Send to customer
  if (customerEmail) {
    sendMail({ to: customerEmail, subject, html }).catch(() => {});
  }

  // Send to shop admin
  const adminEmail = getAdminEmail(shopSlug);
  if (adminEmail) {
    const adminBody = `
      <h2 style="margin-top:0;font-size:18px;">New Order${orderId ? ' — ' + esc(orderId) : ''}</h2>
      <table style="width:100%;margin:12px 0;">
        <tr><td style="padding:4px 0;color:#888;font-size:13px;width:100px;">Customer</td><td style="padding:4px 0;font-size:13px;font-weight:600;">${esc(customerName)}</td></tr>
        ${customerEmail ? `<tr><td style="padding:4px 0;color:#888;font-size:13px;">Email</td><td style="padding:4px 0;font-size:13px;">${esc(customerEmail)}</td></tr>` : ''}
        ${buildDetailRows(orderData)}
      </table>
      ${buildItemsTable(orderData)}
    `;
    const adminHtml = emailShell({ companyName, primaryColor, body: adminBody });
    const adminSubject = `[New Order] ${orderId || 'Order'} from ${customerName} | ${companyName}`;
    sendMail({ to: adminEmail, subject: adminSubject, html: adminHtml }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public: sendShippedNotification
// ---------------------------------------------------------------------------

async function sendShippedNotification(orderData, trackingNumber, shopSlug) {
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);

  if (!customerEmail) {
    console.warn(`[email] No customer email for order ${orderId} — skipping shipped notification`);
    return;
  }

  const trackingHtml = trackingNumber
    ? `<p style="margin:16px 0;padding:12px 16px;background:#f0fdf4;border-radius:8px;font-size:14px;">
         <strong>Tracking Number:</strong> ${esc(trackingNumber)}
       </p>`
    : '';

  const body = `
    <h2 style="margin-top:0;font-size:18px;">Your order has shipped!</h2>
    <p style="color:#555;">Hi ${esc(customerName)}, your order${orderId ? ' <strong>' + esc(orderId) + '</strong>' : ''} is on its way.</p>
    ${trackingHtml}
    ${buildItemsTable(orderData)}
    <p style="color:#888;font-size:13px;margin-top:24px;">Thank you for your purchase!</p>
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Your order has shipped${orderId ? ' — ' + orderId : ''} | ${companyName}`;
  sendMail({ to: customerEmail, subject, html }).catch(() => {});
}

module.exports = { sendOrderConfirmation, sendShippedNotification, getAdminEmail };
