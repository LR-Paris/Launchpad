// ---------------------------------------------------------------------------
// self-signup.js — an LR Paris email gets its Launchpad account at first sign in.
//
// Nobody has to create the account first. Someone at an address in
// SELF_SIGNUP_DOMAINS (default lrparis.com) types it on the sign-in page, gets
// the usual six-digit code by email, and the account is made at the moment the
// code comes back right:
//
//   login-request  the code is mailed exactly as for an existing account, with
//                  the same answer, and kept hashed in users.db pending_signups.
//                  No account exists yet. An address nobody proves leaves
//                  nothing in the user admin.
//   login-verify   a right code creates the account (role user, no shops, no
//                  right to create shops, created_by self-signup) and signs the
//                  person in like anyone else. That includes the sign-in that
//                  Sign in with Launchpad sends other apps to (sso.js).
//
// This file is only the rules: which addresses qualify, what the account is
// called, a brake on how many new addresses one IP may ask for, and a budget for
// wrong codes across all of them. The tables and the code checks are in users.js,
// the two routes are in auth.js. Two more gates sit in users.js signupAllowed: an
// address an admin blocked (deleting an account blocks it, so deleting still
// revokes access), and, once LR Parrot has sent the list of people who really
// work here (sso.js POST /members), only those people.
//
// Nobody is told about any of it. The only email is the sign-in code the person
// asked for: no welcome email, no note to an admin.
// ---------------------------------------------------------------------------

