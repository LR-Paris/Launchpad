import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deployShop, deleteShop, getShops, updateShop, getShopLogs, shopAction,
  listShopFiles, readShopFile, writeShopFile, changePassword, uploadShopFiles,
} from '../lib/api';
import {
  ArrowLeft, Rocket, Trash2, Terminal, Database, Save, RefreshCw,
  Play, Square, RotateCcw, Folder, FileText, ChevronRight, X, Lock, Eye, EyeOff, Upload,
} from 'lucide-react';

export default function Settings() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [deployLog, setDeployLog] = useState('');
  const terminalRef = useRef(null);

  // Edit state per shop slug
  const [editValues, setEditValues] = useState({});
  const [editingSlug, setEditingSlug] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  // Password change state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showOldPw, setShowOldPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [pwMessage, setPwMessage] = useState('');
  const [pwError, setPwError] = useState('');

  // File browser state
  const [browsePath, setBrowsePath] = useState('.');
  const [openFilePath, setOpenFilePath] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileEdited, setFileEdited] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileError, setFileError] = useState('');
  const [fileSuccess, setFileSuccess] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef(null);

  // Fetch all shops for the database viewer
  const { data: shopsData, isLoading: shopsLoading } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
    refetchInterval: 10000,
  });
  const allShops = shopsData?.shops || [];

  // Live logs for current shop
  const { data: logsData, refetch: refetchLogs } = useQuery({
    queryKey: ['shop-logs', slug],
    queryFn: () => getShopLogs(slug, 200),
    refetchInterval: 5000,
  });

  // File listing for browser
  const { data: filesData, isLoading: filesLoading, refetch: refetchFiles } = useQuery({
    queryKey: ['shop-files', slug, browsePath],
    queryFn: () => listShopFiles(slug, browsePath),
  });

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logsData?.logs, deployLog]);

  const deployMutation = useMutation({
    mutationFn: () => deployShop(slug),
    onSuccess: (data) => {
      setMessage(data.message);
      setDeployLog(data.log || '');
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['shop-logs', slug] });
    },
    onError: (err) => {
      setMessage(err.response?.data?.error || 'Deploy failed');
      setDeployLog(err.response?.data?.log || '');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteShop(slug, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      navigate('/');
    },
    onError: (err) => setMessage(err.response?.data?.error || 'Delete failed'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ targetSlug, data }) => updateShop(targetSlug, data),
    onSuccess: (data) => {
      setSaveSuccess(`Saved changes for "${data.shop.slug}".`);
      setSaveError('');
      setEditingSlug(null);
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setTimeout(() => setSaveSuccess(''), 3000);
    },
    onError: (err) => {
      setSaveError(err.response?.data?.error || 'Failed to save');
    },
  });

  const actionMutation = useMutation({
    mutationFn: (action) => shopAction(slug, action),
    onSuccess: () => {
      setMessage('');
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['shop-logs', slug] });
    },
    onError: (err) => setMessage(err.response?.data?.error || 'Action failed'),
  });

  const handleDelete = () => {
    if (window.confirm(`Permanently delete shop "${slug}" and all its files?`)) {
      deleteMutation.mutate();
    }
  };

  const startEdit = (shop) => {
    setEditingSlug(shop.slug);
    setEditValues((prev) => ({
      ...prev,
      [shop.slug]: { name: shop.name, port: String(shop.port), subdomain: shop.subdomain },
    }));
    setSaveError('');
    setSaveSuccess('');
  };

  const cancelEdit = () => {
    setEditingSlug(null);
    setSaveError('');
  };

  const handleSave = (targetSlug) => {
    const vals = editValues[targetSlug];
    if (!vals) return;
    updateMutation.mutate({ targetSlug, data: { name: vals.name, port: vals.port, subdomain: vals.subdomain } });
  };

  const setField = (shopSlug, field, value) => {
    setEditValues((prev) => ({
      ...prev,
      [shopSlug]: { ...prev[shopSlug], [field]: value },
    }));
  };

  // Password change handler
  const handleChangePassword = async () => {
    setPwError('');
    setPwMessage('');
    try {
      await changePassword(oldPassword, newPassword);
      setPwMessage('Password changed successfully.');
      setOldPassword('');
      setNewPassword('');
      setTimeout(() => setPwMessage(''), 4000);
    } catch (err) {
      setPwError(err.response?.data?.error || 'Failed to change password');
    }
  };

  // File browser handlers
  const openFile = async (filePath) => {
    setFileError('');
    setFileSuccess('');
    try {
      const data = await readShopFile(slug, filePath);
      setOpenFilePath(filePath);
      setFileContent(data.content);
      setFileEdited(data.content);
      setFileDirty(false);
    } catch (err) {
      setFileError(err.response?.data?.error || 'Failed to read file');
    }
  };

  const handleFileSave = async () => {
    if (!openFilePath) return;
    setFileSaving(true);
    setFileError('');
    setFileSuccess('');
    try {
      await writeShopFile(slug, openFilePath, fileEdited);
      setFileContent(fileEdited);
      setFileDirty(false);
      setFileSuccess('File saved.');
      setTimeout(() => setFileSuccess(''), 3000);
    } catch (err) {
      setFileError(err.response?.data?.error || 'Failed to save file');
    } finally {
      setFileSaving(false);
    }
  };

  const navigateTo = (newPath) => {
    setOpenFilePath(null);
    setBrowsePath(newPath);
  };

  const handleUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setFileError('');
    setFileSuccess('');
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    try {
      const result = await uploadShopFiles(slug, browsePath, formData);
      setFileSuccess(result.message);
      refetchFiles();
      setTimeout(() => setFileSuccess(''), 4000);
    } catch (err) {
      setFileError(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  // Build breadcrumb parts from browsePath
  const breadcrumbs = browsePath === '.' ? [] : browsePath.split('/').filter(Boolean);

  const logOutput = [deployLog, logsData?.logs].filter(Boolean).join('\n\n--- Live Logs ---\n');
  const currentShop = allShops.find((s) => s.slug === slug);
  const currentStatus = currentShop?.status ?? 'stopped';

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-xl font-semibold">Settings — {slug}</h1>
      </div>

      {message && (
        <div className="rounded-md border bg-muted px-4 py-3 text-sm mb-4">{message}</div>
      )}

      <div className="space-y-6">
        {/* Container Control */}
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium">Container Control</h2>
            <span
              className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
                currentStatus === 'running'
                  ? 'bg-green-100 text-green-700'
                  : currentStatus === 'error'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-zinc-100 text-zinc-600'
              }`}
            >
              {currentStatus}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {currentStatus !== 'running' && (
              <button
                onClick={() => actionMutation.mutate('start')}
                disabled={actionMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {actionMutation.isPending ? 'Starting...' : 'Start'}
              </button>
            )}
            {currentStatus === 'running' && (
              <button
                onClick={() => actionMutation.mutate('stop')}
                disabled={actionMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-secondary text-secondary-foreground px-3 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
              >
                <Square className="h-4 w-4" />
                {actionMutation.isPending ? 'Stopping...' : 'Stop'}
              </button>
            )}
            <button
              onClick={() => actionMutation.mutate('restart')}
              disabled={actionMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-secondary text-secondary-foreground px-3 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {actionMutation.isPending ? 'Restarting...' : 'Restart'}
            </button>
          </div>
        </div>

        {/* Redeploy */}
        <div className="rounded-lg border bg-card p-5">
          <h2 className="font-medium mb-2">Redeploy</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Pull latest changes and rebuild the shop container.
          </p>
          <button
            onClick={() => deployMutation.mutate()}
            disabled={deployMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Rocket className="h-4 w-4" />
            {deployMutation.isPending ? 'Deploying...' : 'Redeploy'}
          </button>
        </div>

        {/* Terminal / Logs Panel */}
        <div className="rounded-lg border bg-zinc-950 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900">
            <Terminal className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-xs font-mono text-zinc-400">container logs — {slug}</span>
            <div className="flex-1" />
            <button
              onClick={() => refetchLogs()}
              className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
          <div
            ref={terminalRef}
            className="p-4 h-64 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed"
          >
            {logOutput || <span className="text-zinc-600">No logs available. Start the container to see output.</span>}
          </div>
        </div>

        {/* Shop File Browser */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b bg-muted/40">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Shop Files — {slug}</h2>
            <div className="flex-1" />
            <button
              onClick={() => uploadInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <Upload className="h-3 w-3" /> {uploading ? 'Uploading...' : 'Upload'}
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleUpload}
            />
            <button
              onClick={() => refetchFiles()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 px-5 py-2 border-b bg-muted/20 text-xs font-mono">
            <button
              onClick={() => navigateTo('.')}
              className="text-primary hover:underline"
            >
              {slug}
            </button>
            {breadcrumbs.map((part, i) => {
              const pathTo = breadcrumbs.slice(0, i + 1).join('/');
              return (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <button
                    onClick={() => navigateTo(pathTo)}
                    className="text-primary hover:underline"
                  >
                    {part}
                  </button>
                </span>
              );
            })}
          </div>

          {fileError && (
            <div className="px-5 py-2 text-xs text-destructive bg-red-50 border-b border-red-100">
              {fileError}
            </div>
          )}
          {fileSuccess && (
            <div className="px-5 py-2 text-xs text-green-700 bg-green-50 border-b border-green-100">
              {fileSuccess}
            </div>
          )}

          <div className="flex" style={{ minHeight: '300px' }}>
            {/* File tree panel */}
            <div className="w-56 border-r overflow-y-auto flex-shrink-0">
              {filesLoading ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">Loading...</p>
              ) : !filesData?.entries?.length ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">Empty directory.</p>
              ) : (
                <ul className="py-1">
                  {browsePath !== '.' && (
                    <li>
                      <button
                        onClick={() => {
                          const parts = browsePath.split('/');
                          parts.pop();
                          navigateTo(parts.length ? parts.join('/') : '.');
                        }}
                        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                      >
                        <ArrowLeft className="h-3 w-3" /> ..
                      </button>
                    </li>
                  )}
                  {filesData.entries.map((entry) => {
                    const entryPath = browsePath === '.' ? entry.name : `${browsePath}/${entry.name}`;
                    const isOpen = openFilePath === entryPath;
                    return (
                      <li key={entry.name}>
                        <button
                          onClick={() => {
                            if (entry.isDirectory) {
                              navigateTo(entryPath);
                            } else if (entry.readable) {
                              openFile(entryPath);
                            }
                          }}
                          className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs transition-colors ${
                            isOpen
                              ? 'bg-primary/10 text-primary font-medium'
                              : 'hover:bg-muted/50 text-foreground'
                          } ${!entry.isDirectory && !entry.readable ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {entry.isDirectory ? (
                            <Folder className="h-3 w-3 flex-shrink-0 text-yellow-500" />
                          ) : (
                            <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Editor panel */}
            <div className="flex-1 flex flex-col min-w-0">
              {openFilePath ? (
                <>
                  <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/20">
                    <span className="text-xs font-mono text-muted-foreground flex-1 truncate">{openFilePath}</span>
                    {fileDirty && (
                      <span className="text-xs text-amber-600 font-medium">unsaved</span>
                    )}
                    <button
                      onClick={handleFileSave}
                      disabled={fileSaving || !fileDirty}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                      <Save className="h-3 w-3" />
                      {fileSaving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setOpenFilePath(null); setFileDirty(false); }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <textarea
                    className="flex-1 w-full font-mono text-xs p-4 bg-zinc-950 text-zinc-200 resize-none outline-none leading-relaxed"
                    value={fileEdited}
                    onChange={(e) => {
                      setFileEdited(e.target.value);
                      setFileDirty(e.target.value !== fileContent);
                    }}
                    spellCheck={false}
                    style={{ minHeight: '280px' }}
                  />
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                  Select a file to view or edit
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Database Viewer / Editor */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b bg-muted/40">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Database — shops.db</h2>
            <span className="text-xs text-muted-foreground ml-1">({allShops.length} records)</span>
          </div>

          {saveSuccess && (
            <div className="px-5 py-2 text-xs text-green-700 bg-green-50 border-b border-green-100">
              {saveSuccess}
            </div>
          )}
          {saveError && (
            <div className="px-5 py-2 text-xs text-destructive bg-red-50 border-b border-red-100">
              {saveError}
            </div>
          )}

          {shopsLoading ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">Loading...</p>
          ) : allShops.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">No shops in database.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-medium">ID</th>
                    <th className="px-4 py-2.5 text-left font-medium">Slug</th>
                    <th className="px-4 py-2.5 text-left font-medium">Name</th>
                    <th className="px-4 py-2.5 text-left font-medium">Port</th>
                    <th className="px-4 py-2.5 text-left font-medium">Subdomain</th>
                    <th className="px-4 py-2.5 text-left font-medium">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium">Created</th>
                    <th className="px-4 py-2.5 text-left font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {allShops.map((shop) => {
                    const isEditing = editingSlug === shop.slug;
                    const vals = editValues[shop.slug] || {};
                    const isCurrentShop = shop.slug === slug;
                    return (
                      <tr
                        key={shop.id}
                        className={`border-b last:border-0 transition-colors ${
                          isCurrentShop ? 'bg-primary/5' : 'hover:bg-muted/30'
                        }`}
                      >
                        <td className="px-4 py-2.5 text-muted-foreground text-xs">{shop.id}</td>
                        <td className="px-4 py-2.5">
                          <code className="text-xs bg-muted px-1 py-0.5 rounded">{shop.slug}</code>
                          {isCurrentShop && (
                            <span className="ml-1.5 text-xs text-primary font-medium">current</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <input
                              className="w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                              value={vals.name ?? shop.name}
                              onChange={(e) => setField(shop.slug, 'name', e.target.value)}
                            />
                          ) : (
                            shop.name
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <input
                              className="w-20 rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                              value={vals.port ?? shop.port}
                              onChange={(e) => setField(shop.slug, 'port', e.target.value)}
                              type="number"
                            />
                          ) : (
                            shop.port
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <input
                              className="w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                              value={vals.subdomain ?? shop.subdomain}
                              onChange={(e) => setField(shop.slug, 'subdomain', e.target.value)}
                            />
                          ) : (
                            shop.subdomain
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-block text-xs px-1.5 py-0.5 rounded-full font-medium ${
                              shop.status === 'running'
                                ? 'bg-green-100 text-green-700'
                                : shop.status === 'error'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            {shop.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {shop.created_at?.slice(0, 16).replace('T', ' ') ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <div className="flex gap-1">
                              <button
                                onClick={() => handleSave(shop.slug)}
                                disabled={updateMutation.isPending}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                              >
                                <Save className="h-3 w-3" />
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="rounded px-2 py-1 text-xs bg-secondary hover:bg-accent transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(shop)}
                              className="rounded px-2 py-1 text-xs bg-secondary hover:bg-accent transition-colors"
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Account / Password */}
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-medium">Account</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">Change your admin password.</p>

          {pwMessage && (
            <div className="mb-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
              {pwMessage}
            </div>
          )}
          {pwError && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-destructive">
              {pwError}
            </div>
          )}

          <div className="space-y-3 max-w-sm">
            <div>
              <label className="block text-xs font-medium mb-1 text-muted-foreground">Current Password</label>
              <div className="relative">
                <input
                  type={showOldPw ? 'text' : 'password'}
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring pr-9"
                  placeholder="Enter current password"
                />
                <button
                  type="button"
                  onClick={() => setShowOldPw(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showOldPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-muted-foreground">New Password</label>
              <div className="relative">
                <input
                  type={showNewPw ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring pr-9"
                  placeholder="At least 8 characters"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <button
              onClick={handleChangePassword}
              disabled={!oldPassword || !newPassword}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Lock className="h-4 w-4" />
              Change Password
            </button>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="rounded-lg border border-destructive/30 bg-card p-5">
          <h2 className="font-medium text-destructive mb-2">Danger Zone</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Permanently delete this shop, its container, and all associated files.
          </p>
          <button
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-2 text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            {deleteMutation.isPending ? 'Deleting...' : 'Delete Shop'}
          </button>
        </div>
      </div>
    </div>
  );
}
