const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');

const { checkShopPermission } = require('./users');
const { requireUnlocked } = require('./lock');
const { renameCollectionInCsv, renameItemInCsv } = require('./inventory');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');

// Parse a path under DATABASE/ShopCollections to figure out whether a rename
// affects the inventory.csv (collection rename, item rename, or item move).
// Returns one of:
//   { type: 'collection', name }
//   { type: 'item', collection, item }
//   { type: 'photo' | 'other' }
function classifyCollectionPath(relPath) {
  const parts = relPath.split('/').filter(Boolean);
  if (parts[0] !== 'DATABASE' || parts[1] !== 'ShopCollections') {
    return { type: 'other' };
  }
  if (parts.length === 3) return { type: 'collection', name: parts[2] };
  if (parts.length === 4) return { type: 'item', collection: parts[2], item: parts[3] };
  return { type: 'photo' };
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB per file

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tmpDir = path.join(__dirname, '..', 'data', 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

function safeShopPath(slug, relPath) {
  const shopDir = path.resolve(SHOPS_DIR, slug);
  const resolved = path.resolve(shopDir, relPath || '.');
  if (!resolved.startsWith(shopDir + path.sep) && resolved !== shopDir) {
    return null;
  }
  return resolved;
}

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.env',
  '.yml', '.yaml', '.css', '.html', '.htm', '.xml', '.sh', '.mjs',
  '.cjs', '.toml', '.ini', '.conf', '.config', '.lock', '.gitignore',
  '.dockerfile', '.csv', '.svg',
]);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.ico', '.bmp', '.avif',
]);

const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.avif': 'image/avif',
};

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return base === 'dockerfile' || base === 'makefile' || base === '.env';
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// GET /api/shops/:slug/files?path=subdir
router.get('/:slug/files', (req, res) => {
  const { slug } = req.params;
  const relPath = req.query.path || '.';
  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Path is not a directory' });
  }

  const SKIP = new Set(['.git', 'node_modules', '.next']);
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(e => !SKIP.has(e.name))
    .map(e => {
      const childPath = path.join(resolved, e.name);
      const childStat = fs.statSync(childPath);
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        size: e.isDirectory() ? null : childStat.size,
        modified: childStat.mtime.toISOString(),
        readable: !e.isDirectory() && isTextFile(e.name),
        isImage: !e.isDirectory() && isImageFile(e.name),
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const shopDir = path.resolve(SHOPS_DIR, slug);
  const currentRelPath = path.relative(shopDir, resolved) || '.';

  res.json({ path: currentRelPath, entries });
});

// GET /api/shops/:slug/files/read?path=file.txt
router.get('/:slug/files/read', (req, res) => {
  const { slug } = req.params;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });

  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
  if (stat.size > 500 * 1024) return res.status(400).json({ error: 'File too large to edit (>500KB)' });
  if (!isTextFile(resolved)) return res.status(400).json({ error: 'Binary file cannot be edited' });

  const content = fs.readFileSync(resolved, 'utf8');
  res.json({ path: relPath, content });
});

// GET /api/shops/:slug/files/image?path=photo.jpg
router.get('/:slug/files/image', (req, res) => {
  const { slug } = req.params;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });

  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });

  const ext = path.extname(resolved).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=60');
  fs.createReadStream(resolved).pipe(res);
});

// PUT /api/shops/:slug/files/write?path=file.txt (requires can_edit_ui)
router.put('/:slug/files/write', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });

  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (!isTextFile(resolved)) return res.status(400).json({ error: 'Binary file cannot be written' });

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  req.app.locals.auditLog?.('file_written', { req, details: { slug, path: relPath } });
  res.json({ message: 'File saved', path: relPath });
});

// DELETE /api/shops/:slug/files?path=file.txt (requires can_delete)
router.delete('/:slug/files', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_delete')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });
  // Prevent deleting the root shop directory itself
  if (relPath === '.' || relPath === '') return res.status(400).json({ error: 'Cannot delete root directory' });

  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true });
  } else {
    fs.unlinkSync(resolved);
  }
  req.app.locals.auditLog?.('file_deleted', { req, details: { slug, path: relPath, isDirectory: stat.isDirectory() } });
  res.json({ message: 'Deleted', path: relPath });
});

