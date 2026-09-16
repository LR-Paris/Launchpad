/**
 * Internal-only banner for a shop that is not approved.
 *
 * Rendered by the root layout as the first child of <body>, so it sits above
 * the shop header and no individual page can leave it out.
 *
 * SHOP_STAGE comes from the container environment, which Launchpad writes into
 * docker-compose.yml. This is a server component, so the check happens when the
 * page is built, not in the browser: there is no flash, nothing to dismiss, and
 * no client script that could fail and hide it.
 *
 * Any value other than 'in_production' shows the banner, including a missing
 * value. A shop that has not been told what it is counts as not approved.
 */

const STAGE = process.env.SHOP_STAGE || '';
const IS_APPROVED = STAGE === 'in_production';

// LR Paris accent orange, from the approved 2026 palette. Black on it is
// 7.1:1, past AA, and it reads as a warning without reading as an error.
// A yellow tested higher but is not a brand color, and adding one needs
// Design and Marketing sign-off. One token, so swapping it later is one line.
const BANNER_BG = '#FF6423';
const BANNER_FG = '#000000';
const BANNER_MIN_HEIGHT = 64;

/**
 * The robots tag that goes with the banner.
 *
 * The layout renders this inside <head>, because a robots tag in the body is
 * ignored by search engines. The X-Robots-Tag header in next.config.js says the
 * same thing on every response and is the one that does the real work; this tag
 * is here so the page says it about itself too.
 */
export function StageRobotsMeta() {
  if (IS_APPROVED) return null;
  return <meta name="robots" content="noindex,nofollow" />;
}

export default function StageBanner() {
  if (IS_APPROVED) return null;

  return (
    <>
      <div
        role="alert"
        aria-live="polite"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 2147483647,
          minHeight: `${BANNER_MIN_HEIGHT}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '2px',
          padding: '10px 16px',
          background: BANNER_BG,
          color: BANNER_FG,
          borderBottom: `2px solid ${BANNER_FG}`,
          textAlign: 'center',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          boxSizing: 'border-box',
        }}
      >
        <strong
          style={{
            fontSize: '15px',
            fontWeight: 800,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            lineHeight: 1.2,
          }}
        >
          Internal only. This store is not approved.
        </strong>
        <span style={{ fontSize: '13px', lineHeight: 1.35 }}>
          Test site for LR Paris and client review. Do not place orders.
        </span>
      </div>
      {/* Holds the same space in the flow so the shop header is not covered. */}
      <div aria-hidden="true" style={{ minHeight: `${BANNER_MIN_HEIGHT}px` }} />
    </>
  );
}
