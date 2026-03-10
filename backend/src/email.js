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

function getBaseUrl() {
  return process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3001}`;
}

function getProductImageUrl(slug, productId) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/email-image/${encodeURIComponent(productId)}`;
}

function getCancelUrl(slug, orderId, token) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/${encodeURIComponent(orderId)}/cancel?token=${token}`;
}

function getPoUrl(slug, filename) {
  return `${getBaseUrl()}/api/shops/${slug}/orders/po?filename=${encodeURIComponent(filename)}`;
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
// Receipt builder — itemized receipt with product images
// ---------------------------------------------------------------------------

function buildReceipt(row, primaryColor, slug) {
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
      const sku = it.sku ? `<span style="color:#999;font-size:10px;display:block;margin-top:2px;">SKU: ${esc(it.sku)}</span>` : '';
      const qty = it.quantity || 1;
      const unitPrice = it.boxCost != null ? Number(it.boxCost) : 0;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;
      const units = it.unitsPerBox ? `<span style="color:#999;font-size:10px;display:block;">${qty * it.unitsPerBox} units</span>` : '';

      // Product image
      const imgSrc = (slug && it.productId) ? getProductImageUrl(slug, it.productId) : '';
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
        <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;color:#555;">${unitPrice ? '$' + unitPrice.toFixed(2) : ''}</span>
        </td>
        <td style="padding:12px 12px 12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;font-weight:600;color:#111;">${lineTotal ? '$' + lineTotal.toFixed(2) : ''}</span>
        </td>
      </tr>`;
    }).join('');

    const displayTotal = total || (subtotal ? '$' + subtotal.toFixed(2) : '');

    return `
      <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #eee;border-radius:8px;overflow:hidden;">
        <tr style="background:#fafafa;">
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;" colspan="2">Item</th>
          <th style="padding:10px 8px;text-align:center;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
          <th style="padding:10px 8px;text-align:right;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
          <th style="padding:10px 12px;text-align:right;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Total</th>
        </tr>
        ${rows}
        ${displayTotal ? `
        <tr style="background:#fafafa;">
          <td colspan="4" style="padding:14px 12px;text-align:right;font-weight:700;font-size:14px;color:#333;">Order Total</td>
          <td style="padding:14px 12px;text-align:right;font-weight:700;font-size:18px;color:${primaryColor};">${esc(displayTotal)}</td>
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
// Detailed info block — shipping, contact, notes, freight
// ---------------------------------------------------------------------------

