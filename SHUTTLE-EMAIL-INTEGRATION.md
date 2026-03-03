# Shuttle Email Integration Guide — Launchpad 3.0

This guide explains the changes needed in each **Shuttle shop** (Next.js template) so that
order confirmation emails are sent automatically when a customer places an order.

All email sending is handled by the **Launchpad backend** — the Shuttle shop only needs to
fire a single POST request after it writes the order to CSV.

---

## Overview

```
Customer places order
        │
        ▼
┌──────────────────────┐
│  Shuttle (Next.js)   │
│  app/api/orders/     │
│  route.ts            │
│                      │
│  1. Write CSV row    │
│  2. POST /notify ──────────► Launchpad Backend
│     (fire & forget)  │         │
└──────────────────────┘         ▼
                          ┌─────────────────┐
                          │  email.js        │
                          │  - Read branding │
                          │  - Build receipt │
                          │  - Mailgun send  │
                          └─────────────────┘
                                 │
                          ┌──────┴──────┐
                          ▼             ▼
                    Customer       Shop Admin
                    Email          Email
```

---

## Step 1 — Add Environment Variable

Add `LAUNCHPAD_API_URL` to the shop's `.env` file. This tells the Shuttle container
where to reach the Launchpad backend.

### For new shops

Edit `backend/src/shops.js` line ~566, where the shop `.env` is written during creation.
Add `LAUNCHPAD_API_URL` to the env content:

