import { useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, ShieldCheck } from 'lucide-react';
import { listPasskeys, registerPasskey, deletePasskey, passkeySupported } from '../lib/passkey';

// Account-level passkey management. Rendered on the /settings page.
export default function PasskeysCard() {
  const [passkeys, setPasskeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const supported = passkeySupported();

  const refresh = async () => {
    try { setPasskeys(await listPasskeys()); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const handleAdd = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      const nickname = (window.prompt('Name this passkey (e.g. "MacBook Touch ID")') || '').trim();
      await registerPasskey(nickname);
      setMsg('Passkey added.');
      await refresh();
    } catch (err) {
      const name = err && err.name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError((err.response && err.response.data && err.response.data.error) || err.message || 'Could not add passkey');
      }
    } finally { setBusy(false); }
  };

  const handleRemove = async (id) => {
    if (!window.confirm('Remove this passkey? You will not be able to sign in with it anymore.')) return;
    setError(''); setMsg(''); setBusy(true);
    try { await deletePasskey(id); await refresh(); }
    catch (err) { setError((err.response && err.response.data && err.response.data.error) || 'Could not remove passkey'); }
    finally { setBusy(false); }
  };

  return (
    <div className="lp-card rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
             style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
          <KeyRound className="h-3.5 w-3.5 lp-glow" />
        </div>
        <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Passkeys</h2>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Sign in with Face ID, Touch ID, or your device PIN instead of an emailed code.
        Passkeys are phishing-resistant; your email code still works as a backup.
      </p>

      {!supported && (
        <p className="text-xs text-destructive font-mono mb-3">This browser does not support passkeys.</p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground mb-4">Loading...</p>
      ) : passkeys.length === 0 ? (
        <p className="text-xs text-muted-foreground mb-4">No passkeys yet.</p>
      ) : (
        <div className="space-y-2 mb-4">
          {passkeys.map((p) => (
            <div key={p.credential_id}
                 className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                  {p.nickname || 'Passkey'}
                </p>
                <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                  {p.device_type === 'multiDevice' ? 'Synced' : 'This device'}
                  {p.last_used_at ? ` - last used ${new Date(p.last_used_at).toLocaleDateString()}` : ' - never used'}
                </p>
              </div>
              <button onClick={() => handleRemove(p.credential_id)} disabled={busy}
                className="inline-flex items-center gap-1 text-xs text-destructive hover:bg-destructive/10 rounded px-2 py-1 transition-all disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-destructive font-mono mb-2">{error}</p>}
      {msg && <p className="text-xs text-primary font-mono mb-2">{msg}</p>}

      <button onClick={handleAdd} disabled={busy || !supported}
        className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/40 transition-all disabled:opacity-50">
        <Plus className="h-4 w-4" /> {busy ? 'Working...' : 'Add a passkey'}
      </button>
    </div>
  );
}
