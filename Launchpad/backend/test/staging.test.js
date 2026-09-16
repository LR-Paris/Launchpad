// Tests for the DATABASE stage/apply/rollback pipeline (backend/src/staging.js).
//
// No test framework is installed on this server, so this is plain node:
//
//   cd backend && node test/staging.test.js
//
// Exits non-zero if anything fails. Every fixture zip is built here, so the file
// is self-contained and needs no checked-in binaries.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const staging = require('../src/staging');

let failures = 0;
let passed = 0;

function test(name, fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-staging-'));
  try {
    fn(workspace);
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    if (process.env.VERBOSE) console.error(err);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const S_IFREG = 0x8000;
const S_IFLNK = 0xA000;
const S_IFBLK = 0x6000;

// The fixture zips are written by hand rather than with adm-zip, because adm-zip
// sanitizes entry names and rewrites external attributes when it WRITES a zip.
// An attacker's zip writer does neither, so a fixture built with adm-zip cannot
// express the attacks this pipeline has to survive. Stored (uncompressed)
// entries, a central directory, and an end-of-central-directory record is all a
// reader needs.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(files, zipPath) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, spec] of Object.entries(files)) {
    const content = Buffer.isBuffer(spec) ? spec
      : (typeof spec === 'string' ? Buffer.from(spec) : Buffer.from(spec.content || ''));
    const mode = (spec && spec.mode) || (name.endsWith('/') ? 0x41ED : 0x81A4);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: stored
    local.writeUInt32LE(0, 10);           // time + date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, content);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031E, 4);      // version made by: unix
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(content.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((mode * 0x10000) >>> 0, 38);   // external attrs: unix mode
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBuf]));

    offset += local.length + nameBuf.length + content.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(zipPath, Buffer.concat([...parts, centralBuf, end]));
  return zipPath;
}

// The zip bomb fixture needs real deflate, and its entry names are innocent, so
// adm-zip is the right tool for that one.
function makeDeflatedZip(files, zipPath) {
  const zip = new AdmZip();
  for (const [name, spec] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(spec) ? spec : Buffer.from(String(spec)));
  }
  zip.writeZip(zipPath);
  return zipPath;
}


// A zip that tells the truth about everything except how big it unpacks to.
// Real deflate, real CRC, declared uncompressed size of 0 — which is exactly
// what the zip bomb in the security review did, and what every cap in
// inspectZip used to be reading (finding M3).
function makeLyingZip(entryName, payload, zipPath) {
  const zlib = require('zlib');
  const compressed = zlib.deflateRawSync(payload, { level: 9 });
  const nameBuf = Buffer.from(entryName, 'utf8');
  const crc = crc32(payload);
  const DECLARED_SIZE = 0; // the lie

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);             // method: deflated
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(DECLARED_SIZE, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x031E, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(8, 10);           // method: deflated
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(DECLARED_SIZE, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0x81A4 * 0x10000) >>> 0, 38);
  header.writeUInt32LE(0, 42);
  const centralBuf = Buffer.concat([header, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(local.length + nameBuf.length + compressed.length, 16);

  fs.writeFileSync(zipPath, Buffer.concat([local, nameBuf, compressed, centralBuf, end]));
  return zipPath;
}

// A DATABASE laid out the way Shuttle reads one.
function databaseFiles(prefix, products, extra) {
  const files = {};
  files[`${prefix}Design/Details/Colors.txt`] = 'primary: #111111\n';
  files[`${prefix}Design/Details/Fonts.txt`] = 'titleFont: Inter\n';
  files[`${prefix}Design/Details/CompanyName.txt`] = 'Test Shop\n';
  for (const product of products) {
    const base = `${prefix}ShopCollections/${product.collection}/${product.folder}/`;
    files[`${base}Details/Name.txt`] = product.name || product.folder;
    if (product.sku) files[`${base}Details/SKU.txt`] = product.sku;
    if (product.variantType) files[`${base}Details/VariantType.txt`] = product.variantType;
    files[`${base}Photos/main.jpg`] = Buffer.from(`jpeg-${product.folder}`);
  }
  return Object.assign(files, extra || {});
}

function writeTree(root, files) {
  for (const [rel, spec] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (rel.endsWith('/')) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(spec) ? spec : Buffer.from(String(spec)));
  }
}

