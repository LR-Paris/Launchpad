# Signing in to Launchpad

There are two ways to sign in: a six-digit code sent by email, or a passkey.
Both work on the Launchpad sign-in page. Both also work on the page that opens
when someone connects Claude to their shops (`lrparisstore.com/mcp/login`).
Other LR Paris apps, LR Parrot first, can use the same sign-in: see
[Sign in with Launchpad](#sign-in-with-launchpad-other-lr-paris-apps).

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

Run each file with plain node, from `backend/`:

```bash
for f in test/*.test.js; do node "$f" || echo "FAILED: $f"; done
```
