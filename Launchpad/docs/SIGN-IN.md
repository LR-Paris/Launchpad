# Signing in to Launchpad

There are two ways to sign in: a six-digit code sent by email, or a passkey.
Both work on the Launchpad sign-in page. Both also work on the page that opens
when someone connects Claude to their shops (`lrparisstore.com/mcp/login`).
Other LR Paris apps, LR Parrot first, can use the same sign-in: see
[Sign in with Launchpad](#sign-in-with-launchpad-other-lr-paris-apps).

## First sign-in makes the account

Nobody has to create an account for an LR Paris address. Anyone whose email is in
`SELF_SIGNUP_DOMAINS` (comma-separated, default `lrparis.com`, so no change to
`.env` is needed) types it on the sign-in page, gets the usual six-digit code by
email, and the account is made at the moment the code comes back right.

`SELF_SIGNUP_DOMAINS` is the one switch for every way an LR Paris address gets an
account on its own: this page and the dev tool's first sign-in
(`/api/mcp/enroll`, `MCP_ENROLL_DOMAINS` in older `.env` files, which still
works when `SELF_SIGNUP_DOMAINS` is not set). Set it empty and both stop: accounts
are made by an admin only. The two make the same account (name, username, role
`user`, no shops) and are held to the same gates below.

1. **Asking for the code** (`POST /api/auth/login-request`). An address with no
   account that is exactly in an allowed domain gets the same email and the same
   answer as everyone else ("If an account exists, a sign-in code has been sent
   to your email." in the API; the sign-in page says "We sent a 6-digit code to
   <email>" to anyone who typed an email address). No account is made. The code waits in `users.db`
   `pending_signups`: only its hash, good for 10 minutes, five wrong tries, one
   row per address. Cleaned up with the other codes (`cleanupExpiredOTPs`).
2. **Sending the code back** (`POST /api/auth/login-verify`). A right code
   creates the account: role `user`, no shop access, cannot create shops,
   `created_by` `self-signup`. The username is the part before the `@` (made
   unique with 2, 3, ... if taken, in any letter case) and the name is that part
   in words: `arnaud.messager@lrparis.com` becomes `arnaud.messager` and "Arnaud
   Messager". An admin can edit both. `data/audit.log` records `user_created` with
   `via: self-signup`. Access an owner granted to the address before it had an
   account (shuttle-mcp `grant_access`) lands with the account, as for any new
   account. Then the person is signed in like anyone else.
3. **Sign in with Launchpad.** The sign-in page LR Parrot sends people to is this
   page, so the same applies: sign in with a new LR Paris address, and the page
   carries on to `/api/auth/sso/authorize` and back to the app. A self-signed
   account is a plain `user`, which `sso.js` accepts (it checks the email domain
   against the app's `allowedDomains`, not the role).

What it does not do:

- **Usernames never sign up.** Only an email address does. A username with no
  account gets the answer it always got.
- **Other domains are unchanged.** `someone@gmail.com`, `x@lrparis.com.evil.com`,
  `x@sub.lrparis.com` (a subdomain is not the domain) and `x+alias@lrparis.com`
  (one mailbox, one account) get the old answer and no email.
- **It never says whether an account exists.** Same status, same words, whether
  the address is new, known, throttled or outside the domains.
- **Nobody is notified.** The only email is the sign-in code the person asked
  for. No welcome email, no email to an admin, nothing to Teams. The sign-in that
  creates an account does not send the usual "sign-in" security alert either, and
  a wrong code on a first sign-in only goes to the audit log. Their later
  sign-ins are alerted like every account's (`security/authAlerts.js`,
  `ALERT_EMAIL`).

The limits that already apply to codes still apply (10 requests and verifies per
account and IP per 15 minutes, a username and an email counting as one account,
Turnstile when on). A code for an account that exists also dies at its fifth wrong
try, as a first-sign-in code does. Addresses with no account also
get their own: one code a minute and five per 15 minutes per address, and 60 new
addresses an hour per IP, so the sign-in page cannot be used to send mail to
strangers' mailboxes. Past a limit the answer is the same and no email goes out.

`SELF_SIGNUP_DOMAINS` is read at boot and the deploy log says what it found:
`[self-signup] Anyone with an @lrparis.com email gets an account at their first sign in`.
An entry that is not a domain is left out and named. Set it empty to turn the
whole thing off (`[self-signup] Off`). It changes who may sign up; it does not
touch the accounts that exist.

### Who can sign up: gates before the code

Anyone who can read a mailbox gets in, so the address has to belong to a real
person. Two gates come before a code is mailed or checked, for an address with
no account (`signupAllowed` in `users.js`). An address that fails one gets the
same answer as any other, no email, and no account; the audit log says why
(`signup_blocked`, `signup_not_a_member`).

1. **Only the people who work here.** LR Parrot has the company directory (the
   Microsoft 365 tenant). After every directory sync it sends Launchpad the
   addresses of the people who work at LR Paris: `POST /api/auth/sso/members`
   with `{client_id, client_secret, emails}`, the same client secret as the
   token route. Launchpad keeps them (`users.db` `signup_members`, one set per
   app, replaced whole each time; a list with no valid address is refused, so an
   empty list can never open sign-up). Once there are any, only those addresses
   can sign up: an address nobody has a mailbox for, a shared mailbox, a list, a
   guest or someone disabled gets no code. Until LR Parrot has sent a list
   (Launchpad deployed first, or LR Parrot without Graph access) nothing changes
   and any address in an allowed domain can sign up, so deploy order matters:
   see the release steps in LR Parrot's `docs/people-and-sharing-spec.md`. A new
   hire is in the list after the next directory sync (daily; an LR Parrot admin
   can run it at once with `POST /api/admin/directory/sync`). Accounts that exist
   sign in as always, listed or not. The list only carries addresses. Nobody is
   told it was sent.
2. **Blocked addresses.** Deleting an account (`DELETE /api/users/:id`) blocks its
   address (`blocked_emails`), so typing the email again does not bring the
   account back: **deleting an account revokes access for good, until an admin
   makes the account again.** A super_admin can also block an address (a shared
   mailbox that is in the directory), list them and unblock one:
   `GET/POST /api/users/blocked`, `DELETE /api/users/blocked/:email`. Making the
   account by hand (`POST /api/users`) clears the block.

### A budget for wrong first-sign-in codes

Each address has five tries and each IP its own new addresses, but nothing counted
wrong guesses in total. Now the wrong first-sign-in codes of the last hour,
across every address, are counted: at 60 the admin (`ALERT_EMAIL`) gets one email
("someone is guessing first sign-in codes") and first sign-ins for addresses
with no account pause until the hour is over. No code is checked meanwhile, the
answer is the usual one, and accounts that exist sign in as always. A few typos by
people are far from 60.

### What a self-made account can see

A self-made account (`created_by` `self-signup`) that is still a plain `user` sees
only the shops it has a role on: the shop list names clients and projects, and any
LR Paris mailbox can make one. Admin-made accounts, admins, accounts the dev tool's
first sign-in made, and an account an admin has promoted see the list as before
(`LAUNCHPAD_STRICT_SHOP_LIST` still filters it for everyone when set).

## How long a sign-in lasts

The sign-in page asks how long to stay signed in: 1 day, 1 week, 1 month or
3 months. The default is 1 month.

That time counts from the last visit, not from the sign-in. Every request
renews the cookie and the stored session (`rolling` in `backend/src/index.js`).
A person on the 1-week setting who opens Launchpad every few days stays signed
in.

One limit holds whatever the activity: a session ends `SESSION_MAX_AGE_DAYS`
(default 180) after the sign-in that created it. Then the person signs in again.

Both ways in call `startSignedInSession()` in `backend/src/session-policy.js`,
so a passkey and an email code always get the same lifetimes. Sessions created
before this change have no sign-in time stored. Their 180-day clock starts on
their next request, so the deploy signs nobody out.

Signing in always starts a new session id. A session that existed before the
sign-in never becomes the signed-in one. The page fetches a new CSRF token
afterwards.

Every request reads the account again (`sessionGuard()`). A deleted account
loses its session on its next request. A changed role applies on the next
request too, not at the next sign-in.

## Passkeys

A passkey signs in with Face ID, Touch ID or the device PIN. No email code is
needed.

- **Add one.** After an email-code sign-in, Launchpad offers to add a passkey
  when the browser supports passkeys and the account has none. "Not now" hides
  the offer for 30 days.
- **Manage them.** Settings has a Passkeys card to add and remove them.
- **Use one.** Click "Sign in with a passkey" on either sign-in page.
- **Discoverable only.** Both pages ask for a passkey without asking for the
  account first. So registration requires a discoverable passkey
  (`residentKey: 'required'`). An authenticator that cannot store one shows an
  error at registration. It does not save a passkey that can never sign in.

### The connector page

shuttle-mcp serves `/mcp/login` on the same origin as Launchpad. So a passkey
added in Launchpad works there too.

The browser runs the ceremony. The tool server only carries the messages,
signed as actor 0.


1. `POST /api/mcp/passkey/options` returns a ceremony id and the WebAuthn
   options. The challenge stays in Launchpad memory for 5 minutes, single use.
2. `POST /api/mcp/passkey/verify` takes the ceremony id and the browser's
   answer. Launchpad checks the challenge, origin, signature and counter. It
   checks the account exists and is in `MCP_ENROLL_DOMAINS` (default
   `lrparis.com`). It records `mcp_sign_in` with `method: passkey` and
   applies any waiting shop access. Then it returns the person.

Every failure returns the same 401. The route reveals nothing about which
passkeys or accounts exist. Both passkey routes also refuse an answer made
inside another site's frame (`crossOrigin` in the client data). An account outside the allowed domains gets a 403.
The email-code route has the same rule.

## Sign in with Launchpad (other LR Paris apps)

Another internal app can let people sign in with their Launchpad account: the
same people, the same email codes, the same passkeys. The app has no accounts
of its own. LR Parrot (`https://parrot.lrparis.com`) is the first one.

It is a small authorization-code flow in `backend/src/sso.js`.

1. The app sends the browser to
   `GET /api/auth/sso/authorize?client_id=…&redirect_uri=…&state=…`.
   - Unknown `client_id`, or a `redirect_uri` that is not exactly one the app
     registered: a plain 400 page. No redirect, signed in or not.
   - Nobody signed in: a redirect to `/login?next=<this authorize URL>`. After
     an email code or a passkey, the sign-in page goes back to `next`. Someone
     already signed in who lands on that page goes back at once. A sign-in that
     ends on this request (past `SESSION_MAX_AGE_DAYS`, or its account deleted)
     counts as nobody signed in: the same redirect, not a 401.
   - Signed in, account in one of the app's `allowedDomains`: a redirect to
     `redirect_uri?code=<one-time code>&state=<state, unchanged>`.
   - Signed in, any other domain: a plain 403 page.
   A third call is not part of signing in: `POST /api/auth/sso/members` (see "Who
   can sign up" above). It takes the same `client_id` and `client_secret`, a JSON
   `emails` list, and answers `{accepted: n}` (`401 invalid_client`, or `400
   invalid_request` for something that is not a list or has no address in the
   app's `allowedDomains`).
2. The app's server calls `POST /api/auth/sso/token` with the JSON body
   `{client_id, client_secret, code, redirect_uri}`. No cookie, no CSRF token.
   - Good: `200 {user: {id, username, email, name, role}}`.
   - Wrong client or secret: `401 {error: 'invalid_client'}`.
   - Unknown, expired or used code, or a code issued to another app or for
     another `redirect_uri`: `400 {error: 'invalid_grant'}`.
   - A body that is not JSON: `400 {error: 'invalid_request'}`. Neither the
     answer nor the log quotes the body, so a secret in it stays out of both.

The rules behind it:

- **Exact redirect addresses.** No prefix match, no trailing slash, no extra
  query. This stops anyone from sending a code to an address of their choice.
- **Domains.** Each app lists the email domains it accepts in `allowedDomains`.
  Leave it out for `lrparis.com` only. Launchpad has accounts for people outside
  LR Paris. They never get into an internal app unless it lists their domain.
  Both steps read the account as it is now.
- **Codes.** 32 random bytes, base64url. Only their SHA-256 is kept. A code
  lasts 60 seconds. The first try to use it ends it, right or wrong. A caller
  without the client secret cannot use one up.
- **In memory.** Codes live in the backend process. That is fine while
  Launchpad runs as one process. A restart between the two steps costs that
  person one more click. Two backends behind a load balancer would need a
  shared store.
- **Secrets.** Compared in constant time. At least 32 characters.
- **Browsers only.** A request signed by the tool server (shuttle-mcp) names
  a person who is not there to sign in. authorize refuses it with a 403, so
  `MCP_SHARED_SECRET` cannot be turned into a sign-in to another app.
- **The sign-in page** follows a `next` only when it starts with
  `/api/auth/sso/authorize?` (`frontend/src/lib/sso.js`). Anything else is
  ignored, so the page cannot be used as an open redirect. Express also routes
  `/api/auth/sso/authorize/` and other letter cases to authorize, so the backend
  always writes `next` with that exact path and the query string unchanged.
- **Placement** (`backend/src/index.js`). The token route sits before
  express-session, so it never reads, creates or renews a session. Right after
  it, `tokenErrors` answers a body `express.json()` could not read, before the
  global error handler can log or echo the parser's message. The authorize
  route sits after `sessionGuard()`, so it sees the account as it is now. When
  the guard ends a session (past `SESSION_MAX_AGE_DAYS`, or its account
  deleted), every other route gets 401 JSON. For authorize, the guard still
  ends the session, clears the cookie and records `session_ended`, then lets
  the request carry on signed out (`continueAfterEnd`), so the person goes to
  the sign-in page and comes back. Each route has its own rate limit per IP:
  authorize 60 a minute, token 120 a minute.
- **Audit.** `data/audit.log` records `sso_authorize`, `sso_token` and
  `sso_denied` (with a reason) with the client id. Never the code or the
  secret.

### Adding an app

1. Make a secret: `openssl rand -hex 32`.
2. Add the app to `SSO_CLIENTS` in `/root/Launchpad/.env`. Keep the whole
   value on one line, in single quotes:

   ```bash
   SSO_CLIENTS='{"parrot":{"name":"LR Parrot","secret":"<the secret>","redirectUris":["https://parrot.lrparis.com/auth/callback"],"allowedDomains":["lrparis.com"]}}'
   ```

   One entry per app. The key is the `client_id`. `name` shows on the 403
   page. `redirectUris` lists every address the app may come back to, in full.
   `allowedDomains` is optional.
3. Give the app the same `client_id` and secret (for LR Parrot,
   `LAUNCHPAD_CLIENT_SECRET` in its `.env`).
4. Recreate the backend so it reads the new value:
   `cd /root/Launchpad && docker compose up -d --force-recreate backend`.
5. Check the log. It should say
   `[sso] Sign in with Launchpad is on for: parrot (LR Parrot)`.
   - `[sso] SSO_CLIENTS is not valid JSON` means the quoting is wrong. No app
     can sign in until it is fixed. The rest of Launchpad works as usual.
   - `[sso] SSO_CLIENTS: "<id>" is left out: …` names the one entry that is
     wrong and why. The other apps still work.
6. Signed out, this should answer 302 to `/login?next=…`:

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
     'https://lrparisstore.com/api/auth/sso/authorize?client_id=parrot&redirect_uri=https%3A%2F%2Fparrot.lrparis.com%2Fauth%2Fcallback&state=check'
   ```

To remove an app, delete its entry and recreate the backend. Codes already
issued to it stop working at once.

## Tests

`backend/test/sign-in.test.js` boots the backend and checks all of the above
with software passkeys made with `node:crypto`.

`backend/test/sso.test.js` boots the backend with two apps in `SSO_CLIENTS` and
checks every rule of Sign in with Launchpad, through both email codes and
passkeys. That includes authorize with a session that `sessionGuard()` ends on
the way in, authorize spelled `/authorize/` or `/Authorize`, and a token body
that is not JSON. It also boots it once with `SSO_CLIENTS` that is not JSON.
For the 60-second expiry it moves the backend's clock with a small preload,
not with a setting in `src/`.

`backend/test/self-signup.test.js` checks First sign-in makes the account with
node's own test runner: the code and the account, every way a code can fail, the
other domains and usernames, existing accounts, races, the per-address and per-IP
limits, `SELF_SIGNUP_DOMAINS` (and that the dev tool's first sign-in follows it),
Sign in with Launchpad after a self-signup, the list of people who work here, blocked
and deleted addresses, the budget for wrong codes, an identifier spelled with a
look-alike letter, five tries per code for existing accounts, the shop list, and
that nobody is notified (a preload records every request the backend makes and
refuses all but Mailgun).

Run each file with plain node, from `backend/`:

```bash
for f in test/*.test.js; do node "$f" || echo "FAILED: $f"; done
```
