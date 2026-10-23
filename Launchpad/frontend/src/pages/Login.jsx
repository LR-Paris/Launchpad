import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { requestLoginCode, verifyLoginCode, getAuthConfig, resetCsrfToken } from '../lib/api';
import TurnstileWidget from '../components/TurnstileWidget';
import { loginWithPasskey, passkeySupported, listPasskeys, registerPasskey } from '../lib/passkey';
import { ssoNext } from '../lib/sso';
import { Rocket, ArrowLeft, Mail, ShieldCheck, KeyRound, Fingerprint } from 'lucide-react';

// The backend renews the session on every visit, so each choice counts from the
// last time the person used Launchpad (backend/src/session-policy.js).
const REMEMBER_OPTIONS = [
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '1m', label: '1 month' },
  { value: '3m', label: '3 months' },
];
const DEFAULT_REMEMBER = '1m';

// After an email-code sign in, offer to add a passkey, at most once a month.
const PASSKEY_OFFER_KEY = 'lp-passkey-offer-dismissed-at';
const PASSKEY_OFFER_QUIET_MS = 30 * 24 * 60 * 60 * 1000;

function passkeyOfferDismissedRecently() {
  try {
    const at = Number(localStorage.getItem(PASSKEY_OFFER_KEY) || 0);
    return at > 0 && Date.now() - at < PASSKEY_OFFER_QUIET_MS;
  } catch {
    return false;
  }
}

function rememberPasskeyOfferDismissed() {
  try { localStorage.setItem(PASSKEY_OFFER_KEY, String(Date.now())); } catch { /* best effort */ }
}

// A readable default name for the new passkey, shown later under Settings.
function deviceName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

