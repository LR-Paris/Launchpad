require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const { router: authRouter, requireAuth, loadUsers, SESSION_COOKIE_NAME } = require('./auth');

// Minimal session store using better-sqlite3 (replaces connect-sqlite3 which
// depends on the native sqlite3 module that fails to build on alpine).
const Store = session.Store;
class BetterSqlite3Store extends Store {
  constructor(opts) {
    super(opts);
    this.db = new Database(path.join(opts.dir, opts.db));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL)'
    );
    // Purge expired sessions every 15 minutes
    this._cleanup = setInterval(() => {
      this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
    }, 15 * 60 * 1000);
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie?.maxAge || 86400000;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) {
    try {
      const maxAge = sess.cookie?.maxAge || 86400000;
      this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(Date.now() + maxAge, sid);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
}
const { router: shopsRouter, initDb } = require('./shops');
const ordersRouter = require('./orders');
const filesRouter = require('./files');
const inventoryRouter = require('./inventory');
const updateRouter = require('./update');
const ordersWebhookRouter = require('./orders-webhook');

const app = express();
// Trust proxy (required when behind nginx)
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('ERROR: SESSION_SECRET env var must be at least 32 characters.');
  process.exit(1);
}

// Initialize shops database on startup
initDb();

// Check if admin user exists
const users = loadUsers();
if (users.length === 0) {
  console.warn('\n⚠  No admin user found. Run: npm run create-admin\n');
}

// ---------------------------------------------------------------------------
// Audit logger — append-only structured log for security-relevant events
// ---------------------------------------------------------------------------
const AUDIT_LOG_PATH = path.join(__dirname, '..', 'data', 'audit.log');
function auditLog(event, { actor, details, req } = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    actor: actor || (req?.session?.user?.username) || 'system',
    ip: req ? (req.ip || req.connection?.remoteAddress) : undefined,
    details,
  };
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
}
// Expose auditLog so routes can use it
app.locals.auditLog = auditLog;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const baseDomain = process.env.BASE_DOMAIN;

    if (origin === frontendUrl) return callback(null, true);

    // Allow any subdomain of BASE_DOMAIN (http or https, any port)
    if (baseDomain) {
      const escaped = baseDomain.replace(/\./g, '\\.');
      const domainPattern = new RegExp(`^https?://(.*\\.)?${escaped}(:\\d+)?$`);
      if (domainPattern.test(origin)) return callback(null, true);
    }

    // Allow localhost and loopback only in development
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Session setup
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(session({
  store: new BetterSqlite3Store({
    dir: dataDir,
    db: 'sessions.db',
  }),
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
}));

// ---------------------------------------------------------------------------
// CSRF protection — double-submit cookie pattern
// ---------------------------------------------------------------------------
function csrfProtection(req, res, next) {
  // Skip for GET/HEAD/OPTIONS (safe methods) and unauthenticated webhook routes
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Generate CSRF token if session doesn't have one
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  // Check token from header matches session
  const headerToken = req.headers['x-csrf-token'];
  if (!req.session?.csrfToken || headerToken !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// Endpoint to fetch CSRF token (called by frontend on load)
app.get('/api/auth/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.json({ csrfToken: req.session.csrfToken });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global rate limiter for authenticated API endpoints
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// Rate limit password change endpoint
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many password change attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.post('/api/auth/login', loginLimiter);
app.post('/api/auth/change-password', passwordChangeLimiter);
app.use('/api/auth', authRouter);

// Unauthenticated webhook for Shuttle containers (must come BEFORE requireAuth)
const notifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many notification requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/shops', notifyLimiter, ordersWebhookRouter);

// Protected routes — CSRF enforced on state-changing requests
app.use('/api/shops', requireAuth, csrfProtection, shopsRouter);
app.use('/api/shops', requireAuth, csrfProtection, ordersRouter);
app.use('/api/shops', requireAuth, csrfProtection, filesRouter);
app.use('/api/shops', requireAuth, csrfProtection, inventoryRouter);

// System / update routes (protected + CSRF)
app.use('/api/system', requireAuth, csrfProtection, updateRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler — return generic messages in production
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message, err.stack);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';
  res.status(status).json({ error: message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shuttle Platform backend running on port ${PORT}`);
});
