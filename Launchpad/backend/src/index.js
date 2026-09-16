require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
require('./logger'); // File logging — must be first after dotenv

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const { router: authRouter, requireAuth, loadUsers, SESSION_COOKIE_NAME, setUserFns } = require('./auth');
const {
  router: usersRouter,
  meRouter,
  initUsersDb,
  getUserByUsernameOrEmail,
  getUserCount,
  generateOTP,
  verifyOTP,
  cleanupExpiredOTPs,
  getAllUserPermissions,
} = require('./users');

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
// --- ADR-001 "Shuttle Dev Tool" ---------------------------------------------
const { initPlatformDb, degradedReason: platformDbDegraded } = require('./platform-db');
const {
  resolveShopAndRole,
  requireShopAccess,
  accessRouter,
  shopAuditRouter,
  mcpRouter,
  mcpPublicRouter,
  mcpActor,
  mcpEnabled,
  denyMcp,
} = require('./authz');
const healthRouter = require('./health');
// ---------------------------------------------------------------------------

const { router: shopsRouter, initDb } = require('./shops');
const ordersRouter = require('./orders');
const filesRouter = require('./files');
const { router: inventoryRouter } = require('./inventory');
const updateRouter = require('./update');
const ordersWebhookRouter = require('./orders-webhook');
const missionControlRouter = require('./mission-control');
const { trackRouter: analyticsTrackRouter, queryRouter: analyticsQueryRouter } = require('./analytics');
const checkoutRouter = require('./checkout');

// --- ADR-001 phases 1b and 1c (agents B and C) ------------------------------
const { ticketRouter: uploadTicketRouter, uploadRouter, purgeExpiredTickets } = require('./upload-ticket');
const { router: stagingRouter, recoverInterruptedApply } = require('./staging');
const { router: goLiveRouter, publicRouter: reviewRouter } = require('./golive');
// ---------------------------------------------------------------------------

const app = express();
// Trust proxy (required when behind nginx)
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('ERROR: SESSION_SECRET env var must be at least 32 characters.');
  process.exit(1);
}

// Initialize databases on startup
initDb();
initUsersDb();
// Creates data/platform.db and runs the additive user_shop_permissions /
// shops.stage column migrations. Idempotent: a second boot is a no-op.
initPlatformDb();
if (mcpEnabled()) {
  console.log('[mcp] Signed tool access is enabled (X-Launchpad-Actor).');
}

// An apply that died between its two renames leaves the shop's DATABASE parked
// under .DATABASE.replacing-*. Put it back at boot, before anything serves a
// request, so a crash mid-apply never shows a customer an empty shop.
try {
  const shopsRoot = path.join(__dirname, '..', 'shops');
  if (fs.existsSync(shopsRoot)) {
    for (const slug of fs.readdirSync(shopsRoot)) {
      const recovered = recoverInterruptedApply(slug);
      if (recovered) console.warn(`[staging] Recovered an interrupted DATABASE apply for "${slug}".`);
    }
  }
} catch (err) {
  console.error('[staging] Startup recovery sweep failed:', err.message);
}

// Sweep used and expired upload tickets, and the temp zips they point at.
setInterval(purgeExpiredTickets, 60 * 60 * 1000);

// Wire auth module to user functions (breaks circular dependency)
setUserFns({
  getUserByUsernameOrEmail,
  getUserCount,
  generateOTP,
  verifyOTP,
  getAllUserPermissions,
});

// Check if any user exists
const users = loadUsers();
if (users.length === 0) {
  console.warn('\n⚠  No admin user found. Run: npm run create-admin\n');
}

// Cleanup expired OTPs every 30 minutes
setInterval(cleanupExpiredOTPs, 30 * 60 * 1000);

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
// The raw body is kept because the MCP actor signature covers it. express.json
// consumes the stream, so this is the only chance to see the bytes.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
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

// Signed tool requests authenticate with an HMAC header instead of a cookie,
// and are resolved BEFORE express-session so they never write a session row.
app.use(mcpActor);

const sessionMiddleware = session({
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
    maxAge: 24 * 60 * 60 * 1000, // 24 hours default (overridden per-session on login)
    sameSite: 'lax',
  },
});
app.use((req, res, next) => (req.via === 'mcp' ? next() : sessionMiddleware(req, res, next)));

