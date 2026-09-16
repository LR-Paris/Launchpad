const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
// Reading an entry's bytes with a hard output cap, instead of believing the
// size the zip declares about itself. See safe-zip.js.
const { readEntryData, entryFileType, ZipEntryError } = require('./safe-zip');

// authz.js and platform-db.js are agent A's files and land in the same change as
// this one. They are required lazily so everything below the router stays
// loadable (and testable) with plain `node` before the server is wired up.
let _authz = null;
function authz() {
  if (!_authz) _authz = require('./authz');
  return _authz;
}

const DEFAULT_SHOPS_DIR = path.join(__dirname, '..', 'shops');

const LIMITS = {
  // Zip hardening. A DATABASE is a few thousand JPEGs and a few thousand small
  // text files; these caps sit an order of magnitude above anything real.
  MAX_ENTRIES: 20000,
  MAX_TOTAL_UNCOMPRESSED: 1536 * 1024 * 1024, // 1.5 GB
  MAX_ENTRY_UNCOMPRESSED: 256 * 1024 * 1024,
  // Ratio checks only fire above a size floor. A 40-byte SKU.txt compresses to
  // nothing and shows a huge ratio; that is not a bomb, it is a text file.
  RATIO_LIMIT: 100,
  RATIO_MIN_ENTRY_BYTES: 10 * 1024 * 1024,
  RATIO_MIN_TOTAL_BYTES: 1024 * 1024,
  MAX_PATH_SEGMENTS: 24,
  MAX_NAME_LENGTH: 255,

  // Diff budget. The team's Claude usage is metered, so a diff is a summary,
  // never a catalog dump.
  MAX_LIST: 50,
  MAX_RENAME_PAIRS: 4000,
  SIMILARITY_SAME_COLLECTION: 0.70,
  SIMILARITY_CROSS_COLLECTION: 0.85,

  BACKUP_RETENTION: 5,
};

// Server-managed state that lives inside DATABASE but is not part of what a
// designer zips up. inventory.csv in particular holds live stock counts that
// orders decrement; a blind folder swap would silently reset every shop's
// inventory. If the uploaded zip carries these paths the uploader clearly meant
// to replace them, so we respect that and warn. Otherwise we carry them forward.
const CARRY_FORWARD = ['Inventory', 'Presets', 'Checkout'];

// Mirrors the slugify in inventory.js, which mirrors Shuttle's catalog.ts.
// Product IDs have to match across all three or the inventory rows detach.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const JUNK = new Set(['__MACOSX', '__macosx', '.DS_Store', 'Thumbs.db', '.Spotlight-V100', '.fseventsd']);

// ---------------------------------------------------------------------------
// Zip hardening. This is the security boundary: everything past extractZip is
// trusted to be inside the staging directory, so nothing may get past it that
// is not a plain file or a plain directory under that root.
// ---------------------------------------------------------------------------

class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
    this.code = 'PREFLIGHT_FAILED';
  }
}

// Returns the cleaned entry name, or throws. Rejects rather than skips: a zip
// containing a traversal attempt is not a zip we extract the safe parts of.
function checkEntryName(raw) {
  const name = String(raw);
  if (!name) throw new PreflightError('The zip has an entry with no name.');
  if (name.includes('\0')) throw new PreflightError('The zip has an entry name containing a null byte.');
  if (name.includes('\\')) {
    throw new PreflightError(`The zip entry "${name}" uses backslashes in its path, which is not a valid DATABASE path.`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new PreflightError(`The zip entry "${name}" has an absolute path. Zip the DATABASE folder itself, not a full disk path.`);
  }
  const segments = name.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new PreflightError(`The zip entry "${name}" points outside the folder it is being extracted into.`);
  }
  if (segments.length > LIMITS.MAX_PATH_SEGMENTS) {
    throw new PreflightError(`The zip entry "${name}" is nested more than ${LIMITS.MAX_PATH_SEGMENTS} folders deep.`);
  }
  if (segments.some((s) => s.length > LIMITS.MAX_NAME_LENGTH)) {
    throw new PreflightError(`The zip entry "${name}" has a file or folder name longer than ${LIMITS.MAX_NAME_LENGTH} characters.`);
  }
  return segments.join('/');
}

function isJunk(name) {
  return name.split('/').some((part) => JUNK.has(part));
}

// Read the zip's table of contents and decide whether it is safe, without
// writing a single byte. Returns { entries, stripPrefix, totalUncompressed }.
function inspectZip(zipPath) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    throw new PreflightError(`That file is not a readable zip (${err.message}).`);
  }

  let rawEntries;
  try {
    rawEntries = zip.getEntries();
  } catch (err) {
    throw new PreflightError(`That zip could not be read (${err.message}).`);
  }
  if (!rawEntries.length) throw new PreflightError('That zip is empty.');
  if (rawEntries.length > LIMITS.MAX_ENTRIES) {
    throw new PreflightError(`That zip has ${rawEntries.length} entries, more than the ${LIMITS.MAX_ENTRIES} allowed.`);
  }

  const entries = [];
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (const entry of rawEntries) {
    const name = checkEntryName(entry.entryName);
    if (!name || isJunk(name)) continue;

    const type = entryFileType(entry);
    if (type === 'symlink') {
      throw new PreflightError(`The zip entry "${name}" is a symlink. Symlinks are not allowed in a DATABASE upload.`);
    }
    if (type !== 'regular' && type !== 'directory') {
      throw new PreflightError(`The zip entry "${name}" is a ${type}, not a file or a folder.`);
    }

    const size = entry.header.size || 0;
    const compressed = entry.header.compressedSize || 0;
    if (size > LIMITS.MAX_ENTRY_UNCOMPRESSED) {
      throw new PreflightError(`The zip entry "${name}" unpacks to ${Math.round(size / 1024 / 1024)} MB, more than the ${Math.round(LIMITS.MAX_ENTRY_UNCOMPRESSED / 1024 / 1024)} MB allowed for one file.`);
    }
    if (size >= LIMITS.RATIO_MIN_ENTRY_BYTES && compressed > 0 && size / compressed > LIMITS.RATIO_LIMIT) {
      throw new PreflightError(`The zip entry "${name}" expands ${Math.round(size / compressed)} times over, which looks like a zip bomb rather than shop content.`);
    }

    totalUncompressed += size;
    totalCompressed += compressed;
    if (totalUncompressed > LIMITS.MAX_TOTAL_UNCOMPRESSED) {
      throw new PreflightError(`That zip unpacks to more than ${Math.round(LIMITS.MAX_TOTAL_UNCOMPRESSED / 1024 / 1024)} MB.`);
    }

    entries.push({ name, entry, isDirectory: entry.isDirectory || type === 'directory', size });
  }

  if (!entries.length) throw new PreflightError('That zip has nothing in it but operating system junk files.');

  if (totalCompressed >= LIMITS.RATIO_MIN_TOTAL_BYTES && totalUncompressed / totalCompressed > LIMITS.RATIO_LIMIT) {
    throw new PreflightError(`That zip expands ${Math.round(totalUncompressed / totalCompressed)} times over, which looks like a zip bomb rather than shop content.`);
  }

  return { entries, stripPrefix: chooseStripPrefix(entries), totalUncompressed };
}

