// authAlerts.js — "tell me when someone gets in / fails" email alerts
// Dependency-free: uses global fetch + the Mailgun env vars already set in
// docker-compose.yml. Sends to ALERT_EMAIL (default g.lupo@lrparis.com).
//
// Smart volume (so an attacker can't turn your inbox into the DoS target):
//   • login_success  -> emailed immediately, every time.
//   • failures       -> first failure in a window emailed immediately, then
//                       suppressed; a rollup digest is sent every
//                       FAIL_DIGEST_MINUTES (default 10) if anything accumulated.
//
// Call notifyLogin(...) right next to your existing audit() calls in auth.js.

const MG_KEY    = process.env.MAILGUN_API_KEY || '';
const MG_DOMAIN = process.env.MAILGUN_DOMAIN || 'mg.lrparisstore.com';
const MG_BASE   = process.env.MAILGUN_API_BASE || 'https://api.mailgun.net'; // use https://api.eu.mailgun.net if your Mailgun region is EU
const FROM      = process.env.ALERT_FROM || `Launchpad Security <noreply@${MG_DOMAIN}>`;
const TO        = process.env.ALERT_EMAIL || 'g.lupo@lrparis.com';
const DIGEST_MIN = Number(process.env.FAIL_DIGEST_MINUTES || 10);

async function sendMail(subject, text) {
  if (!MG_KEY) { console.warn('[alerts] MAILGUN_API_KEY not set — skipping:', subject); return; }
  try {
    const form = new URLSearchParams({ from: FROM, to: TO, subject, text });
    const r = await fetch(`${MG_BASE}/v3/${MG_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${MG_KEY}`).toString('base64') },
      body: form,
    });
    if (!r.ok) console.error('[alerts] mailgun', r.status, await r.text());
  } catch (e) {
    console.error('[alerts] send error:', e.message);
  }
}
// If you'd rather reuse auth.js's existing mailer, replace sendMail above with a
// call into it — it already holds working Mailgun creds.

// ---- failure accumulator (in-memory; resets on restart, which is fine) ----
const win = { count: 0, ips: new Set(), idents: new Set(), since: null, armed: true };

function recordFailure({ ip, location, identifier, reason }) {
  if (!win.since) win.since = new Date();
  win.count += 1;
  if (ip) win.ips.add(ip);
  if (identifier) win.idents.add(String(identifier).slice(0, 80));
  if (win.armed) { // first failure in this window -> immediate heads-up
    win.armed = false;
    sendMail(
      '⚠️ Launchpad: failed login attempt',
      `A failed sign-in just hit Launchpad.\n\n`
      + `IP: ${ip || 'unknown'}\nLocation: ${location || 'unknown location'}\n`
      + `Identifier tried: ${identifier || 'n/a'}\nReason: ${reason || 'n/a'}\n`
      + `Time: ${new Date().toISOString()}\n\n`
      + `Further failures in the next ${DIGEST_MIN} min will be rolled up into one digest instead of spamming you.`
    );
  }
}

function flushDigest() {
  if (win.count === 0) { win.armed = true; return; }
  const idents = [...win.idents].slice(0, 15);
  sendMail(
    `⚠️ Launchpad: ${win.count} failed sign-in attempts (${win.ips.size} IPs)`,
    `Failed sign-in attempts since ${win.since ? win.since.toISOString() : '?'}:\n\n`
    + `Total: ${win.count}\nUnique IPs: ${win.ips.size}\n`
    + `IPs: ${[...win.ips].slice(0, 25).join(', ')}\n`
    + `Identifiers tried: ${idents.join(', ')}${win.idents.size > idents.length ? ' …' : ''}\n\n`
    + `(Digest window: ${DIGEST_MIN} min. You got an immediate alert for the first one.)`
  );
  win.count = 0; win.ips.clear(); win.idents.clear(); win.since = null; win.armed = true;
}
setInterval(flushDigest, DIGEST_MIN * 60 * 1000).unref();

// ---- public entrypoint ----
// event: 'login_success' | 'login_failed' | 'login_request_failed' | any '*failed*'
function notifyLogin({ event, actor, ip, location, email, details } = {}) {
  try {
    if (event === 'login_success') {
      sendMail(
        `✅ Launchpad sign-in: ${actor || email || 'unknown'}`,
        `Successful Launchpad sign-in.\n\n`
        + `User: ${actor || ''} ${email ? '(' + email + ')' : ''}\n`
        + `IP: ${ip || 'unknown'}\nLocation: ${location || 'unknown location'}\n`
        + `Time: ${new Date().toISOString()}\n\n`
        + `If this wasn't you, rotate access immediately.`
      );
      return;
    }
    if (String(event || '').includes('fail')) {
      recordFailure({ ip, location, identifier: (details && details.identifier) || email, reason: details && details.reason });
    }
  } catch (e) {
    console.error('[alerts] notifyLogin error:', e.message);
  }
}

// One email to the admin, now, for something that is not a single failed sign-in
// (self-signup.js: a script guessing first sign-in codes). The caller says when:
// this does not rate-limit.
function alert(subject, text) {
  sendMail(`⚠️ ${subject}`, text);
}

module.exports = { notifyLogin, alert, _flushDigest: flushDigest };
