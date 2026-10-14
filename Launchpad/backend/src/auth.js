const express = require('express');
const fs = require('fs');
const path = require('path');
const geo = require('./security/geo');
const turnstile = require('./security/turnstile');
const authAlerts = require('./security/authAlerts');
const { startSignedInSession } = require('./session-policy');

const router = express.Router();
const SESSION_COOKIE_NAME = '__lp_sid';

// Lazy-loaded user functions (set after users module is initialized)
let userFns = null;
function setUserFns(fns) { userFns = fns; }

// ---------------------------------------------------------------------------
// Email OTP sender — uses Mailgun (same pattern as email.js)
// ---------------------------------------------------------------------------
async function sendOTPEmail(email, code, username, meta) {
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
      ${meta ? `<p style="font-size: 12px; color: #6b7280; text-align: center; margin: 16px 0 0;">Requested from ${meta.ip} — ${meta.location}.<br/>Not you? Ignore this email and tell Gio.</p>` : ''}
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
// Public: tells the login page whether to show the Turnstile check.
router.get('/config', (req, res) => {
  res.json({ turnstileSiteKey: turnstile.siteKey() });
});

router.post('/login-request', async (req, res) => {
  const { identifier } = req.body; // username or email
  const audit = req.app.locals.auditLog;

  if (typeof identifier !== 'string' || !identifier.trim()) {
    return res.status(400).json({ error: 'Username or email is required' });
  }

  const meta = await geo.requestMeta(req);
  const captcha = await turnstile.verify(req.body.turnstileToken, meta.ip);
  if (!captcha.ok) {
    audit?.('login_request_failed', { req, details: { identifier, reason: `turnstile_${captcha.reason}` } });
    return res.status(403).json({ error: 'The security check did not pass. Reload the page and try again.' });
  }
  const user = userFns.getUserByUsernameOrEmail(identifier.trim());
  if (!user) {
    audit?.('login_request_failed', { req, details: { identifier, reason: 'user_not_found' } });
    authAlerts.notifyLogin({ event: 'login_request_failed', ip: meta.ip, location: meta.location, details: { identifier, reason: 'user_not_found' } });
    // Don't reveal if user exists — return success anyway
    return res.json({ message: 'If an account exists, a sign-in code has been sent to your email.' });
  }

  // Per-account brake: stops a burst of code requests for one account even when
  // each request rides a different IP. Same generic reply eitherway.
  const gate = userFns.canIssueOTP(user.id);
  if (!gate.ok) {
    audit?.('login_request_throttled', { req, details: { username: user.username, reason: gate.reason } });
    authAlerts.notifyLogin({ event: 'login_request_throttled', actor: user.username, ip: meta.ip, location: meta.location, details: { reason: gate.reason } });
    return res.json({ message: 'If an account exists, a sign-in code has been sent to your email.' });
  }

  const code = userFns.generateOTP(user.id);
  sendOTPEmail(user.email, code, user.username, meta);

  audit?.('login_request', { req, details: { username: user.username } });
  res.json({ message: 'If an account exists, a sign-in code has been sent to your email.' });
});

// POST /api/auth/login-verify — verify OTP and create session
router.post('/login-verify', async (req, res) => {
  const { identifier, code, rememberMe } = req.body;
  const audit = req.app.locals.auditLog;

  if (typeof identifier !== 'string' || typeof code !== 'string' || !identifier.trim() || !code.trim()) {
    return res.status(400).json({ error: 'Identifier and code are required' });
  }

  const meta = await geo.requestMeta(req);

  const user = userFns.getUserByUsernameOrEmail(identifier.trim());
  if (!user) {
    audit?.('login_failed', { req, details: { identifier, reason: 'user_not_found' } });
    authAlerts.notifyLogin({ event: 'login_failed', ip: meta.ip, location: meta.location, details: { identifier, reason: 'user_not_found' } });
    return res.status(401).json({ error: 'Invalid code' });
  }

  const valid = userFns.verifyOTP(user.id, code.trim());
  if (!valid) {
    audit?.('login_failed', { req, details: { username: user.username, reason: 'invalid_otp' } });
    authAlerts.notifyLogin({ event: 'login_failed', actor: user.username, ip: meta.ip, location: meta.location, details: { reason: 'invalid_otp' } });
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // How long this sign-in lasts: the "Stay signed in for" choice, renewed on
  // every visit, inside the absolute limit (session-policy.js).
  startSignedInSession(req, rememberMe, user);
  const permissions = userFns.getAllUserPermissions(user.id);

  req.session.save((saveErr) => {
    if (saveErr) {
      return res.status(500).json({ error: 'Failed to save session' });
    }
    audit?.('login_success', { req, actor: user.username });
    authAlerts.notifyLogin({ event: 'login_success', actor: user.username, email: user.email, ip: meta.ip, location: meta.location });
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
  // Exported for the tool server's first sign in (authz.js). It must be this
  // function and not a copy of it: same Mailgun account, same From address,
  // same template, same "expires in 10 minutes" sentence. A second mailer is
  // how two sign-in emails start to disagree about what the code means.
  sendOTPEmail,
};
