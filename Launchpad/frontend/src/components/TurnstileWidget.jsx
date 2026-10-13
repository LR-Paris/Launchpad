import { useEffect, useRef } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { scriptPromise = null; reject(new Error('Turnstile did not load')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

// Cloudflare Turnstile check. Reports its token through onToken. A token works
// once, so the parent bumps resetKey after every sign-in attempt.
export default function TurnstileWidget({ siteKey, onToken, resetKey }) {
  const box = useRef(null);
  const widgetId = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then((ts) => {
        if (cancelled || !box.current) return;
        widgetId.current = ts.render(box.current, {
          sitekey: siteKey,
          theme: 'auto',
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken(''),
        });
      })
      .catch(() => onToken(''));
    return () => {
      cancelled = true;
      if (widgetId.current != null && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, onToken]);

  useEffect(() => {
    if (resetKey && widgetId.current != null && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      onToken('');
    }
  }, [resetKey, onToken]);

  return <div ref={box} className="flex justify-center min-h-[65px]" />;
}
