/**
 * The version the shop reports at runtime.
 *
 * This file, not package.json, is what the UI reads. Launchpad copies it into
 * every shop as part of the override set, so bumping it here is what ships a
 * new Shuttle version to new shops. Existing shops pick it up on their next
 * template update.
 *
 * It replaces the Shuttle template's own lib/version.ts, so it must export
 * everything the template imports from '@/lib/version':
 *
 *   getVersion()      components/Footer.tsx
 *   getVersionInfo()  app/api/version/route.ts
 *   VERSION_INFO.name and VERSION_INFO.version   app/about/page.tsx, through /api/version
 *
 * A missing export is a type error, and a type error stops `next build`, so
 * a shop created with an incomplete copy of this file never comes up.
 * test/shop-overrides.test.js checks the list above.
 */
export const VERSION = 'STS-4.3.1';

export const VERSION_INFO = {
  name: 'Shop Template System',
  version: VERSION,
  codename: 'Beacon',
  releaseDate: '2026-10-20',
  description:
    'Product photos. main.* is always the first photo of a product, and the rest follow in natural name order.',
  attribution: 'Built with LR Paris Shuttle',
};

/** Current version string, for example "STS-4.2.1". */
export function getVersion(): string {
  return VERSION;
}

/** Full version info, served by /api/version and shown on the About page. */
export function getVersionInfo() {
  return VERSION_INFO;
}

/** Major version number: 4 for "STS-4.2.1". */
export function getMajorVersion(): number {
  const match = VERSION.match(/STS-(\d+)\./);
  return match ? parseInt(match[1], 10) : 0;
}

/** Minor version number: 2 for "STS-4.2.1". */
export function getMinorVersion(): number {
  const match = VERSION.match(/STS-\d+\.(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}
