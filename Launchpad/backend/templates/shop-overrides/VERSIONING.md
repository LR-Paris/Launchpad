# Shuttle override set versioning

Launchpad copies the files in `backend/templates/shop-overrides/` on top of every
new shop after it clones the Shuttle template. `lib/version.ts` in that set is
what the shop reports at runtime, so this file is the changelog for the set.

Bump `lib/version.ts` and add a row here in the same change. `package.json` is
not the version the UI reads.

| Version | Date | What changed |
|---------|------|--------------|
| STS-4.2.0 | 2026-09-16 | Stage banner. A shop whose `SHOP_STAGE` is anything other than `in_production` renders a fixed, undismissable banner at the top of every page reading "Internal only. This store is not approved.", plus a `noindex,nofollow` robots tag in `<head>` and an `X-Robots-Tag: noindex,nofollow` header on every response. The banner is rendered by the root layout, so no page can leave it out, and the value is read at build time, so there is nothing to toggle at runtime. Launchpad passes `SHOP_STAGE` into the container and rebuilds the shop when the stage changes. |
| STS-4.1.0 | 2026 | Shop display presets. `useShopPresets` reads `/presets` for whether prices show and whether the copy says request or order. |
| STS-3.0.0 | 2026-04-29 | Product variant selector. Two level color and size picker, variant grouping in the catalog, variant chips on collection cards. |
| STS-2.0.5 | early 2026 | Stable base. Base path routing, `apiFetch`, `FadeImage`, inventory tracking. |

## Files in the override set

| File | What it is for |
|------|----------------|
| `lib/api.ts` | `apiFetch`, `apiUrl`, `assetUrl`. Shop pages must use these, never a bare `fetch('/api/...')`. |
| `lib/design.ts` | Reads the DATABASE design files. |
| `lib/useShopPresets.ts` | Client side view of the display presets. |
| `lib/version.ts` | The version string the UI reads. |
| `components/Analytics.tsx` | Page view beacon, injected into the layout at creation time. |
| `components/StageBanner.tsx` | The internal-only banner and the robots tag, injected into the layout at creation time. |
| `next.config.js` | Base path, asset prefix, trailing slash, and the `X-Robots-Tag` header for a shop that is not in production. |
| `tsconfig.json`, `next-env.d.ts` | Path aliases and Next types. |
| `app/`, `DATABASE/Checkout/schema.json` | Checkout page, order and schema routes, default checkout form. |
