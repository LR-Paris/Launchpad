import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { requestLoginCode, verifyLoginCode } from '../lib/api';
import { Rocket, ArrowLeft, Mail, ShieldCheck } from 'lucide-react';

const REMEMBER_OPTIONS = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '1m', label: '1 month' },
];

export default function Login() {
  const [step, setStep] = useState('identify'); // 'identify' | 'verify'
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [rememberMe, setRememberMe] = useState('1d');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const codeInputRef = useRef(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
      const data = await requestLoginCode(identifier);
      setMessage(data.message);
      setStep('verify');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await verifyLoginCode(identifier, code, rememberMe);
      queryClient.setQueryData(['auth'], data);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
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
            </p>
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
            {error && <p className="text-xs text-destructive font-mono">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full btn-launch rounded-md px-4 py-2.5 text-sm font-medium disabled:opacity-50 transition-all"
            >
              {loading ? 'Sending code...' : 'Send sign-in code'}
            </button>
          </form>
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

            {/* Remember me */}
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground">
                Remember me for
              </label>
              <div className="flex rounded-lg border border-border/60 overflow-hidden">
                {REMEMBER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRememberMe(opt.value)}
                    className={`flex-1 px-2 py-1.5 text-xs font-medium transition-all ${
                      rememberMe === opt.value
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                    } ${opt.value !== '1h' ? 'border-l border-border/60' : ''}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

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