export default function Login() {
  const [step, setStep] = useState('identify'); // 'identify' | 'verify' | 'passkey-offer'
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [rememberMe, setRememberMe] = useState(DEFAULT_REMEMBER);
  const [signedIn, setSignedIn] = useState(null); // user payload held while the passkey offer shows
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const codeInputRef = useRef(null);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileReset, setTurnstileReset] = useState(0);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Set when another LR Paris app sent the person here to sign in
  // (lib/sso.js). After sign in the page goes back there instead of to '/'.
  const sso = ssoNext(useLocation().search);

  useEffect(() => {
    getAuthConfig()
      .then((cfg) => setTurnstileSiteKey(cfg.turnstileSiteKey || null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === 'verify' && codeInputRef.current) {
      codeInputRef.current.focus();
    }
  }, [step]);

  const handleRequestCode = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      const data = await requestLoginCode(identifier, turnstileToken);
      // Someone typing an email address is told a code is on its way. The
      // neutral words ("If an account exists...") are the API's answer to
      // everyone, so it never says who has an account; on this page they only
      // made a person with no account yet think they had none. A username gets
      // the neutral words.
      const typed = identifier.trim();
      setMessage(typed.includes('@') ? `We sent a 6-digit code to ${typed}. It can take a minute.` : data.message);
      setStep('verify');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send code');
    } finally {
      setLoading(false);
      if (turnstileSiteKey) setTurnstileReset((n) => n + 1);
    }
  };

  const handleVerifyCode = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await verifyLoginCode(identifier, code, rememberMe);
      resetCsrfToken(); // the session is new, so is its CSRF token
      // Signed in. Before going in, offer a passkey if this browser can hold
      // one and the account has none yet. Setting the auth data is what leaves
      // this page, so it waits until the offer is answered. Someone on their
      // way back to another app goes straight there; the offer can wait for
      // their next sign-in on Launchpad itself.
      if (!sso && await shouldOfferPasskey()) {
        setSignedIn(data);
        setStep('passkey-offer');
        return;
      }
      finishSignIn(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const shouldOfferPasskey = async () => {
    if (!passkeySupported() || passkeyOfferDismissedRecently()) return false;
    try {
      return (await listPasskeys()).length === 0;
    } catch {
      return false;
    }
  };

  const finishSignIn = (data) => {
    if (sso) {
      window.location.assign(sso);
      return;
    }
    queryClient.setQueryData(['auth'], data);
    navigate('/');
  };

  const handleAddPasskey = async () => {
    setError('');
    setLoading(true);
    try {
      await registerPasskey(deviceName());
      finishSignIn(signedIn);
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        setLoading(false); // they closed the prompt; leave both buttons there
        return;
      }
      setError(err.response?.data?.error || 'Could not add the passkey. You can add one later under Settings.');
      setLoading(false);
    }
  };

  const handleSkipPasskey = () => {
    rememberPasskeyOfferDismissed();
    finishSignIn(signedIn);
  };

  const handlePasskeyLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const data = await loginWithPasskey(rememberMe);
      resetCsrfToken();
      finishSignIn(data);
    } catch (err) {
      // Canceling the OS passkey prompt throws NotAllowed/Abort — not a real error.
      const name = err && err.name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError(err.response?.data?.error || 'Passkey sign-in failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[80vh]">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: '#39C5BB' }}>
            <Rocket className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: 'Syne, sans-serif' }}>
            Launchpad
          </h1>
        </div>

        {step === 'identify' ? (
          <form onSubmit={handleRequestCode} className="space-y-4 rounded-xl border bg-card p-6">
            <div className="flex items-center gap-2 mb-2">
              <Mail className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold" style={{ fontFamily: 'Syne, sans-serif' }}>Sign in</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter your username or email. We'll send a sign-in code to your email.
              Any LR Paris email can sign in.
            </p>
            {sso && (
              <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
                After you sign in, you go back to the app that sent you here.
              </p>
            )}
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground" htmlFor="identifier">
                Username or Email
              </label>
              <input
                id="identifier"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring transition-all"
                placeholder="you@example.com"
                required
                autoFocus
                autoComplete="username"
              />
            </div>
            {turnstileSiteKey && (
              <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} resetKey={turnstileReset} />
            )}
            {/* Stay signed in: applies to the email code and to a passkey alike. */}
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground">
                Stay signed in for
              </label>
              <div className="flex rounded-lg border border-border/60 overflow-hidden">
                {REMEMBER_OPTIONS.map((opt, i) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRememberMe(opt.value)}
                    aria-pressed={rememberMe === opt.value}
                    className={`flex-1 px-2 py-1.5 text-xs font-medium transition-all ${
                      rememberMe === opt.value
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                    } ${i > 0 ? 'border-l border-border/60' : ''}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Counted from your last visit.</p>
            </div>
            {error && <p className="text-xs text-destructive font-mono">{error}</p>}
            <button
              type="submit"
              disabled={loading || (turnstileSiteKey && !turnstileToken)}
              className="w-full btn-launch rounded-md px-4 py-2.5 text-sm font-medium disabled:opacity-50 transition-all"
            >
              {loading ? 'Sending code...' : 'Send sign-in code'}
            </button>

            <div className="flex items-center gap-2 my-1">
              <div className="flex-1 h-px bg-border/60" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border/60" />
            </div>
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium hover:bg-muted/40 disabled:opacity-50 transition-all"
            >
              <KeyRound className="h-4 w-4" />
              Sign in with a passkey
            </button>
          </form>
        ) : step === 'passkey-offer' ? (
          <div className="space-y-4 rounded-xl border bg-card p-6">
            <div className="flex items-center gap-2 mb-2">
              <Fingerprint className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold" style={{ fontFamily: 'Syne, sans-serif' }}>Skip the email code next time</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              You're signed in. Add a passkey and next time you sign in with Face ID, Touch ID or your
              device PIN. It also works when you connect Claude to your shops.
            </p>
            {error && <p className="text-xs text-destructive font-mono">{error}</p>}
            <button
              type="button"
              onClick={handleAddPasskey}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 btn-launch rounded-md px-4 py-2.5 text-sm font-medium disabled:opacity-50 transition-all"
            >
              <KeyRound className="h-4 w-4" />
              {loading ? 'Waiting for your device...' : 'Add a passkey'}
            </button>
            <button
              type="button"
              onClick={handleSkipPasskey}
              disabled={loading}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1 disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        ) : (
          <form onSubmit={handleVerifyCode} className="space-y-4 rounded-xl border bg-card p-6">
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold" style={{ fontFamily: 'Syne, sans-serif' }}>Enter your code</h2>
            </div>
            {message && (
              <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs text-primary font-mono">
                {message}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground" htmlFor="code">
                6-digit code
              </label>
              <input
                ref={codeInputRef}
                id="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-md border bg-background px-3 py-3 text-center text-xl font-mono tracking-[0.5em] outline-none focus:ring-2 focus:ring-ring transition-all"
                placeholder="000000"
                required
                autoComplete="one-time-code"
              />
            </div>

            <p className="text-[11px] text-muted-foreground">
              You stay signed in for {REMEMBER_OPTIONS.find((o) => o.value === rememberMe)?.label} after your last visit.
            </p>

            {error && <p className="text-xs text-destructive font-mono">{error}</p>}

            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full btn-launch rounded-md px-4 py-2.5 text-sm font-medium disabled:opacity-50 transition-all"
            >
              {loading ? 'Verifying...' : 'Sign in'}
            </button>

            <button
              type="button"
              onClick={() => { setStep('identify'); setCode(''); setError(''); setMessage(''); }}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <ArrowLeft className="h-3 w-3" />
              Use a different account
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
