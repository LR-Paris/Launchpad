const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const SESSION_COOKIE_NAME = '__lp_sid';

// Lazy-loaded user functions (set after users module is initialized)
let userFns = null;
function setUserFns(fns) { userFns = fns; }

// ---------------------------------------------------------------------------
// Email OTP sender — uses Mailgun (same pattern as email.js)
// ---------------------------------------------------------------------------
async function sendOTPEmail(email, code, username) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;

  if (!apiKey || !domain) {
    console.log(`[auth] OTP for ${username} (${email}): ${code}  (Mailgun not configured — logging to console)`);
    return;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 420px; margin: 0 auto; padding: 32px 24px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="font-size: 22px; font-weight: 700; color: #0a0a0a; margin: 0;">Launchpad</h1>
        <p style="font-size: 13px; color: #666; margin: 4px 0 0;">Sign-in verification</p>
      </div>
      <div style="background: #f8f9fa; border: 1px solid #e5e7eb; border-radius: 12px; padding: 28px; text-align: center;">
        <p style="font-size: 14px; color: #374151; margin: 0 0 16px;">Your sign-in code is:</p>
        <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #0a0a0a; font-family: 'JetBrains Mono', monospace; margin: 0 0 16px;">${code}</div>
        <p style="font-size: 12px; color: #9ca3af; margin: 0;">This code expires in 10 minutes.</p>
      </div>
      <p style="font-size: 12px; color: #9ca3af; text-align: center; margin: 16px 0 0;">
        If you didn't request this code, you can safely ignore this email.
      </p>
    </div>
  `;

  const form = new FormData();
  form.append('from', `Launchpad <noreply@${domain}>`);
  form.append('to', email);
  form.append('subject', `${code} — Your Launchpad sign-in code`);
  form.append('html', html);

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64') },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[auth] Mailgun ${res.status}: ${text}`);
    } else {
      console.log(`[auth] OTP email sent to ${email}`);
    }
  } catch (err) {
    console.error(`[auth] OTP email failed: ${err.message}`);
    // Still log the code so login isn't blocked
    console.log(`[auth] OTP for ${username} (${email}): ${code}  (email send failed)`);
  }
}

// ---------------------------------------------------------------------------
// Session duration mapping
// ---------------------------------------------------------------------------
const REMEMBER_DURATIONS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/auth/login-request — request OTP code
router.post('/login-request', (req, res) => {
  const { identifier } = req.body; // username or email
  const audit = req.app.locals.auditLog;

  if (!identifier) {
    return res.status(400).json({ error: 'Username or email is required' });
  }

  const user = userFns.getUserByUsernameOrEmail(identifier.trim());
  if (!user) {
    audit?.('login_request_failed', { req, details: { identifier, reason: 'user_not_found' } });
    // Don't reveal if user exists — return success anyway
    return res.json({ message: 'If an account exists, a sign-in code has been sent to your email.' });
  }

  const code = userFns.generateOTP(user.id);
  sendOTPEmail(user.email, code, user.username);

  audit?.('login_request', { req, details: { username: user.username } });
  res.json({ message: 'If an account exists, a sign-in code has been sent to your email.' });
});

// POST /api/auth/login-verify — verify OTP and create session
router.post('/login-verify', (req, res) => {
  const { identifier, code, rememberMe } = req.body;
  const audit = req.app.locals.auditLog;

  if (!identifier || !code) {
    return res.status(400).json({ error: 'Identifier and code are required' });
  }

  const user = userFns.getUserByUsernameOrEmail(identifier.trim());
  if (!user) {
    audit?.('login_failed', { req, details: { identifier, reason: 'user_not_found' } });
    return res.status(401).json({ error: 'Invalid code' });
  }

  const valid = userFns.verifyOTP(user.id, code.trim());
  if (!valid) {
    audit?.('login_failed', { req, details: { username: user.username, reason: 'invalid_otp' } });
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // Set session duration based on remember me
  const duration = REMEMBER_DURATIONS[rememberMe] || REMEMBER_DURATIONS['1d'];
  req.session.cookie.maxAge = duration;

  // Build session user with all needed info
  const permissions = userFns.getAllUserPermissions(user.id);
  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
  };

  req.session.save((saveErr) => {
    if (saveErr) {
      return res.status(500).json({ error: 'Failed to save session' });
    }
    audit?.('login_success', { req, actor: user.username });
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
        permissions,
      },
    });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const audit = req.app.locals.auditLog;
  const username = req.session?.user?.username;
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    audit?.('logout', { actor: username, req });
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ message: 'Logged out' });
  });
});

// GET /api/auth/me — current user with permissions
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { id, username, email, name, role } = req.session.user;
  // Always fetch fresh permissions from DB
  const permissions = userFns.getAllUserPermissions(id);
  res.json({
    user: { id, username, email, name, role, permissions },
  });
});

// Legacy loadUsers for backward compat with index.js startup check
function loadUsers() {
  // Check if users.db has users
  try {
    const count = userFns?.getUserCount?.() || 0;
    return count > 0 ? [{ username: 'exists' }] : [];
  } catch {
    return [];
  }
}

module.exports = {
  router,
  requireAuth,
  loadUsers,
  SESSION_COOKIE_NAME,
  setUserFns,
};
