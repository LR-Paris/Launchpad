#!/usr/bin/env node
// ---------------------------------------------------------------------------
// shop-overrides.test.js — the files Launchpad copies over every new shop must
// still fit the Shuttle template they land on.
//
// templates/shop-overrides/lib/version.ts replaces the template's own
// lib/version.ts. In October 2026 the override exported only VERSION and
// VERSION_INFO, the template imports getVersion() and getVersionInfo(), and
// every new shop failed `next build` on the type check. This test reads what
// the template imports from '@/lib/version' and checks the override exports
// all of it.
//
//   cd backend && node test/shop-overrides.test.js
//
// With SHUTTLE_DIR pointing at a checkout of LR-Paris/Shuttle, the import
// list is read from that checkout. Without it, the list below is used: it is
// what Shuttle main imports today.
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

const OVERRIDES = path.join(__dirname, '..', 'templates', 'shop-overrides');
const versionTs = fs.readFileSync(path.join(OVERRIDES, 'lib', 'version.ts'), 'utf8');

// Shuttle main, 2026-10-14: components/Footer.tsx and app/api/version/route.ts.
const KNOWN_IMPORTS = ['getVersion', 'getVersionInfo'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Every name imported from '@/lib/version' in a tree, override files included,
// because the override's own About page reads /api/version too.
function importsFromVersion(root) {
  const names = new Set();
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/version['"]/g;
  for (const file of walk(root)) {
    if (file.endsWith(path.join('lib', 'version.ts'))) continue;
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(text))) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && name !== 'type') names.add(name);
      }
    }
  }
  return names;
}

function exported(text) {
  const names = new Set();
  const re = /export\s+(?:const|function|let|var|class|async\s+function)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

const exportedNames = exported(versionTs);
const shuttleDir = process.env.SHUTTLE_DIR;
const wanted = new Set(KNOWN_IMPORTS);
if (shuttleDir) {
  for (const n of importsFromVersion(shuttleDir)) wanted.add(n);
}
for (const n of importsFromVersion(OVERRIDES)) wanted.add(n);

test(`the override exports every name the template imports from @/lib/version${shuttleDir ? ' (read from SHUTTLE_DIR)' : ''}`, () => {
  const missing = [...wanted].filter((n) => !exportedNames.has(n));
  assert.deepStrictEqual(missing, [], `missing: ${missing.join(', ')}`);
});

test('it keeps the two constants and the version helpers', () => {
  for (const n of ['VERSION', 'VERSION_INFO', 'getVersion', 'getVersionInfo', 'getMajorVersion', 'getMinorVersion']) {
    assert.ok(exportedNames.has(n), `${n} is not exported`);
  }
});

test('VERSION_INFO has the name and version the About page shows', () => {
  const block = versionTs.match(/export\s+const\s+VERSION_INFO\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, 'no VERSION_INFO object literal');
  assert.ok(/\bname\s*:/.test(block[1]), 'VERSION_INFO has no name');
  assert.ok(/\bversion\s*:/.test(block[1]), 'VERSION_INFO has no version');
});

test('VERSION is an STS version the health check can read', () => {
  const m = versionTs.match(/export\s+const\s+VERSION\s*(?::\s*string\s*)?=\s*['"`]([^'"`]+)['"`]/);
  assert.ok(m, 'no VERSION constant');
  assert.ok(/^STS-\d+\.\d+\.\d+$/.test(m[1]), m[1]);
});

test('VERSIONING.md has a row for the version the override reports', () => {
  const m = versionTs.match(/export\s+const\s+VERSION\s*=\s*['"`]([^'"`]+)['"`]/);
  const doc = fs.readFileSync(path.join(OVERRIDES, 'VERSIONING.md'), 'utf8');
  assert.ok(doc.includes(`| ${m[1]} |`), `VERSIONING.md has no row for ${m[1]}`);
});

console.log(failed === 0 ? `\nPASS  ${passed} test(s).` : `\nFAIL  ${failed} of ${passed + failed} test(s).`);
process.exit(failed === 0 ? 0 : 1);