// Handle both a zip whose single root entry is DATABASE/ (strip it) and one that
// is already at the right level. Any single wrapping folder is stripped, because
// "MyBrand DATABASE final v3/" is the same mistake as "DATABASE/".
function chooseStripPrefix(entries) {
  const KNOWN_TOP = new Set(['design', 'shopcollections', 'presets', 'checkout', 'inventory']);
  const topLevel = new Set();
  for (const e of entries) topLevel.add(e.name.split('/')[0]);
  if (topLevel.size !== 1) return '';
  const only = [...topLevel][0];
  if (KNOWN_TOP.has(only.toLowerCase())) return '';
  // A single top-level entry that is a plain file is not a wrapper.
  const wrapsSomething = entries.some((e) => e.name.startsWith(only + '/'));
  return wrapsSomething ? only + '/' : '';
}

// Extract into destDir. destDir must not exist yet; it is created empty, so no
// symlink can already be sitting in the path we write through.
function extractZip(zipPath, destDir) {
  const inspected = inspectZip(zipPath);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });

  let fileCount = 0;
  let writtenBytes = 0;
  for (const item of inspected.entries) {
    let name = item.name;
    if (inspected.stripPrefix && name.startsWith(inspected.stripPrefix)) {
      name = name.slice(inspected.stripPrefix.length);
    } else if (inspected.stripPrefix) {
      continue; // sibling of the wrapper, already filtered by chooseStripPrefix
    }
    if (!name) continue;

    const dest = path.resolve(root, name);
    // Belt and braces: the name was already checked for traversal, but the
    // resolved target is checked too, because this is the one thing that must
    // never be wrong.
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new PreflightError(`The zip entry "${item.name}" resolves outside the upload folder.`);
    }

    if (item.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // The caps above were computed from the zip's own table of contents, which
    // the uploader wrote. This is the one that counts: the entry is inflated
    // with a hard output cap equal to whatever is LEFT of the total budget, so
    // a lying header buys nothing.
    const allowance = Math.min(LIMITS.MAX_ENTRY_UNCOMPRESSED, LIMITS.MAX_TOTAL_UNCOMPRESSED - writtenBytes);
    let data;
    try {
      data = readEntryData(item.entry, allowance);
    } catch (err) {
      if (err instanceof ZipEntryError) throw new PreflightError(err.message);
      throw err;
    }
    writtenBytes += data.length;
    fs.writeFileSync(dest, data);
    fileCount++;
  }

  if (!fileCount) throw new PreflightError('That zip contains no files.');
  return { fileCount, root, bytes: writtenBytes };
}

// ---------------------------------------------------------------------------
// Reading a DATABASE folder the way Shuttle reads it
// ---------------------------------------------------------------------------

const VARIANT_RE = /^(.+?)\s*\(([^)]+)\)\s*$/;

function parseVariantInfo(folderName) {
  const match = String(folderName).match(VARIANT_RE);
  if (!match) return null;
  return {
    baseName: match[1].trim(),
    values: match[2].split(',').map((v) => v.trim()).filter(Boolean),
  };
}

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function dirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !JUNK.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !JUNK.has(e.name)).length;
  } catch {
    return 0;
  }
}

