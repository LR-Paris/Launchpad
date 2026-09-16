const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');

const { checkShopPermission } = require('./users');
const { requireUnlocked } = require('./lock');
const { renameCollectionInCsv, renameItemInCsv } = require('./inventory');
const { requireShopAccess, audit, refuse } = require('./authz');
const { readEntryData, entryFileType, ZipEntryError } = require('./safe-zip');

const router = express.Router();

// ---------------------------------------------------------------------------
// ADR-001. The viewer/editor/owner floor is mounted in index.js (GET viewer,
// DELETE owner, everything else editor). Raised here: a full DATABASE export is
// the whole client catalog and order history leaving the server in one zip, so
// it takes more than read access.
// ---------------------------------------------------------------------------
router.use('/:slug/database/export', requireShopAccess('editor'));

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

// Thrown by the zip checks below so a bad upload comes back as a refusal a
// person can act on, rather than as a 500.
class PreflightFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightFailure';
  }
}

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

// A slug is a directory name, never a path. It arrives as a route parameter,
// and Express decodes %2F in route parameters, so "a%2F..%2F.." would otherwise
// reach path.resolve as a path of its own and move the shop directory itself.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Every path in this module goes through here. It answers one question: does
// this resolve to something inside this one shop's folder, yes or no.
function safeShopPath(slug, relPath) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  if (relPath != null && String(relPath).includes('\0')) return null;
  const shopDir = path.resolve(SHOPS_DIR, slug);
  const resolved = path.resolve(shopDir, relPath == null ? '.' : String(relPath));
  if (!resolved.startsWith(shopDir + path.sep) && resolved !== shopDir) {
    return null;
  }
  return resolved;
}

// Folders inside a shop that belong to the DATABASE pipeline rather than to the
// file browser. Wiping .backups throws away the only way back from a bad apply,
// and wiping .staging destroys a catalog somebody is in the middle of reviewing.
const PROTECTED_TOP_LEVEL = new Set(['.staging', '.backups', '.git']);

// Which of those a path falls into, or null.
function protectedTopLevel(slug, resolved) {
  const shopDir = path.resolve(SHOPS_DIR, slug);
  const first = path.relative(shopDir, resolved).split(path.sep)[0];
  return PROTECTED_TOP_LEVEL.has(first) ? first : null;
}

// One refusal for "that path is not inside this shop", in the contract's shape.
// The legacy string refusals elsewhere in this module are left alone: the
// catalog editor renders `data.error` as text and this is the only place the
// answer changed.
function refuseOutsideShop(res, slug) {
  return refuse(res, 400, 'NOT_PERMITTED',
    `That path is not inside "${slug}".`,
    'Give a path inside the shop folder, for example DATABASE/ShopCollections.', false);
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
  const audit_id = audit(req, 'file_written', { slug, path: relPath });
  res.json({ message: 'File saved', path: relPath, audit_id });
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

  const protectedDir = protectedTopLevel(slug, resolved);
  if (protectedDir) {
    return refuse(res, 400, 'NOT_PERMITTED',
      `"${protectedDir}" holds this shop's backups and staged uploads and cannot be deleted from the file browser.`,
      'Use rollback_database if you want an older catalog back.', false);
  }

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true });
  } else {
    fs.unlinkSync(resolved);
  }
  const audit_id = audit(req, 'file_deleted', { slug, path: relPath, isDirectory: stat.isDirectory() });
  res.json({ message: 'Deleted', path: relPath, audit_id });
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
const MAX_ZIP_ENTRIES = 20000;                    // same ceiling as the staging pipeline

