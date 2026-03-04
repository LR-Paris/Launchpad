const fs = require('fs');
const path = require('path');

const SHOPS_DIR = path.join(__dirname, '..', 'shops');

// ---------------------------------------------------------------------------
// Mailgun transport — uses built-in fetch + FormData, zero npm deps
// ---------------------------------------------------------------------------

async function sendMail({ to, from, subject, html }) {
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
  const hexMatches = colorsRaw.match(/#[0-9a-fA-F]{3,8}/g) || [];
  const primaryColor = hexMatches[0] || '#00b4d8';
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
  return col(row, 'Order ID', 'order_id', 'Order #', 'Order Number', 'ID', 'id');
}

function getOrderDate(row) {
  return col(row, 'Date', 'date', 'Order Date', 'Timestamp');
}

function getTotal(row) {
  return col(row, 'Total', 'total', 'Order Total', 'Amount Due', 'Price');
}

// ---------------------------------------------------------------------------
// Receipt builder — itemized receipt with line totals + grand total
// ---------------------------------------------------------------------------

function buildReceipt(row, primaryColor) {
  const itemsRaw = col(row, 'Items', 'items', 'Products', 'products');
  let items = [];
  if (itemsRaw) {
    try { items = JSON.parse(itemsRaw); } catch { /* not JSON */ }
    if (!Array.isArray(items)) items = [];
  }

  const total = getTotal(row);

  if (items.length > 0) {
    let subtotal = 0;
    const rows = items.map(it => {
      const name = esc(it.productName || it.name || 'Item');
      const sku = it.sku ? `<br><span style="color:#999;font-size:11px;">SKU: ${esc(it.sku)}</span>` : '';
      const qty = it.quantity || 1;
      const unitPrice = it.boxCost != null ? Number(it.boxCost) : 0;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;
      const units = it.unitsPerBox ? `<br><span style="color:#999;font-size:11px;">${qty * it.unitsPerBox} units</span>` : '';
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;">${name}${sku}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:13px;">${qty}${units}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:13px;">${unitPrice ? '$' + unitPrice.toFixed(2) : ''}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-size:13px;font-weight:600;">${lineTotal ? '$' + lineTotal.toFixed(2) : ''}</td>
      </tr>`;
    }).join('');

    const displayTotal = total || (subtotal ? '$' + subtotal.toFixed(2) : '');

    return `
      <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #eee;border-radius:8px;overflow:hidden;">
        <tr style="background:#fafafa;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Total</th>
        </tr>
        ${rows}
        ${displayTotal ? `
        <tr style="background:#fafafa;">
          <td colspan="3" style="padding:14px 12px;text-align:right;font-weight:700;font-size:14px;color:#333;">Order Total</td>
          <td style="padding:14px 12px;text-align:right;font-weight:700;font-size:16px;color:${primaryColor};">${esc(displayTotal)}</td>
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
    if (total) html += `<p style="margin:4px 0 0;font-size:16px;font-weight:700;color:${primaryColor};">Total: ${esc(total)}</p>`;
    html += '</div>';
    return html;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Shipping / detail info block
// ---------------------------------------------------------------------------

function buildInfoBlock(row) {
  const fields = [];
  const address = col(row, 'Shipping Address', 'Address', 'shipping_address');
  const company = col(row, 'Company', 'company', 'Company Name');
  const phone = col(row, 'Phone', 'phone', 'Telephone', 'Mobile');
  const freight = col(row, 'Freight Option', 'freight_option', 'Shipping Method');
  const freightCo = col(row, 'Freight Company', 'freight_company');
  const notes = col(row, 'Order Notes', 'Notes', 'notes', 'Comments', 'Special Instructions');

  if (company) fields.push(['Company', company]);
  if (address) fields.push(['Ship To', address]);
  if (freight) fields.push(['Shipping', freight]);
  if (freightCo) fields.push(['Carrier', freightCo]);
  if (phone) fields.push(['Phone', phone]);
  if (notes) fields.push(['Notes', notes]);

  if (!fields.length) return '';

  const rows = fields.map(([label, val]) =>
    `<tr>
      <td style="padding:5px 0;color:#999;font-size:11px;width:80px;vertical-align:top;text-transform:uppercase;letter-spacing:0.3px;">${label}</td>
      <td style="padding:5px 0;font-size:13px;color:#333;">${esc(val)}</td>
    </tr>`
  ).join('');

  return `<table style="width:100%;margin:16px 0;">${rows}</table>`;
}

// ---------------------------------------------------------------------------
// Email shell — company-branded wrapper
// ---------------------------------------------------------------------------

function emailShell({ companyName, primaryColor, body }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background:${primaryColor};padding:28px 24px;text-align:center;border-radius:12px 12px 0 0;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;letter-spacing:0.5px;">${esc(companyName)}</h1>
    </div>
    <div style="background:#fff;padding:28px 32px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      ${body}
    </div>
    <div style="text-align:center;padding:20px 0;">
      <p style="color:#bbb;font-size:11px;margin:0;">${esc(companyName)}</p>
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Public: sendOrderConfirmation — receipt-style email
// ---------------------------------------------------------------------------

async function sendOrderConfirmation(orderData, shopSlug) {
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const fromAddress = getFromAddress(companyName);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);
  const orderDate = getOrderDate(orderData);

  // Order header with ID and date
  const orderHeader = (orderId || orderDate) ? `
    <div style="margin:16px 0;padding:14px 16px;background:#fafafa;border-radius:8px;border:1px solid #eee;">
      <table style="width:100%;"><tr>
        ${orderId ? `<td style="padding:0;"><span style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Order</span><br><span style="font-size:15px;font-weight:700;color:${primaryColor};">${esc(orderId)}</span></td>` : ''}
        ${orderDate ? `<td style="padding:0;text-align:right;"><span style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Date</span><br><span style="font-size:13px;color:#333;">${esc(orderDate)}</span></td>` : ''}
      </tr></table>
    </div>
  ` : '';

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">Thank you for your order${customerName !== 'Customer' ? ', ' + esc(customerName) : ''}!</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">We've received your order and are processing it now. Here's your receipt:</p>
    ${orderHeader}
    ${buildReceipt(orderData, primaryColor)}
    ${buildInfoBlock(orderData)}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="color:#999;font-size:12px;line-height:1.5;margin:0;">You'll receive another email when your order ships. If you have questions, reply to this email or contact us directly.</p>
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Order Confirmation${orderId ? ' — ' + orderId : ''} | ${companyName}`;

  if (customerEmail) {
    sendMail({ to: customerEmail, from: fromAddress, subject, html }).catch(() => {});
  }

  // Admin email — customer contact info highlighted
  const adminEmail = getAdminEmail(shopSlug);
  if (adminEmail) {
    const adminBody = `
      <h2 style="margin-top:0;font-size:20px;color:#111;">New Order${orderId ? ' — ' + esc(orderId) : ''}</h2>
      <div style="margin:16px 0;padding:16px;background:${primaryColor}08;border-radius:8px;border-left:4px solid ${primaryColor};">
        <table style="width:100%;">
          <tr><td style="padding:4px 0;color:#999;font-size:11px;width:80px;text-transform:uppercase;">Customer</td><td style="padding:4px 0;font-size:14px;font-weight:700;color:#111;">${esc(customerName)}</td></tr>
          ${customerEmail ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Email</td><td style="padding:4px 0;font-size:13px;"><a href="mailto:${esc(customerEmail)}" style="color:${primaryColor};text-decoration:none;">${esc(customerEmail)}</a></td></tr>` : ''}
          ${col(orderData, 'Phone', 'phone', 'Telephone') ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Phone</td><td style="padding:4px 0;font-size:13px;">${esc(col(orderData, 'Phone', 'phone', 'Telephone'))}</td></tr>` : ''}
          ${orderDate ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Date</td><td style="padding:4px 0;font-size:13px;">${esc(orderDate)}</td></tr>` : ''}
        </table>
      </div>
      ${buildReceipt(orderData, primaryColor)}
      ${buildInfoBlock(orderData)}
    `;
    const adminHtml = emailShell({ companyName, primaryColor, body: adminBody });
    const adminSubject = `[New Order] ${orderId || 'Order'} from ${customerName} | ${companyName}`;
    sendMail({ to: adminEmail, from: fromAddress, subject: adminSubject, html: adminHtml }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public: sendShippedNotification
// ---------------------------------------------------------------------------

async function sendShippedNotification(orderData, trackingNumber, shopSlug) {
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
         <p style="margin:0 0 4px;font-size:11px;color:#15803d;text-transform:uppercase;letter-spacing:0.5px;">Tracking Number</p>
         <p style="margin:0;font-size:18px;font-weight:700;color:#166534;letter-spacing:0.5px;">${esc(trackingNumber)}</p>
       </div>`
    : '';

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">Your order has shipped!</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">Hi ${esc(customerName)}, great news — your order${orderId ? ' <strong>' + esc(orderId) + '</strong>' : ''} is on its way.</p>
    ${trackingHtml}
    ${buildReceipt(orderData, primaryColor)}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="color:#999;font-size:12px;line-height:1.5;margin:0;">Thank you for your purchase! If you have questions about your shipment, reply to this email.</p>
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Your order has shipped${orderId ? ' — ' + orderId : ''} | ${companyName}`;
  sendMail({ to: customerEmail, from: fromAddress, subject, html }).catch(() => {});
}

module.exports = { sendOrderConfirmation, sendShippedNotification, getAdminEmail };
