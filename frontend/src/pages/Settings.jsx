import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deployShop, deleteShop, getShops, updateShop, getShopLogs, shopAction,
  listShopFiles, readShopFile, writeShopFile, deleteShopFile, uploadShopFiles,
  getShopImageUrl, replaceShopFile, checkShopUpdate, installShopUpdate,
} from '../lib/api';
import {
  ArrowLeft, Rocket, Trash2, Terminal, Database, Save, RefreshCw,
  Play, Square, RotateCcw, Folder, FileText, ChevronRight, X, Eye, EyeOff,
  Upload, Copy, ImageIcon, Store, SlidersHorizontal, Check, Download,
} from 'lucide-react';
import KeyValueEditor from '../components/KeyValueEditor';
import CollectionsEditor from '../components/CollectionsEditor';

// Sort order for DATABASE/Design/Details files
const SETTINGS_ORDER = [
  'companyname', 'password', 'descriptions', 'colors', 'fonts', 'style',
];

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const aKey = a.name.replace(/\.[^.]+$/, '').toLowerCase();
    const bKey = b.name.replace(/\.[^.]+$/, '').toLowerCase();
    const aIdx = SETTINGS_ORDER.indexOf(aKey);
    const bIdx = SETTINGS_ORDER.indexOf(bKey);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
}