router.post('/:slug/files/upload-zip', requireUnlocked, uploadZip.single('file'), (req, res) => {
  if (!checkShopPermission(req, 'can_edit_ui')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  const relPath = req.query.path || 'DATABASE';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch { /* best effort */ } };

  // THE fix for the hole this route used to have: the target is resolved and
  // confined before anything is deleted. It used to be path.join(shopDir,
  // relPath) with no check at all, so ?path=../../data rm -rf'd the backend's
  // own database folder.
  const shopDir = path.resolve(SHOPS_DIR, slug);
  const targetDir = safeShopPath(slug, relPath);
  if (!targetDir) {
    cleanup();
    return refuseOutsideShop(res, slug);
  }
  if (targetDir === shopDir) {
    cleanup();
    return refuse(res, 400, 'NOT_PERMITTED',
      `A zip cannot replace the whole "${slug}" folder.`,
      'Upload into a folder inside the shop, for example DATABASE.', false);
  }
  const firstSegment = protectedTopLevel(slug, targetDir);
  if (firstSegment) {
    cleanup();
    return refuse(res, 400, 'NOT_PERMITTED',
      `"${firstSegment}" belongs to the upload and backup pipeline and cannot be replaced by a zip.`,
      'Use stage_database and apply_database for catalog changes.', false);
  }

  // Extract beside the target and swap. The old code deleted the target first,
  // so a zip that failed halfway left the shop with a half-written DATABASE and
  // no way back.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const parentDir = path.dirname(targetDir);
  const baseName = path.basename(targetDir);
  // Hidden names, so a half-finished upload that a crash left behind does not
  // look like shop content in the file browser.
  const incomingDir = path.join(parentDir, `.${baseName}.incoming-${stamp}`);
  const replacedDir = path.join(parentDir, `.${baseName}.replaced-${stamp}`);

  try {
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();
    if (!entries.length) throw new PreflightFailure('That zip is empty.');
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new PreflightFailure(`That zip has ${entries.length} entries, more than the ${MAX_ZIP_ENTRIES} allowed.`);
    }

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
    const targetName = baseName;
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

    fs.mkdirSync(incomingDir, { recursive: true });

    let fileCount = 0;
    let writtenBytes = 0;
    for (const entry of entries) {
      // Skip OS junk entries entirely
      const firstPart = entry.entryName.split('/')[0];
      if (JUNK.has(firstPart)) continue;

      const rawName = entry.entryName;
      if (rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
        throw new PreflightFailure(`The zip entry "${rawName}" is not a path inside the folder it is being unpacked into.`);
      }
      if (rawName.split('/').some((part) => part === '..')) {
        throw new PreflightFailure(`The zip entry "${rawName}" points outside the folder it is being unpacked into.`);
      }

      // A symlink or a device node written out as a regular file is a way back
      // out of this folder. The staging pipeline has refused these since day
      // one; this route wrote them.
      const type = entryFileType(entry);
      if (!entry.isDirectory && type !== 'regular' && type !== 'directory') {
        throw new PreflightFailure(`The zip entry "${rawName}" is a ${type}, not a file or a folder.`);
      }

      let entryName = rawName;
      if (stripPrefix && entryName.startsWith(stripPrefix)) {
        entryName = entryName.slice(stripPrefix.length);
      }
      if (!entryName) continue; // skip the root directory entry itself

      const destPath = path.resolve(incomingDir, entryName);
      // Prevent path traversal. Refuse the zip rather than skipping the entry:
      // a zip that tries this is not one to extract the safe parts of.
      if (!destPath.startsWith(incomingDir + path.sep) && destPath !== incomingDir) {
        throw new PreflightFailure(`The zip entry "${rawName}" resolves outside the folder it is being unpacked into.`);
      }

      if (entry.isDirectory) {
        fs.mkdirSync(destPath, { recursive: true });
      } else {
        // The 500 MB cap used to be checked against entry.header.size, which is
        // a number the uploader writes into the zip. This inflates with a hard
        // cap instead, so the size that counts is the one measured here.
        const allowance = MAX_ZIP_EXTRACTED_SIZE - writtenBytes;
        let data;
        try {
          data = readEntryData(entry, allowance);
        } catch (err) {
          if (err instanceof ZipEntryError) {
            throw new PreflightFailure(err.code === 'ZIP_ENTRY_TOO_LARGE'
              ? `That zip unpacks to more than the ${MAX_ZIP_EXTRACTED_SIZE / 1024 / 1024}MB limit.`
              : err.message);
          }
          throw err;
        }
        writtenBytes += data.length;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, data);
        fileCount++;
      }
    }

    // Swap: the old folder only goes away once the new one is complete on disk.
    let hadTarget = false;
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, replacedDir);
      hadTarget = true;
    } else {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    }
    try {
      fs.renameSync(incomingDir, targetDir);
    } catch (err) {
      if (hadTarget) fs.renameSync(replacedDir, targetDir); // put it back
      throw err;
    }
    if (hadTarget) fs.rmSync(replacedDir, { recursive: true, force: true });

    cleanup();

    const audit_id = audit(req, 'zip_uploaded', { slug, path: relPath, fileCount, bytes: writtenBytes });
    res.json({ message: `Extracted ${fileCount} file(s) from zip`, path: relPath, audit_id });
  } catch (err) {
    cleanup();
    fs.rmSync(incomingDir, { recursive: true, force: true });
    if (err instanceof PreflightFailure) {
      return refuse(res, 400, 'PREFLIGHT_FAILED', err.message,
        'Fix that in the folder you zipped and upload it again.', true);
    }
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
  const audit_id = audit(req, 'file_replaced', { slug, path: relPath });
  res.json({ message: 'File replaced', path: relPath, audit_id });
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

  const audit_id = audit(req, 'files_uploaded', { slug, path: relPath, files: saved });
  res.json({ message: `Uploaded ${saved.length} file(s)`, files: saved, audit_id });
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

  const audit_id = audit(req, 'file_renamed', { slug, from, to, inventoryUpdated });
  res.json({ message: 'Renamed', from, to, inventoryUpdated, audit_id });
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

  const audit_id = audit(req, 'file_moved', { slug, from, to, inventoryUpdated });
  res.json({ message: 'Moved', from, to, inventoryUpdated, audit_id });
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

  const audit_id = audit(req, 'file_copied', { slug, from, to });
  res.json({ message: 'Copied', from, to, audit_id });
});

// GET /api/shops/:slug/database/export — stream the shop's DATABASE/ as a zip
router.get('/:slug/database/export', (req, res) => {
  if (!checkShopPermission(req, 'can_view_orders')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { slug } = req.params;
  // Through safeShopPath like everything else here, so a slug that is not a
  // plain directory name cannot reach the filesystem.
  const dbDir = safeShopPath(slug, 'DATABASE');
  if (!dbDir) return refuseOutsideShop(res, slug);
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

  audit(req, 'database_exported', { slug, bytes: buffer.length });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
});

module.exports = router;
