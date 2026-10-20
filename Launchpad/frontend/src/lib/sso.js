// lib/sso.js — "Sign in with Launchpad" on the browser side.
//
// Another LR Paris app (LR Parrot first) sends the browser to
// /api/auth/sso/authorize. When nobody is signed in, the backend sends it on to
// /login?next=<that authorize URL> (backend/src/sso.js). Once the email code or
// the passkey has signed the person in, the page does
// window.location.assign(next): a full page load, not a router navigation,
// because the backend answers that URL with a redirect to the other app.
//
// That one path is the only `next` this page will follow. Anything else is
// ignored, so the sign-in page cannot be used to send someone to an address of
// an attacker's choosing. The path is fixed and starts with "/a", so the
// browser always resolves it on this origin.
export const SSO_AUTHORIZE_PREFIX = '/api/auth/sso/authorize?';

export function ssoNext(search = typeof window !== 'undefined' ? window.location.search : '') {
  let next = null;
  try {
    next = new URLSearchParams(search).get('next');
  } catch {
    return null;
  }
  return typeof next === 'string' && next.startsWith(SSO_AUTHORIZE_PREFIX) ? next : null;
}