// POST /api/shops/:slug/files/upload-zip?path=DATABASE
const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tmpDir = path.join(__dirname, '..', 'data', 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (req, file, cb) => {
      cb(null, `zip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

const MAX_ZIP_EXTRACTED_SIZE = 500 * 1024 * 1024; // 500MB max uncompressed

router.post('/:slug/files/upload-zip', requireUnlocked, uploadZip.single('file'), (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const relPath = req.query.path || 'DATABASE';
  const shopDir = path.resolve(SHOPS_DIR, slug);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    // Zip bomb protection: check total uncompressed size
    let totalSize = 0;
    for (const entry of entries) {
      totalSize += entry.header.size;
      if (totalSize > MAX_ZIP_EXTRACTED_SIZE) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `Zip uncompressed size exceeds ${MAX_ZIP_EXTRACTED_SIZE / 1024 / 1024}MB limit` });
      }
    }

    // Delete the existing target folder entirely so the zip fully replaces it
    const targetDir = path.join(shopDir, relPath);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });

    // Determine which top-level prefix to strip so files always land directly
    // in targetDir regardless of how the zip was created.
    // Ignore common OS artifacts (__MACOSX, .DS_Store) when counting top-level entries.
    const JUNK = new Set(['__MACOSX', '__macosx', '.DS_Store']);
    const topLevelNames = new Set();
    for (const entry of entries) {
      const firstPart = entry.entryName.split('/')[0];
      if (firstPart && !JUNK.has(firstPart)) topLevelNames.add(firstPart);
    }

    let stripPrefix = '';
    const targetName = path.basename(relPath);
    if (topLevelNames.size === 1) {
      // Single meaningful top-level folder — always strip it
      stripPrefix = [...topLevelNames][0] + '/';
    } else if (topLevelNames.size > 1) {
      // Multiple top-level entries — if one matches the target directory name
      // (case-insensitive), strip that prefix to avoid nesting (e.g. DATABASE/DATABASE/…)
      for (const name of topLevelNames) {
        if (name.toLowerCase() === targetName.toLowerCase()) {
          stripPrefix = name + '/';
          break;
        }
      }
    }

    let fileCount = 0;
    for (const entry of entries) {
      // Skip OS junk entries entirely
      const firstPart = entry.entryName.split('/')[0];
      if (JUNK.has(firstPart)) continue;

      let entryName = entry.entryName;
      if (stripPrefix && entryName.startsWith(stripPrefix)) {
        entryName = entryName.slice(stripPrefix.length);
      }
      if (!entryName) continue; // skip the root directory entry itself

      const destPath = path.join(targetDir, entryName);
      // Prevent path traversal
      if (!destPath.startsWith(targetDir + path.sep) && destPath !== targetDir) continue;

      if (entry.isDirectory) {
        fs.mkdirSync(destPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, entry.getData());
        fileCount++;
      }
    }

    // Clean up temp file
    try { fs.unlinkSync(req.file.path); } catch {}

    req.app.locals.auditLog?.('zip_uploaded', { req, details: { slug, path: relPath, fileCount } });
    res.json({ message: `Extracted ${fileCount} file(s) from zip`, path: relPath });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: 'Failed to extract zip: ' + err.message });
  }
});

// POST /api/shops/:slug/files/replace?path=DATABASE/Design/Details/Logo.png
// Replaces a single file at the exact path specified (used for image replacement, requires can_edit_ui)
router.post('/:slug/files/replace', requireUnlocked, upload.single('file'), (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });

  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.renameSync(req.file.path, resolved);
  req.app.locals.auditLog?.('file_replaced', { req, details: { slug, path: relPath } });
  res.json({ message: 'File replaced', path: relPath });
});

// POST /api/shops/:slug/files/upload?path=subdir (requires can_edit_ui)
router.post('/:slug/files/upload', requireUnlocked, upload.array('files', 20), (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const relPath = req.query.path || '.';
  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  fs.mkdirSync(resolved, { recursive: true });

  const saved = [];
  for (const file of req.files) {
    const safeName = path.basename(file.originalname);
    const dest = path.join(resolved, safeName);
    fs.renameSync(file.path, dest);
    saved.push(safeName);
  }

  req.app.locals.auditLog?.('files_uploaded', { req, details: { slug, path: relPath, files: saved } });
  res.json({ message: `Uploaded ${saved.length} file(s)`, files: saved });
});

// POST /api/shops/:slug/files/rename — rename a file or directory in place
// Body: { from, to } — both paths relative to the shop directory.
// Used for: collection rename, item rename, photo rename.
router.post('/:slug/files/rename', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (from === to) return res.status(400).json({ error: 'from and to must differ' });

  const fromAbs = safeShopPath(slug, from);
  const toAbs = safeShopPath(slug, to);
  if (!fromAbs || !toAbs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(fromAbs)) return res.status(404).json({ error: 'Source not found' });
  if (fs.existsSync(toAbs)) return res.status(409).json({ error: 'Destination already exists' });

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);

  // Sync inventory.csv if a collection or item was renamed within the same parent
  const fromInfo = classifyCollectionPath(from);
  const toInfo = classifyCollectionPath(to);
  let inventoryUpdated = 0;
  try {
    if (fromInfo.type === 'collection' && toInfo.type === 'collection') {
      inventoryUpdated = renameCollectionInCsv(slug, fromInfo.name, toInfo.name);
    } else if (fromInfo.type === 'item' && toInfo.type === 'item') {
      inventoryUpdated = renameItemInCsv(
        slug, fromInfo.collection, fromInfo.item, toInfo.collection, toInfo.item
      );
    }
  } catch (err) {
    console.error(`[files] rename inventory sync failed for ${slug}:`, err.message);
  }

  req.app.locals.auditLog?.('file_renamed', { req, details: { slug, from, to, inventoryUpdated } });
  res.json({ message: 'Renamed', from, to, inventoryUpdated });
});

// POST /api/shops/:slug/files/move — move a file or directory across parents
// Body: { from, to }. Same semantics as rename, but `to` may have a different
// parent. Used for: moving items between collections.
router.post('/:slug/files/move', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (from === to) return res.status(400).json({ error: 'from and to must differ' });

  const fromAbs = safeShopPath(slug, from);
  const toAbs = safeShopPath(slug, to);
  if (!fromAbs || !toAbs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(fromAbs)) return res.status(404).json({ error: 'Source not found' });
  if (fs.existsSync(toAbs)) return res.status(409).json({ error: 'Destination already exists' });

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);

  const fromInfo = classifyCollectionPath(from);
  const toInfo = classifyCollectionPath(to);
  let inventoryUpdated = 0;
  try {
    if (fromInfo.type === 'item' && toInfo.type === 'item') {
      inventoryUpdated = renameItemInCsv(
        slug, fromInfo.collection, fromInfo.item, toInfo.collection, toInfo.item
      );
    }
  } catch (err) {
    console.error(`[files] move inventory sync failed for ${slug}:`, err.message);
  }

  req.app.locals.auditLog?.('file_moved', { req, details: { slug, from, to, inventoryUpdated } });
  res.json({ message: 'Moved', from, to, inventoryUpdated });
});

// POST /api/shops/:slug/files/copy — recursively copy a file or directory
// Body: { from, to }. Used for: duplicate item.
router.post('/:slug/files/copy', requireUnlocked, (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (from === to) return res.status(400).json({ error: 'from and to must differ' });

  const fromAbs = safeShopPath(slug, from);
  const toAbs = safeShopPath(slug, to);
  if (!fromAbs || !toAbs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(fromAbs)) return res.status(404).json({ error: 'Source not found' });
  if (fs.existsSync(toAbs)) return res.status(409).json({ error: 'Destination already exists' });

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.cpSync(fromAbs, toAbs, { recursive: true });

  req.app.locals.auditLog?.('file_copied', { req, details: { slug, from, to } });
  res.json({ message: 'Copied', from, to });
});

// GET /api/shops/:slug/database/export — stream the shop's DATABASE/ as a zip
router.get('/:slug/database/export', (req, res) => {
  if (!checkShopPermission(req, 'can_view_orders')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const dbDir = path.join(SHOPS_DIR, slug, 'DATABASE');
  if (!fs.existsSync(dbDir)) return res.status(404).json({ error: 'DATABASE folder not found' });

  const zip = new AdmZip();
  function walk(dir, base) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      // Skip launch lock and tempfiles to keep the export clean
      if (e.name === '.db.lock' || e.name.endsWith('.tmp')) continue;
      const full = path.join(dir, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, rel);
      } else {
        zip.addFile(rel, fs.readFileSync(full));
      }
    }
  }
  walk(dbDir, '');

  const today = new Date().toISOString().slice(0, 10);
  const filename = `${slug}-database-${today}.zip`;
  const buffer = zip.toBuffer();

  req.app.locals.auditLog?.('database_exported', { req, details: { slug, bytes: buffer.length } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
});

module.exports = router;
