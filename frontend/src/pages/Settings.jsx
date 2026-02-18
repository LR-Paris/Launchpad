import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deployShop, deleteShop, getShops, updateShop, getShopLogs } from '../lib/api';
import { ArrowLeft, Rocket, Trash2, Terminal, Database, Save, RefreshCw } from 'lucide-react';

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

  const logOutput = [deployLog, logsData?.logs].filter(Boolean).join('\n\n--- Live Logs ---\n');

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
