import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getShops, getMe, getInventorySummary, getOrders, getShopVersion,
  readShopFile, shopAction,
} from '../lib/api';
import { usePermissions } from '../lib/permissions';
import {
  Rocket, Search, RefreshCw, Lock, Loader2, Package, Activity,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// Display maps (mission-control palette)
// ────────────────────────────────────────────────────────────────────────────
const STATUS = {
  running:  { label: 'running',   color: 'hsl(142 70% 55%)', dot: 'hsl(142 70% 50%)', anim: 'lp-pulse 2s ease-in-out infinite' },
  building: { label: 'building…', color: 'hsl(40 90% 60%)',  dot: 'hsl(40 90% 55%)',  anim: 'lp-blink 1s step-end infinite' },
  stopped:  { label: 'stopped',   color: 'hsl(215 16% 50%)', dot: 'hsl(215 16% 40%)', anim: 'none' },
  error:    { label: 'error',     color: 'hsl(0 80% 62%)',   dot: 'hsl(0 80% 58%)',   anim: 'lp-blink 0.7s step-end infinite' },
};

const LIFECYCLE = {
  development: { label: 'DEV',     c: 'hsl(210 90% 62%)', bg: 'hsl(210 90% 55% / 0.12)', b: 'hsl(210 90% 55% / 0.3)' },
  testing:     { label: 'TESTING', c: 'hsl(40 90% 60%)',  bg: 'hsl(40 90% 55% / 0.12)',  b: 'hsl(40 90% 55% / 0.3)' },
  active:      { label: 'ACTIVE',  c: 'hsl(152 65% 55%)', bg: 'hsl(152 65% 45% / 0.12)', b: 'hsl(152 65% 45% / 0.3)' },
  closed:      { label: 'CLOSED',  c: 'hsl(215 10% 55%)', bg: 'hsl(215 10% 45% / 0.12)', b: 'hsl(215 10% 45% / 0.3)' },
};

const INV = {
  'nominal':     { label: 'Nominal',      color: 'hsl(142 70% 55%)', bg: 'hsl(142 70% 50% / 0.1)' },
  'low-fuel':    { label: 'Low stock',    color: 'hsl(40 90% 60%)',  bg: 'hsl(40 90% 55% / 0.1)' },
  'depleted':    { label: 'Sold out',     color: 'hsl(0 80% 62%)',   bg: 'hsl(0 80% 58% / 0.1)' },
  'no-manifest': { label: 'No inventory', color: 'hsl(var(--muted-foreground))', bg: 'hsl(var(--muted) / 0.7)' },
};

const STATUS_RANK = { running: 0, building: 1, error: 2, stopped: 3 };
const FAVS_KEY = 'lp-pinned-shops';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
function initialsOf(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// Deterministic hue per slug so tiles keep their color across reloads
function hueOf(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return h;
}

// Bucket orders into daily counts for the last 7 days (UTC calendar days)
function last7Days(orders) {
  const counts = new Array(7).fill(0);
  if (!orders?.length) return counts;
  const today = new Date();
  const keys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  for (const o of orders) {
    const raw = o.Date || o.date || '';
    const day = String(raw).slice(0, 10);
    const idx = keys.indexOf(day);
    if (idx !== -1) counts[idx]++;
  }
  return counts;
}

function sparkOf(counts) {
  const max = Math.max(...counts, 1);
  const pts = counts.map((v, i) => {
    const x = (i / (counts.length - 1)) * 68 + 2;
    const y = 19 - (v / max) * 16;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1].split(',');
  return { points: pts.join(' '), x: lx, y: ly };
}

function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || {}; } catch { return {}; }
}

// Disabled-aware action link (mirrors the PermLink pattern from the old card)
function ActionLink({ allowed, to, children }) {
  const cls = 'inline-flex items-center gap-1 rounded-[7px] px-2.5 py-1.5 text-[11px] font-medium text-secondary-foreground bg-secondary/70 border border-border/60 transition-all hover:text-foreground hover:border-primary/35 hover:bg-accent';
  if (!allowed) {
    return (
      <span className={`${cls} opacity-40 cursor-not-allowed pointer-events-none select-none`} aria-disabled="true" title="You don't have permission for this action">
        {children}
        <Lock className="h-2.5 w-2.5 ml-0.5 opacity-60" />
      </span>
    );
  }
  return <Link to={to} className={cls}>{children}</Link>;
}

// ────────────────────────────────────────────────────────────────────────────
// Shop card
// ────────────────────────────────────────────────────────────────────────────
function HomeShopCard({ shop, orders, fav, onFav, delay }) {
  const queryClient = useQueryClient();
  const { getShopPerms } = usePermissions();
  const perms = getShopPerms(shop.slug);
  const [pwVisible, setPwVisible] = useState(false);
  const [hover, setHover] = useState(false);

  const startMutation = useMutation({
    mutationFn: () => shopAction(shop.slug, 'start'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shops'] }),
  });

  const { data: inventoryData } = useQuery({
    queryKey: ['inventory-summary', shop.slug],
    queryFn: () => getInventorySummary(shop.slug),
    refetchInterval: 30000,
  });

  const { data: shopPassword } = useQuery({
    queryKey: ['shop-password', shop.slug],
    queryFn: async () => {
      try {
        return (await readShopFile(shop.slug, 'DATABASE/Design/Details/Password.txt')).content.trim();
      } catch {
        try {
          return (await readShopFile(shop.slug, 'DATABASE/design/details/Password.txt')).content.trim();
        } catch { return ''; }
      }
    },
    staleTime: 60000,
  });

  const { data: versionData } = useQuery({
    queryKey: ['shop-version', shop.slug],
    queryFn: () => getShopVersion(shop.slug).catch(() => null),
    staleTime: 5 * 60 * 1000,
  });

  const st = STATUS[shop.status] || STATUS.stopped;
  const lc = LIFECYCLE[shop.lifecycle_status] || null;
  const invStatus = inventoryData?.status || 'no-manifest';
  const inv = INV[invStatus] || INV['no-manifest'];
  const counts = useMemo(() => last7Days(orders), [orders]);
  const spark = useMemo(() => sparkOf(counts), [counts]);
  const ordersToday = counts[counts.length - 1];
  const version = versionData?.currentVersion || versionData?.dbVersion || null;
  const hue = hueOf(shop.slug);
  const canStart = (shop.status === 'stopped' || shop.status === 'error') && perms.can_edit_ui;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative flex flex-col rounded-[14px] border bg-card/65 backdrop-blur-xl lp-fadein"
      style={{
        padding: '18px 18px 14px',
        borderColor: hover ? 'hsl(188 100% 42% / 0.35)' : 'hsl(var(--border) / 0.8)',
        boxShadow: hover
          ? '0 0 0 1px hsl(188 100% 42% / 0.08), 0 8px 32px hsl(188 100% 42% / 0.08)'
          : '0 4px 24px hsl(0 0% 0% / 0.15)',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'border-color 0.25s ease, box-shadow 0.25s ease, transform 0.2s ease',
        animationDelay: delay,
      }}
    >
      {/* header */}
      <div className="flex items-start gap-3">
        <div
          className="flex-none flex items-center justify-center text-white"
          style={{
            width: 44, height: 44, borderRadius: 11,
            fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 17,
            background: `linear-gradient(135deg, hsl(${hue} 60% 38%), hsl(${hue + 40} 70% 30%))`,
            boxShadow: 'inset 0 1px 0 hsl(0 0% 100% / 0.15)',
          }}
        >
          {initialsOf(shop.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate text-[15px] font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
              {shop.name}
            </h3>
            {lc && (
              <span
                className="font-mono"
                style={{
                  fontSize: 9, fontWeight: 600, letterSpacing: '0.08em',
                  padding: '2px 6px', borderRadius: 4,
                  border: `1px solid ${lc.b}`, background: lc.bg, color: lc.c,
                }}
              >
                {lc.label}
              </span>
            )}
          </div>
          <a
            href={`/${shop.slug}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-primary hover:underline"
          >
            /{shop.slug} ↗
          </a>
        </div>
        <button
          onClick={() => onFav(shop.slug)}
          title={fav ? 'Unpin' : 'Pin to top'}
          className="flex-none border-none bg-transparent cursor-pointer p-0.5 text-[15px] leading-none transition-transform hover:scale-125"
          style={{ color: fav ? 'hsl(45 95% 60%)' : 'hsl(215 16% 35%)' }}
        >
          {fav ? '★' : '☆'}
        </button>
      </div>

      <p className="mt-2.5 mb-0 truncate text-xs text-muted-foreground">
        {shop.description || 'No description provided.'}
      </p>

      {/* access + version */}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/70 px-2.5 py-2">
        <Lock className="h-[11px] w-[11px] text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.1em' }}>pass</span>
        {shopPassword ? (
          <button
            onClick={() => setPwVisible(v => !v)}
            title={pwVisible ? 'Click to hide' : 'Click to reveal'}
            className="cursor-pointer border-none bg-transparent p-0 font-mono text-[11.5px] text-foreground/80 hover:text-primary select-all"
            style={{ letterSpacing: '0.04em' }}
          >
            {pwVisible ? shopPassword : '••••••••••'}
          </button>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground/70">none</span>
        )}
        <div className="flex-1" />
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.1em' }}>ver</span>
        <span
          className="font-mono text-[11px] text-primary"
          style={{ padding: '2px 7px', borderRadius: 5, background: 'hsl(188 100% 42% / 0.09)', border: '1px solid hsl(188 100% 42% / 0.22)' }}
        >
          {version || '—'}
        </span>
      </div>

      {/* status strip */}
      <div className="mt-3 flex items-center gap-3.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium" style={{ color: st.color }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.dot, animation: st.anim }} />
          {shop.status === 'building' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {st.label}
        </span>
        <Link
          to={`/shops/${shop.slug}/catalog`}
          className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] transition-opacity hover:opacity-80"
          style={{ padding: '3px 8px', borderRadius: 6, background: inv.bg, color: inv.color }}
        >
          <Package className="h-2.5 w-2.5" />
          {inv.label}
        </Link>
        <div className="flex-1" />
        <div className="flex items-center gap-2" title="Orders, last 7 days">
          <svg width="72" height="22" viewBox="0 0 72 22" style={{ overflow: 'visible' }}>
            <polyline points={spark.points} fill="none" stroke="hsl(188 100% 48%)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
            <circle cx={spark.x} cy={spark.y} r="2.2" fill="hsl(188 100% 55%)" />
          </svg>
          <span className="font-mono text-[11px] text-foreground/80">
            {ordersToday}
            <span className="text-muted-foreground"> today</span>
          </span>
        </div>
      </div>

      {/* actions */}
      <div className="mt-3.5 flex items-center gap-1.5 border-t border-border/70 pt-3">
        {canStart && (
          <button
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
            className="inline-flex items-center gap-1 cursor-pointer rounded-[7px] px-2.5 py-1.5 text-[11px] font-semibold transition-all disabled:opacity-50"
            style={{ color: 'hsl(142 70% 55%)', background: 'hsl(142 70% 50% / 0.1)', border: '1px solid hsl(142 70% 50% / 0.25)' }}
          >
            {startMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : '▶'} Start
          </button>
        )}
        <div className="flex-1" />
        <ActionLink allowed={perms.can_view_orders} to={`/shops/${shop.slug}/orders`}>Orders</ActionLink>
        <ActionLink allowed={perms.can_edit_items} to={`/shops/${shop.slug}/catalog`}>Catalog</ActionLink>
        <ActionLink allowed={perms.can_view_analytics} to={`/shops/${shop.slug}/analytics`}>Analytics</ActionLink>
        <ActionLink allowed={perms.can_edit_ui} to={`/shops/${shop.slug}/settings`}>Settings</ActionLink>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Dashboard (Launchpad home — "Mission Control")
// ────────────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
    refetchInterval: 10000,
  });

  const { data: meData } = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
  });

  const { canCreateShops } = usePermissions();
  const shops = useMemo(() => data?.shops || [], [data]);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [favs, setFavs] = useState(loadFavs);

  const toggleFav = useCallback((slug) => {
    setFavs(prev => {
      const next = { ...prev, [slug]: !prev[slug] };
      if (!next[slug]) delete next[slug];
      try { localStorage.setItem(FAVS_KEY, JSON.stringify(next)); } catch { /* best effort */ }
      return next;
    });
  }, []);

  // Per-shop orders (for sparklines + "orders today"); permission errors → empty
  const ordersResults = useQueries({
    queries: shops.map(s => ({
      queryKey: ['orders-lite', s.slug],
      queryFn: () => getOrders(s.slug).catch(() => ({ orders: [] })),
      staleTime: 60000,
      refetchInterval: 60000,
    })),
  });
  const ordersBySlug = useMemo(() => {
    const map = {};
    shops.forEach((s, i) => { map[s.slug] = ordersResults[i]?.data?.orders || []; });
    return map;
  }, [shops, ordersResults]);

  const statOrdersToday = useMemo(
    () => shops.reduce((n, s) => {
      const counts = last7Days(ordersBySlug[s.slug]);
      return n + counts[counts.length - 1];
    }, 0),
    [shops, ordersBySlug],
  );

  const running = shops.filter(s => s.status === 'running').length;

  const userName = meData?.user?.name?.split(' ')[0] || meData?.user?.username || 'commander';
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

  // Search + filter + sort (pinned → status rank → name)
  const shownShops = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shops
      .filter(s =>
        (!q || s.name.toLowerCase().includes(q) || s.slug.includes(q) || (s.description || '').toLowerCase().includes(q)) &&
        (filter === 'all' ? true : filter === 'favs' ? !!favs[s.slug] : s.status === filter))
      .slice()
      .sort((a, b) =>
        (favs[b.slug] ? 1 : 0) - (favs[a.slug] ? 1 : 0) ||
        (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4) ||
        a.name.localeCompare(b.name));
  }, [shops, query, filter, favs]);

  const chips = [
    { key: 'all', label: 'all' },
    { key: 'favs', label: '★ pinned' },
    { key: 'running', label: 'running' },
    { key: 'building', label: 'building' },
    { key: 'stopped', label: 'stopped' },
  ];

  return (
    <div className="lp-fadein flex min-h-[calc(100vh-120px)] flex-col">
      {/* ── Hero ─────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="mb-1.5 font-mono text-[11px] uppercase text-muted-foreground" style={{ letterSpacing: '0.22em' }}>
            Mission Control · LR Paris
          </p>
          <h1
            className="m-0 text-foreground"
            style={{ fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 42, letterSpacing: '-0.02em', lineHeight: 1.05 }}
          >
            {greeting}, {userName}.
          </h1>
          <p className="mb-0 mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <span>{running > 0 ? 'Your fleet is looking good' : 'The fleet is quiet — nothing running'}</span>
            <span
              className="inline-block"
              style={{ width: 7, height: 14, background: 'hsl(188 100% 50% / 0.8)', animation: 'lp-blink 1.1s step-end infinite' }}
            />
          </p>
        </div>
        <div className="flex items-center gap-5">
          <div className="flex gap-6 font-mono">
            <div className="text-right">
              <div className="text-2xl font-medium" style={{ color: 'hsl(142 70% 55%)' }}>{running}</div>
              <div className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.14em' }}>running</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-medium text-foreground">{shops.length}</div>
              <div className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.14em' }}>shops</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-medium text-primary">{statOrdersToday}</div>
              <div className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.14em' }}>orders today</div>
            </div>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh shops"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border/40 text-muted-foreground transition-all hover:border-primary/40 hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
          {canCreateShops && (
            <Link to="/shops/new" className="btn-launch inline-flex items-center gap-2 rounded-[9px] px-5 py-3 text-sm">
              <Rocket className="h-4 w-4" style={{ animation: 'lp-drift 3s ease-in-out infinite' }} />
              Launch Shop
            </Link>
          )}
        </div>
      </div>

      {/* ── Controls ─────────────────────────────────────── */}
      <div className="mb-5 mt-7 flex flex-wrap items-center gap-2.5 lp-fadein" style={{ animationDelay: '80ms' }}>
        <div className="relative min-w-[220px] max-w-[340px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search shops…"
            className="w-full rounded-lg border border-border bg-input py-2 pl-[34px] pr-3 text-[13px] text-foreground outline-none transition-all focus:border-primary/50 focus:ring-[3px] focus:ring-primary/10"
          />
        </div>
        {chips.map(c => {
          const active = filter === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className="cursor-pointer font-mono text-[11px] transition-all hover:border-primary/50"
              style={{
                padding: '7px 13px', borderRadius: 99,
                border: `1px solid ${active ? 'hsl(188 100% 42% / 0.5)' : 'hsl(var(--border))'}`,
                background: active ? 'hsl(188 100% 42% / 0.14)' : 'hsl(var(--input) / 0.6)',
                color: active ? 'hsl(188 100% 55%)' : 'hsl(var(--muted-foreground))',
              }}
            >
              {c.label}
            </button>
          );
        })}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground">{shownShops.length} / {shops.length} shops</span>
      </div>

      {/* ── States ───────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <span className="term-cursor" />
          Loading shops...
        </div>
      )}
      {error && <p className="py-8 text-center text-sm text-destructive">Failed to load shops.</p>}

      {!isLoading && !error && shops.length === 0 && (
        <div className="lp-card rounded-xl p-12 text-center">
          <div
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl"
            style={{ background: 'linear-gradient(135deg, hsl(188 100% 38% / 0.15), hsl(210 100% 52% / 0.1))' }}
          >
            <Rocket className="lp-glow h-7 w-7" />
          </div>
          <h2 className="mb-2 text-lg font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>No shops yet</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            {canCreateShops ? 'Launch your first shop to get started.' : 'No shops have been created yet. Ask an admin to set one up.'}
          </p>
          {canCreateShops && (
            <Link to="/shops/new" className="btn-launch inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-sm">
              <Rocket className="h-4 w-4" />
              Launch your first shop
            </Link>
          )}
        </div>
      )}

      {/* ── Shop grid ────────────────────────────────────── */}
      {!isLoading && shownShops.length > 0 && (
        <div className="grid gap-[18px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {shownShops.map((shop, i) => (
            <HomeShopCard
              key={shop.id}
              shop={shop}
              orders={ordersBySlug[shop.slug]}
              fav={!!favs[shop.slug]}
              onFav={toggleFav}
              delay={`${i * 50}ms`}
            />
          ))}
        </div>
      )}

      {!isLoading && shops.length > 0 && shownShops.length === 0 && (
        <div className="rounded-[14px] border border-dashed border-border px-5 py-14 text-center">
          <p className="mb-1 text-base font-bold text-foreground" style={{ fontFamily: 'Syne, sans-serif' }}>No shops match</p>
          <p className="mb-4 text-[13px] text-muted-foreground">Try a different search, or clear the filters.</p>
          <button
            onClick={() => { setQuery(''); setFilter('all'); }}
            className="cursor-pointer rounded-[7px] px-4 py-2 text-xs font-semibold text-primary transition-colors"
            style={{ background: 'hsl(188 100% 42% / 0.1)', border: '1px solid hsl(188 100% 42% / 0.3)' }}
          >
            Clear filters
          </button>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────── */}
      <footer className="mt-12 border-t border-border/50 pb-2 pt-4 text-center">
        <p className="m-0 font-mono text-[11px] text-muted-foreground/80">
          Launchpad LC-{__APP_VERSION__} “Ignition” · made with <span style={{ color: 'hsl(350 80% 60%)' }}>♥</span> in NYC
        </p>
      </footer>
    </div>
  );
}