// Build the model the diff and the validator both work from. Never holds file
// contents beyond the handful of small Details/*.txt values Shuttle itself reads.
function scanDatabase(dbRoot) {
  const model = {
    root: dbRoot,
    exists: fs.existsSync(dbRoot),
    hasDesign: fs.existsSync(path.join(dbRoot, 'Design')),
    hasShopCollections: fs.existsSync(path.join(dbRoot, 'ShopCollections')),
    hasColors: fs.existsSync(path.join(dbRoot, 'Design', 'Details', 'Colors.txt')),
    hasFonts: fs.existsSync(path.join(dbRoot, 'Design', 'Details', 'Fonts.txt')),
    hasInventory: fs.existsSync(path.join(dbRoot, 'Inventory', 'inventory.csv')),
    collections: [],
    products: new Map(),
  };
  if (!model.exists) return model;

  const collectionsDir = path.join(dbRoot, 'ShopCollections');
  for (const collection of dirNames(collectionsDir)) {
    const colDir = path.join(collectionsDir, collection);
    const products = [];
    for (const folder of dirNames(colDir)) {
      const itemDir = path.join(colDir, folder);
      const detailsDir = path.join(itemDir, 'Details');
      const variant = parseVariantInfo(folder);
      const variantTypeRaw = readTrimmed(path.join(detailsDir, 'VariantType.txt'));
      const product = {
        key: `${collection}/${folder}`,
        collection,
        folder,
        productId: `${slugify(collection)}-${slugify(folder)}`,
        name: readTrimmed(path.join(detailsDir, 'Name.txt')) || folder,
        sku: readTrimmed(path.join(detailsDir, 'SKU.txt')),
        hasDetails: fs.existsSync(detailsDir),
        photoCount: countFiles(path.join(itemDir, 'Photos')),
        variant,
        variantType: variantTypeRaw
          ? variantTypeRaw.split(',').map((v) => v.trim()).filter(Boolean)
          : null,
      };
      products.push(product);
      model.products.set(product.key, product);
    }
    model.collections.push({ name: collection, products });
  }
  return model;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Everything here is derived from how Shuttle actually parses a DATABASE.
// blocking[] is reserved for things that would break the shop build, because the
// person on the other end cannot override a block: a false block is worse than a
// warning. Everything that only degrades the result is a warning.
function validate(model, oldModel) {
  const warnings = [];
  const blocking = [];
  const variants = { new_groups: [], broken: [] };

  if (!model.hasShopCollections) {
    blocking.push('There is no ShopCollections folder at the top level of the zip. Zip the DATABASE folder itself, or its contents, not the folder above it.');
  }
  if (!model.hasDesign) {
    blocking.push('There is no Design folder at the top level of the zip. Every DATABASE has one, so this zip is almost certainly from the wrong folder level.');
  }
  if (model.hasShopCollections && model.collections.length === 0) {
    blocking.push('ShopCollections has no collection folders in it, so the shop would have nothing to sell.');
  }

  if (model.hasDesign && !model.hasColors) {
    warnings.push('Design/Details/Colors.txt is missing, so the shop will fall back to the default palette.');
  }
  if (model.hasDesign && !model.hasFonts) {
    warnings.push('Design/Details/Fonts.txt is missing, so the shop will fall back to the default fonts.');
  }

  // Product ID collisions genuinely break the catalog: two folders that slugify
  // to the same id fight over the same product route and the same inventory row.
  const byProductId = new Map();
  for (const product of model.products.values()) {
    if (!product.productId || product.productId === '-') {
      blocking.push(`"${product.key}" has no letters or numbers in its folder name, so Shuttle cannot build a product address for it.`);
      continue;
    }
    if (byProductId.has(product.productId)) {
      blocking.push(`"${product.key}" and "${byProductId.get(product.productId)}" both become the product address "${product.productId}", so one would hide the other.`);
    } else {
      byProductId.set(product.productId, product.key);
    }
  }

  const missingSku = [];
  const emptyPhotos = [];
  const skuOwners = new Map();
  for (const product of model.products.values()) {
    if (!product.sku) missingSku.push(product.key);
    else if (skuOwners.has(product.sku)) {
      warnings.push(`"${product.key}" and "${skuOwners.get(product.sku)}" share the SKU ${product.sku}, so orders and stock for them cannot be told apart.`);
    } else skuOwners.set(product.sku, product.key);
    if (product.photoCount === 0) emptyPhotos.push(product.key);
  }
  if (missingSku.length) {
    warnings.push(`${missingSku.length} product${missingSku.length === 1 ? '' : 's'} have no Details/SKU.txt, starting with ${missingSku.slice(0, 3).join(', ')}. They will still show, but stock cannot be tracked for them.`);
  }
  if (emptyPhotos.length) {
    warnings.push(`${emptyPhotos.length} product${emptyPhotos.length === 1 ? '' : 's'} have no photos, starting with ${emptyPhotos.slice(0, 3).join(', ')}.`);
  }

  for (const collection of model.collections) {
    if (collection.products.length === 0) {
      warnings.push(`Collection "${collection.name}" has no products in it.`);
    }
  }

  analyseVariants(model, oldModel, variants, warnings);

  return { warnings, blocking, variants };
}

// Grouping rule, straight from Shuttle's catalog.ts: 2 or more sibling folders in
// the same collection sharing a base name are a variant group. One folder with
// parentheses is a plain product, which is correct behavior, so it is a warning
// at most and never a block.
function analyseVariants(model, oldModel, variants, warnings) {
  const oldGroups = new Set();
  if (oldModel) {
    for (const group of variantGroups(oldModel).keys()) oldGroups.add(group);
  }

  for (const [groupKey, members] of variantGroups(model)) {
    if (members.length < 2) {
      const only = members[0];
      warnings.push(`"${only.folder}" in ${only.collection} is written like a variant but nothing else in that collection shares the name "${only.variant.baseName}", so it will show as a single product.`);
      continue;
    }

    const arities = new Set(members.map((m) => m.variant.values.length));
    const declared = members.map((m) => m.variantType).filter(Boolean);
    const dimensions = declared.length
      ? declared[0]
      : (members[0].variant.values.length === 2 ? ['Color', 'Size'] : ['Color']);

    if (!oldGroups.has(groupKey)) {
      const firstValues = [...new Set(members.map((m) => m.variant.values[0]))];
      variants.new_groups.push(`${groupKey} (${dimensions.join(', ')}): ${firstValues.join(', ')}`);
    }

    if (arities.size > 1) {
      variants.broken.push({
        group: groupKey,
        why: `Its folders do not all list the same number of values (${[...arities].sort().join(' and ')}), so the picker cannot line them up.`,
      });
    }
    const distinctDeclared = new Set(declared.map((d) => d.join(', ')));
    if (distinctDeclared.size > 1) {
      variants.broken.push({
        group: groupKey,
        why: `Its folders disagree about what the dimensions are called (${[...distinctDeclared].join(' / ')}) in Details/VariantType.txt.`,
      });
    }
    if (declared.length && declared[0].length !== members[0].variant.values.length && arities.size === 1) {
      variants.broken.push({
        group: groupKey,
        why: `Details/VariantType.txt names ${declared[0].length} dimension(s) but the folder names carry ${members[0].variant.values.length}.`,
      });
    }
    const noSku = members.filter((m) => !m.sku);
    if (noSku.length) {
      variants.broken.push({
        group: groupKey,
        why: `${noSku.length} of ${members.length} variants have no Details/SKU.txt, so stock cannot be tracked per variant.`,
      });
    }
  }
}

// Map of "Collection/BaseName" -> members, for every folder that parses as a
// variant. Groups of one are included so the lonely-sibling warning can be made.
function variantGroups(model) {
  const groups = new Map();
  for (const collection of model.collections) {
    for (const product of collection.products) {
      if (!product.variant) continue;
      const key = `${collection.name}/${product.variant.baseName}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const s = a.length > 120 ? a.slice(0, 120) : a;
  const t = b.length > 120 ? b.slice(0, 120) : b;
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev; prev = curr; curr = swap;
  }
  return prev[t.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

// A rename should read as a rename, not as an add plus a remove. SKU first,
// because a SKU is an identity the person actually maintains; base-name
// similarity second, for the products that have no SKU yet.
function detectRenames(oldProducts, newProducts, warnings) {
  const removed = new Map(oldProducts);
  const added = new Map(newProducts);
  const renamed = [];

  // Pass 1: SKU. Only SKUs that are unique on both sides can identify anything.
  const oldBySku = uniqueBySku(removed);
  const newBySku = uniqueBySku(added);
  for (const [sku, oldProduct] of oldBySku) {
    const newProduct = newBySku.get(sku);
    if (!newProduct) continue;
    if (oldProduct.key === newProduct.key) continue;
    renamed.push({ from: oldProduct.key, to: newProduct.key, sku, matched_by: 'sku' });
    removed.delete(oldProduct.key);
    added.delete(newProduct.key);
  }

  // Pass 2: base-name similarity, greedy on the best score.
  if (removed.size && added.size) {
    if (removed.size * added.size > LIMITS.MAX_RENAME_PAIRS) {
      warnings.push(`Too many products changed at once to check for renames by name (${removed.size} removed against ${added.size} added), so some renames may be listed as one removal and one addition.`);
    } else {
      const pairs = [];
      for (const oldProduct of removed.values()) {
        for (const newProduct of added.values()) {
          const sameCollection = oldProduct.collection === newProduct.collection;
          const score = similarity(oldProduct.folder.toLowerCase(), newProduct.folder.toLowerCase());
          const floor = sameCollection
            ? LIMITS.SIMILARITY_SAME_COLLECTION
            : LIMITS.SIMILARITY_CROSS_COLLECTION;
          if (score >= floor) pairs.push({ score, oldProduct, newProduct });
        }
      }
      pairs.sort((a, b) => b.score - a.score);
      for (const pair of pairs) {
        if (!removed.has(pair.oldProduct.key) || !added.has(pair.newProduct.key)) continue;
        renamed.push({
          from: pair.oldProduct.key,
          to: pair.newProduct.key,
          sku: pair.newProduct.sku || null,
          matched_by: 'name',
        });
        removed.delete(pair.oldProduct.key);
        added.delete(pair.newProduct.key);
      }
    }
  }

  return { added: [...added.keys()].sort(), removed: [...removed.keys()].sort(), renamed };
}

function uniqueBySku(products) {
  const counts = new Map();
  for (const product of products.values()) {
    if (!product.sku) continue;
    counts.set(product.sku, (counts.get(product.sku) || 0) + 1);
  }
  const unique = new Map();
  for (const product of products.values()) {
    if (product.sku && counts.get(product.sku) === 1) unique.set(product.sku, product);
  }
  return unique;
}

function cap(list, label, warnings) {
  if (list.length <= LIMITS.MAX_LIST) return list;
  warnings.push(`Only the first ${LIMITS.MAX_LIST} ${label} are listed here; ${list.length - LIMITS.MAX_LIST} more are not shown.`);
  return list.slice(0, LIMITS.MAX_LIST);
}

// The ADR section 4b shape, exactly. Never the whole catalog, never photo bytes.
function buildDiff(oldModel, newModel, willBackupTo) {
  const { warnings, blocking, variants } = validate(newModel, oldModel);

  const oldOnly = new Map();
  const newOnly = new Map();
  for (const [key, product] of oldModel.products) {
    if (!newModel.products.has(key)) oldOnly.set(key, product);
  }
  for (const [key, product] of newModel.products) {
    if (!oldModel.products.has(key)) newOnly.set(key, product);
  }
  const changes = detectRenames(oldOnly, newOnly, warnings);

  if (oldModel.exists && oldModel.products.size && newModel.products.size === 0) {
    blocking.push('This zip has no products at all, and the shop currently has ' + oldModel.products.size + '. Applying it would empty the shop.');
  }
  if (oldModel.hasInventory && !newModel.hasInventory) {
    warnings.push('The zip has no Inventory/inventory.csv, so the stock counts currently on the shop will be kept as they are.');
  }
  if (newModel.hasInventory) {
    warnings.push('The zip includes Inventory/inventory.csv, so the stock counts currently on the shop will be replaced by the ones in the zip.');
  }

  return {
    products: {
      added: cap(changes.added, 'added products', warnings),
      removed: cap(changes.removed, 'removed products', warnings),
      renamed: cap(changes.renamed, 'renamed products', warnings),
    },
    variants: {
      new_groups: cap(variants.new_groups, 'new variant groups', warnings),
      broken: cap(variants.broken, 'broken variant groups', warnings),
    },
    warnings,
    blocking,
    will_backup_to: willBackupTo,
  };
}

// ---------------------------------------------------------------------------
// Staging, apply, rollback
// ---------------------------------------------------------------------------

function shopPaths(slug, shopsDir) {
  const base = shopsDir || DEFAULT_SHOPS_DIR;
  const shopDir = path.join(base, slug);
  return {
    shopsDir: base,
    shopDir,
    live: path.join(shopDir, 'DATABASE'),
    stagingRoot: path.join(shopDir, '.staging'),
    backupsRoot: path.join(shopDir, '.backups'),
  };
}

function backupStamp(date) {
  // ISO, colon-free so the filename is portable, and still sorting
  // lexicographically into chronological order.
  return date.toISOString().replace(/:/g, '-');
}

// If the process died between the two renames of a swap, the shop has no
// DATABASE but the old one is parked right next to it. Put it back. Called at
// the top of every entry point, and exported so health.js can call it too.
function recoverInterruptedApply(slug, shopsDir) {
  const p = shopPaths(slug, shopsDir);
  if (!fs.existsSync(p.shopDir)) return null;
  if (fs.existsSync(p.live)) return null;
  const parked = fs.readdirSync(p.shopDir)
    .filter((n) => n.startsWith('.DATABASE.replacing-'))
    .sort();
  if (!parked.length) return null;
  const restore = path.join(p.shopDir, parked[parked.length - 1]);
  fs.renameSync(restore, p.live);
  for (const stale of parked.slice(0, -1)) {
    fs.rmSync(path.join(p.shopDir, stale), { recursive: true, force: true });
  }
  return parked[parked.length - 1];
}

// The only way the live DATABASE is ever replaced: two adjacent renames, with a
// verified backup already on disk before either of them runs.
function swapInPlace(shopDir, incomingDir) {
  const live = path.join(shopDir, 'DATABASE');
  const parked = path.join(shopDir, `.DATABASE.replacing-${backupStamp(new Date())}`);
  const hadLive = fs.existsSync(live);
  if (hadLive) fs.renameSync(live, parked);
  try {
    fs.renameSync(incomingDir, live);
  } catch (err) {
    if (hadLive && fs.existsSync(parked) && !fs.existsSync(live)) fs.renameSync(parked, live);
    throw err;
  }
  if (hadLive) fs.rmSync(parked, { recursive: true, force: true });
}

function zipDirectory(sourceDir, destZip) {
  const zip = new AdmZip();
  // Returns how many entries this folder contributed, so a folder that would
  // otherwise vanish from the backup (an empty Photos/, say) gets an explicit
  // directory entry. A rollback has to give back the same tree, not a tree with
  // the empty folders quietly removed.
  (function walk(dir, base) {
    let added = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Same exclusions as the existing database export: the launch lock and
      // half-written temp files are not shop content.
      if (entry.name === '.db.lock' || entry.name.endsWith('.tmp') || JUNK.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow a link out of the folder
      if (entry.isDirectory()) added += walk(full, rel);
      else if (entry.isFile()) { zip.addFile(rel, fs.readFileSync(full)); added++; }
    }
    if (added === 0 && base) { zip.addFile(base + '/', Buffer.alloc(0)); return 1; }
    return added;
  })(sourceDir, '');

  // Write to a temp name and rename, so a half-written backup is never mistaken
  // for a good one by rollback or by retention.
  const tmp = `${destZip}.tmp`;
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  zip.writeZip(tmp);
  const bytes = fs.statSync(tmp).size;
  if (!bytes) {
    fs.unlinkSync(tmp);
    throw new Error('Backup zip came out empty.');
  }
  fs.renameSync(tmp, destZip);
  return bytes;
}

// Copy forward the server-managed folders the zip did not carry, onto the
// staging tree, BEFORE the swap. That keeps the swap a single atomic rename of a
// tree that is already exactly what the shop should end up with.
function carryForward(liveDb, stagedDb) {
  const carried = [];
  if (!fs.existsSync(liveDb)) return carried;
  for (const name of CARRY_FORWARD) {
    const from = path.join(liveDb, name);
    const to = path.join(stagedDb, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.cpSync(from, to, { recursive: true });
    carried.push(name);
  }
  return carried;
}

function readMeta(stagingDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stagingDir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

const STAGING_ID_RE = /^[0-9A-Za-z._-]{1,80}$/;
const BACKUP_ID_RE = /^[0-9A-Za-z._-]{1,120}\.zip$/;

// The character class above happily accepts "." and "..", which path.join
// resolves to .staging and to the shop folder itself. discardStaging then
// rm -rf'd whatever that came out to. One check, used by every route that takes
// a staging id, so apply and rollback are safe on purpose rather than by luck.
function isSafeStagingId(stagingId) {
  const id = String(stagingId == null ? '' : stagingId);
  if (!STAGING_ID_RE.test(id)) return false;
  return !id.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function assertStagingId(stagingId) {
  if (isSafeStagingId(stagingId)) return String(stagingId);
  const err = new Error('That staging id is not one this server issued.');
  err.code = 'PREFLIGHT_FAILED';
  throw err;
}

// Resolve a staging id to a directory, or return null. A staging is only ever a
// direct child of the shop's .staging folder, and it only counts as a staging
// when its meta.json is there and names this shop. Nothing destructive in this
// module runs on a directory that has not been through here.
function resolveStagingDir({ slug, stagingId, shopsDir }) {
  if (!isSafeStagingId(stagingId)) return null;
  const p = shopPaths(slug, shopsDir);
  const stagingRoot = path.resolve(p.stagingRoot);
  const dir = path.resolve(stagingRoot, String(stagingId));
  if (path.dirname(dir) !== stagingRoot) return null;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const meta = readMeta(dir);
  if (!meta || meta.shop !== slug) return null;
  return { dir, meta, stagingRoot };
}

// stage_database: unzip into shops/<slug>/.staging/<id>/, validate, return the
// diff. NEVER into the live DATABASE.
function stageDatabase({ slug, zipPath, userId, ticketId, shopsDir }) {
  const p = shopPaths(slug, shopsDir);
  recoverInterruptedApply(slug, shopsDir);
  if (!fs.existsSync(p.shopDir)) {
    const err = new Error(`There is no shop folder for "${slug}" on this server.`);
    err.code = 'NO_SUCH_SHOP';
    throw err;
  }

  pruneStagings(slug, shopsDir);

  const now = new Date();
  const stagingId = `${backupStamp(now)}-${crypto.randomBytes(4).toString('hex')}`;
  const stagingDir = path.join(p.stagingRoot, stagingId);
  const stagedDb = path.join(stagingDir, 'DATABASE');
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const extracted = extractZip(zipPath, stagedDb);
    const oldModel = scanDatabase(p.live);
    const newModel = scanDatabase(stagedDb);
    const willBackupTo = path.posix.join('shops', slug, '.backups', `${backupStamp(now)}.zip`);
    const diff = buildDiff(oldModel, newModel, willBackupTo);

    const meta = {
      staging_id: stagingId,
      shop: slug,
      user_id: userId || null,
      ticket_id: ticketId || null,
      created_at: now.toISOString(),
      backup_id: `${backupStamp(now)}.zip`,
      files: extracted.fileCount,
      bytes: extracted.bytes,
      diff,
    };
    fs.writeFileSync(path.join(stagingDir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { staging_id: stagingId, diff, meta };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

// apply_database: back the current DATABASE up first, then swap the staging in.
// Refuses if the staging has anything in blocking[].
function applyDatabase({ slug, stagingId, shopsDir }) {
  const p = shopPaths(slug, shopsDir);
  recoverInterruptedApply(slug, shopsDir);
  assertStagingId(stagingId);
  const resolved = resolveStagingDir({ slug, stagingId, shopsDir });
  if (!resolved) {
    const err = new Error(`There is no staged upload "${stagingId}" for "${slug}".`);
    err.code = 'PREFLIGHT_FAILED';
    throw err;
  }
  const stagingDir = resolved.dir;
  const meta = resolved.meta;
  const stagedDb = path.join(stagingDir, 'DATABASE');
  if (!fs.existsSync(stagedDb)) {
    const err = new Error(`There is no staged upload "${stagingId}" for "${slug}".`);
    err.code = 'PREFLIGHT_FAILED';
    throw err;
  }
  if (!meta.diff || !Array.isArray(meta.diff.blocking)) {
    const err = new Error(`The staged upload "${stagingId}" is missing its record of what changed.`);
    err.code = 'PREFLIGHT_FAILED';
    throw err;
  }
  if (meta.diff.blocking.length) {
    const err = new Error(meta.diff.blocking[0]);
    err.code = 'STAGING_BLOCKED';
    err.blocking = meta.diff.blocking;
    throw err;
  }

  const carried = carryForward(p.live, stagedDb);

  // The backup is on disk, complete and renamed into place, before anything
  // touches the live folder.
  let backupId = meta.backup_id;
  let backupPath = path.join(p.backupsRoot, backupId);
  let suffix = 2;
  while (fs.existsSync(backupPath)) {
    backupId = meta.backup_id.replace(/\.zip$/, `-${suffix}.zip`);
    backupPath = path.join(p.backupsRoot, backupId);
    suffix++;
  }
  let backupBytes = 0;
  if (fs.existsSync(p.live)) {
    backupBytes = zipDirectory(p.live, backupPath);
  } else {
    backupId = null;
    backupPath = null;
  }

  swapInPlace(p.shopDir, stagedDb);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const pruned = pruneBackups(slug, shopsDir, backupId);

  return {
    backup_id: backupId,
    backup_bytes: backupBytes,
    staging_id: stagingId,
    carried_forward: carried,
    pruned_backups: pruned,
  };
}

// rollback_database: restore, default latest.
function rollbackDatabase({ slug, backupId, shopsDir }) {
  const p = shopPaths(slug, shopsDir);
  recoverInterruptedApply(slug, shopsDir);
  const backups = listBackups({ slug, shopsDir });
  if (!backups.length) {
    const err = new Error(`There are no backups of "${slug}" to roll back to.`);
    err.code = 'PREFLIGHT_FAILED';
    throw err;
  }
  let target = backups[0];
  if (backupId) {
    if (!BACKUP_ID_RE.test(String(backupId))) {
      const err = new Error('That backup id is not one this server issued.');
      err.code = 'PREFLIGHT_FAILED';
      throw err;
    }
    target = backups.find((b) => b.id === backupId);
    if (!target) {
      const err = new Error(`There is no backup "${backupId}" for "${slug}".`);
      err.code = 'PREFLIGHT_FAILED';
      throw err;
    }
  }

  const restoreDir = path.join(p.stagingRoot, `.restore-${backupStamp(new Date())}-${crypto.randomBytes(3).toString('hex')}`);
  const restoreDb = path.join(restoreDir, 'DATABASE');
  fs.mkdirSync(restoreDir, { recursive: true });
  try {
    extractZip(path.join(p.backupsRoot, target.id), restoreDb);

    // A rollback is itself a change, so it gets a backup too. Otherwise rolling
    // back by mistake is the one move in this pipeline with no way out.
    let safetyId = null;
    if (fs.existsSync(p.live)) {
      safetyId = `${backupStamp(new Date())}.zip`;
      let safetyPath = path.join(p.backupsRoot, safetyId);
      let suffix = 2;
      while (fs.existsSync(safetyPath)) {
        safetyId = safetyId.replace(/(-\d+)?\.zip$/, `-${suffix}.zip`);
        safetyPath = path.join(p.backupsRoot, safetyId);
        suffix++;
      }
      zipDirectory(p.live, safetyPath);
    }

    swapInPlace(p.shopDir, restoreDb);
    fs.rmSync(restoreDir, { recursive: true, force: true });
    // Never prune the backup that was just restored from, or the safety copy.
    const pruned = pruneBackups(slug, shopsDir, target.id, safetyId);
    return { restored_from: target.id, backup_id: safetyId, pruned_backups: pruned };
  } catch (err) {
    fs.rmSync(restoreDir, { recursive: true, force: true });
    throw err;
  }
}

function listBackups({ slug, shopsDir }) {
  const p = shopPaths(slug, shopsDir);
  if (!fs.existsSync(p.backupsRoot)) return [];
  return fs.readdirSync(p.backupsRoot)
    .filter((n) => n.endsWith('.zip'))
    .map((id) => {
      const stat = fs.statSync(path.join(p.backupsRoot, id));
      return { id, bytes: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first, ids sort chronologically
}

// Retention of five per shop, oldest pruned on apply.
function pruneBackups(slug, shopsDir, ...keep) {
  const p = shopPaths(slug, shopsDir);
  const protectedIds = new Set(keep.filter(Boolean));
  const backups = listBackups({ slug, shopsDir });
  const pruned = [];
  for (const backup of backups.slice(LIMITS.BACKUP_RETENTION)) {
    if (protectedIds.has(backup.id)) continue;
    try {
      fs.unlinkSync(path.join(p.backupsRoot, backup.id));
      pruned.push(backup.id);
    } catch { /* best-effort */ }
  }
  return pruned;
}

// A staged upload is up to half a gigabyte sitting in the shop folder. Stagings
// nobody applied are swept after a week so an abandoned review does not quietly
// fill the droplet.
const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function pruneStagings(slug, shopsDir) {
  const p = shopPaths(slug, shopsDir);
  if (!fs.existsSync(p.stagingRoot)) return [];
  const cutoff = Date.now() - STAGING_MAX_AGE_MS;
  const pruned = [];
  for (const name of fs.readdirSync(p.stagingRoot)) {
    const dir = path.join(p.stagingRoot, name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      pruned.push(name);
    } catch { /* best-effort */ }
  }
  return pruned;
}

function listStagings({ slug, shopsDir }) {
  const p = shopPaths(slug, shopsDir);
  if (!fs.existsSync(p.stagingRoot)) return [];
  return fs.readdirSync(p.stagingRoot)
    .filter((n) => !n.startsWith('.'))
    .map((id) => readMeta(path.join(p.stagingRoot, id)))
    .filter(Boolean)
    .map((meta) => ({
      staging_id: meta.staging_id,
      created_at: meta.created_at,
      user_id: meta.user_id,
      files: meta.files,
      blocking: meta.diff.blocking.length,
      warnings: meta.diff.warnings.length,
    }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function getStaging({ slug, stagingId, shopsDir }) {
  const resolved = resolveStagingDir({ slug, stagingId, shopsDir });
  return resolved ? resolved.meta : null;
}

function discardStaging({ slug, stagingId, shopsDir }) {
  // resolveStagingDir is the whole guard: a safe id, a direct child of this
  // shop's .staging folder, and a meta.json that names this shop. Anything else
  // is not a staging and is never deleted.
  const resolved = resolveStagingDir({ slug, stagingId, shopsDir });
  if (!resolved) return false;
  fs.rmSync(resolved.dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// platform.db bookkeeping. The filesystem is the source of truth (meta.json
// travels with the staged folder); these rows exist so the UI and the MCP can
// list and audit without walking every shop directory.
// ---------------------------------------------------------------------------

let _tablesReady = false;
function db() {
  const { db: handle } = require('./platform-db');
  if (!_tablesReady) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS database_stagings (
        id TEXT PRIMARY KEY,
        shop_slug TEXT NOT NULL,
        user_id INTEGER,
        ticket_id TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'staged',
        blocking_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        diff_json TEXT NOT NULL,
        applied_at INTEGER,
        backup_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_database_stagings_shop ON database_stagings(shop_slug);
    `);
    _tablesReady = true;
  }
  return handle;
}

function recordStagingRow({ stagingId, slug, userId, ticketId, diff }) {
  db().prepare(`
    INSERT OR REPLACE INTO database_stagings
      (id, shop_slug, user_id, ticket_id, created_at, status, blocking_count, warning_count, diff_json)
    VALUES (?, ?, ?, ?, ?, 'staged', ?, ?, ?)
  `).run(stagingId, slug, userId || null, ticketId || null, Date.now(),
    diff.blocking.length, diff.warnings.length, JSON.stringify(diff));
}

function markStagingStatus(stagingId, status, backupId) {
  db().prepare('UPDATE database_stagings SET status = ?, applied_at = ?, backup_id = ? WHERE id = ?')
    .run(status, Date.now(), backupId || null, stagingId);
}

// ---------------------------------------------------------------------------
// Routes. Mounted on /api/shops inside the requireAuth + CSRF tree.
// ---------------------------------------------------------------------------

const router = express.Router();

const { isLegacyShop, refuseLegacy } = require('./upload-ticket');

function guardShop(req, res, next) {
  if (isLegacyShop(req.params.slug)) return refuseLegacy(res, req.params.slug);
  return next();
}

function handleFailure(res, slug, err) {
  const { refuse } = authz();
  if (err && err.code === 'SHOP_BUSY') {
    return refuse(res, 409, 'SHOP_BUSY',
      `Someone else is working on "${slug}" right now (${err.action}).`,
      'Wait for that to finish and try again.', true);
  }
  if (err && err.code === 'STAGING_BLOCKED') {
    return refuse(res, 409, 'STAGING_BLOCKED',
      `This upload cannot be applied yet: ${err.blocking[0]}`,
      'Fix that in the DATABASE folder, zip it again and upload it again.', true);
  }
  if (err && err.code === 'NO_SUCH_SHOP') {
    return refuse(res, 404, 'NO_SUCH_SHOP', err.message,
      'Check the shop name, or ask an admin whether it still exists.', false);
  }
  if (err && err.code === 'PREFLIGHT_FAILED') {
    return refuse(res, 400, 'PREFLIGHT_FAILED', err.message,
      'Fix that and upload the zip again.', true);
  }
  throw err;
}

// POST /api/shops/:slug/database/stage  { ticket }
// Normally the upload route stages as part of the same request. This exists for
// the case where the bytes landed but staging did not finish.
router.post('/:slug/database/stage', guardShop, requireRole('editor'), async (req, res) => {
  const { audit, refuse, withShopLock } = authz();
  const { slug } = req.params;
  const { getTicketByRaw } = require('./upload-ticket');
  const row = getTicketByRaw((req.body || {}).ticket);

  if (!row || row.shop_slug !== slug) {
    return refuse(res, 401, 'TICKET_INVALID', 'That upload ticket is not valid for this shop.',
      'Call request_upload for this shop to get a fresh ticket.', true);
  }
  if (row.staging_id) {
    const meta = getStaging({ slug, stagingId: row.staging_id });
    if (meta) return res.json({ shop: slug, staging_id: meta.staging_id, diff: meta.diff });
  }
  if (!row.upload_path || !fs.existsSync(row.upload_path)) {
    return refuse(res, 400, 'PREFLIGHT_FAILED', 'Nothing was uploaded against that ticket, or the upload has already been cleaned up.',
      'Call request_upload for a new ticket and upload the zip again.', true);
  }

  try {
    // withShopLock is async. Without the await, `result` is a Promise, the
    // spread below produces an empty object and the staged upload is recorded
    // with an undefined id while the work is still running.
    const result = await withShopLock(slug, req.session.user.id, 'stage_database', () => (
      stageDatabase({ slug, zipPath: row.upload_path, userId: row.user_id, ticketId: row.id })
    ));
    require('./upload-ticket').recordStaging(row.id, result.staging_id);
    recordStagingRow({ stagingId: result.staging_id, slug, userId: row.user_id, ticketId: row.id, diff: result.diff });
    const audit_id = audit(req, 'database_staged', {
      shop_slug: slug, staging_id: result.staging_id,
      blocking: result.diff.blocking.length, warnings: result.diff.warnings.length,
    });
    return res.json({ shop: slug, staging_id: result.staging_id, diff: result.diff, audit_id });
  } catch (err) {
    return handleFailure(res, slug, err);
  }
});

// GET /api/shops/:slug/database/stagings
router.get('/:slug/database/stagings', requireRole('viewer'), (req, res) => {
  res.json({ shop: req.params.slug, stagings: listStagings({ slug: req.params.slug }) });
});

// GET /api/shops/:slug/database/stagings/:stagingId
router.get('/:slug/database/stagings/:stagingId', requireRole('viewer'), (req, res) => {
  const { refuse } = authz();
  const meta = getStaging({ slug: req.params.slug, stagingId: req.params.stagingId });
  if (!meta) {
    return refuse(res, 404, 'PREFLIGHT_FAILED', 'There is no staged upload by that name for this shop.',
      'List the staged uploads for this shop to see what is waiting.', true);
  }
  return res.json({ shop: req.params.slug, staging_id: meta.staging_id, created_at: meta.created_at, diff: meta.diff });
});

// DELETE /api/shops/:slug/database/stagings/:stagingId
router.delete('/:slug/database/stagings/:stagingId', requireRole('editor'), (req, res) => {
  const { audit } = authz();
  const removed = discardStaging({ slug: req.params.slug, stagingId: req.params.stagingId });
  const audit_id = removed
    ? audit(req, 'database_staging_discarded', { shop_slug: req.params.slug, staging_id: req.params.stagingId })
    : null;
  res.json({ shop: req.params.slug, discarded: removed, audit_id });
});

// POST /api/shops/:slug/database/apply  { staging_id }
router.post('/:slug/database/apply', guardShop, requireRole('editor'), async (req, res) => {
  const { audit, withShopLock } = authz();
  const { slug } = req.params;
  const stagingId = (req.body || {}).staging_id;
  try {
    const result = await withShopLock(slug, req.session.user.id, 'apply_database', () => (
      applyDatabase({ slug, stagingId })
    ));
    markStagingStatus(stagingId, 'applied', result.backup_id);
    const audit_id = audit(req, 'database_applied', {
      shop_slug: slug, staging_id: stagingId, backup_id: result.backup_id,
      carried_forward: result.carried_forward, pruned_backups: result.pruned_backups,
    });
    return res.json({ shop: slug, ...result, audit_id });
  } catch (err) {
    if (err && err.code === 'STAGING_BLOCKED') {
      audit(req, 'database_apply_refused', { shop_slug: slug, staging_id: stagingId, blocking: err.blocking });
    }
    return handleFailure(res, slug, err);
  }
});

// POST /api/shops/:slug/database/rollback  { backup_id? }
router.post('/:slug/database/rollback', guardShop, requireRole('editor'), async (req, res) => {
  const { audit, withShopLock } = authz();
  const { slug } = req.params;
  const backupId = (req.body || {}).backup_id || null;
  try {
    const result = await withShopLock(slug, req.session.user.id, 'rollback_database', () => (
      rollbackDatabase({ slug, backupId })
    ));
    const audit_id = audit(req, 'database_rolled_back', {
      shop_slug: slug, restored_from: result.restored_from, backup_id: result.backup_id,
    });
    return res.json({ shop: slug, ...result, audit_id });
  } catch (err) {
    return handleFailure(res, slug, err);
  }
});

// GET /api/shops/:slug/database/backups
router.get('/:slug/database/backups', requireRole('viewer'), (req, res) => {
  res.json({
    shop: req.params.slug,
    retention: LIMITS.BACKUP_RETENTION,
    backups: listBackups({ slug: req.params.slug }),
  });
});

// Thin wrapper so the role name sits next to the route it guards, while the
// actual check stays agent A's.
function requireRole(minRole) {
  return (req, res, next) => authz().requireShopAccess(minRole)(req, res, next);
}

module.exports = {
  router,
  // pipeline
  stageDatabase,
  applyDatabase,
  rollbackDatabase,
  listBackups,
  listStagings,
  pruneStagings,
  getStaging,
  discardStaging,
  isSafeStagingId,
  resolveStagingDir,
  recoverInterruptedApply,
  recordStagingRow,
  markStagingStatus,
  // pieces, exported for the tests and for reuse
  inspectZip,
  extractZip,
  scanDatabase,
  buildDiff,
  validate,
  parseVariantInfo,
  detectRenames,
  zipDirectory,
  PreflightError,
  LIMITS,
  CARRY_FORWARD,
};
