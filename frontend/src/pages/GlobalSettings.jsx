import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { changePassword } from '../lib/api';
import { ArrowLeft, Lock, Sun, Moon, Shield, Palette, Server } from 'lucide-react';

export default function GlobalSettings({ theme, toggleTheme }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  const changePwMutation = useMutation({
    mutationFn: () => changePassword(oldPassword, newPassword),
    onSuccess: () => {
      setPwSuccess('Password changed successfully.');
      setPwError('');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPwSuccess(''), 4000);
    },
    onError: (err) => {
      setPwError(err.response?.data?.error || 'Failed to change password.');
      setPwSuccess('');
    },
  });

  const handleChangePw = (e) => {
    e.preventDefault();
    setPwError('');
    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setPwError('New password must be at least 8 characters.');
      return;
    }
    changePwMutation.mutate();
  };

  return (
    <div className="max-w-2xl lp-fadein">
      <div className="flex items-center gap-3 mb-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
        <div>
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">System</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Settings</h1>
        </div>
      </div>

      <div className="space-y-5">

        {/* Appearance */}
        <div className="lp-card rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                 style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
              <Palette className="h-3.5 w-3.5 lp-glow" />
            </div>
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Appearance</h2>
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Currently using <span className="font-mono text-primary">{theme}</span> mode
              </p>
            </div>
            <button
              onClick={toggleTheme}
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/40 transition-all"
            >
              {theme === 'dark'
                ? <><Sun className="h-4 w-4" /> Switch to Light</>
                : <><Moon className="h-4 w-4" /> Switch to Dark</>}
            </button>
          </div>
        </div>

        {/* Admin Account */}
        <div className="lp-card rounded-xl p-5">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                 style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
              <Shield className="h-3.5 w-3.5 lp-glow" />
            </div>
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Admin Account</h2>
          </div>

          <div className="flex items-center gap-2 mb-5">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Change Password</h3>
          </div>

          {pwSuccess && (
            <div className="rounded-md border border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] px-4 py-2.5 text-xs text-[hsl(142,70%,50%)] font-mono mb-4">
              {pwSuccess}
            </div>
          )}
          {pwError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive font-mono mb-4">
              {pwError}
            </div>
          )}

          <form onSubmit={handleChangePw} className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground" htmlFor="oldPw">
                Current Password
              </label>
              <input
                id="oldPw"
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
                required
                disabled={changePwMutation.isPending}
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground" htmlFor="newPw">
                New Password
              </label>
              <input
                id="newPw"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
                required
                minLength={8}
                disabled={changePwMutation.isPending}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground mt-1">Minimum 8 characters.</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 text-muted-foreground" htmlFor="confirmPw">
                Confirm New Password
              </label>
              <input
                id="confirmPw"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
                required
                disabled={changePwMutation.isPending}
                autoComplete="new-password"
              />
            </div>
            <div className="pt-1">
              <button
                type="submit"
                disabled={changePwMutation.isPending}
                className="btn-launch inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-sm disabled:opacity-50"
              >
                <Lock className="h-4 w-4" />
                {changePwMutation.isPending ? 'Changing...' : 'Change Password'}
              </button>
            </div>
          </form>
        </div>

        {/* Platform Info */}
        <div className="lp-card rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                 style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
              <Server className="h-3.5 w-3.5 lp-glow" />
            </div>
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Platform</h2>
          </div>
          <div className="space-y-2.5 font-mono text-xs">
            <div className="flex items-center justify-between py-1.5 border-b border-border/30">
              <span className="text-muted-foreground">Template</span>
              <span className="text-foreground">Shuttle LC-0.12</span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-border/30">
              <span className="text-muted-foreground">Database zip extraction</span>
              <span className="text-[hsl(142,70%,50%)]">replaces DATABASE folder</span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-border/30">
              <span className="text-muted-foreground">Orders path</span>
              <span className="text-foreground">DATABASE/Orders/Orders.csv</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">Password path</span>
              <span className="text-foreground">DATABASE/Design/Details/Password.txt</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
