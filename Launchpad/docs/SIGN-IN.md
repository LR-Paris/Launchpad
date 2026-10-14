# Signing in to Launchpad

There are two ways to sign in: a six-digit code sent by email, or a passkey.
Both work on the Launchpad sign-in page. Both also work on the page that opens
when someone connects Claude to their shops (`lrparisstore.com/mcp/login`).

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

## Tests

`backend/test/sign-in.test.js` boots the backend and checks all of the above
with software passkeys made with `node:crypto`.