```javascript
// backend/src/shops.js — inside the POST / handler
const envContent = [
  `SHOP_NAME=${name}`,
  `SHOP_SLUG=${slug}`,
  `SHOP_PORT=${port}`,
  `BASE_PATH=/${slug}`,
  `PUBLIC_URL=/${slug}`,
  `NEXT_PUBLIC_BASE_PATH=/${slug}`,
  `LAUNCHPAD_API_URL=http://172.17.0.1:${process.env.PORT || 3001}`,
].join('\n') + '\n';
```

> **Why `172.17.0.1`?** — Each Shuttle shop runs in a Docker container. The Docker
> bridge network default gateway `172.17.0.1` points to the host machine where the
> Launchpad backend is running. If your setup uses a custom Docker network, adjust
> accordingly.

### For existing shops

Append the variable to each existing shop's `.env` file:

```bash
# Run from the Launchpad root directory
for dir in backend/shops/*/; do
  slug=$(basename "$dir")
  echo "LAUNCHPAD_API_URL=http://172.17.0.1:3001" >> "$dir/.env"
  echo "Updated $slug"
done
```

Then restart each shop container so it picks up the new env var.

---

## Step 2 — Add Status and Tracking Columns to CSV

When the Shuttle order route writes a new row to `orders.csv`, it should include
two new columns: **Status** and **Tracking Number**.

### Where to change

In the Shuttle template's order API route — typically at:
```
app/api/orders/route.ts
```

### What to add

When building the CSV row, append two new fields:

| Column           | Default Value | Purpose                                    |
|------------------|---------------|--------------------------------------------|
| `Status`         | `Pending`     | Updated to "Shipped" when admin ships order|
| `Tracking Number`| _(empty)_     | Filled in when admin ships order           |

### Example implementation

If the current CSV header construction looks like this:

```typescript
// BEFORE — existing columns
const headers = [
  'Order ID', 'Date', 'Customer Name', 'Email', 'Phone',
  'Company', 'Shipping Address', 'Items', 'Total',
  'Freight Option', 'Freight Company', 'Order Notes', 'PO File'
];
```

Add the two new columns at the end:

```typescript
// AFTER — with status tracking columns
const headers = [
  'Order ID', 'Date', 'Customer Name', 'Email', 'Phone',
  'Company', 'Shipping Address', 'Items', 'Total',
  'Freight Option', 'Freight Company', 'Order Notes', 'PO File',
  'Status', 'Tracking Number'       // ← NEW
];
```

And when building the data row:

```typescript
const row = [
  orderId, date, customerName, email, phone,
  company, address, JSON.stringify(items), total,
  freightOption, freightCompany, notes, poFileName,
  'Pending', ''                       // ← NEW: default status
];
```

> **Note:** The Launchpad backend has a `backfillStatusColumns()` function that
> automatically adds these columns to old CSVs that don't have them. So even if
> existing orders don't have these columns, they'll appear as "Pending" in the UI.
> However, adding the columns at write time is cleaner and avoids the backfill overhead.

---

## Step 3 — Fire Notification to Launchpad

After the CSV row is successfully written, send a fire-and-forget POST request
to the Launchpad `/notify` endpoint. This triggers the order confirmation email.

### Endpoint

```
POST {LAUNCHPAD_API_URL}/api/shops/{SHOP_SLUG}/orders/notify
```

### Request body

```json
{
  "orderData": {
    "Order ID": "ORD-20260303-ABC123",
    "Date": "2026-03-03",
    "Customer Name": "Jane Smith",
    "Email": "jane@example.com",
    "Phone": "555-0123",
    "Company": "Acme Corp",
    "Shipping Address": "123 Main St, City, ST 12345",
    "Items": "[{\"productName\":\"Widget\",\"quantity\":2,\"boxCost\":25.00,\"sku\":\"WDG-001\"}]",
    "Total": "$50.00",
    "Freight Option": "Standard Shipping",
    "Order Notes": "Please gift wrap",
    "PO File": "PO-12345.pdf"
  }
}
```

The `orderData` object should contain the **same key-value pairs** as the CSV row
(column name → value). The Launchpad email module auto-detects column names using
flexible matching (e.g., "Email", "email", "E-mail", "Customer Email" all work).

### Implementation

Add this after the CSV write in `app/api/orders/route.ts`:

```typescript
// --- Send notification to Launchpad (fire-and-forget) ---
const launchpadUrl = process.env.LAUNCHPAD_API_URL;
const shopSlug = process.env.SHOP_SLUG;

if (launchpadUrl && shopSlug) {
  // Build the orderData object from the same values used for the CSV row
  const orderData: Record<string, string> = {};
  headers.forEach((header, i) => {
    orderData[header] = row[i] ?? '';
  });

  // Fire and forget — don't await, don't let failures block the response
  fetch(`${launchpadUrl}/api/shops/${shopSlug}/orders/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderData }),
  }).catch((err) => {
    console.error('[notify] Failed to notify Launchpad:', err.message);
  });
}
```

### Key points

- **Fire-and-forget**: Do NOT `await` the fetch. The customer should get their
  order confirmation page immediately — the email will send in the background.
- **No auth required**: The Launchpad `/notify` endpoint is unauthenticated but
  validates that the shop slug exists in the database and on disk. It's also
  rate-limited to 30 requests per minute.
- **Failure is silent**: If Launchpad is down or the URL is wrong, the order still
  completes normally. The email just won't send. Errors are logged to the
  Shuttle container's console.

---

## Step 4 — Create AdminEmail.txt

Each shop can have its own admin notification email. When an order comes in, a
copy of the receipt goes to this address.

### File location

```
DATABASE/Design/Details/AdminEmail.txt
```

### Content

Just the email address, nothing else:

```
orders@yourcompany.com
```

### How it's used

The Launchpad email module reads this file when sending order confirmations:
1. If `AdminEmail.txt` exists → sends admin alert to that address
2. If missing → falls back to `FALLBACK_ADMIN_EMAIL` from Launchpad's `.env`
3. If neither exists → no admin email is sent (customer still gets theirs)

### Adding to the DATABASE Builder template

If you have a DATABASE Builder or shop template generator, add `AdminEmail.txt`
to the `DATABASE/Design/Details/` directory alongside the existing files:

```
DATABASE/Design/Details/
├── AdminEmail.txt          ← NEW
├── Colors.txt
├── CompanyName.txt
├── Password.txt
├── ...
```

### Configuring via Launchpad UI

Shop admins can also set the admin email through the Launchpad Settings panel.
`AdminEmail.txt` appears in the Settings page alongside other Design/Details files
like CompanyName, Colors, etc.

---

## Step 5 — Ensure Branding Files Exist

The email templates pull branding from these `DATABASE/Design/Details/` files:

| File | Purpose | Fallback |
|------|---------|----------|
| `CompanyName.txt` | Company name in email header + "From" name | Shop slug |
| `Colors.txt` | Primary brand color for email header bar | `#00b4d8` |
| `AdminEmail.txt` | Admin notification recipient | `FALLBACK_ADMIN_EMAIL` env var |

### Colors.txt format

The email module extracts the **first hex color** from this file:

```
Primary: #1a365d
Secondary: #e53e3e
Background: #f7fafc
```

In this example, `#1a365d` would be used as the email header background color.

### CompanyName.txt format

Just the company name:

```
Acme Industries
```

This appears in:
- The email header bar (white text on brand-colored background)
- The "From" address: `Acme Industries <noreply@mg.yourdomain.com>`
- The email footer

---

## Complete Example — Full Order Route

Here's what a complete `app/api/orders/route.ts` might look like with the
notification integrated:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'DATABASE');

// CSV helper — escape fields with commas, quotes, or newlines
function escapeCSV(value: string): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      orderId, customerName, email, phone, company,
      address, items, total, freightOption, freightCompany,
      notes, poFileName
    } = body;

    const date = new Date().toISOString().split('T')[0];

    // --- CSV column definitions ---
    const headers = [
      'Order ID', 'Date', 'Customer Name', 'Email', 'Phone',
      'Company', 'Shipping Address', 'Items', 'Total',
      'Freight Option', 'Freight Company', 'Order Notes', 'PO File',
      'Status', 'Tracking Number'
    ];

    const row = [
      orderId, date, customerName, email, phone,
      company, address, JSON.stringify(items), total,
      freightOption, freightCompany, notes, poFileName || '',
      'Pending', ''
    ];

    // --- Write to CSV ---
    const ordersDir = path.join(DB_PATH, 'Orders');
    const csvPath = path.join(ordersDir, 'orders.csv');

    if (!fs.existsSync(ordersDir)) {
      fs.mkdirSync(ordersDir, { recursive: true });
    }

    const csvRow = row.map(escapeCSV).join(',');

    if (!fs.existsSync(csvPath)) {
      // New file — write header + first row
      fs.writeFileSync(csvPath, headers.join(',') + '\n' + csvRow + '\n');
    } else {
      // Append row to existing file
      fs.appendFileSync(csvPath, csvRow + '\n');
    }

    // --- Notify Launchpad (fire-and-forget) ---
    const launchpadUrl = process.env.LAUNCHPAD_API_URL;
    const shopSlug = process.env.SHOP_SLUG;

    if (launchpadUrl && shopSlug) {
      const orderData: Record<string, string> = {};
      headers.forEach((header, i) => {
        orderData[header] = String(row[i] ?? '');
      });

      fetch(`${launchpadUrl}/api/shops/${shopSlug}/orders/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderData }),
      }).catch((err) => {
        console.error('[notify] Failed to notify Launchpad:', err.message);
      });
    }

    return NextResponse.json({ success: true, orderId });
  } catch (error) {
    console.error('Order POST error:', error);
    return NextResponse.json(
      { error: 'Failed to process order' },
      { status: 500 }
    );
  }
}
```

---

## Step 6 — Docker Compose Network (Optional)

If your Docker containers use a custom network (not the default bridge), you may
need to adjust `LAUNCHPAD_API_URL` to use the correct gateway IP or hostname.

### Default bridge network (most setups)

```
LAUNCHPAD_API_URL=http://172.17.0.1:3001
```

### Custom bridge network

Check the gateway:
```bash
docker network inspect <network-name> | grep Gateway
```

### host.docker.internal (Docker Desktop on Mac/Windows)

```
LAUNCHPAD_API_URL=http://host.docker.internal:3001
```

### Same Docker Compose stack

If Launchpad and shops run in the same Docker Compose, use the service name:
```
LAUNCHPAD_API_URL=http://launchpad-backend:3001
```

---

## What Emails Look Like

### Order Confirmation (to customer)

```
From: Acme Industries <noreply@mg.yourdomain.com>
Subject: Order Confirmation — ORD-20260303-ABC123 | Acme Industries

┌──────────────────────────────────────┐
│         ACME INDUSTRIES              │  ← Brand color header
│     (white text on #1a365d bg)       │
├──────────────────────────────────────┤
│                                      │
│  Thank you for your order, Jane!     │
│                                      │
│  ┌─────────┬─────────────────────┐   │
│  │ Order   │ ORD-20260303-ABC123 │   │
│  │ Date    │ 2026-03-03          │   │
│  └─────────┴─────────────────────┘   │
│                                      │
│  ┌────────┬─────┬────────┬───────┐   │
│  │ Item   │ Qty │ Price  │ Total │   │  ← Receipt table
│  ├────────┼─────┼────────┼───────┤   │
│  │ Widget │ 2   │ $25.00 │$50.00 │   │
│  ├────────┼─────┼────────┼───────┤   │
│  │              Order Total $50.00│   │  ← Brand color
│  └────────────────────────────────┘   │
│                                      │
│  Company:  Acme Corp                 │
│  Ship To:  123 Main St...            │  ← Info block
│  Shipping: Standard                  │
│                                      │
│  ─────────────────────────────────   │
│  You'll receive another email when   │
│  your order ships.                   │
│                                      │
├──────────────────────────────────────┤
│         Acme Industries              │  ← Footer
└──────────────────────────────────────┘
```

### Admin Alert (to shop owner)

Same receipt layout but with a prominent **customer contact block** at the top
showing customer name, email (clickable mailto link), phone, and date.

### Shipped Notification (to customer)

Sent when admin clicks "Mark as Shipped" in Launchpad. Includes:
- Green tracking number box (if tracking provided)
- Order receipt recap
- Company branding

---

## Testing

### 1. Test the notify endpoint directly

```bash
curl -X POST http://localhost:3001/api/shops/YOUR-SHOP-SLUG/orders/notify \
  -H 'Content-Type: application/json' \
  -d '{
    "orderData": {
      "Order ID": "TEST-001",
      "Date": "2026-03-03",
      "Customer Name": "Test Customer",
      "Email": "your-test-email@example.com",
      "Items": "[{\"productName\":\"Test Item\",\"quantity\":1,\"boxCost\":29.99,\"sku\":\"TST-001\"}]",
      "Total": "$29.99",
      "Shipping Address": "123 Test St, City, ST 12345"
    }
  }'
```

Expected response: `{"message":"Notification queued"}`

Check your test email inbox and the Launchpad console for the send log.

### 2. Test with a real order through Shuttle

1. Place an order through the Shuttle shop frontend
2. Check the Shuttle container logs for `[notify]` messages
3. Check the Launchpad backend logs for `[email] Sent "Order Confirmation..."` messages
4. Verify the customer and admin both received emails

### 3. Test the shipped notification

1. Open the shop's Orders page in Launchpad
2. Click on a pending order
3. Click "Mark as Shipped"
4. Enter a tracking number (optional)
5. Confirm — check that the customer receives a shipped email

### 4. Test fallbacks

- Remove `AdminEmail.txt` → should fall back to `FALLBACK_ADMIN_EMAIL`
- Remove `CompanyName.txt` → should use the shop slug as the company name
- Remove Mailgun env vars → should log a warning but not crash
- Set `LAUNCHPAD_API_URL` to a bad URL → order should still complete, email just won't send

---

## Checklist

- [ ] Added `LAUNCHPAD_API_URL` to shop `.env` (new and existing shops)
- [ ] Updated `shops.js` to include `LAUNCHPAD_API_URL` in new shop env generation
- [ ] Added `Status` and `Tracking Number` columns to CSV headers in Shuttle order route
- [ ] Added default values `'Pending'` and `''` to CSV data rows
- [ ] Added fire-and-forget `fetch()` to notify endpoint after CSV write
- [ ] Created `DATABASE/Design/Details/AdminEmail.txt` with shop admin email
- [ ] Verified `CompanyName.txt` and `Colors.txt` exist for branding
- [ ] Tested order confirmation email (customer + admin)
- [ ] Tested shipped notification email
- [ ] Restarted shop containers after env changes

---

## Environment Variables Reference

### Launchpad `.env` (backend)

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `MAILGUN_API_KEY` | Yes | `key-abc123...` | Mailgun API authentication |
| `MAILGUN_DOMAIN` | Yes | `mg.yourdomain.com` | Mailgun sending domain |
| `FALLBACK_ADMIN_EMAIL` | No | `admin@yourdomain.com` | Fallback when `AdminEmail.txt` is missing |

### Shop `.env` (per container)

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `LAUNCHPAD_API_URL` | Yes | `http://172.17.0.1:3001` | Launchpad backend URL for notifications |
| `SHOP_SLUG` | Yes | `acme-store` | Already exists — used to identify shop in notify URL |
