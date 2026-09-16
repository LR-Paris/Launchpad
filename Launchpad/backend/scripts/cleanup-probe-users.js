#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cleanup-probe-users.js — remove the account rows the old enrollment order
// left behind.
//
//   node backend/scripts/cleanup-probe-users.js              # dry run, the default
//   node backend/scripts/cleanup-probe-users.js --dry-run    # the same thing, said out loud
//   node backend/scripts/cleanup-probe-users.js --apply      # actually delete
//
// Until the ordering fix, POST /api/mcp/enroll wrote a users row as soon as an
// address was submitted, before the six digit code was checked. Any address in
// an allowed domain therefore became a row in Launchpad's user admin, whether
// or not anybody could read the mail. Those rows hold nothing and can do
// nothing, but they are in a list people read and one of them can be made to
// carry a colleague's name.
//
// A row is deleted only when ALL of these are true:
//   * created_by = 'mcp-enroll'          (the only creator this script knows)
//   * no user_shop_permissions row       (it is a member of nothing)
//   * no trace of a completed sign in    (see evidenceOfSignIn below)
//   * role is the ordinary 'user' role
//
// Anything created by 'admin' or by 'migration' is refused outright, even if it
// somehow met the other tests. This script deletes people's accounts; every
// doubt resolves toward keeping the row.
//
// No ids are hardcoded. If the cleanup is run on a server where nobody probed
// anything, it finds nothing and says so.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const DATA_DIR = process.env.LAUNCHPAD_DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_DB = path.join(DATA_DIR, 'users.db');
const PLATFORM_DB = path.join(DATA_DIR, 'platform.db');
const SESSIONS_DB = path.join(DATA_DIR, 'sessions.db');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

// Creators this script will never touch, whatever else is true of the row.
const PROTECTED_CREATORS = ['admin', 'migration'];
// The creator that the broken enrollment used. Nothing else is a candidate.
const PROBE_CREATOR = 'mcp-enroll';
// Audit actions that the broken flow wrote BEFORE the code was checked. They
// are the fingerprint of the bug, not evidence that anybody signed in.
const NOT_EVIDENCE = new Set(['mcp_enroll', 'mcp_enroll_request', 'login_request', 'login_request_failed', 'login_failed']);
// The action a VERIFIED sign in writes. It exists precisely so this script can
// tell a colleague who really signed in through the tool from a row the broken
// ordering created for an address nobody ever proved. It is evidence; the
// 'mcp_enroll' rows above it are not.

