#!/usr/bin/env python3
"""
Order confirmation e-mail rework, from ELC's 9/1 review.

Their notes:
  - Shipping Method is shown, but this was never selected
  - Freight Method - we never selected this
  - Total is shown twice - but where is this coming from anyway?
  - no e-mail when someone cancels
  - formatting is incorrect when there is more than one item
  - add Brand Name, Budget, customer e-mail up top
  - remove the "all order fields" section and Unit price

Handled as a platform change rather than an ELC special case: the e-mail now
reads the shop's own Presets/Display.txt, so a shop that hides prices gets an
e-mail with no prices, and every other shop is untouched.

On "where is this coming from anyway?" — the total is the internal reference
figure recomputed from the rate card. It is deliberately never shown to a
requestor on a price-hidden shop, so it should never have reached the e-mail
either.

Run from the Launchpad repo root:  python3 patch_email.py
"""
import sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
errors, touched = [], []


def patch(rel, edits):
    p = ROOT / rel
    if not p.exists():
        errors.append(f'{rel}: file not found')
        return
    src = original = p.read_text()
    for old, new, count in edits:
        found = src.count(old)
        if found != count:
            errors.append(f'{rel}: expected {count}, found {found} for: {old[:70]!r}')
            continue
        src = src.replace(old, new)
    if src != original:
        p.write_text(src)
        touched.append(rel)
    else:
        errors.append(f'{rel}: no change applied')


EMAIL = 'backend/src/email.js'

# ---------------------------------------------------------------- 1. helper
patch(EMAIL, [
    (
        """function shopHasLogo(slug) {""",
        """/**
 * Does this shop hide prices? Mirrors Shuttle's Presets/Display.txt.
 *
 * A price-hidden shop is an approvals portal: the requestor never sees a figure
 * on the site, so putting unit prices and a total in the confirmation e-mail
 * contradicts the storefront and exposes rate card pricing over e-mail.
 */
function shopHidesPrices(slug) {
  const content = readShopFile(slug, 'Presets/Display.txt');
  if (!content) return false;
  for (const line of String(content).split('\\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, v] = t.split(':').map(s => (s || '').trim());
    if (k === 'show_prices') return v === 'false';
  }
  return false;
}

function shopHasLogo(slug) {""",
        1,
    ),
])

# ---------------------------------------------------------------- 2. receipt
patch(EMAIL, [
    (
        "function buildReceipt(row, primaryColor, slug) {",
        "function buildReceipt(row, primaryColor, slug) {\n"
        "  const hidePrices = shopHidesPrices(slug);",
        1,
    ),
    # per-line price cells
    (
        """        <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;color:#555;">${unitPrice ? '$' + unitPrice.toFixed(2) : ''}</span>
        </td>
        <td style="padding:12px 12px 12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;font-weight:600;color:#111;">${lineTotal ? '$' + lineTotal.toFixed(2) : ''}</span>
        </td>
      </tr>`;""",
        """        ${hidePrices ? '' : `
        <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;color:#555;">${unitPrice ? '$' + unitPrice.toFixed(2) : ''}</span>
        </td>
        <td style="padding:12px 12px 12px 8px;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;">
          <span style="font-size:13px;font-weight:600;color:#111;">${lineTotal ? '$' + lineTotal.toFixed(2) : ''}</span>
        </td>`}
      </tr>`;""",
        1,
    ),
    # header cells and the total row
    (
        """          <th style="padding:10px 8px;text-align:center;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
          <th style="padding:10px 8px;text-align:right;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Unit Price</th>
          <th style="padding:10px 12px;text-align:right;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Line Total</th>
        </tr>
        ${rows}
        ${displayTotal ? `
        <tr style="background:#fafafa;">
          <td colspan="4" style="padding:14px 12px;text-align:right;font-weight:700;font-size:14px;color:#333;">Total Cost</td>
          <td style="padding:14px 12px;text-align:right;font-weight:700;font-size:18px;color:${primaryColor};">${esc(displayTotal)}</td>
        </tr>
        ` : ''}""",
        """          <th style="padding:10px 8px;text-align:center;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
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
        ` : ''}""",
        1,
    ),
    # flat fallback: no total either
    (
        """    if (total) html += `<p style="margin:4px 0 0;font-size:16px;font-weight:700;color:${primaryColor};">Total Cost: ${esc(formatMoney(total))}</p>`;""",
        """    if (total && !hidePrices) html += `<p style="margin:4px 0 0;font-size:16px;font-weight:700;color:${primaryColor};">Total Cost: ${esc(formatMoney(total))}</p>`;""",
        1,
    ),
])

