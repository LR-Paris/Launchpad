import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface OrderItem {
  productId: string;
  productName: string;
  sku: string;
  boxCost: number;
  unitsPerBox: number;
  quantity: number;
}

interface OrderData {
  name: string;
  email: string;
  phone: string;
  company: string;
  country?: string;
  shippingAddress: string;
  freightOption: string;
  freightCompany: string;
  freightAccount: string;
  freightContact: string;
  orderNotes: string;
  customFields?: Record<string, string | boolean>;
  items: OrderItem[];
  total: number;
}

const CSV_HEADER = 'Order ID,Date,Customer Name,Email,Phone,Company,Country,Shipping Address,Freight Option,Freight Company,Freight Account,Freight Contact,Billing Name,Billing Address,Billing City,Billing ZIP,Billing Country,Order Notes,Custom Fields,Items,Total';

function generateOrderId(): string {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `ORD-${timestamp}-${random}`;
}

function escapeCSVField(field: string | number | boolean | null | undefined): string {
  if (field == null || field === '') return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function POST(request: NextRequest) {
  try {
    const orderData: OrderData = await request.json();

    // Validate required fields
    if (!orderData.name || !orderData.email || !orderData.items?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const orderId = generateOrderId();
    const orderDate = new Date().toISOString();
    const cf = orderData.customFields || {};

    // Freight summary for the combined "Freight Option" column
    const freightInfo = orderData.freightOption === 'own'
      ? `Own: ${orderData.freightCompany} (${orderData.freightAccount}) - ${orderData.freightContact}`
      : 'LR Paris';

    // Extract billing fields (may come from customFields)
    const billingName    = String(cf.billingName    || '');
    const billingAddress = String(cf.billingAddress || '');
    const billingCity    = String(cf.billingCity    || '');
    const billingZip     = String(cf.billingZip     || '');
    const billingCountry = String(cf.billingCountry || '');

    // Remaining custom fields (exclude billing ones we've promoted to columns)
    const PROMOTED = new Set(['billingName','billingAddress','billingCity','billingZip','billingCountry','billingSameAsShipping']);
    const remainingCF: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(cf)) {
      if (!PROMOTED.has(k)) remainingCF[k] = v;
    }
    const customFieldsJson = Object.keys(remainingCF).length ? JSON.stringify(remainingCF) : '';

    const csvRow = [
      escapeCSVField(orderId),
      escapeCSVField(orderDate),
      escapeCSVField(orderData.name),
      escapeCSVField(orderData.email),
      escapeCSVField(orderData.phone),
      escapeCSVField(orderData.company),
      escapeCSVField(orderData.country || ''),
      escapeCSVField(orderData.shippingAddress),
      escapeCSVField(freightInfo),
      escapeCSVField(orderData.freightCompany),
      escapeCSVField(orderData.freightAccount),
      escapeCSVField(orderData.freightContact),
      escapeCSVField(billingName),
      escapeCSVField(billingAddress),
      escapeCSVField(billingCity),
      escapeCSVField(billingZip),
      escapeCSVField(billingCountry),
      escapeCSVField(orderData.orderNotes),
      escapeCSVField(customFieldsJson),
      escapeCSVField(JSON.stringify(orderData.items)),
      escapeCSVField(orderData.total.toFixed(2)),
    ].join(',');

    // Write to CSV — create with header if new file
    const ordersPath = path.join(process.cwd(), 'DATABASE', 'Orders', 'orders.csv');
    fs.mkdirSync(path.dirname(ordersPath), { recursive: true });

    if (!fs.existsSync(ordersPath)) {
      fs.writeFileSync(ordersPath, CSV_HEADER + '\n', 'utf-8');
    }
    fs.appendFileSync(ordersPath, csvRow + '\n', 'utf-8');

    // Notify Launchpad (fire-and-forget) — triggers confirmation email
    const launchpadUrl = process.env.LAUNCHPAD_API_URL;
    const slug = process.env.SHOP_SLUG;
    if (launchpadUrl && slug) {
      const notifyPayload = {
        orderId,
        'Order ID': orderId,
        'Customer Name': orderData.name,
        name: orderData.name,
        email: orderData.email,
        Email: orderData.email,
        Phone: orderData.phone || '',
        Company: orderData.company || '',
        Country: orderData.country || '',
        'Shipping Address': orderData.shippingAddress,
        'Freight Option': freightInfo,
        'Freight Company': orderData.freightCompany || '',
        'Freight Account': orderData.freightAccount || '',
        'Freight Contact': orderData.freightContact || '',
        'Billing Name': billingName,
        'Billing Address': billingAddress,
        'Billing City': billingCity,
        'Billing ZIP': billingZip,
        'Billing Country': billingCountry,
        'Order Notes': orderData.orderNotes || '',
        'Custom Fields': customFieldsJson,
        Items: JSON.stringify(orderData.items),
        items: orderData.items,
        Total: orderData.total.toFixed(2),
        total: orderData.total,
        Date: orderDate,
      };

      fetch(`${launchpadUrl}/api/shops/${slug}/orders/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderData: notifyPayload }),
      }).catch(err => console.error('[orders] Notify failed:', err));
    }

    return NextResponse.json({ success: true, orderId, message: 'Order submitted successfully' });
  } catch (error) {
    console.error('Error processing order:', error);
    return NextResponse.json({ error: 'Failed to process order' }, { status: 500 });
  }
}