function heading(text) {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function openReadOnly(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.log(`NOTE: ${path.basename(file)} could not be read (${err.message}).`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Never completed a sign in" is the claim that does the work here, so it is
// asked of every place a completed sign in leaves a mark, and any one of them
// saves the row. otp_codes is deliberately NOT one of them: generateOTP marks a
// user's previous code used=1 when it issues a new one, so a used code proves
// somebody asked for a second code, not that anybody read the first.
// ---------------------------------------------------------------------------
function buildEvidence() {
  const signedIn = new Set();      // user ids
  const signedInNames = new Set(); // usernames, from the append-only log

  const pdb = openReadOnly(PLATFORM_DB);
  if (pdb) {
    try {
      for (const row of pdb.prepare('SELECT user_id, action FROM audit_log WHERE user_id IS NOT NULL').all()) {
        if (!NOT_EVIDENCE.has(row.action)) signedIn.add(Number(row.user_id));
      }
    } catch { /* no audit_log yet */ }
    try {
      for (const row of pdb.prepare('SELECT DISTINCT user_id FROM mcp_static_tokens').all()) {
        signedIn.add(Number(row.user_id));
      }
    } catch { /* no tokens table yet */ }
    pdb.close();
  }

  const sdb = openReadOnly(SESSIONS_DB);
  if (sdb) {
    try {
      // Expired sessions count too. A session that has run out is still proof
      // that somebody was once logged in as that user.
      for (const row of sdb.prepare('SELECT sess FROM sessions').all()) {
        try {
          const id = JSON.parse(row.sess)?.user?.id;
          if (Number.isInteger(id)) signedIn.add(id);
        } catch { /* not a session we can read */ }
      }
    } catch { /* no sessions table yet */ }
    sdb.close();
  }

  return { signedIn, signedInNames };
}

// data/audit.log is a file, not a table, and it is the only place the web
// login's own success event lands. It is keyed by username rather than id.
async function readAuditFile(signedInNames) {
  if (!fs.existsSync(AUDIT_FILE)) return;
  const stream = readline.createInterface({ input: fs.createReadStream(AUDIT_FILE), crlfDelay: Infinity });
  for await (const line of stream) {
    if (!line || line.indexOf('login_success') === -1) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'login_success' && entry.actor) signedInNames.add(String(entry.actor));
    } catch { /* a truncated line is not evidence either way */ }
  }
}

async function main() {
  if (!fs.existsSync(USERS_DB)) {
    console.log(`Nothing to do: ${USERS_DB} does not exist.`);
    return 0;
  }

  console.log(`cleanup-probe-users  (${DRY ? 'DRY RUN, nothing will be deleted' : 'APPLY, rows will be deleted'})`);
  console.log(`data directory: ${DATA_DIR}`);

  const evidence = buildEvidence();
  await readAuditFile(evidence.signedInNames);

  const udb = new Database(USERS_DB);
  udb.pragma('busy_timeout = 5000');

  const candidates = udb.prepare(
    'SELECT id, username, email, name, role, created_at, created_by FROM users WHERE created_by = ? ORDER BY id',
  ).all(PROBE_CREATOR);

  const memberships = udb.prepare('SELECT COUNT(*) AS n FROM user_shop_permissions WHERE user_id = ?');

  const doomed = [];
  const kept = [];

  for (const user of candidates) {
    const why = [];
    if (PROTECTED_CREATORS.includes(String(user.created_by))) why.push(`created_by is ${user.created_by}`);
    if (user.role !== 'user') why.push(`role is ${user.role}`);
    if (memberships.get(user.id).n > 0) why.push('holds shop permissions');
    if (evidence.signedIn.has(user.id)) why.push('has signed in (audit_log, token or session)');
    if (evidence.signedInNames.has(user.username)) why.push('has signed in (audit.log login_success)');
    if (why.length) kept.push({ user, why });
    else doomed.push(user);
  }

  // Said explicitly rather than assumed: a row created by admin or migration is
  // not a candidate in the first place, and this is where you can see that.
  const protectedCount = udb.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE created_by IN (${PROTECTED_CREATORS.map(() => '?').join(',')})`,
  ).get(...PROTECTED_CREATORS).n;

  heading('Scope');
  console.log(`${candidates.length} row(s) created by '${PROBE_CREATOR}'`);
  console.log(`${protectedCount} row(s) created by ${PROTECTED_CREATORS.join(' or ')} — never considered`);

  if (kept.length) {
    heading('Kept');
    for (const { user, why } of kept) {
      console.log(`  keep   id=${user.id}  ${user.email}  (${why.join('; ')})`);
    }
  }

  heading(DRY ? 'Would delete' : 'Deleting');
  if (!doomed.length) {
    console.log('  nothing');
  }
  for (const user of doomed) {
    console.log(`  id=${user.id}  username=${user.username}  email=${user.email}  name=${JSON.stringify(user.name)}  created_at=${user.created_at}  created_by=${user.created_by}`);
  }

  if (DRY) {
    heading('Result');
    console.log(`${doomed.length} row(s) would be deleted. Nothing was changed.`);
    console.log('Run again with --apply to delete them.');
    udb.close();
    return 0;
  }

  if (doomed.length) {
    // users.db holds the only copy of the user list. Back it up before touching
    // it, through SQLite's own backup API so a WAL mid-write is not a problem.
    const backup = path.join(DATA_DIR, `users.db.pre-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
    await udb.backup(backup);
    console.log(`\nbackup written: ${backup}`);

    const delOtp = udb.prepare('DELETE FROM otp_codes WHERE user_id = ?');
    const delUser = udb.prepare('DELETE FROM users WHERE id = ? AND created_by = ?');
    const run = udb.transaction((rows) => {
      for (const user of rows) {
        delOtp.run(user.id);
        // created_by is in the WHERE clause too, so a row that changed under us
        // between the scan and the delete is left alone rather than removed.
        const info = delUser.run(user.id, PROBE_CREATOR);
        if (info.changes !== 1) throw new Error(`user ${user.id} changed under the cleanup; nothing was deleted`);
      }
    });
    run(doomed);

    // Leave a mark in the same place every other privileged action goes, so the
    // rows disappearing from the user admin has a written reason.
    try {
      const pdb = new Database(PLATFORM_DB);
      pdb.pragma('busy_timeout = 5000');
      pdb.prepare(
        'INSERT INTO audit_log (ts, user_id, username, shop_slug, action, detail, via) VALUES (?, NULL, ?, NULL, ?, ?, ?)',
      ).run(Date.now(), 'cleanup-probe-users', 'probe_users_deleted',
        JSON.stringify({ deleted: doomed.map((u) => ({ id: u.id, email: u.email })), backup }), 'system');
      // A pending claim on a deleted address is stale by definition.
      try {
        const clear = pdb.prepare('DELETE FROM pending_enrollments WHERE email = ?');
        for (const user of doomed) clear.run(String(user.email).toLowerCase());
      } catch { /* the table may not exist on an older platform.db */ }
      pdb.close();
    } catch (err) {
      console.log(`NOTE: the deletion could not be written to platform.db audit_log (${err.message}).`);
    }
  }

  heading('Result');
  console.log(`${doomed.length} row(s) deleted.`);
  udb.close();
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`cleanup-probe-users failed: ${err.stack || err.message}`);
  process.exit(1);
});