// ---------------------------------------------------------------------------
// CSRF protection — double-submit cookie pattern
// ---------------------------------------------------------------------------
function csrfProtection(req, res, next) {
  // Skip for GET/HEAD/OPTIONS (safe methods) and unauthenticated webhook routes
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Signed tool requests carry no cookie, so there is no cross-site request to
  // forge. The HMAC over body+actor+timestamp is the stronger check.
  if (req.via === 'mcp') return next();

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
// Keyed by IP *and* identifier. Per-IP alone was right when every sign in came
// from a person's own browser. It is wrong now: every enrollment through the
// dev tool arrives from one container, so ten sign ins would lock out the
// eleventh person on a shared bucket they never touched. Pairing the two keeps
// the per-person brake (10 tries per address per 15 minutes) and keeps a single
// noisy IP from spraying addresses, without one colleague's sign in costing
// another one theirs.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Slightly higher since OTP needs 2 requests per login
  keyGenerator: (req) => {
    // The web login calls the address "identifier"; the tool server's two
    // enrollment routes call it "email". Reading both is what keeps every sign
    // in on the same per-address budget instead of collapsing the tool server's
    // traffic onto one bucket keyed by its container IP.
    const ident = String(req.body?.identifier || req.body?.email || '').trim().toLowerCase().slice(0, 120);
    return `${req.ip || 'noip'}|${ident || 'noident'}`;
  },
  // express-rate-limit warns when a custom keyGenerator touches req.ip, because
  // a bare IPv6 address lets one client rotate through a /64. Here the address
  // is only half the key and the identifier is the half that matters, so the
  // check is turned off rather than worked around.
  validate: { ip: false },
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global rate limiter for authenticated API endpoints.
// GET reads are exempt: the catalog editor fans out many small reads per item
// (Name/Cost/Description/Hidden + Photos listing + thumbnail) and the dashboard
// polls inventory/password per shop card — browsing 2-3 collections blew past
// 120 req/min and everything 429'd (items loaded, then images failed, then
// nothing loaded until the window reset). Mutations remain rate limited.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 240,
  skip: (req) => req.method === 'GET',
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// Routes
app.post('/api/auth/login-request', loginLimiter);
app.post('/api/auth/login-verify', loginLimiter);
app.use('/api/auth', authRouter);

// ---------------------------------------------------------------------------
// The tool server's own routes. enroll and token/introspect are called with
// actor 0, before the caller has a user id, so they sit OUTSIDE requireAuth;
// both refuse anything that did not arrive signed. The other three are normal
// authenticated routes that happen to be MCP only.
// ---------------------------------------------------------------------------
//
// The two enrollment routes go through the SAME limiter as the web login, and
// not one of their own. They mail through the same sender and write the same
// otp_codes rows, so a separate budget would just be a second way to spend the
// first one.
app.post('/api/mcp/enroll', loginLimiter);
app.post('/api/mcp/enroll/verify', loginLimiter);
app.use('/api/mcp', mcpPublicRouter);
app.use('/api/mcp', requireAuth, mcpRouter);

// User management routes (protected + CSRF, super_admin enforced inside router)
//
// denyMcp comes first and is the point: these three mounts predate ADR-001 and
// gate on requireRole('super_admin'), which reads the account role and knows
// nothing about how the request arrived. A signed tool call carrying a
// super_admin's id used to get all of it, including "create another
// super_admin". There is no MCP use case for any of them, so the tool server
// never gets in at all, whatever it holds.
app.use('/api/users', requireAuth, denyMcp('User administration'), csrfProtection, usersRouter);

// Who am I, what may I reach — the first call every client makes.
app.use('/api/me', requireAuth, meRouter);

// Unauthenticated webhook for Shuttle containers (must come BEFORE requireAuth)
const notifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many notification requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
// Scope the limiter to the webhook endpoint ONLY. Mounting it on '/api/shops'
// throttled EVERY /api/shops request to 30/min — the catalog editor's fan-out
// reads (details + photos + thumbnails per item) blew through that after one
// collection, causing the items/images-then-nothing loading failures.
app.use('/api/shops/:slug/orders/notify', notifyLimiter);
app.use('/api/shops', ordersWebhookRouter);

// Unauthenticated analytics tracking beacon (must come BEFORE requireAuth)
const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many tracking requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
// Same scoping fix: limit only the tracking beacon, not all of /api/shops.
app.use('/api/shops/:slug/analytics/track', analyticsLimiter);
app.use('/api/shops', analyticsTrackRouter);

// Unauthenticated DATABASE upload (must stay OUTSIDE the requireAuth tree).
// The ticket in the URL is the whole credential: single use, 15 minute expiry,
// bound to one shop and one user, stored only as its SHA-256. It sits here
// because a shell `curl --data-binary @db.zip` has no session cookie and a
// browser drop has no CSRF token. Rate limiting, the ticket check and the body
// cap all live inside the router, and the ticket is burned before a byte is
// written to disk.
app.use('/api/upload', uploadRouter);

// Client site review — a token in the URL is the only credential, so this
// cannot sit behind requireAuth. golive.js applies its own read and write rate
// limiters and every response is scoped to the one shop the token points at.
app.use('/api/review', reviewRouter);

// ---------------------------------------------------------------------------
// ADR-001 shop scope
//
// Access requests come FIRST, because the whole point of request_access is that
// somebody with no access can call it.
// ---------------------------------------------------------------------------
app.use('/api/shops', requireAuth, csrfProtection, accessRouter);

// Then the floor that every remaining /api/shops/:slug route sits behind. It is
// mounted once, here, rather than decorated onto each handler: a route added
// next month is covered by default instead of by somebody remembering.
// Individual routers raise the bar above this floor where the action deserves
// it (shops.js, orders.js, files.js).
//
// Reading is viewer, deleting is owner, everything else is editor. A path that
// needs more than that says so in its own router.
app.use('/api/shops/:slug', requireAuth, resolveShopAndRole, requireShopAccess({
  GET: 'viewer',
  HEAD: 'viewer',
  DELETE: 'owner',
  default: 'editor',
}));

// Protected routes — CSRF enforced on state-changing requests
app.use('/api/shops', requireAuth, csrfProtection, shopAuditRouter);
app.use('/api/shops', requireAuth, csrfProtection, healthRouter);
app.use('/api/shops', requireAuth, csrfProtection, shopsRouter);
app.use('/api/shops', requireAuth, csrfProtection, ordersRouter);
app.use('/api/shops', requireAuth, csrfProtection, filesRouter);
app.use('/api/shops', requireAuth, csrfProtection, inventoryRouter);
app.use('/api/shops', requireAuth, csrfProtection, checkoutRouter);

// Issuing an upload ticket is a normal authenticated, CSRF-protected action:
// you must already have editor access to be handed the credential the
// unauthenticated upload route accepts.
app.use('/api/shops', requireAuth, csrfProtection, uploadTicketRouter);
// stage / apply / rollback / backups. Every mutation inside runs through withShopLock.
app.use('/api/shops', requireAuth, csrfProtection, stagingRouter);
// preflight / go-live approval / PUT :slug/stage.
app.use('/api/shops', requireAuth, csrfProtection, goLiveRouter);

// Analytics query routes (protected, read-only so no CSRF needed)
app.use('/api/shops', requireAuth, analyticsQueryRouter);

// System / update routes (protected + CSRF, admin-only enforced inside router)
app.use('/api/system', requireAuth, denyMcp('Updating Launchpad'), csrfProtection, updateRouter);

// Mission Control (protected, admin-only enforced inside router)
app.use('/api/mission-control', requireAuth, denyMcp('Mission Control'), missionControlRouter);

// Health check. It reports whether platform.db is the real file or the
// in-memory fallback, because a server that came up degraded looks completely
// healthy from the outside otherwise.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    platform_db: platformDbDegraded() ? 'degraded' : 'ok',
    timestamp: new Date().toISOString(),
  });
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

// Only listen when started directly. Requiring this file (the route-coverage
// test does) builds the app without binding a port.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Launchpad backend running on port ${PORT}`);
  });
}

module.exports = app;
