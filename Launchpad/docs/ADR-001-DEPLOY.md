# ADR-001 deploy record — 2026-09-16

Live on `138.197.230.129` since 19:41 UTC. Backend and `shuttle-mcp` shipped together;
no shop was rebuilt, so no storefront changed.

## Branches and repos

| Repo | Branch | Head |
|---|---|---|
| `LR-Paris/Launchpad` | `feat/shuttle-dev-tool` | `d8b16fa` |
| `LR-Paris/shuttle-mcp` | `main` | `374e822` |
| `LR-Paris/shuttle-plugin` | `main` | `6f3a932` |

On the server, `pre-adr001-local-state-20260916T192249Z` holds the exact working tree from
before the deploy, including the 451 lines of `email.js` work that had never been committed.

## What is running

- Every `/:slug` route is behind `requireShopAccess`. 70 guarded, 7 public by design.
- Membership is the `role` column on `user_shop_permissions`, backfilled most-generous-wins.
  13 rows became 8 owner, 3 editor, 2 viewer. Nobody lost access. Gio owns all 18 shops.
- New state is in `backend/data/platform.db`. Deleting that file rolls back everything new.
- `shuttle-mcp` on `127.0.0.1:3002`, behind `location = /mcp` and `location /mcp/`.
  OAuth discovery answers at the domain root. No docker socket, no Launchpad mount.
- A request signed by the MCP is never an admin. Verified live: Gio over MCP cannot create
  a user, cannot reach `/api/users`, `/api/system` or `/api/mission-control`, and cannot set
  a shop to `in_production`.

Refusals as they actually came back:

```
Margot -> serhant   403 NOT_A_MEMBER   You have no access to "serhant".
                                       Call request_access for that shop, and its owners decide.
Brigid -> set_stage 403 ROLE_TOO_LOW   Your access to "michael-kors" is editor, and this needs owner.
                                       Ask Charles Dolige, Giovanni Lupo or Margot to raise your access.
```

## Backups

`/root/backups/predeploy-20260916T192249Z/` — all three databases via sqlite `.backup`,
audit.log, docker-compose.yml, .env, and the nginx config as it was.
`/root/backups/adr001-20260916T182612Z/` also holds a 451 MB tar of every shop's DATABASE.

Rollback is three commands:

```bash
cd /root && git checkout pre-adr001-local-state-20260916T192249Z
cp /root/backups/predeploy-20260916T192249Z/*.db /root/Launchpad/backend/data/
cd /root/Launchpad && docker compose up -d --force-recreate backend
```

`platform.db` can stay; nothing older reads it.

## Two things that broke during the deploy

**The nginx include is generated, and it was tracked in git.** Checking out the branch
replaced it with an older copy and amex-aviation, morgan-stanley and vista lost their
location blocks, so all three served the Launchpad SPA instead of the store for about two
minutes. Restored from the preservation branch; the file is now in `.gitignore`, same as
`backend/data/` and `shops/`. If you ever check out a branch from before commit `00b34c3`,
this will happen again.

**Health told the truth in `why` and the opposite in `title`.** A shop with 48 unshipped
orders reported "No orders waiting", and the suggestions named `get_catalog`, `get_orders`
and four other tools that do not exist. Both fixed in `d8b16fa`, and `route-coverage.test.js`
now fails if `health.js` names a tool that is not real.

## Four holes that were already open, now closed

These predate the ADR and were live on the server.

1. `POST /api/shops/:slug/files/upload-zip` took a `path` query parameter, joined it, and
   `rmSync`'d the target with no confinement check. An editor on any one shop could delete
   and overwrite `backend/data/` — users.db, shops.db, sessions.db — or any other shop's
   folder. Reproduced, then closed: `safeShopPath` is now mandatory on every path in that file.
2. Both zip readers trusted the uncompressed size the zip declared about itself. A 1 MB file
   took the backend from 68 MB to 2.2 GB in a second. Now inflated through a real cap with a
   CRC check.
3. `PATCH /api/shops/:slug` let anyone with `can_edit_ui` set a shop live. No admin check.
4. `checkout.js` was mounted at `/api/shops` while declaring `/shops/:slug/...`, so it served
   `/api/shops/shops/:slug/...`. The checkout schema editor has been dead for months and
   every save silently 404'd.

## What is not done

- **Nobody has installed the plugin yet.** Phase 3 is built and pushed but unexercised.
  Onboard two people and watch the first session, as the ADR says.
- **The stage banner is not live.** `SHOP_STAGE` reaches new shops only. The 18 running shops
  keep their current build until something rebuilds them, and a rebuild now would put
  "INTERNAL ONLY" on any shop not marked `in_production`. Five are: michael-kors, serhant,
  lw-attire, elc-premiums, demo. Backfill before the next rebuild, one shop at a time.
  michael-kors is pre-template and needs doing by hand.
- **Ten shops have only Gio as owner** — serhant, bozzuto, breitling, specialized,
  legrandhotel, amex-aviation, morgan-stanley, vista, elc-premiums, demo. Until the real
  account people are made owners, they cannot use the tool on their own shops.
- `LAUNCHPAD_STRICT_SHOP_LIST` is off, so the web dashboard still shows everyone every shop.
  Turn it on once owners are assigned.
- The admin password is still shared. ADR action item 6.
- A read-only `backend/data/` still stops the backend at boot, in pre-ADR code. Separate fix.
- Nothing ties `shuttle-mcp`'s registered tool names to the backend's `MCP_TOOLS` constant.
  One assertion in `mcp/test/tools.test.js` would close it.

## Test suites

```
backend/test/route-coverage.test.js    70 guarded, 7 public by design
backend/test/authz.test.js             89 assertions
backend/test/staging.test.js           28 passed
backend/test/integration.test.js       115 assertions, real server over HTTP
shuttle-mcp  npm test                  42 passed
```

`integration.test.js` boots the backend as a process and walks enrollment, refusal, grant,
health, and a stage-apply-rollback round trip that ends byte-identical. Run it before any
future backend change.
