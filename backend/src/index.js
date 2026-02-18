require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const SQLiteStore = require('connect-sqlite3')(session);
const { router: authRouter, requireAuth, loadUsers } = require('./auth');
const shopsRouter = require('./shops');
const ordersRouter = require('./orders');

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('ERROR: SESSION_SECRET env var must be at least 32 characters.');
  process.exit(1);
}

// Check if admin user exists
const users = loadUsers();
if (users.length === 0) {
  console.warn('\n⚠  No admin user found. Run: npm run create-admin\n');
}

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// Session setup
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(session({
  store: new SQLiteStore({
    dir: dataDir,
    db: 'sessions.db',
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
}));

// Rate limit login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.post('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);

// Protected routes
app.use('/api/shops', requireAuth, shopsRouter);
app.use('/api/shops', requireAuth, ordersRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shuttle Platform backend running on port ${PORT}`);
});
