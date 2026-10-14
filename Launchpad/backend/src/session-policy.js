// ---------------------------------------------------------------------------
// session-policy.js — how long a Launchpad sign-in lasts.
//
// Two clocks run on every signed-in session:
//
//  - Idle. The "Stay signed in for" choice on the sign-in page. The cookie and
//    the sessions.db row are renewed on every request (express-session
//    `rolling`), so this counts from the person's last visit, not from the
//    moment they signed in. Someone who opens Launchpad every week stays signed
//    in on the one-week setting indefinitely, up to the second clock.
//
//  - Absolute. SESSION_MAX_AGE_DAYS, 180 by default. However busy a session
//    is, it ends this long after the sign-in that created it, and the person
//    signs in again. With a passkey that is one touch.
//
// Email codes and passkeys both go through startSignedInSession(), so the two
// ways in cannot disagree about how long a sign-in lasts.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const REMEMBER_DURATIONS = {
  '1h': HOUR, // no longer offered on the page, still accepted from an old tab
  '1d': DAY,
  '1w': 7 * DAY,
  '1m': 30 * DAY,
  '3m': 90 * DAY,
};

// What a sign-in gets when the page sends nothing, or something unknown.
const DEFAULT_REMEMBER = '1m';

function rememberKey(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REMEMBER_DURATIONS, value)
    ? value
    : DEFAULT_REMEMBER;
}

function sessionDuration(value) {
  return REMEMBER_DURATIONS[rememberKey(value)];
}

function maxSessionAgeMs(env = process.env) {
  const days = Number(env.SESSION_MAX_AGE_DAYS);
  return Number.isFinite(days) && days > 0 ? days * DAY : 180 * DAY;
}

// Called at the moment a person has proved who they are, by email code or by
// passkey. The caller saves the session afterwards.
function startSignedInSession(req, rememberMe, user) {
  const key = rememberKey(rememberMe);
  req.session.cookie.maxAge = REMEMBER_DURATIONS[key];
  req.session.remember = key;
  req.session.signedInAt = Date.now();
  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  return key;
}

// Ends a session that has outlived the absolute limit. A session from before
// this file existed carries no signedInAt; its clock starts on its next
// request, so nobody is signed out by the deploy that introduces it.
function enforceMaxSessionAge({ cookieName, auditLog } = {}) {
  return function maxSessionAge(req, res, next) {
    if (req.via === 'mcp' || !req.session || !req.session.user) return next();
    const now = Date.now();
    if (!req.session.signedInAt) {
      req.session.signedInAt = now;
      return next();
    }
    if (now - req.session.signedInAt <= maxSessionAgeMs()) return next();

    const username = req.session.user.username;
    return req.session.destroy(() => {
      if (cookieName) res.clearCookie(cookieName);
      if (auditLog) auditLog('session_expired', { actor: username, req, details: { reason: 'max_age' } });
      res.status(401).json({ error: 'Your sign-in has expired. Sign in again.' });
    });
  };
}

module.exports = {
  REMEMBER_DURATIONS,
  DEFAULT_REMEMBER,
  rememberKey,
  sessionDuration,
  maxSessionAgeMs,
  startSignedInSession,
  enforceMaxSessionAge,
};
