/**
 * The version the shop reports at runtime.
 *
 * This file, not package.json, is what the UI reads. Launchpad copies it into
 * every shop as part of the override set, so bumping it here is what ships a
 * new Shuttle version to new shops. Existing shops pick it up on their next
 * template update.
 */
export const VERSION = 'STS-4.2.0';

export const VERSION_INFO = {
  codename: 'Beacon',
  releaseDate: '2026-09-16',
  description:
    'Stage banner. A store that is not in production shows a fixed internal-only banner on every page and is marked noindex, driven by SHOP_STAGE at build time.',
};
