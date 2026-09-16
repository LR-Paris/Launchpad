/** @type {import('next').NextConfig} */

// SHOP_STAGE comes from the container environment, which Launchpad writes into
// docker-compose.yml. Read here, at build time, so the header is compiled into
// the shop rather than decided per request. Any value other than
// 'in_production' means the site is not approved, including a missing value.
const SHOP_STAGE = process.env.SHOP_STAGE || '';
const IS_APPROVED = SHOP_STAGE === 'in_production';

const noindexHeaders = IS_APPROVED
  ? []
  : [
      {
        // Every path, so a crawler cannot reach an unapproved store through a
        // page nobody remembered to mark. Matches the banner condition exactly.
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex,nofollow' },
        ],
      },
    ];

const nextConfig = {
  images: { unoptimized: true },
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || '',
  trailingSlash: true,
  async headers() {
    return [
      ...noindexHeaders,
      {
        source: '/api/images/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
        ],
      },
    ];
  },
}

module.exports = nextConfig
