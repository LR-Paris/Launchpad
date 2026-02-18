import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createShop, getShopLogs, uploadDatabaseZip } from '../lib/api';
import { ArrowLeft, Terminal, Rocket, Database, FileArchive } from 'lucide-react';

export default function NewShop() {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [dbFiles, setDbFiles] = useState(null); // single File (zip)
  const [error, setError] = useState('');
  const [createdSlug, setCreatedSlug] = useState(null);
  const [creationLog, setCreationLog] = useState('');
  const [liveLogs, setLiveLogs] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const terminalRef = useRef(null);
  const dbInputRef = useRef(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: createShop,
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setCreationLog(data.log || '');
      const slug = data.shop?.slug;
      setCreatedSlug(slug || null);

      // Upload DATABASE.zip if selected
      if (slug && dbFiles) {
        setUploadStatus('Extracting DATABASE.zip...');
        try {
          const result = await uploadDatabaseZip(slug, 'DATABASE', dbFiles);
          setUploadStatus(`✓ DATABASE: ${result.message}`);
        } catch (uploadErr) {
          setUploadStatus(`✗ DATABASE upload failed: ${uploadErr.response?.data?.error || uploadErr.message}`);
        }
      }
    },
    onError: (err) => {
      setError(err.response?.data?.error || 'Failed to create shop');
    },
  });

  const { data: logsData } = useQuery({
    queryKey: ['shop-logs', createdSlug],
    queryFn: () => getShopLogs(createdSlug, 150),
    enabled: !!createdSlug,
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (logsData?.logs !== undefined) setLiveLogs(logsData.logs);
  }, [logsData]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [creationLog, liveLogs, uploadStatus]);

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    setCreationLog('');
    setLiveLogs('');
    setUploadStatus('');
    setCreatedSlug(null);
    const payload = { name };
    if (folderPath.trim()) payload.folderPath = folderPath.trim();
    mutation.mutate(payload);
  };

  const terminalContent = [creationLog, uploadStatus, liveLogs]
    .filter(Boolean)
    .join('\n\n');

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
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">New Deployment</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Deploy Shop</h1>
        </div>
      </div>

      {!createdSlug && (
        <form onSubmit={handleSubmit} className="lp-card rounded-xl p-6 mb-4 space-y-5">
          {/* Shop name */}
          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="name"
                   style={{ fontFamily: 'Syne, sans-serif' }}>
              Shop Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Shop"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
              required
              disabled={mutation.isPending}
            />
            {slug && (
              <p className="text-xs text-muted-foreground mt-1.5 font-mono">
                slug: <code className="text-primary">{slug}</code>
              </p>
            )}
          </div>

          {/* Source folder (optional) */}
          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="folderPath"
                   style={{ fontFamily: 'Syne, sans-serif' }}>
              Source Folder Path{' '}
              <span className="text-muted-foreground font-normal text-xs">(optional)</span>
            </label>
            <input
              id="folderPath"
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="/path/to/local/shop"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
              disabled={mutation.isPending}
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Leave empty to clone from the Shuttle template repository.
            </p>
          </div>

          {/* DATABASE zip upload */}
          <div className="rounded-lg border border-dashed border-border hover:border-primary/40 transition-colors p-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                   style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
                <Database className="h-4 w-4 lp-glow" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold mb-0.5" style={{ fontFamily: 'Syne, sans-serif' }}>
                  Upload DATABASE.zip
                  <span className="ml-2 text-xs font-normal text-muted-foreground">(optional)</span>
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  Upload a <code className="font-mono">.zip</code> of your DATABASE folder — it will be extracted into the shop after deployment.
                </p>
                <input
                  ref={dbInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => setDbFiles(e.target.files?.[0] || null)}
                  disabled={mutation.isPending}
                />
                <button
                  type="button"
                  onClick={() => dbInputRef.current?.click()}
                  disabled={mutation.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/40 transition-all disabled:opacity-50"
                >
                  <FileArchive className="h-3.5 w-3.5" />
                  {dbFiles ? dbFiles.name : 'Choose .zip file'}
                </button>
                {dbFiles && (
                  <p className="text-xs text-muted-foreground mt-2 font-mono">
                    {dbFiles.name} — {(dbFiles.size / 1024).toFixed(1)} KB
                  </p>
                )}
              </div>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="btn-launch inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-sm disabled:opacity-50"
            >
              <Rocket className="h-4 w-4" />
              {mutation.isPending ? 'Deploying...' : 'Deploy Shop'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              disabled={mutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm font-medium hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Terminal panel */}
      {(mutation.isPending || creationLog || createdSlug) && (
        <div className="rounded-xl border border-border/60 bg-[hsl(222,32%,4%)] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-[hsl(222,28%,7%)]">
            <Terminal className="h-3.5 w-3.5 text-primary/70" />
            <span className="text-xs font-mono text-muted-foreground">
              {createdSlug ? `shop: ${createdSlug}` : 'deploying...'}
            </span>
            <div className="flex-1" />
            {createdSlug && (
              <div className="flex items-center gap-3">
                <Link to={`/shops/${createdSlug}/settings`}
                      className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
                  settings →
                </Link>
                <button onClick={() => navigate('/')}
                        className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
                  dashboard →
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
            {mutation.isPending && <span className="term-cursor" />}
          </div>
        </div>
      )}
    </div>
  );
}
