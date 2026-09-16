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
//
// The body is the ADR-001 refusal payload, because this is a refusal and an
// agent that can read every other refusal should not need a special case for
// this one. The 423 status and the top-level `reason` are kept exactly as they
// were: the current frontend checks both, and `error` moving from a string to
// an object is already the breaking half of this change. possible is true —
// the build finishes on its own, usually within a few minutes.
function requireUnlocked(req, res, next) {
  const slug = req.params.slug;
  if (slug && isLocked(slug)) {
    return res.status(423).json({
      error: {
        code: 'SHOP_BUSY',
        message: `"${slug}" is launching, so the catalog is read only until the build finishes.`,
        resolution: 'Wait for the launch to finish, usually two or three minutes, then try again.',
        possible: true,
      },
      reason: 'launch_in_progress',
    });
  }
  next();
}

module.exports = { isLocked, readLock, acquire, release, requireUnlocked };
