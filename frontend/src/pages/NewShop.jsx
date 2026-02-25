import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createShop, getShopLogs, uploadDatabaseZip } from '../lib/api';
import { ArrowLeft, Terminal, Rocket, Database, FileArchive, Zap } from 'lucide-react';

const SHOP_PRESETS = [
  {
    label: 'Basic Free Shop',
    shopType: 'free',
    dataRequired: { address: true, details: true, extra_notes: true, shipping_handler: true, hotel_list: false },
  },
  {
    label: 'PO Required Shop',
    shopType: 'po',
    dataRequired: { address: true, details: true, extra_notes: true, shipping_handler: true, hotel_list: false },
  },
  {
    label: 'Hotel Event Shop',
    shopType: 'free',
    dataRequired: { address: true, details: true, extra_notes: true, shipping_handler: false, hotel_list: true },
  },
  {
    label: 'Minimal Free Shop',
    shopType: 'free',
    dataRequired: { address: false, details: false, extra_notes: false, shipping_handler: true, hotel_list: false },
  },
];

export default function NewShop() {
  const [name, setName] = useState('');
  const [customSlug, setCustomSlug] = useState('');
  const [description, setDescription] = useState('');
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

  // STS-2.01: Shop type & preset state
  const [shopType, setShopType] = useState('free');
  const [dataRequired, setDataRequired] = useState({
    address: true,
    details: true,
    extra_notes: true,
    shipping_handler: true,
    hotel_list: false,
  });
  const [hotelList, setHotelList] = useState('');

  const mutation = useMutation({
    mutationFn: createShop,
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setCreationLog(data.log || '');
      const slug = data.shop?.slug;
      setCreatedSlug(slug || null);

      // Upload DATABASE.zip if selected
      if (slug && dbFiles) {
        setUploadStatus('Uploading DATABASE.zip to server...');
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

  const autoSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const slug = customSlug
    ? customSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : autoSlug;

  const applyPreset = (preset) => {
    setShopType(preset.shopType);
    setDataRequired({ ...preset.dataRequired });
    if (!preset.dataRequired.hotel_list) setHotelList('');
  };

  const toggleDataRequired = (key) => {
    setDataRequired(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (key === 'hotel_list' && !next.hotel_list) setHotelList('');
      return next;
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    setCreationLog('');
    setLiveLogs('');
    setUploadStatus('');
    setCreatedSlug(null);
    const payload = { name, shopType, dataRequired };
    if (customSlug.trim()) payload.slug = customSlug.trim();
    if (description.trim()) payload.description = description.trim();
    if (folderPath.trim()) payload.folderPath = folderPath.trim();
    if (dataRequired.hotel_list && hotelList.trim()) payload.hotelList = hotelList.trim();
    mutation.mutate(payload);
  };

  const terminalContent = [creationLog, uploadStatus, liveLogs]
    .filter(Boolean)
    .join('\n\n');

  const dataRequiredLabels = {
    address: 'Address',
    details: 'Details',
    extra_notes: 'Extra Notes',
    shipping_handler: 'Shipping Handler',
    hotel_list: 'Hotel List',
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
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">New Launch</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Launch Shop</h1>
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
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="description"
                   style={{ fontFamily: 'Syne, sans-serif' }}>
              Description{' '}
              <span className="text-muted-foreground font-normal text-xs">(optional)</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description shown on the dashboard"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all resize-none"
              rows={2}
              disabled={mutation.isPending}
            />
          </div>

          {/* URL Path */}
          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="customSlug"
                   style={{ fontFamily: 'Syne, sans-serif' }}>
              URL Path{' '}
              <span className="text-muted-foreground font-normal text-xs">(optional)</span>
            </label>
            <div className="flex items-center gap-0 rounded-md border border-border bg-input overflow-hidden focus-within:ring-1 focus-within:ring-primary/60 focus-within:border-primary/60 transition-all">
              <span className="pl-3 text-sm text-muted-foreground select-none whitespace-nowrap">lrparisstore.com /</span>
              <input
                id="customSlug"
                type="text"
                value={customSlug}
                onChange={(e) => setCustomSlug(e.target.value)}
                placeholder={autoSlug || 'my-awesome-shop'}
                className="flex-1 bg-transparent px-1 py-2 text-sm font-mono outline-none"
                disabled={mutation.isPending}
              />
            </div>
            {slug && (
              <p className="text-xs text-muted-foreground mt-1.5 font-mono">
                URL: <code className="text-primary">/{slug}</code>
              </p>
            )}
          </div>

          {/* Template Presets */}
          <div>
            <label className="block text-sm font-semibold mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
              Quick Setup
            </label>
            <div className="flex flex-wrap gap-2">
              {SHOP_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  disabled={mutation.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
                >
                  <Zap className="h-3 w-3" />
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Shop Type */}
          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="shopType"
                   style={{ fontFamily: 'Syne, sans-serif' }}>
              Shop Type
            </label>
            <select
              id="shopType"
              value={shopType}
              onChange={(e) => setShopType(e.target.value)}
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
              disabled={mutation.isPending}
            >
              <option value="free">Free</option>
              <option value="po">Purchase Order</option>
              <option value="stripe" disabled>Stripe (Coming Soon)</option>
            </select>
          </div>

          {/* Data Required Checkboxes */}
          <div>
            <label className="block text-sm font-semibold mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
              Checkout Fields
            </label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(dataRequiredLabels).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={dataRequired[key]}
                    onChange={() => toggleDataRequired(key)}
                    disabled={mutation.isPending}
                    className="rounded border-border accent-primary"
                  />
                  <span className={dataRequired[key] ? 'text-foreground' : 'text-muted-foreground'}>
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Hotel List (conditional) */}
          {dataRequired.hotel_list && (
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="hotelList"
                     style={{ fontFamily: 'Syne, sans-serif' }}>
                Hotel List
              </label>
              <textarea
                id="hotelList"
                value={hotelList}
                onChange={(e) => setHotelList(e.target.value)}
                placeholder={"Hilton Downtown\nMarriott Convention Center\nHyatt Regency"}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all resize-none"
                rows={4}
                disabled={mutation.isPending}
              />
              <p className="text-xs text-muted-foreground mt-1">
                One hotel per line. Shown as a dropdown during checkout.
              </p>
            </div>
          )}

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
                  Upload a <code className="font-mono">.zip</code> containing your <code className="font-mono">DATABASE/</code> folder — it will be uploaded to the server and replace the template DATABASE folder after deployment.
                </p>
                <input
                  ref={dbInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => setDbFiles(e.target.files?.[0] || null)}
                  disabled={mutation.isPending}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => dbInputRef.current?.click()}
                    disabled={mutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/40 transition-all disabled:opacity-50"
                  >
                    <FileArchive className="h-3.5 w-3.5" />
                    {dbFiles ? dbFiles.name : 'Choose .zip file'}
                  </button>
                  <span className="text-[10px] text-muted-foreground/60">Max 1 GB</span>
                </div>
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
              {mutation.isPending ? 'Launching...' : 'Launch Shop'}
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

      {/* Launch success */}
      {createdSlug && !mutation.isPending && (
        <div className="lp-card rounded-xl p-6 mb-4 text-center lp-fadein">
          <img
            src="https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExOG42ZDY2ZzNoeWNoNWZ5eTN0bmdqaDdqcGtvMm8xbjExaThjbTVhNyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/jV65cP2S4mphrQfJkk/giphy.gif"
            alt="Launching!"
            className="mx-auto rounded-lg mb-4 max-h-48"
          />
          <h2 className="text-lg font-bold mb-1" style={{ fontFamily: 'Syne, sans-serif' }}>
            Launching Site Now!
          </h2>
          <p className="text-sm text-muted-foreground">
            Your shop <code className="text-primary font-mono">/{createdSlug}</code> has been created.
          </p>
        </div>
      )}

      {/* Terminal panel */}
      {(mutation.isPending || creationLog || createdSlug) && (
        <div className="rounded-xl border border-border/60 bg-[hsl(222,32%,4%)] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-[hsl(222,28%,7%)]">
            <Terminal className="h-3.5 w-3.5 text-primary/70" />
            <span className="text-xs font-mono text-muted-foreground">
              {createdSlug ? `shop: ${createdSlug}` : 'launching...'}
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
              <span className="text-zinc-500">Launching shop — cloning template &amp; starting container...</span>
            )}
            {mutation.isPending && (
              <div className="text-amber-400/80 mb-2">
                Building the shop — this may take a few minutes.{'\n'}
                The shop will be ready when the terminal shows:{'\n'}
                <span className="text-[hsl(142,70%,50%)]">  ✓ Starting...{'\n'}  ✓ Ready in Xms</span>
              </div>
            )}
            {terminalContent || (mutation.isPending ? '' : <span className="text-zinc-500">No output.</span>)}
            {mutation.isPending && <span className="term-cursor" />}
          </div>
        </div>
      )}
    </div>
  );
}
