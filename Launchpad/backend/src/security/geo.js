// geo.js — requester IP + coarse location for auth emails.
// Prefers Cloudflare's own location headers (zero latency, already on the request
// when the "Add visitor location headers" Managed Transform is enabled in
// Cloudflare). Falls back to a short, timeout-bounded geo lookup so it never
// blocks the login path for long. Dependency-free (global fetch).

const LOOKUP_TIMEOUT_MS = Number(process.env.GEO_TIMEOUT_MS || 1500);

function clientIp(req) {
  const h = req.headers || {};
  return (h['cf-connecting-ip']
    || (h['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip || '').trim();
}

// From Cloudflare headers, if the location Managed Transform is on.
function locationFromHeaders(req) {
  const h = req.headers || {};
  const parts = [h['cf-ipcity'], h['cf-region'], (h['cf-ipcountry'] || '').toUpperCase()]
    .filter(Boolean);
  return parts.join(', ');
}

// Fallback lookup (https, no API key). Returns '' on any failure/timeout.
async function geoLookup(ip) {
  if (!ip) return '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=city,region,country_code,success`,
      { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (!d || d.success === false) return '';
    return [d.city, d.region, d.country_code].filter(Boolean).join(', ');
  } catch (_) { return ''; }
}

// Returns { ip, location } — headers first, lookup only if needed.
async function requestMeta(req) {
  const ip = clientIp(req);
  let location = locationFromHeaders(req);
  if (!location && ip) location = await geoLookup(ip);
  return { ip: ip || 'unknown', location: location || 'unknown location' };
}

// One-line string for an email body.
function requestedFromLine(meta) {
  return `Requested from ${meta.ip} · ${meta.location} · ${new Date().toUTCString()}`;
}

module.exports = { clientIp, locationFromHeaders, geoLookup, requestMeta, requestedFromLine };