function buildInfoBlock(row) {
  const fields = [];
  const company = col(row, 'Company', 'company', 'Company Name');
  const address = col(row, 'Shipping Address', 'Address', 'shipping_address');
  const phone = col(row, 'Phone', 'phone', 'Telephone', 'Mobile');
  const freight = col(row, 'Freight Option', 'freight_option', 'Shipping Method');
  const freightCo = col(row, 'Freight Company', 'freight_company');
  const notes = col(row, 'Order Notes', 'Notes', 'notes', 'Comments', 'Special Instructions');
  const hotel = col(row, 'Hotel', 'hotel', 'Hotel Name', 'Hotel Selection', 'Accommodation');

  if (company) fields.push(['Company', company]);
  if (address) fields.push(['Ship To', address]);
  if (freight) fields.push(['Shipping Method', freight]);
  if (freightCo) fields.push(['Carrier', freightCo]);
  if (hotel) fields.push(['Hotel', hotel]);
  if (phone) fields.push(['Phone', phone]);
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
      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Shipping Details</p>
      <table style="width:100%;">${rows}</table>
    </div>
  `;
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
      <p style="color:#bbb;font-size:11px;margin:0;">&copy; ${new Date().getFullYear()} ${esc(companyName)}. All rights reserved.</p>
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Public: sendOrderConfirmation — detailed receipt email with product images
// ---------------------------------------------------------------------------

async function sendOrderConfirmation(orderData, shopSlug) {
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const fromAddress = getFromAddress(companyName);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);
  const orderDate = getOrderDate(orderData);
  const total = getTotal(orderData);
  const email = getCustomerEmail(orderData);

  // Generate cancel token
  const { generateCancelToken } = require('./orders-webhook');
  const cancelToken = orderId ? generateCancelToken(orderId, shopSlug) : '';
  const cancelUrl = (orderId && cancelToken) ? getCancelUrl(shopSlug, orderId, cancelToken) : '';

  // Order header with ID, date, and status
  const orderHeader = `
    <div style="margin:20px 0;padding:16px 20px;background:#fafafa;border-radius:8px;border:1px solid #eee;">
      <table style="width:100%;border-collapse:collapse;">
        ${orderId ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Order Number</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:15px;font-weight:700;color:${primaryColor};">${esc(orderId)}</span></td>
        </tr>` : ''}
        ${orderDate ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Order Date</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:13px;color:#333;">${esc(orderDate)}</span></td>
        </tr>` : ''}
        <tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Status</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:12px;font-weight:600;color:#d97706;background:#fef3c7;padding:2px 10px;border-radius:12px;">Pending</span></td>
        </tr>
        ${email ? `<tr>
          <td style="padding:4px 0;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Email</span></td>
          <td style="padding:4px 0;text-align:right;"><span style="font-size:13px;color:#333;">${esc(email)}</span></td>
        </tr>` : ''}
        ${total ? `<tr>
          <td style="padding:8px 0 0;border-top:1px solid #eee;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Total</span></td>
          <td style="padding:8px 0 0;text-align:right;border-top:1px solid #eee;"><span style="font-size:18px;font-weight:700;color:${primaryColor};">${esc(total)}</span></td>
        </tr>` : ''}
      </table>
    </div>
  `;

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">Order Confirmation</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">Hi ${esc(customerName)}, thank you for your order${companyName ? ' with <strong>' + esc(companyName) + '</strong>' : ''}. We've received it and are processing it now.</p>
    ${orderHeader}
    <p style="margin:24px 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Items</p>
    ${buildReceipt(orderData, primaryColor, shopSlug)}
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
    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;">You'll receive a shipping notification with tracking details when your order is on its way.</p>
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Order Confirmation${orderId ? ' — ' + orderId : ''} | ${companyName}`;

  if (customerEmail) {
    sendMail({ to: customerEmail, from: fromAddress, subject, html }).catch(() => {});
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
  const contactRows = [];
  contactRows.push(['Customer', customerName]);
  if (customerEmail) contactRows.push(['Email', `<a href="mailto:${esc(customerEmail)}" style="color:${primaryColor};text-decoration:none;">${esc(customerEmail)}</a>`]);
  if (phone) contactRows.push(['Phone', `<a href="tel:${esc(phone)}" style="color:${primaryColor};text-decoration:none;">${esc(phone)}</a>`]);
  if (company) contactRows.push(['Company', company]);
  if (orderDate) contactRows.push(['Date', orderDate]);

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
  if (address) shipFields.push(['Ship To', address]);
  if (freight) shipFields.push(['Shipping Method', freight]);
  if (freightCo) shipFields.push(['Carrier', freightCo]);
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

  const allFieldsCard = allFieldRows ? `
    <details style="margin:16px 0;">
      <summary style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;cursor:pointer;padding:8px 0;">All Order Fields</summary>
      <table style="width:100%;margin-top:8px;">${allFieldRows}</table>
    </details>
  ` : '';

  const adminBody = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">New Order${orderId ? ' — ' + esc(orderId) : ''}${total ? ' <span style="color:' + primaryColor + ';">' + esc(total) + '</span>' : ''}</h2>
    ${contactCard}
    <p style="margin:24px 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Items</p>
    ${buildReceipt(orderData, primaryColor, shopSlug)}
    ${shippingCard}
    ${notesCard}
    ${poCard}
    ${allFieldsCard}
  `;

  const adminHtml = emailShell({ companyName, primaryColor, body: adminBody });
  const adminSubject = `[New Order] ${orderId || 'Order'} from ${customerName}${total ? ' — ' + total : ''} | ${companyName}`;
  sendMail({ to: adminEmail, from: fromAddress, subject: adminSubject, html: adminHtml }).catch(() => {});
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
    ${buildReceipt(orderData, primaryColor, shopSlug)}
    ${buildInfoBlock(orderData)}
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Your order has shipped${orderId ? ' — ' + orderId : ''} | ${companyName}`;
  sendMail({ to: customerEmail, from: fromAddress, subject, html }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Public: sendCancellationEmail — confirms cancellation to customer + admin
// ---------------------------------------------------------------------------

async function sendCancellationEmail(orderData, shopSlug) {
  const { companyName, primaryColor } = getShopBranding(shopSlug);
  const fromAddress = getFromAddress(companyName);
  const customerEmail = getCustomerEmail(orderData);
  const customerName = getCustomerName(orderData);
  const orderId = getOrderId(orderData);
  const total = getTotal(orderData);

  const body = `
    <h2 style="margin-top:0;font-size:20px;color:#111;">Order Cancelled</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">Hi ${esc(customerName)}, your order${orderId ? ' <strong>' + esc(orderId) + '</strong>' : ''} has been cancelled as requested.</p>
    <div style="margin:20px 0;padding:16px 20px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
      <table style="width:100%;">
        ${orderId ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;width:100px;text-transform:uppercase;">Order</td><td style="padding:4px 0;font-size:14px;font-weight:700;color:#991b1b;">${esc(orderId)}</td></tr>` : ''}
        ${total ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Amount</td><td style="padding:4px 0;font-size:14px;color:#333;">${esc(total)}</td></tr>` : ''}
        <tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Status</td><td style="padding:4px 0;font-size:12px;font-weight:600;color:#dc2626;">Cancelled</td></tr>
      </table>
    </div>
    <p style="color:#999;font-size:12px;line-height:1.5;margin:20px 0 0;">If you did not request this cancellation, please contact us immediately.</p>
  `;

  const html = emailShell({ companyName, primaryColor, body });
  const subject = `Order Cancelled${orderId ? ' — ' + orderId : ''} | ${companyName}`;

  if (customerEmail) {
    sendMail({ to: customerEmail, from: fromAddress, subject, html }).catch(() => {});
  }

  // Notify admin
  const adminEmail = getAdminEmail(shopSlug);
  if (adminEmail) {
    const adminBody = `
      <h2 style="margin-top:0;font-size:20px;color:#dc2626;">Order Cancelled — ${esc(orderId || 'Unknown')}</h2>
      <div style="margin:16px 0;padding:16px;background:#fef2f2;border-radius:8px;border-left:4px solid #dc2626;">
        <table style="width:100%;">
          <tr><td style="padding:4px 0;color:#999;font-size:11px;width:80px;text-transform:uppercase;">Customer</td><td style="padding:4px 0;font-size:14px;font-weight:700;color:#111;">${esc(customerName)}</td></tr>
          ${customerEmail ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Email</td><td style="padding:4px 0;font-size:13px;">${esc(customerEmail)}</td></tr>` : ''}
          ${total ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Amount</td><td style="padding:4px 0;font-size:14px;font-weight:600;">${esc(total)}</td></tr>` : ''}
          <tr><td style="padding:4px 0;color:#999;font-size:11px;">Action</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:#dc2626;">Customer self-cancelled within 2-hour window</td></tr>
        </table>
      </div>
      ${buildReceipt(orderData, primaryColor, shopSlug)}
    `;
    const adminHtml = emailShell({ companyName, primaryColor, body: adminBody });
    const adminSubject = `[Cancelled] ${orderId || 'Order'} from ${customerName} | ${companyName}`;
    sendMail({ to: adminEmail, from: fromAddress, subject: adminSubject, html: adminHtml }).catch(() => {});
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
