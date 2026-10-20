#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stage-banner-update.test.js — a template update keeps the stage banner.
//
// The internal-only banner is a create-time patch to app/layout.tsx.
// update-template and upgrade stash every local patch before they pull, so
// Waldorf, the Ritz and NASCAR would have lost the banner on their next update.
// The routes now note whether the layout had it and put it back. A shop
// created before the banner existed (Bozzuto) stays without one.
//
//   cd backend && node test/stage-banner-update.test.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sandbox = require('./_sandbox');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

const sb = sandbox.create({ label: 'stage-banner' });
const { layoutHasStageBanner } = sb.require('shops.js');
const { injectStageBanner } = sb.require('golive.js');

// What Shuttle main's app/layout.tsx looks like after a git pull.
const PULLED = [
  "import Header from '@/components/Header';",
  '',
  'export default function RootLayout({ children }: { children: React.ReactNode }) {',
  '  return (',
  '    <html lang="en">',
  '      <head>',
  '      </head>',
  '      <body>',
  '        {children}',
  '      </body>',
  '    </html>',
  '  );',
  '}',
  '',
].join('\n');

function shop(name) {
  const dir = path.join(sb.shopsDir, name);
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'layout.tsx'), PULLED);
  return dir;
}
const layout = (dir) => fs.readFileSync(path.join(dir, 'app', 'layout.tsx'), 'utf8');
const count = (text, word) => text.split(word).length - 1;

// The two lines update-template and upgrade now run around the pull.
function updateTemplate(dir) {
  const hadStageBanner = layoutHasStageBanner(dir);
  fs.writeFileSync(path.join(dir, 'app', 'layout.tsx'), PULLED); // git stash + git pull
  if (hadStageBanner) injectStageBanner(dir);
}

test('a layout straight from Shuttle has no banner', () => {
  assert.strictEqual(layoutHasStageBanner(shop('plain')), false);
});

test('a shop that had the banner still has it after an update', () => {
  const dir = shop('waldorf');
  assert.strictEqual(injectStageBanner(dir), 1);
  assert.strictEqual(layoutHasStageBanner(dir), true);
  updateTemplate(dir);
  const text = layout(dir);
  assert.strictEqual(count(text, '<StageBanner />'), 1, 'one banner, at the top of <body>');
  assert.strictEqual(count(text, '<StageRobotsMeta />'), 1, 'one robots tag, in <head>');
});

test('a shop created before the banner existed stays without one', () => {
  const dir = shop('bozzuto');
  updateTemplate(dir);
  assert.strictEqual(layoutHasStageBanner(dir), false);
});

test('a second update does not add a second banner', () => {
  const dir = shop('twice');
  injectStageBanner(dir);
  updateTemplate(dir);
  updateTemplate(dir);
  assert.strictEqual(count(layout(dir), '<StageBanner />'), 1);
});

test('a shop with no layout file is not an error', () => {
  const dir = path.join(sb.shopsDir, 'empty');
  fs.mkdirSync(dir, { recursive: true });
  assert.strictEqual(layoutHasStageBanner(dir), false);
});

sb.destroy();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