const DEFAULT_DOMAINS = ['lrparis.com'];
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
// ASCII only, on purpose: a look-alike letter from another alphabet never
// passes for lrparis.com. No "+", so arnaud+x@lrparis.com cannot be a second
// account for arnaud's mailbox. No quotes, no spaces, no comments.
const EMAIL_RE = /^([a-z0-9](?:[a-z0-9._'-]*[a-z0-9])?)@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/;

// SELF_SIGNUP_DOMAINS: comma-separated, "@" optional, case ignored. Not set:
// lrparis.com. Set but empty: off. It is the one switch for every way an LR Paris
// address gets an account on its own: this sign-in page and the dev tool's first
// sign in (authz.js enrollDomains). MCP_ENROLL_DOMAINS, the dev tool's older name
// for it, still works when SELF_SIGNUP_DOMAINS is not set.
function parseDomains(value) {
  if (value === undefined) return { domains: DEFAULT_DOMAINS.slice(), ignored: [] };
  const domains = [];
  const ignored = [];
  for (const part of String(value).split(',')) {
    const d = part.trim().toLowerCase().replace(/^@/, '');
    if (!d) continue;
    if (DOMAIN_RE.test(d)) { if (!domains.includes(d)) domains.push(d); } else ignored.push(part.trim());
  }
  return { domains, ignored };
}

// Parsed once per distinct value, so a typo is logged once and not per request.
let parsedFrom = null;
let parsed = { domains: DEFAULT_DOMAINS.slice(), ignored: [] };

function selfSignupDomains() {
  const value = process.env.SELF_SIGNUP_DOMAINS !== undefined ? process.env.SELF_SIGNUP_DOMAINS : process.env.MCP_ENROLL_DOMAINS;
  if (value !== parsedFrom) {
    parsedFrom = value;
    parsed = parseDomains(value);
    for (const d of parsed.ignored) console.error(`[self-signup] SELF_SIGNUP_DOMAINS: "${d.slice(0, 80)}" is not a domain and is left out.`);
  }
  return parsed.domains;
}

// One line at boot, so the deploy log says who can sign up.
function describeSelfSignup() {
  const domains = selfSignupDomains();
  console.log(domains.length
    ? `[self-signup] Anyone with an ${domains.map((d) => `@${d}`).join(' or ')} email gets an account at their first sign in (and at the dev tool's first sign in)`
    : '[self-signup] Off: SELF_SIGNUP_DOMAINS is empty, so accounts are made by an admin only');
}

// The address to sign up, or null. Only an email whose domain is EXACTLY one of
// the allowed ones (not a subdomain, not a longer name that ends the same way).
// A username, which has no "@", is never an address.
function signupEmail(identifier) {
  if (typeof identifier !== 'string') return null;
  const email = identifier.trim().toLowerCase();
  if (email.length > 254 || email.includes('..')) return null;
  const m = EMAIL_RE.exec(email);
  if (!m || m[1].length > 64) return null;
  return selfSignupDomains().includes(m[2]) ? email : null;
}

// "arnaud.messager@lrparis.com" -> "arnaud.messager"; users.js adds 2, 3, ...
// when somebody has it.
function usernameBase(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return local || 'user';
}

// "arnaud.messager" -> "Arnaud Messager". A placeholder an admin can edit.
function displayName(email) {
  const words = String(email).split('@')[0].split(/[._'-]+/).filter(Boolean);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return name || usernameBase(email);
}

// ---------------------------------------------------------------------------
// A brake on addresses nobody has asked about before.
//
// Before this, a code request for an address with no account did nothing, so
// the sign-in page could not be used to send mail. Now an address in an allowed
// domain gets a real email, and one IP could ask for a thousand of them. This
// caps that per IP (req.ip, the same address the login limiter keys on). The
// number is for a runaway, not for people: a whole office signing in for the
// first time behind one address stays well under it. Per address, users.js
// gives one code a minute and five every fifteen.
// ---------------------------------------------------------------------------
const NEW_ADDRESS_WINDOW_MS = 60 * 60 * 1000;
const NEW_ADDRESS_MAX = 60;
const NEW_ADDRESS_IPS_MAX = 5000;
const askers = new Map(); // ip -> { count, resetAt }

function allowNewAddressCode(ip, now = Date.now()) {
  const key = String(ip || 'noip');
  const entry = askers.get(key);
  if (!entry || entry.resetAt <= now) {
    askers.delete(key);
    while (askers.size >= NEW_ADDRESS_IPS_MAX) askers.delete(askers.keys().next().value);
    askers.set(key, { count: 1, resetAt: now + NEW_ADDRESS_WINDOW_MS });
    return true;
  }
  if (entry.count >= NEW_ADDRESS_MAX) return false;
  entry.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// A budget for wrong codes, across every address.
//
// Each address has its own five tries, and each IP its own new addresses, but
// nothing counted wrong guesses in total: a script spread over many IPs and many
// invented addresses could keep guessing six-digit codes and nobody would hear
// of it. This counts the wrong codes sent for first sign ins (an address with no
// account) in the last hour. Past GUESS_MAX the admin gets one email and first
// sign ins are paused until the hour is over: the answer stays the same and no
// code is checked, so a flood cannot guess. Sign ins to accounts that exist are
// not touched. The number is for a script, not for people: a whole office
// signing in for the first time makes a handful of typos.
// ---------------------------------------------------------------------------
const GUESS_WINDOW_MS = 60 * 60 * 1000;
const GUESS_MAX = 60;
const guesses = { count: 0, addresses: new Set(), resetAt: 0, alerted: false };

function rollGuesses(now) {
  if (guesses.resetAt <= now) {
    guesses.count = 0;
    guesses.addresses.clear();
    guesses.resetAt = now + GUESS_WINDOW_MS;
    guesses.alerted = false;
  }
}

// True while first sign ins are paused.
function firstSignInsPaused(now = Date.now()) {
  rollGuesses(now);
  return guesses.count >= GUESS_MAX;
}

// One wrong code for a first sign in. Returns { paused, justPaused, count, addresses }:
// justPaused is true once per window, the moment the admin should be told.
function noteWrongSignupCode(email, now = Date.now()) {
  rollGuesses(now);
  guesses.count += 1;
  if (guesses.addresses.size < 1000) guesses.addresses.add(email);
  const paused = guesses.count >= GUESS_MAX;
  const justPaused = paused && !guesses.alerted;
  if (justPaused) guesses.alerted = true;
  return { paused, justPaused, count: guesses.count, addresses: guesses.addresses.size, resumesAt: guesses.resetAt };
}

// For the tests: forget the counts.
function resetGuessBudget() {
  guesses.count = 0;
  guesses.addresses.clear();
  guesses.resetAt = 0;
  guesses.alerted = false;
}

module.exports = {
  selfSignupDomains,
  describeSelfSignup,
  signupEmail,
  usernameBase,
  displayName,
  allowNewAddressCode,
  firstSignInsPaused,
  noteWrongSignupCode,
  resetGuessBudget,
  parseDomains,
  NEW_ADDRESS_MAX,
  GUESS_MAX,
};
