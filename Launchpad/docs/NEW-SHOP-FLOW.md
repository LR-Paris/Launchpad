# New shop flow fixes (backend 4.4.0)

Branch `fix/new-shop-flow` starts from `feat/shuttle-dev-tool`.

We found these problems on 2026-10-13. We built the-ritz-carlton end to end through the dev tool.

## What changed

| Area | Before | Now |
|---|---|---|
| New shop catalog | The clone kept the Shuttle template DATABASE: Michael Kors products, logo, fonts, FAQ and the password `mk2026`. | `src/starter-database.js` writes an empty starter. It keeps every README and sets the shop name and a new password. `create_shop` returns that password. |
| Taken address | A bare `{ error }` with no code. The tool server reported a platform fault. | `NOT_PERMITTED`. It tells a member of that shop to call `get_shop` and carry on. It tells anyone else to pick another address or call `request_access`. |
| Create permission | "Ask Gio", also when the caller was Gio. | It tells an admin account to turn on "Can create shops" for its own account on the Users page. |
| `whoami` | No permission field. | `can_create_shops`, so `/new-shop` can check before it asks for a slug. |
| Audit of `shop_created` | The row had `shop_slug` NULL, so `list_audit` on the shop never showed it. | `audit()` takes the slug from the detail when the route has no `:slug`. |
| Audit actor | The username only. Gio's account has the username `admin`. | `actor` is `username <email>`. `actor_email` is a separate field. |
| `grant_access` for a person with no account | Refused. | The grant waits in the `pending_grants` table in `platform.db`. It applies at the first sign in, or when an admin creates the account. Launchpad writes no unproven users row. Launchpad refuses addresses outside the enroll domains. |
| Upload link | `/api/upload/<ticket>`. Every agent had to guess the host. | An absolute link when `SHOP_BASE_URL` or `FRONTEND_URL` is set. The response also has `expires_in_minutes: 15`. |
| Checkout go-live check | It split all of `ShopType.txt` on `:`. The template comment block became the shop type. | It reads `key: value` lines and skips comments, like the parser in the shop. |
| SKU go-live check | The label said "Every product has a SKU". The check also fails on duplicates. | The label is "Every product has its own SKU". |
| Orders on apply and rollback | Not carried forward. Every zip from the template has an empty `Orders/orders.csv`. A catalog update wiped the order history, and a rollback restored old orders. | The live `Orders` folder always stays, on apply and on rollback. The diff warns when a zip has an Orders folder. |
| Design-first upload | A zip with no collections was always blocked. | Allowed with a warning when the live shop has no products. Still blocked when it would empty a shop that has products. |

## New script

The script `scripts/reset-starter-database.js` puts an existing shop on the empty starter.
It does a dry run by default.
It refuses a shop in production or a shop with orders.
It also refuses a catalog that is not the template sample, unless you add `--force`.
It writes a backup that `rollback_database` can restore.

The shop the-ritz-carlton needs it. That shop still shows the Michael Kors sample catalog.

```bash
cd /root/Launchpad/Launchpad/backend
node scripts/reset-starter-database.js the-ritz-carlton
node scripts/reset-starter-database.js the-ritz-carlton --apply
```

After the reset, rebuild the shop from Launchpad. Then upload the Ritz-Carlton DATABASE.

## Tests

```
test/route-coverage.test.js   PASS
test/authz.test.js            95 assertions
test/staging.test.js          32 passed (4 new)
test/integration.test.js      170 assertions (26 new)
test/new-shop-flow.test.js    18 passed (new file)
```

## Deploy notes

There is no migration. The function `initPlatformDb()` creates `pending_grants` at boot.

Set `FRONTEND_URL` to the public address, for example `https://lrparisstore.com`.
The function `shopUrl()` already uses it.

Follow ADR-001-DEPLOY.md, and back up the three databases first.

## Needed in shuttle-mcp

The repo `shuttle-mcp` is private, so this branch cannot change it.

| Tool | Change |
|---|---|
| `whoami` | Pass `can_create_shops` through to the tool output. |
| `create_shop` | Pass `password` and `catalog` through. Fix the description: a new shop runs behind its password, at stage `no_status`, with an empty catalog. |
| `request_upload` | Pass `upload_url` and `expires_in_minutes` through unchanged. |
| `grant_access` | Pass `invited` and `email` through. The description is now true. |
| `list_audit` | Pass `actor_email` through. |
