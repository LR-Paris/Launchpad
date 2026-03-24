import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deployShop, deleteShop, getShops, updateShop, getShopLogs, shopAction,
  listShopFiles, readShopFile, writeShopFile, deleteShopFile, uploadShopFiles,
  getShopImageUrl, replaceShopFile, checkShopUpdate, installShopUpdate, wipeOrders,
  getShopVersion, upgradeShop,
} from '../lib/api';
import { usePermissions } from '../lib/permissions';
import {
  ArrowLeft, Rocket, Trash2, Terminal, Database, Save, RefreshCw,
  Play, Square, RotateCcw, Folder, FileText, ChevronRight, X, Eye, EyeOff,
  Upload, Copy, ImageIcon, Store, SlidersHorizontal, Check, Download, ShoppingCart,
  ArrowUpCircle, Settings2, Package, Lock,
} from 'lucide-react';
import KeyValueEditor from '../components/KeyValueEditor';

// Sort order for DATABASE/Design/Details files
const SETTINGS_ORDER = [
  'companyname', 'password', 'adminemail', 'descriptions', 'colors', 'fonts', 'style',
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
  const { getShopPerms } = usePermissions();
  const perms = getShopPerms(slug);
  const canEditUI = perms.can_edit_ui;
  const canDelete = perms.can_delete;
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

  // Template update state
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

  // Wipe orders state
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeTyped, setWipeTyped] = useState('');
  const [wiping, setWiping] = useState(false);
  const [wipeMessage, setWipeMessage] = useState('');

  // STS-2.01: Shop Configuration (Presets) state
  const [presetShopType, setPresetShopType] = useState('free');
  const [presetDataRequired, setPresetDataRequired] = useState({
    address: true, details: true, extra_notes: true, shipping_handler: true, hotel_list: false,
  });
  const [presetHotelList, setPresetHotelList] = useState('');
  const [presetLoading, setPresetLoading] = useState(true);
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetSuccess, setPresetSuccess] = useState('');
  const [presetError, setPresetError] = useState('');
  const [presetExists, setPresetExists] = useState(false);

  // Preset folder files (DATABASE/Presets) editor state
  const [presetsEntries, setPresetsEntries] = useState([]);
  const [presetsValues, setPresetsValues] = useState({});
  const [presetsOriginal, setPresetsOriginal] = useState({});
  const [presetsSaving, setPresetsSaving] = useState({});
  const [presetsLoading, setPresetsLoading] = useState(true);


  // Version management state
  const [versionInfo, setVersionInfo] = useState(null);
  const [versionChecking, setVersionChecking] = useState(false);
  const [upgradeLog, setUpgradeLog] = useState('');
  const [shopVersionInfo, setShopVersionInfo] = useState(null);

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

  // Load STS-2.01 preset files
  useEffect(() => {
    setPresetLoading(true);
    Promise.all([
      readShopFile(slug, 'DATABASE/Presets/ShopType.txt').catch(() => null),
      readShopFile(slug, 'DATABASE/Presets/DataRequired.txt').catch(() => null),
      readShopFile(slug, 'DATABASE/Design/Details/Hotels.txt').catch(() => null),
    ]).then(([shopTypeData, dataReqData, hotelsData]) => {
      if (shopTypeData) {
        setPresetExists(true);
        const typeMatch = shopTypeData.content.match(/type:\s*(\w+)/);
        if (typeMatch) setPresetShopType(typeMatch[1]);
      }
      if (dataReqData) {
        setPresetExists(true);
        const dr = {};
        for (const line of dataReqData.content.split('\n')) {
          const match = line.match(/^(\w+):\s*(true|false)/);
          if (match) dr[match[1]] = match[2] === 'true';
        }
        setPresetDataRequired(prev => ({ ...prev, ...dr }));
      }
      if (hotelsData) {
        setPresetHotelList(hotelsData.content);
      }
      setPresetLoading(false);
    }).catch(() => {
      setPresetLoading(false);
    });
  }, [slug]);

  // Load all files from DATABASE/Presets for the Preset Folder editor
  const loadPresetFiles = () => {
    setPresetsLoading(true);
    listShopFiles(slug, 'DATABASE/Presets')
      .then(async (data) => {
        const entries = (data.entries || []).filter(e => !e.isDirectory);
        setPresetsEntries(entries);

        const textEntries = entries.filter(e => e.readable);
        const values = {};
        const original = {};

        await Promise.all(textEntries.map(async (entry) => {
          const filePath = `DATABASE/Presets/${entry.name}`;
          try {
            const fileData = await readShopFile(slug, filePath);
            values[filePath] = fileData.content;
            original[filePath] = fileData.content;
          } catch {
            values[filePath] = '';
            original[filePath] = '';
          }
        }));

        setPresetsValues(values);
        setPresetsOriginal(original);
        setPresetsLoading(false);
      })
      .catch(() => {
        setPresetsEntries([]);
        setPresetsLoading(false);
      });
  };

  useEffect(() => {
    loadPresetFiles();
  }, [slug]);

  // Auto-fetch shop version info (commit hash + date + STS) on mount
  useEffect(() => {
    getShopVersion(slug)
      .then((data) => setShopVersionInfo(data))
      .catch(() => {});
  }, [slug]);

  const savePresets = async () => {
    if (!canEditUI) return;
    setPresetSaving(true);
    setPresetError('');
    setPresetSuccess('');
    try {
      await writeShopFile(slug, 'DATABASE/Presets/ShopType.txt', `type: ${presetShopType}`);
      const drContent = Object.entries(presetDataRequired)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      await writeShopFile(slug, 'DATABASE/Presets/DataRequired.txt', drContent);
      if (presetDataRequired.hotel_list && presetHotelList.trim()) {
        await writeShopFile(slug, 'DATABASE/Design/Details/Hotels.txt', presetHotelList);
      }
      setPresetExists(true);
      setPresetSuccess('Shop configuration saved.');
      // Reload preset files to sync the raw editor
      loadPresetFiles();
      setTimeout(() => setPresetSuccess(''), 3000);
    } catch (err) {
      setPresetError(err.response?.data?.error || 'Failed to save configuration');
    } finally {
      setPresetSaving(false);
    }
  };

  const savePresetFile = async (filePath) => {
    setPresetsSaving(prev => ({ ...prev, [filePath]: true }));
    setPresetError('');
    setPresetSuccess('');
    try {
      await writeShopFile(slug, filePath, presetsValues[filePath]);
      setPresetsOriginal(prev => ({ ...prev, [filePath]: presetsValues[filePath] }));
      // Sync structured UI if ShopType or DataRequired changed
      if (filePath.endsWith('ShopType.txt')) {
        const typeMatch = presetsValues[filePath].match(/type:\s*(\w+)/);
        if (typeMatch) setPresetShopType(typeMatch[1]);
      }
      if (filePath.endsWith('DataRequired.txt')) {
        const dr = {};
        for (const line of presetsValues[filePath].split('\n')) {
          const match = line.match(/^(\w+):\s*(true|false)/);
          if (match) dr[match[1]] = match[2] === 'true';
        }
        setPresetDataRequired(prev => ({ ...prev, ...dr }));
      }
      const label = friendlyLabel(filePath.split('/').pop());
      setPresetSuccess(`${label} saved.`);
      setTimeout(() => setPresetSuccess(''), 3000);
    } catch (err) {
      setPresetError(err.response?.data?.error || 'Failed to save preset file');
    } finally {
      setPresetsSaving(prev => ({ ...prev, [filePath]: false }));
    }
  };

  const checkVersion = async () => {
    setVersionChecking(true);
    try {
      const data = await getShopVersion(slug);
      setVersionInfo(data);
    } catch {
      setVersionInfo(null);
    } finally {
      setVersionChecking(false);
    }
  };

  const upgradeMutation = useMutation({
    mutationFn: () => upgradeShop(slug),
    onSuccess: (data) => {
      setUpgradeLog(data.log || '');
      setMessage(data.message);
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      checkVersion();
    },
    onError: (err) => {
      setUpgradeLog(err.response?.data?.log || '');
      setMessage(err.response?.data?.error || 'Upgrade failed');
    },
  });

  const handleUpgrade = () => {
    if (!canEditUI) return;
    if (window.confirm('Upgrade this shop to the latest version? The container will be rebuilt.')) {
      upgradeMutation.mutate();
    }
  };

  const friendlyLabel = (filename) => {
    const name = filename.replace(/\.[^.]+$/, '');
    return name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_-]/g, ' ')
      .trim();
  };

  const saveDetailFile = async (filePath) => {
    if (!canEditUI) return;
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
    if (!canDelete) return;
    if (deleteTyped === currentShop?.name) {
      setShowDeleteConfirm(false);
      setDeleteTyped('');
      deleteMutation.mutate();
    }
  };

  const handleWipeOrders = async () => {
    if (!canDelete || wipeTyped !== currentShop?.name) return;
    setWiping(true);
    setWipeMessage('');
    try {
      const data = await wipeOrders(slug);
      setWipeMessage(data.message || 'Orders wiped successfully.');
      setShowWipeConfirm(false);
      setWipeTyped('');
      setTimeout(() => setWipeMessage(''), 5000);
    } catch (err) {
      setWipeMessage(err.response?.data?.error || 'Failed to wipe orders');
    } finally {
      setWiping(false);
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
    if (!canEditUI) return;
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
    if (!openFilePath || !canEditUI) return;
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
    if (!canDelete) return;
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
    if (!canEditUI) return;
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
    if (!canEditUI) return;
    if (!window.confirm('Update the shop template? The shop will be rebuilt and restarted.')) return;
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

      {/* Lifecycle Status */}
      <div className="flex items-center gap-3 mb-5">
        <span className="text-xs font-semibold text-muted-foreground" style={{ fontFamily: 'Syne, sans-serif' }}>Status</span>
        <div className="flex items-center gap-1">
          {[
            ['none', 'No Status', 'bg-secondary text-muted-foreground border-border/60 hover:bg-accent'],
            ['development', 'Development', 'bg-blue-500/10 text-blue-400 border-blue-500/25 hover:bg-blue-500/20'],
            ['testing', 'In Testing', 'bg-amber-500/10 text-amber-400 border-amber-500/25 hover:bg-amber-500/20'],
            ['active', 'Active', 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20'],
            ['closed', 'Closed', 'bg-zinc-500/10 text-zinc-400 border-zinc-500/25 hover:bg-zinc-500/20'],
          ].map(([value, label, cls]) => {
            const isActive = (currentShop?.lifecycle_status || 'none') === value;
            return (
              <button
                key={value}
                onClick={() => {
                  updateMutation.mutate({ targetSlug: slug, data: { lifecycle_status: value } });
                }}
                className={`text-[11px] font-mono font-medium px-2 py-1 rounded border transition-all ${
                  isActive
                    ? cls + ' ring-1 ring-primary/40'
                    : 'bg-secondary/30 text-muted-foreground/50 border-border/30 hover:bg-secondary/60 hover:text-muted-foreground'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-5">

        {/* Shop Settings — DATABASE/Design/Details */}
        <div className={`lp-card rounded-xl overflow-hidden${!detailsLoading ? ' lp-fadein' : ''}`}>
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
              hiddenFiles={['README.md', 'Hotels.txt']}
            />
          )}
        </div>

        {/* Product catalog & inventory — /shops/:slug/catalog */}
        <Link
          to={`/shops/${slug}/catalog`}
          className="lp-card rounded-xl p-5 flex items-center gap-3 hover:border-primary/30 border border-border/40 transition-all"
        >
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-primary/10">
            <Package className="h-5 w-5 lp-glow" />
          </div>
          <div>
            <p className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Catalog</p>
            <p className="text-xs text-muted-foreground font-mono">Manage product catalog & inventory</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" />
        </Link>

        {/* Shop Configuration — STS-2.01 Presets */}
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <Settings2 className="h-4 w-4 text-primary/70" />
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Shop Configuration</h2>
            <span className="text-xs text-muted-foreground font-mono ml-1">Shop Presets</span>
          </div>

          {presetSuccess && (
            <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] flex items-center gap-1.5">
              <Check className="h-3 w-3" />
              {presetSuccess}
            </div>
          )}
          {presetError && (
            <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20">{presetError}</div>
          )}

          {presetLoading ? (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-muted-foreground font-mono">Loading configuration...</p>
            </div>
          ) : (
            <div className="p-5 space-y-4">
              {!presetExists && (
                <div className="rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  No presets configured yet. This shop may be pre-STS-2.01. Configure and save to create preset files.
                </div>
              )}

              {/* Shop Type */}
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ fontFamily: 'Syne, sans-serif' }}>
                  Shop Type
                </label>
                <select
                  value={presetShopType}
                  onChange={(e) => setPresetShopType(e.target.value)}
                  className="w-full max-w-xs rounded-md border border-border bg-input px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/60 transition-all"
                >
                  <option value="free">Free</option>
                  <option value="po">Purchase Order</option>
                  <option value="stripe" disabled>Stripe (Coming Soon)</option>
                </select>
              </div>

              {/* Data Required */}
              <div>
                <label className="block text-xs font-semibold mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
                  Checkout Fields
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    ['address', 'Address'],
                    ['details', 'Details'],
                    ['extra_notes', 'Extra Notes'],
                    ['shipping_handler', 'Shipping Handler'],
                    ['hotel_list', 'Hotel List'],
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={presetDataRequired[key]}
                        onChange={() => setPresetDataRequired(prev => {
                          const next = { ...prev, [key]: !prev[key] };
                          if (key === 'hotel_list' && !next.hotel_list) setPresetHotelList('');
                          return next;
                        })}
                        className="rounded border-border accent-primary"
                      />
                      <span className={presetDataRequired[key] ? 'text-foreground' : 'text-muted-foreground'}>
                        {label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Hotel List */}
              {presetDataRequired.hotel_list && (() => {
                const allLines = presetHotelList.split('\n');
                const commentLines = allLines.filter(l => l.trimStart().startsWith('#'));
                const hotelLines = allLines.filter(l => !l.trimStart().startsWith('#'));
                const hotelText = hotelLines.join('\n');
                const hotelCount = hotelLines.filter(h => h.trim()).length;
                return (
                  <div>
                    <label className="block text-xs font-semibold mb-1" style={{ fontFamily: 'Syne, sans-serif' }}>
                      Hotel List
                    </label>
                    {commentLines.length > 0 && (
                      <div className="text-[10px] text-muted-foreground font-mono mb-1.5 bg-muted/30 rounded px-2 py-1 border border-border/30">
                        {commentLines.map((c, i) => <div key={i}>{c}</div>)}
                      </div>
                    )}
                    <textarea
                      value={hotelText}
                      onChange={(e) => {
                        const newHotels = e.target.value;
                        setPresetHotelList(commentLines.length > 0 ? commentLines.join('\n') + '\n' + newHotels : newHotels);
                      }}
                      placeholder={"Hilton Downtown\nMarriott Convention Center\nHyatt Regency"}
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs font-mono outline-none focus:ring-1 focus:ring-primary/60 transition-all resize-y min-h-[120px]"
                      rows={8}
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      One hotel per line.{hotelCount > 0 ? ` ${hotelCount} hotel${hotelCount !== 1 ? 's' : ''}.` : ''}
                    </p>
                  </div>
                );
              })()}

              <button
                onClick={savePresets}
                disabled={presetSaving}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-50 transition-colors"
              >
                <Save className="h-3 w-3" />
                {presetSaving ? 'Saving...' : 'Save Configuration'}
              </button>

              {/* Preset Folder Files — DATABASE/Presets */}
              <div className="border-t border-border/40 pt-4 mt-1">
                <div className="flex items-center gap-2 mb-3">
                  <Folder className="h-3.5 w-3.5 text-primary/70" />
                  <span className="text-xs font-semibold" style={{ fontFamily: 'Syne, sans-serif' }}>Preset Files</span>
                  <span className="text-[10px] text-muted-foreground font-mono ml-1">DATABASE / Presets</span>
                </div>

                {presetsLoading ? (
                  <p className="text-xs text-muted-foreground font-mono">Loading preset files...</p>
                ) : presetsEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No preset files yet. Save configuration above to create them.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {presetsEntries.filter(e => e.readable && !['README.md', 'DataRequired.txt', 'ShopType.txt'].includes(e.name)).map(entry => {
                      const filePath = `DATABASE/Presets/${entry.name}`;
                      const content = presetsValues[filePath] ?? '';
                      const original = presetsOriginal[filePath] ?? '';
                      const isDirty = content !== original;
                      const isSaving = presetsSaving[filePath];
                      const label = friendlyLabel(entry.name);
                      const lineCount = Math.max(2, Math.min(6, content.split('\n').length));
                      return (
                        <div key={entry.name} className="rounded-md border border-border/40 bg-muted/20 p-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-medium">{label}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">{entry.name}</span>
                          </div>
                          <textarea
                            value={content}
                            onChange={(e) => setPresetsValues(prev => ({ ...prev, [filePath]: e.target.value }))}
                            className="w-full rounded-md border border-border/60 bg-input px-3 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-primary/60 transition-all resize-none"
                            rows={lineCount}
                            spellCheck={false}
                          />
                          <div className="flex items-center gap-2 mt-1.5">
                            {isDirty && <span className="text-[10px] text-amber-400 font-mono">unsaved</span>}
                            <div className="flex-1" />
                            <button
                              onClick={() => savePresetFile(filePath)}
                              disabled={!isDirty || isSaving}
                              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                              <Save className="h-2.5 w-2.5" />
                              {isSaving ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

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
            {!canEditUI && (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-mono"><Lock className="h-3 w-3" /> Read-only</span>
            )}
            {currentStatus !== 'running' && (
              <button
                onClick={() => actionMutation.mutate('start')}
                disabled={actionMutation.isPending || !canEditUI}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {actionMutation.isPending ? 'Starting...' : 'Start'}
              </button>
            )}
            {currentStatus === 'running' && (
              <button
                onClick={() => actionMutation.mutate('stop')}
                disabled={actionMutation.isPending || !canEditUI}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
              >
                <Square className="h-3.5 w-3.5" />
                {actionMutation.isPending ? 'Stopping...' : 'Stop'}
              </button>
            )}
            <button
              onClick={() => actionMutation.mutate('restart')}
              disabled={actionMutation.isPending || !canEditUI}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {actionMutation.isPending ? 'Restarting...' : 'Restart'}
            </button>
            <button
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending || !canEditUI}
              className="btn-launch inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs disabled:opacity-50 ml-auto"
            >
              <Rocket className="h-3.5 w-3.5" />
              {deployMutation.isPending ? 'Relaunching...' : 'Relaunch'}
            </button>
          </div>
        </div>

        {/* Shop Template Update */}
        <div className="lp-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-primary/70" />
              <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Shuttle Version</h2>
            </div>
            <div className="text-right">
              <span className="text-sm font-mono font-semibold text-[hsl(188,100%,42%)]">
                {shopVersionInfo?.currentVersion || currentShop?.shuttle_version || 'Unknown'}
              </span>
              {shopVersionInfo?.localCommit && (
                <div className="text-[11px] font-mono text-muted-foreground mt-0.5">
                  {shopVersionInfo.localCommit}
                  <span className="ml-1.5">{shopVersionInfo.localDate?.slice(0, 10)}</span>
                </div>
              )}
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
            Caution: Only update when necessary. Skipping multiple versions may cause compatibility issues.
          </p>

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
                    disabled={updateInstalling || !canEditUI}
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

          {upgradeLog && (
            <div className="mt-3 rounded-md bg-[hsl(222,32%,4%)] border border-border/40 p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {upgradeLog}
            </div>
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
              disabled={uploading || !canEditUI}
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
                      disabled={fileSaving || !fileDirty || !canEditUI}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-40 transition-colors"
                    >
                      {!canEditUI ? <Lock className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                      {fileSaving ? 'Saving...' : !canEditUI ? 'Read-only' : 'Save'}
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
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 space-y-6">
          <h2 className="text-sm font-bold text-destructive mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
            Danger Zone
          </h2>

          {/* Wipe Orders */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <ShoppingCart className="h-3.5 w-3.5 text-destructive/70" />
              <h3 className="text-xs font-semibold text-destructive">Wipe Orders</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Clear all orders from the CSV file. The header row is preserved but all order data will be permanently deleted.
            </p>
            {(currentShop?.lifecycle_status === 'active') && (
              <div className="mb-3 px-3 py-2 rounded-md text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20">
                Wipe is disabled while the shop is Active.
              </div>
            )}
            {wipeMessage && (
              <div className={`mb-3 px-3 py-2 rounded-md text-xs border ${
                wipeMessage.includes('fail') || wipeMessage.includes('Failed')
                  ? 'text-destructive bg-destructive/5 border-destructive/20'
                  : 'text-[hsl(142,70%,50%)] bg-[hsl(142,70%,5%)] border-[hsl(142,70%,20%)]'
              }`}>{wipeMessage}</div>
            )}
            {showWipeConfirm ? (
              <div className="space-y-3">
                <p className="text-xs text-destructive font-medium">
                  Type <code className="font-mono bg-destructive/10 px-1.5 py-0.5 rounded">{currentShop?.name}</code> to confirm:
                </p>
                <input
                  type="text"
                  value={wipeTyped}
                  onChange={(e) => setWipeTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleWipeOrders(); if (e.key === 'Escape') { setShowWipeConfirm(false); setWipeTyped(''); } }}
                  placeholder={currentShop?.name}
                  className="w-full max-w-xs rounded-md border border-destructive/40 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-destructive/60 transition-all"
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleWipeOrders}
                    disabled={wiping || wipeTyped !== currentShop?.name}
                    className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-2 text-xs font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
                  >
                    <ShoppingCart className="h-3.5 w-3.5" />
                    {wiping ? 'Wiping...' : 'Wipe All Orders'}
                  </button>
                  <button
                    onClick={() => { setShowWipeConfirm(false); setWipeTyped(''); }}
                    className="rounded-md px-3 py-2 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowWipeConfirm(true)}
                disabled={!canDelete || currentShop?.lifecycle_status === 'active'}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive/80 text-destructive-foreground px-3 py-2 text-xs font-medium hover:bg-destructive/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {!canDelete ? <Lock className="h-3.5 w-3.5" /> : <ShoppingCart className="h-3.5 w-3.5" />}
                Wipe Orders
              </button>
            )}
          </div>

          <div className="border-t border-destructive/20" />

          {/* Delete Shop */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Trash2 className="h-3.5 w-3.5 text-destructive/70" />
              <h3 className="text-xs font-semibold text-destructive">Delete Shop</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Permanently delete this shop, its container, and all associated files. This cannot be undone.
            </p>
            {(currentShop?.lifecycle_status === 'active' || currentShop?.lifecycle_status === 'testing') && (
              <div className="mb-3 px-3 py-2 rounded-md text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20">
                Deletion is disabled while the shop is {currentShop?.lifecycle_status === 'active' ? 'Active' : 'In Testing'}.
              </div>
            )}
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
                disabled={deleteMutation.isPending || !canDelete || currentShop?.lifecycle_status === 'active' || currentShop?.lifecycle_status === 'testing'}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-2 text-xs font-medium hover:bg-destructive/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {!canDelete ? <Lock className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete Shop
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
