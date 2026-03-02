import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { changePassword, getSystemVersion, checkForUpdate, installUpdate, getShops, getSystemBranches } from '../lib/api';
import { ArrowLeft, Lock, Sun, Moon, Shield, Palette, Server, RefreshCw, Download, CheckCircle, Database, ExternalLink, Settings, GitBranch, AlertTriangle } from 'lucide-react';

export default function GlobalSettings({ theme, toggleTheme }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [updateLog, setUpdateLog] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branches, setBranches] = useState([]);
  const [currentBranch, setCurrentBranch] = useState('');

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

  // Version info
  const versionQuery = useQuery({
    queryKey: ['system-version'],
    queryFn: getSystemVersion,
  });

  // Check for update (manual trigger)
  const updateCheckMutation = useMutation({
    mutationFn: checkForUpdate,
  });

  // Install update
  const installMutation = useMutation({
    mutationFn: (branch) => installUpdate(branch || undefined),
    onSuccess: (data) => {
      setUpdateLog(data.log || 'Update completed successfully.');
      // Refresh version info
      versionQuery.refetch();
      updateCheckMutation.reset();
      // Refresh branches since we may be on a new branch now
      loadBranches();
    },
    onError: (err) => {
      setUpdateLog(err.response?.data?.log || err.response?.data?.error || 'Update failed.');
    },
  });

  // Shops data for database panel
  const { data: shopsData, isLoading: shopsLoading } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
    refetchInterval: 10000,
  });
  const allShops = shopsData?.shops || [];

  const version = versionQuery.data?.version || '...';
  const git = versionQuery.data?.git || {};
  const updateData = updateCheckMutation.data;

  // Load branches
  const loadBranches = async () => {
    setBranchesLoading(true);
    try {
      const data = await getSystemBranches();
      setBranches(data.branches || []);
      setCurrentBranch(data.currentBranch || '');
      if (!selectedBranch && data.currentBranch) {
        setSelectedBranch(data.currentBranch);
      }
    } catch {
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  };

  useEffect(() => {
    loadBranches();
  }, []);

  // Keep selectedBranch synced with git info if not yet set
  useEffect(() => {
    if (!selectedBranch && git.branch) {
      setSelectedBranch(git.branch);
    }
  }, [git.branch]);

  const handleUpdate = () => {
    const branch = selectedBranch || undefined;
    const switchingBranch = branch && branch !== currentBranch;
    const msg = switchingBranch
      ? `Switch to branch "${branch}" and update? The platform will rebuild and restart.`
      : 'Pull latest and update? The platform will rebuild and restart.';
    if (!window.confirm(msg)) return;
    setUpdateLog('');
    installMutation.mutate(branch);
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

        {/* Platform Info & Updates */}
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
              <span className="text-muted-foreground">Version</span>
              <span className="text-[hsl(188,100%,42%)] font-semibold text-sm">{version}</span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-border/30">
              <span className="text-muted-foreground">Git Branch</span>
              <span className="text-foreground inline-flex items-center gap-1.5">
                <GitBranch className="h-3 w-3 text-primary/60" />
                {git.branch || '...'}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-border/30">
              <span className="text-muted-foreground">Git Commit</span>
              <span className="text-foreground">{git.commit || '...'}</span>
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

          {/* Update Section */}
          <div className="mt-5 pt-4 border-t border-border/30">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Updates</h3>
            </div>

            {/* Check for update result */}
            {updateData && (
              <div className={`rounded-md border px-4 py-2.5 text-xs font-mono mb-4 ${
                updateData.updateAvailable
                  ? 'border-[hsl(48,100%,30%)] bg-[hsl(48,100%,5%)] text-[hsl(48,100%,60%)]'
                  : 'border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] text-[hsl(142,70%,50%)]'
              }`}>
                {updateData.updateAvailable ? (
                  <span>Update available: <strong>{updateData.remoteVersion}</strong> (current: {updateData.localVersion})</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Up to date ({updateData.localVersion})
                  </span>
                )}
              </div>
            )}

            {updateCheckMutation.isError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive font-mono mb-4">
                Failed to check for updates: {updateCheckMutation.error?.response?.data?.error || updateCheckMutation.error?.message}
              </div>
            )}

            {installMutation.isError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive font-mono mb-4">
                Update failed: {installMutation.error?.response?.data?.error || installMutation.error?.message}
              </div>
            )}

            {updateLog && (
              <pre className="rounded-md border border-border/40 bg-black/30 px-4 py-3 text-xs text-muted-foreground font-mono mb-4 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                {updateLog}
              </pre>
            )}

            {/* Branch Selection */}
            <div className="mb-4">
              <label className="flex items-center gap-1.5 text-xs font-semibold mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
                <GitBranch className="h-3.5 w-3.5 text-primary/70" />
                Target Branch
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={selectedBranch}
                  onChange={(e) => setSelectedBranch(e.target.value)}
                  disabled={installMutation.isPending}
                  className="flex-1 max-w-xs rounded-md border border-border bg-input px-3 py-2 text-xs font-mono outline-none focus:ring-1 focus:ring-primary/60 transition-all"
                >
                  {branches.length === 0 && selectedBranch && (
                    <option value={selectedBranch}>{selectedBranch}</option>
                  )}
                  {branches.map(b => (
                    <option key={b} value={b}>
                      {b}{b === currentBranch ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={loadBranches}
                  disabled={branchesLoading}
                  className="inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:text-primary bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
                  title="Refresh branches"
                >
                  <RefreshCw className={`h-3 w-3 ${branchesLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              {selectedBranch && selectedBranch !== currentBranch && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  <span>This will switch from <span className="font-mono">{currentBranch}</span> to <span className="font-mono">{selectedBranch}</span></span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => { setUpdateLog(''); updateCheckMutation.mutate(); }}
                disabled={updateCheckMutation.isPending}
                className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/40 transition-all disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${updateCheckMutation.isPending ? 'animate-spin' : ''}`} />
                {updateCheckMutation.isPending ? 'Checking...' : 'Check for Update'}
              </button>

              <button
                onClick={handleUpdate}
                disabled={installMutation.isPending || !selectedBranch}
                className="btn-launch inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm disabled:opacity-50"
              >
                <Download className={`h-4 w-4 ${installMutation.isPending ? 'animate-bounce' : ''}`} />
                {installMutation.isPending ? 'Updating...' : (
                  selectedBranch && selectedBranch !== currentBranch
                    ? 'Switch & Update'
                    : 'Pull & Update'
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Shops Database */}
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <Database className="h-4 w-4 text-primary/70" />
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Shops Database</h2>
            <span className="text-xs text-muted-foreground font-mono ml-1">({allShops.length} records)</span>
          </div>

          {shopsLoading ? (
            <p className="px-5 py-4 text-sm text-muted-foreground font-mono">Loading...</p>
          ) : allShops.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground font-mono">No shops in database.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-xs text-muted-foreground bg-muted/50">
                    <th className="px-4 py-2.5 text-left font-medium font-mono">ID</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">Name</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">URL Path</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">Created</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono"></th>
                  </tr>
                </thead>
                <tbody>
                  {allShops.map((shop) => (
                    <tr key={shop.id} className="border-b border-border/30 last:border-0 hover:bg-foreground/[0.02] transition-colors">
                      <td className="px-4 py-2.5 text-muted-foreground text-xs font-mono">{shop.id}</td>
                      <td className="px-4 py-2.5 text-xs">{shop.name}</td>
                      <td className="px-4 py-2.5 text-xs font-mono">
                        <a href={`/${shop.slug}/`} target="_blank" rel="noopener noreferrer"
                           className="text-primary hover:underline inline-flex items-center gap-0.5">
                          /{shop.slug} <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                        </a>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {shop.status === 'running' ? (
                            <span className="w-1.5 h-1.5 status-dot-running" />
                          ) : (
                            <span className={`w-1.5 h-1.5 rounded-full ${shop.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
                          )}
                          <span className={`text-xs font-mono ${
                            shop.status === 'running' ? 'text-[hsl(142,70%,50%)]'
                            : shop.status === 'error' ? 'text-destructive'
                            : 'text-muted-foreground'
                          }`}>{shop.status}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono whitespace-nowrap">
                        {shop.created_at?.slice(0, 16).replace('T', ' ') ?? '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/shops/${shop.slug}/settings`}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-secondary hover:bg-accent border border-border/60 transition-colors"
                        >
                          <Settings className="h-3 w-3" /> Settings
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