export default function Settings() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [deployLog, setDeployLog] = useState('');
  const terminalRef = useRef(null);

  // DB table edit state
  const [editValues, setEditValues] = useState({});
  const [editingSlug, setEditingSlug] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  // File browser state
  const [browsePath, setBrowsePath] = useState('DATABASE');
  const [openFilePath, setOpenFilePath] = useState(null);
  const [fileMode, setFileMode] = useState('text'); // 'text' | 'image'
  const [fileContent, setFileContent] = useState('');
  const [fileEdited, setFileEdited] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileError, setFileError] = useState('');
  const [fileSuccess, setFileSuccess] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef(null);

  // DATABASE/Design/Details info
  const [shopTitle, setShopTitle] = useState('');
  const [shopDescription, setShopDescription] = useState('');

  // Shuttle template update state
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateError, setUpdateError] = useState('');

  // DATABASE password file viewer
  const [shopPassword, setShopPassword] = useState('');
  const [passwordShown, setPasswordShown] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

  // Shop Settings UI — DATABASE/Design/Details
  const [detailsEntries, setDetailsEntries] = useState([]);
  const [detailsValues, setDetailsValues] = useState({});
  const [detailsOriginal, setDetailsOriginal] = useState({});
  const [detailsSaving, setDetailsSaving] = useState({});
  const [detailsSuccess, setDetailsSuccess] = useState('');
  const [detailsError, setDetailsError] = useState('');
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [replacingImage, setReplacingImage] = useState(null);
  const [imageTimestamps, setImageTimestamps] = useState({});

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');

  const { data: shopsData, isLoading: shopsLoading } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
    refetchInterval: 10000,
  });
  const allShops = shopsData?.shops || [];

  const { data: logsData, refetch: refetchLogs } = useQuery({
    queryKey: ['shop-logs', slug],
    queryFn: () => getShopLogs(slug, 200),
    refetchInterval: 5000,
  });

  const { data: filesData, isLoading: filesLoading, refetch: refetchFiles, error: filesError } = useQuery({
    queryKey: ['shop-files', slug, browsePath],
    queryFn: () => listShopFiles(slug, browsePath),
  });

  // Fall back to root if DATABASE folder doesn't exist
  useEffect(() => {
    if (filesError && browsePath === 'DATABASE') {
      setBrowsePath('.');
    }
  }, [filesError, browsePath]);

  // Load DATABASE/Design/Details/CompanyName.txt and Descriptions.txt
  useEffect(() => {
    readShopFile(slug, 'DATABASE/Design/Details/CompanyName.txt')
      .then((d) => setShopTitle(d.content.trim()))
      .catch(() => setShopTitle(''));
    readShopFile(slug, 'DATABASE/Design/Details/Descriptions.txt')
      .then((d) => {
        const raw = d.content.trim();
        // Parse "about: ..." line if present, otherwise show full content
        const aboutMatch = raw.match(/^about:\s*(.+)/m);
        setShopDescription(aboutMatch ? aboutMatch[1].trim() : raw);
      })
      .catch(() => setShopDescription(''));
  }, [slug]);

  // Load DATABASE/Design/Details/Password.txt
  useEffect(() => {
    readShopFile(slug, 'DATABASE/Design/Details/Password.txt')
      .then((data) => setShopPassword(data.content.trim()))
      .catch(() => {
        // Try lowercase fallback
        readShopFile(slug, 'DATABASE/design/details/Password.txt')
          .then((d) => setShopPassword(d.content.trim()))
          .catch(() => setShopPassword(''));
      });
  }, [slug]);

  // Load all files from DATABASE/Design/Details for the Shop Settings UI
  useEffect(() => {
    setDetailsLoading(true);
    listShopFiles(slug, 'DATABASE/Design/Details')
      .then(async (data) => {
        const entries = (data.entries || []).filter(e => !e.isDirectory);
        setDetailsEntries(entries);

        const textEntries = entries.filter(e => e.readable);
        const values = {};
        const original = {};

        await Promise.all(textEntries.map(async (entry) => {
          const filePath = `DATABASE/Design/Details/${entry.name}`;
          try {
            const fileData = await readShopFile(slug, filePath);
            values[filePath] = fileData.content;
            original[filePath] = fileData.content;
          } catch {
            values[filePath] = '';
            original[filePath] = '';
          }
        }));

        setDetailsValues(values);
        setDetailsOriginal(original);
        setDetailsLoading(false);
      })
      .catch(() => {
        setDetailsEntries([]);
        setDetailsLoading(false);
      });
  }, [slug]);

  const friendlyLabel = (filename) => {
    const name = filename.replace(/\.[^.]+$/, '');
    return name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_-]/g, ' ')
      .trim();
  };

  const saveDetailFile = async (filePath) => {
    setDetailsSaving(prev => ({ ...prev, [filePath]: true }));
    setDetailsError('');
    setDetailsSuccess('');
    try {
      await writeShopFile(slug, filePath, detailsValues[filePath]);
      setDetailsOriginal(prev => ({ ...prev, [filePath]: detailsValues[filePath] }));
      const label = friendlyLabel(filePath.split('/').pop());
      setDetailsSuccess(`${label} saved.`);
      // Also update the header shop info if relevant
      if (filePath.endsWith('CompanyName.txt')) {
        setShopTitle(detailsValues[filePath].trim());
      } else if (filePath.endsWith('Descriptions.txt')) {
        const raw = detailsValues[filePath].trim();
        const aboutMatch = raw.match(/^about:\s*(.+)/m);
        setShopDescription(aboutMatch ? aboutMatch[1].trim() : raw);
      } else if (filePath.endsWith('Password.txt')) {
        setShopPassword(detailsValues[filePath].trim());
      }
      setTimeout(() => setDetailsSuccess(''), 3000);
    } catch (err) {
      setDetailsError(err.response?.data?.error || 'Failed to save file');
    } finally {
      setDetailsSaving(prev => ({ ...prev, [filePath]: false }));
    }
  };

  const handleImageReplace = async (filePath, file) => {
    if (!file) return;
    setReplacingImage(filePath);
    setDetailsError('');
    setDetailsSuccess('');
    try {
      await replaceShopFile(slug, filePath, file);
      // Force image refresh by adding a timestamp
      setImageTimestamps(prev => ({ ...prev, [filePath]: Date.now() }));
      const label = friendlyLabel(filePath.split('/').pop());
      setDetailsSuccess(`${label} replaced.`);
      setTimeout(() => setDetailsSuccess(''), 3000);
    } catch (err) {
      setDetailsError(err.response?.data?.error || 'Failed to replace image');
    } finally {
      setReplacingImage(null);
    }
  };

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
    onSuccess: (data, variables) => {
      const newSlug = data.shop.slug;
      setSaveSuccess(`Saved "${newSlug}".`);
      setSaveError('');
      setEditingSlug(null);
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setTimeout(() => setSaveSuccess(''), 3000);
      // If the current shop's slug was changed, navigate to the new URL
      if (variables.targetSlug === slug && newSlug !== slug) {
        navigate(`/shops/${newSlug}/settings`, { replace: true });
      }
    },
    onError: (err) => setSaveError(err.response?.data?.error || 'Failed to save'),
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
    if (deleteTyped === currentShop?.name) {
      setShowDeleteConfirm(false);
      setDeleteTyped('');
      deleteMutation.mutate();
    }
  };

  const startEdit = (shop) => {
    setEditingSlug(shop.slug);
    setEditValues((prev) => ({
      ...prev,
      [shop.slug]: { name: shop.name, description: shop.description || '', slug: shop.slug },
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
    updateMutation.mutate({ targetSlug, data: { name: vals.name, description: vals.description, slug: vals.slug } });
  };

  const setField = (shopSlug, field, value) => {
    setEditValues((prev) => ({
      ...prev,
      [shopSlug]: { ...prev[shopSlug], [field]: value },
    }));
  };

  const openFile = async (filePath, entry) => {
    setFileError('');
    setFileSuccess('');
    if (entry?.isImage) {
      setOpenFilePath(filePath);
      setFileMode('image');
      return;
    }
    try {
      const data = await readShopFile(slug, filePath);
      setOpenFilePath(filePath);
      setFileContent(data.content);
      setFileEdited(data.content);
      setFileDirty(false);
      setFileMode('text');
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

  const handleDeleteFile = async (filePath) => {
    if (!window.confirm(`Delete "${filePath}"?`)) return;
    try {
      await deleteShopFile(slug, filePath);
      if (openFilePath === filePath) setOpenFilePath(null);
      refetchFiles();
      setFileSuccess(`Deleted ${filePath}.`);
      setTimeout(() => setFileSuccess(''), 3000);
    } catch (err) {
      setFileError(err.response?.data?.error || 'Failed to delete file');
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
    for (const file of files) formData.append('files', file);
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

  const copyPassword = () => {
    navigator.clipboard.writeText(shopPassword).then(() => {
      setPasswordCopied(true);
      setTimeout(() => setPasswordCopied(false), 2000);
    });
  };

  const handleCheckUpdate = async () => {
    setUpdateChecking(true);
    setUpdateError('');
    setUpdateMessage('');
    try {
      const data = await checkShopUpdate(slug);
      setUpdateInfo(data);
    } catch (err) {
      setUpdateError(err.response?.data?.error || 'Failed to check for updates');
    } finally {
      setUpdateChecking(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!window.confirm('Update the Shuttle template? The shop will be rebuilt and restarted.')) return;
    setUpdateInstalling(true);
    setUpdateError('');
    setUpdateMessage('');
    try {
      const data = await installShopUpdate(slug);
      setUpdateMessage(data.message || 'Update installed successfully');
      setDeployLog(data.log || '');
      setUpdateInfo(null); // Reset so user can check again
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['shop-logs', slug] });
    } catch (err) {
      setUpdateError(err.response?.data?.error || 'Update failed');
      if (err.response?.data?.log) setDeployLog(err.response.data.log);
    } finally {
      setUpdateInstalling(false);
    }
  };

  const breadcrumbs = browsePath === '.' ? [] : browsePath.split('/').filter(Boolean);
  const logOutput = [deployLog, logsData?.logs].filter(Boolean).join('\n\n--- Live Logs ---\n');
  const currentShop = allShops.find((s) => s.slug === slug);
  const currentStatus = currentShop?.status ?? 'stopped';

  return (
    <div className="max-w-4xl lp-fadein">
      <div className="flex items-center gap-3 mb-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
        <div>
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Shop Configuration</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>{slug}</h1>
        </div>
      </div>

      {message && (
        <div className="rounded-md border border-border bg-card px-4 py-3 text-sm mb-4 font-mono">{message}</div>
      )}

      <div className="space-y-5">

        {/* Shop Settings — DATABASE/Design/Details */}
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <SlidersHorizontal className="h-4 w-4 text-primary/70" />
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Shop Settings</h2>
            <span className="text-xs text-muted-foreground font-mono ml-1">DATABASE / Design / Details</span>
          </div>

          {detailsSuccess && (
            <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] flex items-center gap-1.5">
              <Check className="h-3 w-3" />
              {detailsSuccess}
            </div>
          )}
          {detailsError && (
            <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20">{detailsError}</div>
          )}

          {detailsLoading ? (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-muted-foreground font-mono">Loading settings...</p>
            </div>
          ) : detailsEntries.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-muted-foreground font-mono">
                No settings files found in DATABASE/Design/Details/.
              </p>
              <p className="text-xs text-muted-foreground font-mono mt-1">
                Upload a DATABASE.zip or create files via the file browser below.
              </p>
            </div>
          ) : (
            <KeyValueEditor
              slug={slug}
              entries={sortEntries(detailsEntries)}
              basePath="DATABASE/Design/Details"
              values={detailsValues}
              originalValues={detailsOriginal}
              onValueChange={(fp, val) => setDetailsValues(prev => ({ ...prev, [fp]: val }))}
              onSave={saveDetailFile}
              saving={detailsSaving}
              onImageReplace={handleImageReplace}
              replacingImage={replacingImage}
              imageTimestamps={imageTimestamps}
              hiddenFiles={['README.md']}
            />
          )}
        </div>

        {/* Shop Collections — DATABASE/ShopCollections */}
        <CollectionsEditor slug={slug} />

        {/* Container Control */}
        <div className="lp-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Container Control</h2>
            <div className="flex items-center gap-1.5">
              {currentStatus === 'running' ? (
                <span className="w-2 h-2 status-dot-running" />
              ) : (
                <span className={`w-2 h-2 rounded-full ${currentStatus === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
              )}
              <span className={`text-xs font-mono font-medium ${
                currentStatus === 'running' ? 'text-[hsl(142,70%,50%)]'
                : currentStatus === 'error' ? 'text-destructive'
                : 'text-muted-foreground'
              }`}>{currentStatus}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {currentStatus !== 'running' && (
              <button
                onClick={() => actionMutation.mutate('start')}
                disabled={actionMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {actionMutation.isPending ? 'Starting...' : 'Start'}
              </button>
            )}
            {currentStatus === 'running' && (
              <button
                onClick={() => actionMutation.mutate('stop')}
                disabled={actionMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
              >
                <Square className="h-3.5 w-3.5" />
                {actionMutation.isPending ? 'Stopping...' : 'Stop'}
              </button>
            )}
            <button
              onClick={() => actionMutation.mutate('restart')}
              disabled={actionMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {actionMutation.isPending ? 'Restarting...' : 'Restart'}
            </button>
            <button
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending}
              className="btn-launch inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs disabled:opacity-50 ml-auto"
            >
              <Rocket className="h-3.5 w-3.5" />
              {deployMutation.isPending ? 'Relaunching...' : 'Relaunch'}
            </button>
          </div>
        </div>

        {/* Shuttle Template Update */}
        <div className="lp-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-primary/70" />
              <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Shuttle Version</h2>
            </div>
          </div>

          {updateError && (
            <div className="mb-3 px-3 py-2 rounded-md text-xs text-destructive bg-destructive/5 border border-destructive/20">{updateError}</div>
          )}
          {updateMessage && (
            <div className="mb-3 px-3 py-2 rounded-md text-xs text-[hsl(142,70%,50%)] bg-[hsl(142,70%,5%)] border border-[hsl(142,70%,20%)] flex items-center gap-1.5">
              <Check className="h-3 w-3" />
              {updateMessage}
            </div>
          )}

          {updateInfo ? (
            <div className="space-y-3">
              <div className="flex items-center gap-4 text-xs font-mono">
                <div>
                  <span className="text-muted-foreground">Local: </span>
                  <span className="text-foreground">{updateInfo.localCommit}</span>
                  <span className="text-muted-foreground ml-1.5">{updateInfo.localDate?.slice(0, 10)}</span>
                </div>
                {updateInfo.remoteCommit && (
                  <div>
                    <span className="text-muted-foreground">Remote: </span>
                    <span className="text-foreground">{updateInfo.remoteCommit}</span>
                    <span className="text-muted-foreground ml-1.5">{updateInfo.remoteDate?.slice(0, 10)}</span>
                  </div>
                )}
              </div>

              {updateInfo.updateAvailable ? (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-amber-400 font-medium">
                    Update available ({updateInfo.commitsBehind} commit{updateInfo.commitsBehind !== 1 ? 's' : ''} behind)
                  </span>
                  <button
                    onClick={handleInstallUpdate}
                    disabled={updateInstalling}
                    className="btn-launch inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {updateInstalling ? 'Updating...' : 'Install Update'}
                  </button>
                  <button
                    onClick={handleCheckUpdate}
                    disabled={updateChecking}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${updateChecking ? 'animate-spin' : ''}`} /> Re-check
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[hsl(142,70%,50%)] font-medium flex items-center gap-1">
                    <Check className="h-3 w-3" /> Up to date
                  </span>
                  <button
                    onClick={handleCheckUpdate}
                    disabled={updateChecking}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${updateChecking ? 'animate-spin' : ''}`} /> Re-check
                  </button>
                </div>
              )}

              {updateInfo.reason && (
                <p className="text-xs text-muted-foreground">{updateInfo.reason}</p>
              )}
            </div>
          ) : (
            <button
              onClick={handleCheckUpdate}
              disabled={updateChecking}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${updateChecking ? 'animate-spin' : ''}`} />
              {updateChecking ? 'Checking...' : 'Check for Update'}
            </button>
          )}
        </div>

        {/* Terminal / Logs */}
        <div className="rounded-xl border border-border/60 bg-[hsl(222,32%,4%)] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-secondary/60">
            <Terminal className="h-3.5 w-3.5 text-primary/70" />
            <span className="text-xs font-mono text-muted-foreground">logs — {slug}</span>
            <div className="flex-1" />
            <button
              onClick={() => refetchLogs()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
          <div
            ref={terminalRef}
            className="p-4 h-80 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed"
          >
            {logOutput || <span className="text-zinc-600">No logs. Start the container to see output.</span>}
          </div>
        </div>

        {/* File Explorer */}
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <Folder className="h-4 w-4 text-primary/70" />
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>File Explorer</h2>
            <div className="flex-1" />
            <button
              onClick={() => uploadInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
            >
              <Upload className="h-3 w-3" /> {uploading ? 'Uploading...' : 'Upload'}
            </button>
            <span className="text-[10px] text-muted-foreground/60">Max 1 GB</span>
            <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
            <button
              onClick={() => refetchFiles()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors ml-2"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 px-5 py-2 border-b border-border/30 bg-muted/40 text-xs font-mono">
            <button onClick={() => navigateTo('.')} className="text-primary hover:underline">{slug}</button>
            {breadcrumbs.map((part, i) => {
              const pathTo = breadcrumbs.slice(0, i + 1).join('/');
              return (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <button onClick={() => navigateTo(pathTo)} className="text-primary hover:underline">{part}</button>
                </span>
              );
            })}
          </div>

          {fileError && (
            <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20">{fileError}</div>
          )}
          {fileSuccess && (
            <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)]">{fileSuccess}</div>
          )}

          <div className="flex" style={{ minHeight: '300px' }}>
            {/* File tree */}
            <div className="w-56 border-r border-border/40 overflow-y-auto flex-shrink-0 bg-card">
              {filesLoading ? (
                <p className="px-4 py-3 text-xs text-muted-foreground font-mono">Loading...</p>
              ) : !filesData?.entries?.length ? (
                <p className="px-4 py-3 text-xs text-muted-foreground font-mono">Empty directory.</p>
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
                        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 transition-colors"
                      >
                        <ArrowLeft className="h-3 w-3" /> ..
                      </button>
                    </li>
                  )}
                  {filesData.entries.map((entry) => {
                    const entryPath = browsePath === '.' ? entry.name : `${browsePath}/${entry.name}`;
                    const isOpen = openFilePath === entryPath;
                    return (
                      <li key={entry.name} className="group relative">
                        <button
                          onClick={() => {
                            if (entry.isDirectory) navigateTo(entryPath);
                            else if (entry.isImage || entry.readable) openFile(entryPath, entry);
                          }}
                          className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs transition-colors pr-8 ${
                            isOpen
                              ? 'bg-primary/10 text-primary font-medium'
                              : 'hover:bg-foreground/5 text-foreground'
                          } ${!entry.isDirectory && !entry.readable && !entry.isImage ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {entry.isDirectory ? (
                            <Folder className="h-3 w-3 flex-shrink-0 text-yellow-400/80" />
                          ) : entry.isImage ? (
                            <ImageIcon className="h-3 w-3 flex-shrink-0 text-pink-400/80" />
                          ) : (
                            <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </button>
                        {!entry.isDirectory && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteFile(entryPath); }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                            title="Delete file"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Editor / Image preview */}
            <div className="flex-1 flex flex-col min-w-0 bg-card">
              {openFilePath && fileMode === 'image' ? (
                <div className="flex-1 flex flex-col">
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-secondary/60">
                    <ImageIcon className="h-3 w-3 text-pink-400/80" />
                    <span className="text-xs font-mono text-muted-foreground flex-1 truncate">{openFilePath}</span>
                    <button
                      onClick={() => setOpenFilePath(null)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
                    <img
                      src={getShopImageUrl(slug, openFilePath)}
                      alt={openFilePath}
                      className="max-w-full max-h-full object-contain rounded-lg border border-border/40"
                    />
                  </div>
                </div>
              ) : openFilePath && fileMode === 'text' ? (
                <>
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-secondary/60">
                    <span className="text-xs font-mono text-muted-foreground flex-1 truncate">{openFilePath}</span>
                    {fileDirty && <span className="text-xs text-amber-400 font-mono">unsaved</span>}
                    <button
                      onClick={handleFileSave}
                      disabled={fileSaving || !fileDirty}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-40 transition-colors"
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
                    className="flex-1 w-full font-mono text-xs p-4 bg-transparent text-foreground resize-none outline-none leading-relaxed"
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
                <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground font-mono">
                  Select a file to view or edit
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Shops Database Viewer */}
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <Database className="h-4 w-4 text-primary/70" />
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Shops Database</h2>
            <span className="text-xs text-muted-foreground font-mono ml-1">({allShops.length} records)</span>
          </div>

          {saveSuccess && (
            <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)]">{saveSuccess}</div>
          )}
          {saveError && (
            <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20">{saveError}</div>
          )}

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
                    <th className="px-4 py-2.5 text-left font-medium font-mono">Description</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">URL Path</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono">Created</th>
                    <th className="px-4 py-2.5 text-left font-medium font-mono"></th>
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
                        className={`border-b border-border/30 last:border-0 transition-colors ${
                          isCurrentShop ? 'bg-primary/5' : 'hover:bg-foreground/[0.02]'
                        }`}
                      >
                        <td className="px-4 py-2.5 text-muted-foreground text-xs font-mono">
                          {shop.id}
                          {isCurrentShop && <span className="ml-1 text-primary">←</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {isEditing ? (
                            <input
                              className="w-full rounded border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
                              value={vals.name ?? shop.name}
                              onChange={(e) => setField(shop.slug, 'name', e.target.value)}
                            />
                          ) : shop.name}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {isEditing ? (
                            <input
                              className="w-full rounded border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
                              value={vals.description ?? (shop.description || '')}
                              onChange={(e) => setField(shop.slug, 'description', e.target.value)}
                              placeholder="Short description"
                            />
                          ) : (
                            <span className="text-muted-foreground">{shop.description || '—'}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs font-mono">
                          {isEditing ? (
                            <div className="flex items-center gap-0 rounded border border-border/60 bg-input overflow-hidden focus-within:ring-1 focus-within:ring-primary/60">
                              <span className="pl-1.5 text-[10px] text-muted-foreground select-none">/</span>
                              <input
                                className="w-full bg-transparent px-1 py-1 text-xs font-mono outline-none"
                                value={vals.slug ?? shop.slug}
                                onChange={(e) => setField(shop.slug, 'slug', e.target.value)}
                              />
                            </div>
                          ) : (
                            <a
                              href={`/${shop.slug}/`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              /{shop.slug}
                            </a>
                          )}
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
                          {isEditing ? (
                            <div className="flex gap-1">
                              <button
                                onClick={() => handleSave(shop.slug)}
                                disabled={updateMutation.isPending}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-50 transition-colors"
                              >
                                <Save className="h-3 w-3" /> Save
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
                              className="rounded px-2 py-1 text-xs bg-secondary hover:bg-accent border border-border/60 transition-colors"
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

        {/* Danger Zone */}
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <h2 className="text-sm font-bold text-destructive mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
            Danger Zone
          </h2>
          <p className="text-xs text-muted-foreground mb-4">
            Permanently delete this shop, its container, and all associated files. This cannot be undone.
          </p>
          {showDeleteConfirm ? (
            <div className="space-y-3">
              <p className="text-xs text-destructive font-medium">
                Type <code className="font-mono bg-destructive/10 px-1.5 py-0.5 rounded">{currentShop?.name}</code> to confirm deletion:
              </p>
              <input
                type="text"
                value={deleteTyped}
                onChange={(e) => setDeleteTyped(e.target.value)}
                placeholder={currentShop?.name}
                className="w-full max-w-xs rounded-md border border-destructive/40 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-destructive/60 transition-all"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending || deleteTyped !== currentShop?.name}
                  className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-2 text-xs font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleteMutation.isPending ? 'Deleting...' : 'Delete Shop'}
                </button>
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeleteTyped(''); }}
                  className="rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={deleteMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-2 text-xs font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Shop
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