// Create shops/<slug>/ with lib/version.ts (so it is not a legacy shop) and an
// optional live DATABASE. Returns the shopsDir to pass into the pipeline.
function makeShop(workspace, slug, liveProducts, extra) {
  const shopsDir = path.join(workspace, 'shops');
  const shopDir = path.join(shopsDir, slug);
  fs.mkdirSync(path.join(shopDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(shopDir, 'lib', 'version.ts'), "export const VERSION = 'STS-3.0.0'\n");
  if (liveProducts) writeTree(shopDir, databaseFiles('DATABASE/', liveProducts, extra));
  return shopsDir;
}

function manifest(dir) {
  const lines = [];
  (function walk(current, base) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { lines.push(`D ${rel}`); walk(full, rel); }
      else lines.push(`F ${rel} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  })(dir, '');
  return lines.join('\n');
}

function expectPreflight(fn, fragment) {
  let thrown = null;
  try { fn(); } catch (err) { thrown = err; }
  assert.ok(thrown, 'expected the upload to be rejected, but it was accepted');
  assert.strictEqual(thrown.code, 'PREFLIGHT_FAILED', `expected PREFLIGHT_FAILED, got ${thrown.code}: ${thrown.message}`);
  if (fragment) {
    assert.ok(thrown.message.toLowerCase().includes(fragment.toLowerCase()),
      `expected the refusal to mention "${fragment}", got: ${thrown.message}`);
  }
  return thrown;
}

// ---------------------------------------------------------------------------
// Zip hardening
// ---------------------------------------------------------------------------

console.log('\nzip hardening');

test('zip slip: an entry escaping with .. is rejected and writes nothing', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const canary = path.join(workspace, 'pwned.txt');
  const files = databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  files['../../pwned.txt'] = 'owned';
  const zipPath = makeZip(files, path.join(workspace, 'slip.zip'));

  expectPreflight(() => staging.stageDatabase({ slug: 'demox', zipPath, shopsDir }), 'points outside');
  assert.ok(!fs.existsSync(canary), 'the traversal entry was written outside the staging folder');
  const stagingRoot = path.join(shopsDir, 'demox', '.staging');
  assert.ok(!fs.existsSync(stagingRoot) || fs.readdirSync(stagingRoot).length === 0,
    'a rejected upload left a staging folder behind');
  assert.ok(fs.existsSync(path.join(shopsDir, 'demox', 'DATABASE', 'Design')),
    'the live DATABASE was touched by a rejected upload');
});

test('zip slip: an absolute path entry is rejected', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const files = databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  files['/etc/cron.d/whatever'] = 'owned';
  const zipPath = makeZip(files, path.join(workspace, 'abs.zip'));
  expectPreflight(() => staging.stageDatabase({ slug: 'demox', zipPath, shopsDir }), 'absolute path');
});

test('symlink escape: a symlink entry is rejected', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const files = databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  // A link named like an innocent file, pointing at the host's secrets. Writing
  // this out and then writing "through" it is the classic zip symlink escape.
  files['Design/Details/Colors.txt.link'] = { content: '../../../../../../etc/passwd', mode: S_IFLNK | 0o777 };
  const zipPath = makeZip(files, path.join(workspace, 'symlink.zip'));

  expectPreflight(() => staging.stageDatabase({ slug: 'demox', zipPath, shopsDir }), 'symlink');
});

test('symlink escape: the mode check actually sees the link bit', () => {
  // Guards the guard: if adm-zip ever stops round-tripping external attributes,
  // the symlink test above would pass for the wrong reason.
  const zipPath = path.join(os.tmpdir(), `attr-${crypto.randomBytes(4).toString('hex')}.zip`);
  makeZip({ 'a.txt': { content: 'x', mode: S_IFLNK | 0o777 } }, zipPath);
  try {
    const entry = new AdmZip(zipPath).getEntries()[0];
    const mode = ((entry.header.attr || 0) >>> 16) & 0xffff;
    assert.strictEqual(mode & 0xF000, S_IFLNK, 'the unix mode did not survive into the zip we read back');
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
});

test('device files are rejected', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const files = databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  files['Design/zero'] = { content: '', mode: S_IFBLK | 0o666 };
  const zipPath = makeZip(files, path.join(workspace, 'device.zip'));
  expectPreflight(() => staging.stageDatabase({ slug: 'demox', zipPath, shopsDir }), 'device');
});

test('zip bomb: a wildly compressible entry is rejected before extraction', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const files = databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  files['Design/bomb.bin'] = Buffer.alloc(24 * 1024 * 1024, 0); // 24 MB of zeros
  const zipPath = makeDeflatedZip(files, path.join(workspace, 'bomb.zip'));

  assert.ok(fs.statSync(zipPath).size < 1024 * 1024, 'the bomb fixture did not actually compress');
  expectPreflight(() => staging.stageDatabase({ slug: 'demox', zipPath, shopsDir }), 'zip bomb');
});

test('a normal DATABASE with a plain regular-file mode is accepted', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const files = databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  files['Design/Details/Notes.txt'] = { content: 'hello', mode: S_IFREG | 0o644 };
  const zipPath = makeZip(files, path.join(workspace, 'plain.zip'));
  const result = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.deepStrictEqual(result.diff.blocking, [], `unexpected blocking: ${result.diff.blocking.join(' | ')}`);
});

test('a zip wrapped in a single DATABASE/ folder is unwrapped', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', null);
  const zipPath = makeZip(
    databaseFiles('DATABASE/', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]),
    path.join(workspace, 'wrapped.zip')
  );
  const result = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.deepStrictEqual(result.diff.blocking, [], `unexpected blocking: ${result.diff.blocking.join(' | ')}`);
  assert.deepStrictEqual(result.diff.products.added, ['Core/Mug']);
});

// ---------------------------------------------------------------------------
// Structure and variant grammar
// ---------------------------------------------------------------------------

console.log('\nvalidation');

test('a zip from the wrong folder level is blocked, not silently applied', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const zipPath = makeZip({ 'Somefolder/notes.txt': 'nope', 'Otherfolder/more.txt': 'nope' }, path.join(workspace, 'wrong.zip'));
  const result = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.ok(result.diff.blocking.length >= 1, 'a zip with no ShopCollections should be blocked');
  assert.ok(result.diff.blocking.join(' ').includes('ShopCollections'));
});

test('a legitimate 2D variant set is one new group and nothing blocking', (workspace) => {
  const shopsDir = makeShop(workspace, 'demo12', [{ collection: 'Evergreen', folder: 'Mug', sku: 'BASE-1' }]);
  const products = [
    { collection: 'Evergreen', folder: 'Mug', sku: 'BASE-1' },
    { collection: 'Evergreen', folder: 'DOF glass candle (Amber, Small)', sku: 'CN-AM-S', variantType: 'Scent, Size' },
    { collection: 'Evergreen', folder: 'DOF glass candle (Amber, Large)', sku: 'CN-AM-L', variantType: 'Scent, Size' },
    { collection: 'Evergreen', folder: 'DOF glass candle (Clear, Small)', sku: 'CN-CL-S', variantType: 'Scent, Size' },
    { collection: 'Evergreen', folder: 'DOF glass candle (Clear, Large)', sku: 'CN-CL-L', variantType: 'Scent, Size' },
  ];
  const zipPath = makeZip(databaseFiles('', products), path.join(workspace, 'variants.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demo12', zipPath, shopsDir });

  assert.deepStrictEqual(diff.blocking, [], `a valid variant set must never block: ${diff.blocking.join(' | ')}`);
  assert.deepStrictEqual(diff.variants.broken, [], `a valid variant set must not be broken: ${JSON.stringify(diff.variants.broken)}`);
  assert.strictEqual(diff.variants.new_groups.length, 1, `expected one new group, got ${JSON.stringify(diff.variants.new_groups)}`);
  const group = diff.variants.new_groups[0];
  assert.ok(group.includes('Evergreen/DOF glass candle'), group);
  assert.ok(group.includes('Scent, Size'), group);
  assert.ok(group.includes('Amber') && group.includes('Clear'), group);
  // Dimension 0 values are deduplicated: a 2D grid must not list Amber twice.
  assert.strictEqual((group.match(/Amber/g) || []).length, 1, `dim[0] values were not deduplicated: ${group}`);
  assert.strictEqual(diff.products.added.length, 4);
});

test('one lonely sibling with parentheses is a warning, never blocking', (workspace) => {
  const shopsDir = makeShop(workspace, 'demo12', [{ collection: 'Evergreen', folder: 'Mug', sku: 'BASE-1' }]);
  const products = [
    { collection: 'Evergreen', folder: 'Mug', sku: 'BASE-1' },
    { collection: 'Evergreen', folder: 'Dopp Kit (Black)', sku: 'MK-DP-BLK' },
  ];
  const zipPath = makeZip(databaseFiles('', products), path.join(workspace, 'lonely.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demo12', zipPath, shopsDir });

  assert.deepStrictEqual(diff.blocking, [], 'a single product with parentheses is correct behavior and must not block');
  assert.deepStrictEqual(diff.variants.new_groups, [], 'a group of one is not a variant group');
  const warning = diff.warnings.find((w) => w.includes('Dopp Kit (Black)'));
  assert.ok(warning, `expected a warning about the lonely sibling, got: ${JSON.stringify(diff.warnings)}`);
  assert.ok(warning.includes('single product'), warning);
});

test('a variant group missing a SKU is reported as broken but does not block', (workspace) => {
  const shopsDir = makeShop(workspace, 'demo12', [{ collection: 'Evergreen', folder: 'Mug', sku: 'BASE-1' }]);
  const products = [
    { collection: 'Evergreen', folder: 'Mug', sku: 'BASE-1' },
    { collection: 'Evergreen', folder: 'Dopp Kit (Black)', sku: 'MK-DP-BLK' },
    { collection: 'Evergreen', folder: 'Dopp Kit (Camel)' },
  ];
  const zipPath = makeZip(databaseFiles('', products), path.join(workspace, 'nosku.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demo12', zipPath, shopsDir });

  assert.deepStrictEqual(diff.blocking, []);
  assert.strictEqual(diff.variants.broken.length, 1, JSON.stringify(diff.variants.broken));
  assert.strictEqual(diff.variants.broken[0].group, 'Evergreen/Dopp Kit');
  assert.ok(diff.variants.broken[0].why.includes('SKU.txt'), diff.variants.broken[0].why);
});

test('two folders that slugify to the same product address are blocked', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', null);
  const products = [
    { collection: 'Core', folder: 'Tote Bag', sku: 'T-1' },
    { collection: 'Core', folder: 'Tote  bag', sku: 'T-2' },
  ];
  const zipPath = makeZip(databaseFiles('', products), path.join(workspace, 'collide.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.ok(diff.blocking.some((b) => b.includes('core-tote-bag')), JSON.stringify(diff.blocking));
});

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

console.log('\ndiff');

test('a rename is detected by SKU, not reported as an add plus a remove', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [
    { collection: 'Evergreen', folder: 'Dopp Kit', sku: 'MK-DP-BLK' },
    { collection: 'Evergreen', folder: 'Mug', sku: 'MG-1' },
  ]);
  const products = [
    { collection: 'Evergreen', folder: 'Leather Dopp Kit', sku: 'MK-DP-BLK' },
    { collection: 'Evergreen', folder: 'Mug', sku: 'MG-1' },
  ];
  const zipPath = makeZip(databaseFiles('', products), path.join(workspace, 'rename.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });

  assert.deepStrictEqual(diff.products.added, [], `added should be empty: ${JSON.stringify(diff.products.added)}`);
  assert.deepStrictEqual(diff.products.removed, [], `removed should be empty: ${JSON.stringify(diff.products.removed)}`);
  assert.strictEqual(diff.products.renamed.length, 1);
  assert.deepStrictEqual(diff.products.renamed[0], {
    from: 'Evergreen/Dopp Kit',
    to: 'Evergreen/Leather Dopp Kit',
    sku: 'MK-DP-BLK',
    matched_by: 'sku',
  });
});

test('a rename with no SKU falls back to base-name similarity', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Canvas Tote Bag' }]);
  const zipPath = makeZip(
    databaseFiles('', [{ collection: 'Core', folder: 'Canvas Tote Bags' }]),
    path.join(workspace, 'rename2.zip')
  );
  const { diff } = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.strictEqual(diff.products.renamed.length, 1, JSON.stringify(diff.products));
  assert.strictEqual(diff.products.renamed[0].matched_by, 'name');
  assert.deepStrictEqual(diff.products.added, []);
  assert.deepStrictEqual(diff.products.removed, []);
});

test('the diff never carries the whole catalog or any photo bytes', (workspace) => {
  const products = [];
  for (let i = 0; i < 400; i++) products.push({ collection: 'Core', folder: `Item ${i}`, sku: `SKU-${i}` });
  const shopsDir = makeShop(workspace, 'demox', null);
  const zipPath = makeZip(databaseFiles('', products), path.join(workspace, 'big.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });

  assert.strictEqual(diff.products.added.length, staging.LIMITS.MAX_LIST);
  assert.ok(diff.warnings.some((w) => w.includes('350 more')), JSON.stringify(diff.warnings));
  const serialized = JSON.stringify(diff);
  assert.ok(!serialized.includes('jpeg-'), 'photo bytes leaked into the diff');
  assert.ok(serialized.length < 20000, `the diff is ${serialized.length} bytes, which is too much to hand a model`);
});

test('the diff shape is exactly the ADR 4b shape', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', null);
  const zipPath = makeZip(databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]), path.join(workspace, 'shape.zip'));
  const { diff } = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.deepStrictEqual(Object.keys(diff), ['products', 'variants', 'warnings', 'blocking', 'will_backup_to']);
  assert.deepStrictEqual(Object.keys(diff.products), ['added', 'removed', 'renamed']);
  assert.deepStrictEqual(Object.keys(diff.variants), ['new_groups', 'broken']);
  assert.ok(diff.will_backup_to.startsWith('shops/demox/.backups/'), diff.will_backup_to);
  assert.ok(diff.will_backup_to.endsWith('.zip'), diff.will_backup_to);
});

// ---------------------------------------------------------------------------
// Apply and rollback
// ---------------------------------------------------------------------------

console.log('\napply and rollback');

test('apply then rollback comes back byte-identical', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [
    { collection: 'Evergreen', folder: 'Dopp Kit', sku: 'MK-DP-BLK' },
    { collection: 'Evergreen', folder: 'Mug', sku: 'MG-1' },
  ], {
    // An empty folder and a server-managed file, because a rollback that loses
    // either of those is not a rollback.
    'DATABASE/ShopCollections/Evergreen/Mug/Photos/': '',
    'DATABASE/Inventory/inventory.csv': 'SKU,Product ID,Product Name,Collection,Stock,Last Updated,Notes\nMG-1,evergreen-mug,Mug,Evergreen,7,,\n',
  });
  const live = path.join(shopsDir, 'demox', 'DATABASE');
  fs.rmSync(path.join(live, 'ShopCollections', 'Evergreen', 'Mug', 'Photos', 'main.jpg'), { force: true });
  const before = manifest(live);

  const zipPath = makeZip(databaseFiles('', [
    { collection: 'Evergreen', folder: 'Dopp Kit', sku: 'MK-DP-BLK' },
    { collection: 'Evergreen', folder: 'Tote', sku: 'TT-1' },
  ]), path.join(workspace, 'next.zip'));

  const staged = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.deepStrictEqual(staged.diff.blocking, [], staged.diff.blocking.join(' | '));
  assert.deepStrictEqual(staged.diff.products.added, ['Evergreen/Tote']);
  assert.deepStrictEqual(staged.diff.products.removed, ['Evergreen/Mug']);

  const applied = staging.applyDatabase({ slug: 'demox', stagingId: staged.staging_id, shopsDir });
  assert.ok(applied.backup_id, 'apply did not report a backup id');
  assert.ok(fs.existsSync(path.join(shopsDir, 'demox', '.backups', applied.backup_id)), 'the backup zip is not on disk');
  assert.ok(applied.carried_forward.includes('Inventory'), 'live stock counts were not carried forward');
  assert.notStrictEqual(manifest(live), before, 'apply did not change anything');
  assert.ok(fs.existsSync(path.join(live, 'ShopCollections', 'Evergreen', 'Tote')), 'the new product is not live');
  assert.ok(fs.existsSync(path.join(live, 'Inventory', 'inventory.csv')), 'inventory.csv was wiped by the swap');

  const rolled = staging.rollbackDatabase({ slug: 'demox', shopsDir });
  assert.strictEqual(rolled.restored_from, applied.backup_id);
  assert.strictEqual(manifest(live), before, 'the rollback did not restore the DATABASE byte for byte');
});

test('rollback can name an older backup and the default is the newest', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'One', sku: 'S1' }]);
  const ids = [];
  for (let i = 2; i <= 4; i++) {
    const zipPath = makeZip(
      databaseFiles('', [{ collection: 'Core', folder: `Gen ${i}`, sku: `S${i}` }]),
      path.join(workspace, `gen${i}.zip`)
    );
    const staged = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
    ids.push(staging.applyDatabase({ slug: 'demox', stagingId: staged.staging_id, shopsDir }).backup_id);
  }
  const backups = staging.listBackups({ slug: 'demox', shopsDir });
  assert.strictEqual(backups[0].id, ids[ids.length - 1], 'list_backups is not newest first');

  staging.rollbackDatabase({ slug: 'demox', backupId: ids[0], shopsDir });
  const live = path.join(shopsDir, 'demox', 'DATABASE', 'ShopCollections', 'Core');
  assert.ok(fs.existsSync(path.join(live, 'One')), 'rolling back to the first backup did not restore generation 1');
});

test('apply refuses a staging that has anything blocking', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const zipPath = makeZip({ 'Somefolder/notes.txt': 'nope', 'Other/more.txt': 'nope' }, path.join(workspace, 'bad.zip'));
  const staged = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.ok(staged.diff.blocking.length);

  let thrown = null;
  try { staging.applyDatabase({ slug: 'demox', stagingId: staged.staging_id, shopsDir }); } catch (err) { thrown = err; }
  assert.ok(thrown, 'apply accepted a blocked staging');
  assert.strictEqual(thrown.code, 'STAGING_BLOCKED');
  assert.ok(fs.existsSync(path.join(shopsDir, 'demox', 'DATABASE', 'ShopCollections', 'Core', 'Mug')),
    'a refused apply still changed the live DATABASE');
});

test('backup retention keeps five per shop and prunes the oldest', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Gen 0', sku: 'S0' }]);
  for (let i = 1; i <= 8; i++) {
    const zipPath = makeZip(
      databaseFiles('', [{ collection: 'Core', folder: `Gen ${i}`, sku: `S${i}` }]),
      path.join(workspace, `gen${i}.zip`)
    );
    const staged = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
    staging.applyDatabase({ slug: 'demox', stagingId: staged.staging_id, shopsDir });
  }
  const backups = staging.listBackups({ slug: 'demox', shopsDir });
  assert.strictEqual(backups.length, staging.LIMITS.BACKUP_RETENTION,
    `expected ${staging.LIMITS.BACKUP_RETENTION} backups, found ${backups.length}`);
});

test('a half-finished apply is recovered, never left with no DATABASE', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const shopDir = path.join(shopsDir, 'demox');
  // Simulate the process dying between the two renames of the swap.
  fs.renameSync(path.join(shopDir, 'DATABASE'), path.join(shopDir, '.DATABASE.replacing-2026-09-16T00-00-00.000Z'));
  assert.ok(!fs.existsSync(path.join(shopDir, 'DATABASE')));

  const recovered = staging.recoverInterruptedApply('demox', shopsDir);
  assert.ok(recovered, 'nothing was recovered');
  assert.ok(fs.existsSync(path.join(shopDir, 'DATABASE', 'ShopCollections', 'Core', 'Mug')),
    'the DATABASE was not put back');
});

test('staging never writes into the live DATABASE', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const live = path.join(shopsDir, 'demox', 'DATABASE');
  const before = manifest(live);
  const zipPath = makeZip(databaseFiles('', [{ collection: 'Core', folder: 'Totally Different', sku: 'Z9' }]), path.join(workspace, 'other.zip'));
  const staged = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.strictEqual(manifest(live), before, 'stage_database modified the live DATABASE');
  assert.ok(fs.existsSync(path.join(shopsDir, 'demox', '.staging', staged.staging_id, 'DATABASE')));
});


// ---------------------------------------------------------------------------
// Security review, finding M3: the declared uncompressed size is a number the
// uploader writes. Nothing may be decided by it.
// ---------------------------------------------------------------------------
test('a zip that declares a size of zero is still capped on its real inflated length', (workspace) => {
  const payload = Buffer.alloc(4 * 1024 * 1024); // 4 MB that deflates to a few KB
  const zipPath = makeLyingZip('ShopCollections/Bags/Tote/Photos/main.jpg', payload, path.join(workspace, 'bomb.zip'));
  assert.ok(fs.statSync(zipPath).size < 64 * 1024, 'the fixture should be tiny on disk');

  // inspectZip is happy: every cap it reads says zero.
  const inspected = staging.inspectZip(zipPath);
  assert.strictEqual(inspected.totalUncompressed, 0, 'the declared total is the lie we expect');

  // Extraction is where it has to be caught. Shrink the budget rather than
  // building a gigabyte fixture; the code reads LIMITS at each entry.
  const entryCap = staging.LIMITS.MAX_ENTRY_UNCOMPRESSED;
  const totalCap = staging.LIMITS.MAX_TOTAL_UNCOMPRESSED;
  staging.LIMITS.MAX_ENTRY_UNCOMPRESSED = 1024 * 1024;
  staging.LIMITS.MAX_TOTAL_UNCOMPRESSED = 1024 * 1024;
  try {
    expectPreflight(
      () => staging.extractZip(zipPath, path.join(workspace, 'out')),
      'size allowance',
    );
  } finally {
    staging.LIMITS.MAX_ENTRY_UNCOMPRESSED = entryCap;
    staging.LIMITS.MAX_TOTAL_UNCOMPRESSED = totalCap;
  }
});

test('an honest entry is written byte for byte, and the reported size is the real one', (workspace) => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 0x5a);
  const zipPath = makeLyingZip('Design/Details/Colors.txt', payload, path.join(workspace, 'honest.zip'));
  const out = path.join(workspace, 'out');
  const result = staging.extractZip(zipPath, out);
  assert.strictEqual(result.fileCount, 1);
  assert.strictEqual(result.bytes, payload.length, 'extractZip reported the declared size instead of the real one');
  const written = fs.readFileSync(path.join(out, 'Design', 'Details', 'Colors.txt'));
  assert.strictEqual(written.length, payload.length);
  assert.ok(written.equals(payload), 'the bytes on disk are not the bytes in the zip');
});

test('an entry whose checksum does not match its contents is refused', (workspace) => {
  const zipPath = path.join(workspace, 'corrupt.zip');
  const name = 'Design/Details/Colors.txt';
  makeLyingZip(name, Buffer.from('the real contents, long enough to deflate into something worth flipping a bit in'), zipPath);
  // Flip a byte inside the deflate stream: what comes out no longer matches the
  // CRC in the header, which is the check adm-zip used to be doing for us.
  const buf = fs.readFileSync(zipPath);
  const dataStart = 30 + Buffer.byteLength(name);
  buf[dataStart + 4] = buf[dataStart + 4] ^ 0xff;
  fs.writeFileSync(zipPath, buf);
  assert.throws(() => staging.extractZip(zipPath, path.join(workspace, 'out')), /PreflightError|damaged|not readable/);
});

// ---------------------------------------------------------------------------
// Security review, finding M4: a staging id is a folder name, never a path.
// ---------------------------------------------------------------------------
test('a staging id of .. or . is refused by every route that takes one', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const shopDir = path.join(shopsDir, 'demox');
  fs.mkdirSync(path.join(shopDir, '.staging'), { recursive: true });

  for (const bad of ['..', '.', '../..', '..%2f..', '', null, undefined, 'a/../..', 'a\\..']) {
    assert.strictEqual(staging.isSafeStagingId(bad), false, `accepted ${JSON.stringify(bad)}`);
    assert.strictEqual(staging.discardStaging({ slug: 'demox', stagingId: bad, shopsDir }), false,
      `discardStaging acted on ${JSON.stringify(bad)}`);
    assert.strictEqual(staging.getStaging({ slug: 'demox', stagingId: bad, shopsDir }), null);
    assert.throws(() => staging.applyDatabase({ slug: 'demox', stagingId: bad, shopsDir }),
      (err) => err.code === 'PREFLIGHT_FAILED', `applyDatabase accepted ${JSON.stringify(bad)}`);
  }

  // And the thing the PoC actually destroyed is still there.
  assert.ok(fs.existsSync(path.join(shopDir, 'DATABASE')), 'the live DATABASE was deleted');
  assert.ok(fs.existsSync(path.join(shopDir, '.staging')), 'the staging root was deleted');
});

test('discardStaging only deletes a real staging of this shop', (workspace) => {
  const shopsDir = makeShop(workspace, 'demox', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]);
  const stagingRoot = path.join(shopsDir, 'demox', '.staging');

  // A folder with no meta.json is not a staging, whatever it is called.
  const stray = path.join(stagingRoot, 'not-a-staging');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'keep.txt'), 'x');
  assert.strictEqual(staging.discardStaging({ slug: 'demox', stagingId: 'not-a-staging', shopsDir }), false);
  assert.ok(fs.existsSync(stray), 'a folder with no meta.json was deleted anyway');

  // Nor is one whose meta.json names another shop.
  const otherShop = path.join(stagingRoot, 'belongs-elsewhere');
  fs.mkdirSync(otherShop, { recursive: true });
  fs.writeFileSync(path.join(otherShop, 'meta.json'), JSON.stringify({ staging_id: 'belongs-elsewhere', shop: 'serhant' }));
  assert.strictEqual(staging.discardStaging({ slug: 'demox', stagingId: 'belongs-elsewhere', shopsDir }), false);
  assert.ok(fs.existsSync(otherShop), 'a staging belonging to another shop was deleted');

  // A real one still goes.
  const zipPath = makeZip(databaseFiles('', [{ collection: 'Core', folder: 'Mug', sku: 'A1' }]), path.join(workspace, 'db.zip'));
  const staged = staging.stageDatabase({ slug: 'demox', zipPath, shopsDir });
  assert.strictEqual(staging.discardStaging({ slug: 'demox', stagingId: staged.staging_id, shopsDir }), true);
  assert.ok(!fs.existsSync(path.join(stagingRoot, staged.staging_id)));
});

console.log(`\n${passed} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
