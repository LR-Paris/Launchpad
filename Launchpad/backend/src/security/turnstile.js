// Cloudflare Turnstile check for the email-code request.
//
// Off until both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set. Passkey
// sign-in skips it: a bot cannot complete a passkey ceremony anyway.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function enabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

function siteKey() {
  return enabled() ? process.env.TURNSTILE_SITE_KEY : null;
}

// Resolves to { ok: true } or { ok: false, reason }. Fails closed when
// Cloudflare cannot be reached; passkeys still work in that case.
async function verify(token, ip) {
  if (!enabled()) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return { ok: false, reason: 'missing' };
  }
  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d.success) return { ok: true };
    return { ok: false, reason: (d['error-codes'] || []).join(',') || 'rejected' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

module.exports = { enabled, siteKey, verify };
