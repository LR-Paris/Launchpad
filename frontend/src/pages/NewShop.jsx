import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createShop, getShopLogs } from '../lib/api';
import { ArrowLeft, Terminal } from 'lucide-react';

export default function NewShop() {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [error, setError] = useState('');
  const [createdSlug, setCreatedSlug] = useState(null);
  const [creationLog, setCreationLog] = useState('');
  const [liveLogs, setLiveLogs] = useState('');
  const terminalRef = useRef(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: createShop,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setCreationLog(data.log || '');
      setCreatedSlug(data.shop?.slug || null);
    },
    onError: (err) => {
      setError(err.response?.data?.error || 'Failed to create shop');
    },
  });

  // Poll live docker logs once shop is created
  const { data: logsData } = useQuery({
    queryKey: ['shop-logs', createdSlug],
    queryFn: () => getShopLogs(createdSlug, 150),
    enabled: !!createdSlug,
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (logsData?.logs !== undefined) {
      setLiveLogs(logsData.logs);
    }
  }, [logsData]);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [creationLog, liveLogs]);

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    setCreationLog('');
    setLiveLogs('');
    setCreatedSlug(null);
    const payload = { name };
    if (folderPath.trim()) {
      payload.folderPath = folderPath.trim();
    }
    mutation.mutate(payload);
  };

  const terminalContent = [creationLog, liveLogs].filter(Boolean).join('\n\n--- Live Container Logs ---\n');

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-xl font-semibold">Deploy New Shop</h1>
      </div>

      {!createdSlug && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-card p-6 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="name">
              Shop Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Shop"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              required
              disabled={mutation.isPending}
            />
            {slug && (
              <p className="text-xs text-muted-foreground mt-1">
                Slug: <code className="bg-muted px-1 rounded">{slug}</code>
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="folderPath">
              Local Folder Path <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              id="folderPath"
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="/path/to/local/shop"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              disabled={mutation.isPending}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to clone from the Shuttle template repository.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? 'Deploying...' : 'Deploy Shop'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              disabled={mutation.isPending}
              className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Terminal panel — shown during creation and after */}
      {(mutation.isPending || creationLog || createdSlug) && (
        <div className="rounded-lg border bg-zinc-950 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900">
            <Terminal className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-xs font-mono text-zinc-400">
              {createdSlug ? `shop: ${createdSlug}` : 'deploying...'}
            </span>
            <div className="flex-1" />
            {createdSlug && (
              <div className="flex items-center gap-2">
                <Link
                  to={`/shops/${createdSlug}/settings`}
                  className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Settings
                </Link>
                <button
                  onClick={() => navigate('/')}
                  className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Dashboard →
                </button>
              </div>
            )}
          </div>
          <div
            ref={terminalRef}
            className="p-4 h-80 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed"
          >
            {mutation.isPending && !creationLog && (
              <span className="text-zinc-500">Waiting for server...</span>
            )}
            {terminalContent || (mutation.isPending ? '' : <span className="text-zinc-500">No output.</span>)}
            {mutation.isPending && (
              <span className="inline-block w-2 h-3 bg-zinc-400 ml-0.5 animate-pulse" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