# ---------------------------------------------------------------- 3. info block
patch(EMAIL, [
    (
        """function buildInfoBlock(row) {
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
  if (notes) fields.push(['Notes', notes]);""",
        """function buildInfoBlock(row) {
  const fields = [];
  const company = col(row, 'Company', 'company', 'Company Name');
  const address = col(row, 'Shipping Address', 'Address', 'shipping_address');
  const billing = col(row, 'Billing Address', 'billing_address');
  const phone = col(row, 'Phone', 'phone', 'Telephone', 'Mobile');
  const freight = col(row, 'Freight Option', 'freight_option', 'Shipping Method');
  const freightCo = col(row, 'Freight Company', 'freight_company');
  const notes = col(row, 'Order Notes', 'Notes', 'notes', 'Comments', 'Special Instructions');
  const hotel = col(row, 'Hotel', 'hotel', 'Hotel Name', 'Hotel Selection', 'Accommodation');
  const inHand = col(row, 'In Hand Date', 'in_hand_date');
  const artLink = col(row, 'Art Link', 'art_link');
  const po = col(row, 'PO Number', 'po_number');

  // A shop with the freight selector switched off never asked the requestor to
  // choose a carrier, but the order row still carried a default. Showing it as
  // "Shipping Method" told ELC they had picked something they never saw.
  const freightWasChosen = freight && !/^(lr paris|none|n\\/a)$/i.test(String(freight).trim());

  if (company) fields.push(['Company', company]);
  if (address) fields.push(['Ship To', address]);
  if (billing && billing !== address) fields.push(['Bill To', billing]);
  if (inHand) fields.push(['In Hand Date', inHand]);
  if (po) fields.push(['PO Number', po]);
  if (freightWasChosen) fields.push(['Freight', freight]);
  if (freightWasChosen && freightCo) fields.push(['Carrier', freightCo]);
  if (hotel) fields.push(['Hotel', hotel]);
  if (phone) fields.push(['Phone', phone]);
  if (artLink) fields.push(['Custom Artwork', artLink]);
  if (notes) fields.push(['Notes', notes]);""",
        1,
    ),
    (
        """      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Shipping Details</p>""",
        """      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Order Details</p>""",
        1,
    ),
])

# ---------------------------------------------------------------- 4. customer email
patch(EMAIL, [
    (
        """  const total = getTotal(orderData);
  const email = getCustomerEmail(orderData);""",
        """  const total = getTotal(orderData);
  const email = getCustomerEmail(orderData);
  const hidePrices = shopHidesPrices(shopSlug);
  const brand = col(orderData, 'Brand', 'brand');
  const budget = col(orderData, 'Estimated Budget', 'estimated_budget');""",
        1,
    ),
    # brand + budget up top, total gone when prices are hidden
    (
        """        ${prettyTotal ? `<tr>
          <td style="padding:8px 0 0;border-top:1px solid #eee;"><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Total Cost</span></td>
          <td style="padding:8px 0 0;text-align:right;border-top:1px solid #eee;"><span style="font-size:18px;font-weight:700;color:${primaryColor};">${esc(prettyTotal)}</span></td>
        </tr>` : ''}""",
        """        ${brand ? `<tr>
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
        </tr>` : ''}""",
        1,
    ),
    # request-flavoured copy on a price-hidden shop
    (
        """    <h2 style="margin-top:0;font-size:20px;color:#111;">Order Confirmation${orderId ? ' — ' + esc(orderId) : ''}</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">Hi ${esc(customerName)}, thank you for your order${companyName ? ' with <strong>' + esc(companyName) + '</strong>' : ''}. We've received it and are processing it now.</p>""",
        """    <h2 style="margin-top:0;font-size:20px;color:#111;">${hidePrices ? 'Request Received' : 'Order Confirmation'}${orderId ? ' — ' + esc(orderId) : ''}</h2>
    <p style="color:#666;font-size:14px;line-height:1.5;">${hidePrices
      ? `Hi ${esc(customerName)}, thank you for your request${companyName ? ' to <strong>' + esc(companyName) + '</strong>' : ''}. We have it and are reviewing it now. This is not an order confirmation &mdash; nothing is produced or shipped until we confirm specifications, pricing and lead time in writing.`
      : `Hi ${esc(customerName)}, thank you for your order${companyName ? ' with <strong>' + esc(companyName) + '</strong>' : ''}. We've received it and are processing it now.`}</p>""",
        1,
    ),
    (
        """    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;">You'll receive a shipping notification with tracking details when your order is on its way.</p>""",
        """    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;">${hidePrices
      ? 'A member of the team will follow up with pricing and lead time.'
      : "You'll receive a shipping notification with tracking details when your order is on its way."}</p>""",
        1,
    ),
    (
        """  const subject = `Order Confirmation${orderId ? ' — ' + orderId : ''} | ${companyName}`;""",
        """  const subject = `${hidePrices ? 'Request Received' : 'Order Confirmation'}${orderId ? ' — ' + orderId : ''} | ${companyName}`;""",
        1,
    ),
])

