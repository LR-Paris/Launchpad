#!/usr/bin/env node
// ---------------------------------------------------------------------------
// order-email.test.js — a shop can word its own order confirmation.
//
// DATABASE/Design/Details/OrderEmail.txt carries a subject, an optional
// heading and the message. Bozzuto's capsule store takes reservations, not
// orders, and the client wrote the email they want customers to get. Without
// the file every shop keeps the standard wording.
//
//   cd backend && node test/order-email.test.js
//
// The send runs for real against a sandbox copy of the backend, with fetch
// stubbed, so the subject and HTML checked here are what Mailgun would get.
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sandbox = require('./_sandbox');

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
    }
  });
}

const sb = sandbox.create({ label: 'order-email' });
const email = sb.require('email.js');
const { parseOrderEmailCopy } = email;

const BOZZUTO = [
  'subject: Your Bozzuto Capsule Collection Reservation',
  '',
  'Thank you for your reservation from the Bozzuto Capsule Collection.',
  '',
  'Your requested quantity has been recorded and will count toward the production minimum for this item.',
  '',
  'For questions about your reservation, contact',
  'Alexandra Byrne at a.byrne@lrparis.com.',
  '',
].join('\n');

function writeShop(slug, files) {
  const details = path.join(sb.shopsDir, slug, 'DATABASE', 'Design', 'Details');
  fs.mkdirSync(details, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(details, name), text);
}

// Capture what sendMail hands to Mailgun.
const sent = [];
process.env.SESSION_SECRET = 'order-email-test-secret';  // signs the cancel link
process.env.MAILGUN_API_KEY = 'test-key';
process.env.MAILGUN_DOMAIN = 'mail.example.test';
global.fetch = async (url, opts) => {
  const form = opts.body;
  sent.push({ to: form.get('to'), subject: form.get('subject'), html: form.get('html') });
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

async function send(slug) {
  sent.length = 0;
  await email.sendOrderConfirmation({
    'Order ID': 'ORD-1001',
    'Order Date': '2026-10-16T12:00:00Z',
    'First Name': 'Jamie',
    'Last Name': 'Rivera',
    Email: 'jamie@example.test',
    Total: '440.00',
    Items: JSON.stringify([]),
  }, slug);
  await new Promise((r) => setImmediate(r));
  return sent.find((m) => m.to === 'jamie@example.test');
}

test('the parser reads the subject and splits the message on blank lines', () => {
  const copy = parseOrderEmailCopy(BOZZUTO);
  assert.strictEqual(copy.subject, 'Your Bozzuto Capsule Collection Reservation');
  assert.strictEqual(copy.heading, copy.subject, 'the heading defaults to the subject');
  assert.strictEqual(copy.paragraphs.length, 3);
  assert.strictEqual(copy.paragraphs[2], 'For questions about your reservation, contact\nAlexandra Byrne at a.byrne@lrparis.com.');
});

test('the parser takes a heading, skips comments and copes with Windows line ends', () => {
  const copy = parseOrderEmailCopy('# wording from the client\r\nsubject: A\r\nheading: B\r\n\r\nOne.\r\n\r\nTwo.\r\n');
  assert.deepStrictEqual(copy, { subject: 'A', heading: 'B', paragraphs: ['One.', 'Two.'] });
});

test('a file without a subject, or without a message, is ignored', () => {
  assert.strictEqual(parseOrderEmailCopy(''), null);
  assert.strictEqual(parseOrderEmailCopy('subject: Only a subject\n'), null);
  assert.strictEqual(parseOrderEmailCopy('Just a message, no settings.\n\nSecond.'), null);
});

test('a shop with OrderEmail.txt sends its own subject, heading and message', async () => {
  writeShop('capsule', { 'CompanyName.txt': 'Bozzuto', 'OrderEmail.txt': BOZZUTO });
  const m = await send('capsule');
  assert.ok(m, 'the customer email went out');
  assert.strictEqual(m.subject, 'Your Bozzuto Capsule Collection Reservation');
  assert.ok(m.html.includes('Thank you for your reservation from the Bozzuto Capsule Collection.'));
  assert.ok(m.html.includes('contact<br>Alexandra Byrne at a.byrne@lrparis.com.'), 'a line break inside a paragraph is kept');
  assert.ok(!m.html.includes('thank you for your order'), 'the standard greeting is gone');
  assert.ok(!m.html.includes('shipping notification'), 'the standard closing line is gone');
  assert.ok(m.html.includes('ORD-1001'), 'the order number is still in the email');
});

test('a shop without the file keeps the standard wording', async () => {
  writeShop('plain', { 'CompanyName.txt': 'Plain Co' });
  const m = await send('plain');
  assert.strictEqual(m.subject, 'Order Confirmation — ORD-1001 | Plain Co');
  assert.ok(m.html.includes('thank you for your order'));
  assert.ok(m.html.includes('shipping notification'));
});

test('the copy is escaped, so a stray tag in the file cannot reach the HTML', async () => {
  writeShop('escaped', {
    'CompanyName.txt': 'Escaped',
    'OrderEmail.txt': 'subject: Hi\nheading: <b>Bold</b>\n\nA <script>x</script> line.\n',
  });
  const m = await send('escaped');
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&lt;b&gt;Bold&lt;/b&gt;'));
});

(async () => {
  for (const run of pending) await run();
  sb.destroy();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
