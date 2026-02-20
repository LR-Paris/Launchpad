const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');

const router = express.Router();
const SHOPS_DIR = path.join(__dirname, '..', 'shops');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB per file
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

// PUT /api/shops/:slug/files/write?path=file.txt
router.put('/:slug/files/write', (req, res) => {
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
  res.json({ message: 'File saved', path: relPath });
});

// DELETE /api/shops/:slug/files?path=file.txt
router.delete('/:slug/files', (req, res) => {
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
  res.json({ message: 'Deleted', path: relPath });
});

// POST /api/shops/:slug/files/upload-zip?path=DATABASE
const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB
router.post('/:slug/files/upload-zip', uploadZip.single('file'), (req, res) => {
  const { slug } = req.params;
  const relPath = req.query.path || 'DATABASE';
  const shopDir = path.resolve(SHOPS_DIR, slug);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

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

    res.json({ message: `Extracted ${fileCount} file(s) from zip`, path: relPath });
  } catch (err) {
    res.status(400).json({ error: 'Failed to extract zip: ' + err.message });
  }
});

// POST /api/shops/:slug/files/replace?path=DATABASE/Design/Details/Logo.png
// Replaces a single file at the exact path specified (used for image replacement)
router.post('/:slug/files/replace', upload.single('file'), (req, res) => {
  const { slug } = req.params;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });

  const resolved = safeShopPath(slug, relPath);
  if (!resolved) return res.status(400).json({ error: 'Invalid path' });

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, req.file.buffer);
  res.json({ message: 'File replaced', path: relPath });
});

// POST /api/shops/:slug/files/upload?path=subdir
router.post('/:slug/files/upload', upload.array('files', 20), (req, res) => {
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
    fs.writeFileSync(dest, file.buffer);
    saved.push(safeName);
  }

  res.json({ message: `Uploaded ${saved.length} file(s)`, files: saved });
});

module.exports = router;