# ---------------------------------------------------------------- 5. admin email
patch(EMAIL, [
    (
        """  const allFieldsCard = allFieldRows ? `
    <details style="margin:16px 0;">
      <summary style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;cursor:pointer;padding:8px 0;">All Order Fields</summary>
      <table style="width:100%;margin-top:8px;">${allFieldRows}</table>
    </details>
  ` : '';""",
        """  // The "All Order Fields" dump repeated everything already laid out above it,
  // so it is gone. allFieldRows is retained only so the block above keeps
  // compiling if someone reintroduces a debug view.
  void allFieldRows;
  const allFieldsCard = '';""",
        1,
    ),
    (
        """    <h2 style="margin-top:0;font-size:20px;color:#111;">New Order${orderId ? ' — ' + esc(orderId) : ''}${total ? ' <span style="color:' + primaryColor + ';">' + esc(formatMoney(total)) + '</span>' : ''}</h2>""",
        """    <h2 style="margin-top:0;font-size:20px;color:#111;">${hidePrices ? 'New Request' : 'New Order'}${orderId ? ' — ' + esc(orderId) : ''}${(total && !hidePrices) ? ' <span style="color:' + primaryColor + ';">' + esc(formatMoney(total)) + '</span>' : ''}</h2>""",
        1,
    ),
    (
        """  const adminSubject = `[New Order] ${orderId || 'Order'} from ${customerName}${total ? ' — ' + formatMoney(total) : ''} | ${companyName}`;""",
        """  const adminSubject = `[${hidePrices ? 'New Request' : 'New Order'}] ${orderId || 'Order'} from ${customerName}${(total && !hidePrices) ? ' — ' + formatMoney(total) : ''} | ${companyName}`;""",
        1,
    ),
])

# ---------------------------------------------------------------- 6. cancellation
patch(EMAIL, [
    (
        """async function sendCancellationEmail(orderData, shopSlug, opts = {}) {""",
        """async function sendCancellationEmail(orderData, shopSlug, opts = {}) {
  const hidePricesCancel = shopHidesPrices(shopSlug);""",
        1,
    ),
    (
        """        ${prettyTotal ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Total Cost</td><td style="padding:4px 0;font-size:14px;color:#333;">${esc(prettyTotal)}</td></tr>` : ''}""",
        """        ${(prettyTotal && !hidePricesCancel) ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;text-transform:uppercase;">Total Cost</td><td style="padding:4px 0;font-size:14px;color:#333;">${esc(prettyTotal)}</td></tr>` : ''}""",
        1,
    ),
    (
        """          ${prettyTotal ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Total Cost</td><td style="padding:4px 0;font-size:14px;font-weight:600;">${esc(prettyTotal)}</td></tr>` : ''}""",
        """          ${(prettyTotal && !hidePricesCancel) ? `<tr><td style="padding:4px 0;color:#999;font-size:11px;">Total Cost</td><td style="padding:4px 0;font-size:14px;font-weight:600;">${esc(prettyTotal)}</td></tr>` : ''}""",
        1,
    ),
])

if errors:
    print('=== PATCH ERRORS ===')
    for e in errors:
        print(' !', e)
    print()
print('patched:')
for t in sorted(set(touched)):
    print('  ', t)
sys.exit(1 if errors else 0)
