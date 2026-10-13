// ---------------------------------------------------------------------------
// starter-database.js — what a brand new shop's DATABASE holds on day one.
//
// POST /api/shops clones the Shuttle template repo, and that repo's DATABASE
// folder is a real client's catalog: it has been Michael Kors since the
// template was cut. Without this step every new shop opened with Michael Kors
// products, logo, fonts, FAQ and password, and kept them until somebody
// uploaded a catalog. The-ritz-carlton sat in testing that way on 2026-10-13.
//
// The starter keeps the folder structure and every README (they are the
// documentation people build from) and removes everything that belongs to a
// client: products, images, fonts, copy, contacts, stock and orders. The
// Details files get neutral values that carry the new shop's own name, and the
// shop gets its own password.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff?)$/i;
const FONT_RE = /\.(otf|ttf|woff2?|eot)$/i;

const COLORS = [
  'primary: #1A1A1A',
  'secondary: #1A1A1A',
  'accent: #1A1A1A',
  'background: #FFFFFF',
  'text: #1A1A1A',
  'textLight: #666666',
  'border: #E5E5E5',
  'success: #2E7D32',
  '',
].join('\n');

const INTER = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap';
const FONTS = [
  'titleFont: Inter',
  'bodyFont: Inter',
  `titleFontUrl: ${INTER}`,
  `bodyFontUrl: ${INTER}`,
  '',
].join('\n');

const HOTELS = [
  '# Hotel list',
  '# One hotel per line. They appear in a dropdown at checkout when',
  '# hotel_list is true in DATABASE/Presets/DataRequired.txt.',
  '# Lines starting with # are comments.',
  '',
].join('\n');

const FAQ = [
  'Q: How do I place an order?',
  'A: Browse a collection, add boxes to your cart, and check out.',
  '',
  'Q: Who do I contact with questions?',
  'A: For questions about an order:',
  'Email: g.lupo@lrparis.com',
  '',
  'For finance questions:',
  'Email: finance@lrparis.com',
  '',
].join('\n');

// A readable password the shop owner can say out loud: a word from the slug
// and four digits, such as "ritz4821". It is replaced by Password.txt in the
// first real catalog upload.
function generateShopPassword(slug) {
  const words = String(slug || '').toLowerCase().split('-').filter((w) => /^[a-z]{3,}$/.test(w) && w !== 'the');
  const word = (words[0] || 'shop').slice(0, 10);
  return `${word}${crypto.randomInt(1000, 10000)}`;
}

function write(dir, file, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

// Remove matching files under dir (recursively when deep). READMEs always stay.
function removeFiles(dir, re, deep) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (deep) n += removeFiles(p, re, deep);
    } else if (re.test(entry.name) && !/^readme/i.test(entry.name)) {
      fs.rmSync(p, { force: true });
      n += 1;
    }
  }
  return n;
}

function countProducts(collectionDir) {
  let n = 0;
  for (const entry of fs.readdirSync(collectionDir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += 1;
  }
  return n;
}

// Keep only the header row of a CSV, so the column order the template expects
// survives. A missing file stays missing: the shop creates its own.
function headerOnly(file) {
  if (!fs.existsSync(file)) return;
  const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] || '';
  fs.writeFileSync(file, first ? `${first}\n` : '');
}

function writeStarterDatabase(dbDir, { name, slug, year = new Date().getFullYear() } = {}) {
  const shopName = String(name || slug || 'New shop').trim();
  let products = 0;

  // Products: every collection folder goes. The README beside them stays.
  const collections = path.join(dbDir, 'ShopCollections');
  fs.mkdirSync(collections, { recursive: true });
  for (const entry of fs.readdirSync(collections, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(collections, entry.name);
    products += countProducts(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The template client's logos, showcase photos and font files.
  const images = removeFiles(path.join(dbDir, 'Design', 'Logos'), IMAGE_RE, false)
    + removeFiles(path.join(dbDir, 'Design', 'ShowcasePhotos'), IMAGE_RE, true);
  const fonts = removeFiles(path.join(dbDir, 'Design', 'Fonts'), FONT_RE, true);

  // Details: neutral, readable, and in the new shop's own name.
  const password = generateShopPassword(slug);
  const details = path.join(dbDir, 'Design', 'Details');
  write(details, 'CompanyName.txt', `${shopName}\n`);
  write(details, 'Colors.txt', COLORS);
  write(details, 'Descriptions.txt', [
    `tagline: Welcome to the ${shopName} shop.`,
    'about: Browse the collections, add boxes to your cart, and check out.',
    `footer: © ${year} ${shopName}. All rights reserved.`,
    '',
  ].join('\n'));
  write(details, 'Fonts.txt', FONTS);
  write(details, 'Style.txt', 'cornerRadius: 0\nstyle: sharp\n');
  write(details, 'Password.txt', `${password}\n`);
  write(details, 'AdminEmail.txt', '');
  write(details, 'Email.txt', 'contact: \n');
  write(details, 'Hotels.txt', HOTELS);
  write(path.join(dbDir, 'Design', 'FAQ'), 'FAQ.txt', FAQ);

  // Stock and orders start empty.
  headerOnly(path.join(dbDir, 'Inventory', 'inventory.csv'));
  headerOnly(path.join(dbDir, 'Orders', 'orders.csv'));

  // A free shop with every checkout field on. No comment lines: Launchpad's
  // own readers and the shop's parser must agree on what these files say.
  write(path.join(dbDir, 'Presets'), 'ShopType.txt', 'type: free\n');
  write(path.join(dbDir, 'Presets'), 'DataRequired.txt',
    'address: true\ndetails: true\nextra_notes: true\nshipping_handler: true\nhotel_list: false\n');

  return { password, removed: { products, images, fonts } };
}

module.exports = { writeStarterDatabase, generateShopPassword };
