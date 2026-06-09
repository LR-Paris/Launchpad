const fs = require('fs');
const path = require('path');

const SHOPS_DIR = path.join(__dirname, '..', 'shops');

function lockPath(slug) {
  return path.join(SHOPS_DIR, slug, '.db.lock');
}

function isLocked(slug) {
  return fs.existsSync(lockPath(slug));
}

function readLock(slug) {
  const p = lockPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { acquired_at: 0 };
  }
}

function acquire(slug, userId) {
  const p = lockPath(slug);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) return;
  fs.writeFileSync(
    p,
    JSON.stringify({ acquired_at: Date.now(), by_user_id: userId || null }),
  );
}

function release(slug) {
  const p = lockPath(slug);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch { /* best-effort */ }
  }
}

// Express middleware: blocks shop-mutating routes while a launch is in progress.
// Old shops with no .db.lock file pass through unchanged.
function requireUnlocked(req, res, next) {
  const slug = req.params.slug;
  if (slug && isLocked(slug)) {
    return res.status(423).json({
      error: 'Shuttle is launching — catalog is read-only until build completes.',
      reason: 'launch_in_progress',
    });
  }
  next();
}

module.exports = { isLocked, readLock, acquire, release, requireUnlocked };
