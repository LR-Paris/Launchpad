import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shopAction, deleteShop, getInventorySummary } from '../lib/api';
import { usePermissions } from '../lib/permissions';
import { Play, Square, RotateCcw, Trash2, ShoppingCart, Settings, ExternalLink, Package, BarChart3, Lock } from 'lucide-react';

const STATUS_COLORS = {
  running: 'text-[hsl(142,70%,50%)]',
  error:   'text-destructive',
  stopped: 'text-muted-foreground',
};

const LIFECYCLE_BADGE = {
  none:        null,
  development: { label: 'DEV',     cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  testing:     { label: 'TESTING', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  active:      { label: 'ACTIVE',  cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  closed:      { label: 'CLOSED',  cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
};

const INVENTORY_DISPLAY = {
  'nominal':     { label: 'Nominal',       color: 'text-[hsl(142,70%,50%)]', bg: 'bg-[hsl(142,70%,50%)]/10' },
  'low-fuel':    { label: 'Low Stock',     color: 'text-amber-500',          bg: 'bg-amber-500/10' },
  'depleted':    { label: 'Sold Out',      color: 'text-red-500',            bg: 'bg-red-500/10' },
  'no-manifest': { label: 'No Inventory',  color: 'text-muted-foreground',   bg: 'bg-muted/30' },
};

// Disabled button wrapper — greys out and shows lock icon when no permission
function PermButton({ allowed, children, className = '', ...props }) {
  if (!allowed) {
    return (
      <span
        className={`${className} opacity-40 cursor-not-allowed pointer-events-none select-none`}
        title="You don't have permission for this action"
        aria-disabled="true"
      >
        {children}
        <Lock className="h-2.5 w-2.5 ml-0.5 opacity-60" />
      </span>
    );
  }
  return <button className={className} {...props}>{children}</button>;
}

// Disabled link wrapper
function PermLink({ allowed, children, className = '', ...props }) {
  if (!allowed) {
    return (
      <span
        className={`${className} opacity-40 cursor-not-allowed pointer-events-none select-none`}
        title="You don't have permission for this action"
        aria-disabled="true"
      >
        {children}
        <Lock className="h-2.5 w-2.5 ml-0.5 opacity-60" />
      </span>
    );
  }
  return <Link className={className} {...props}>{children}</Link>;
}

export default function ShopCard({ shop }) {
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');
  const { getShopPerms } = usePermissions();
  const perms = getShopPerms(shop.slug);

  const actionMutation = useMutation({
    mutationFn: ({ slug, action }) => shopAction(slug, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shops'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (slug) => deleteShop(slug, true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shops'] }),
  });

  const handleDelete = () => {
    if (deleteTyped === shop.name) {
      setShowDeleteConfirm(false);
      setDeleteTyped('');
      deleteMutation.mutate(shop.slug);
    }
  };

  const { data: inventoryData } = useQuery({
    queryKey: ['inventory-summary', shop.slug],
    queryFn: () => getInventorySummary(shop.slug),
    refetchInterval: 30000,
  });

  const busy = actionMutation.isPending || deleteMutation.isPending;
  const statusColor = STATUS_COLORS[shop.status] || STATUS_COLORS.stopped;

  const inventoryStatus = inventoryData?.status || 'no-manifest';
  const inv = INVENTORY_DISPLAY[inventoryStatus] || INVENTORY_DISPLAY['no-manifest'];

  return (
    <div className="rounded-xl p-5 flex flex-col border border-border/60 hover:border-primary/25 transition-all duration-300 h-full"
         style={{
           background: 'hsl(var(--card) / 0.65)',
           backdropFilter: 'blur(12px)',
           WebkitBackdropFilter: 'blur(12px)',
           boxShadow: '0 4px 24px hsl(0 0% 0% / 0.08), inset 0 1px 0 hsl(var(--card) / 0.3)',
         }}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-base truncate" style={{ fontFamily: 'Syne, sans-serif' }}>
            {shop.name}
          </h3>
          <div className="flex items-center gap-2 mt-0.5">
            <code className="text-xs text-muted-foreground font-mono">{shop.slug}</code>
            <span className="text-border">·</span>
            <a
              href={`/${shop.slug}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-primary hover:underline flex items-center gap-0.5"
            >
              /{shop.slug}
              <ExternalLink className="h-2.5 w-2.5 ml-0.5 opacity-60" />
            </a>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {shop.description || 'No description provided.'}
          </p>
        </div>
        {/* Lifecycle + Container Status */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {LIFECYCLE_BADGE[shop.lifecycle_status || 'none'] && (
            <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border ${LIFECYCLE_BADGE[shop.lifecycle_status].cls}`}>
              {LIFECYCLE_BADGE[shop.lifecycle_status].label}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            {shop.status === 'running' ? (
              <span className="w-2 h-2 status-dot-running" />
            ) : (
              <span className={`w-2 h-2 rounded-full ${shop.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
            )}
            <span className={`text-xs font-mono font-medium ${statusColor}`}>
              {shop.status}
            </span>
          </div>
        </div>
      </div>

      {/* Inventory status indicator */}
      {inventoryData && (
        <Link
          to={`/shops/${shop.slug}/catalog`}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-mono font-medium mb-3 transition-all hover:opacity-80 ${inv.bg} ${inv.color}`}
        >
          <Package className="h-3 w-3" />
          {inv.label}
          {inventoryData.total > 0 && (
            <span className="opacity-70">
              ({inventoryData.depleted > 0 ? `${inventoryData.depleted} sold out` : inventoryData.lowFuel > 0 ? `${inventoryData.lowFuel} low` : `${inventoryData.total} items`})
            </span>
          )}
        </Link>
      )}

      {/* Spacer to push actions to bottom */}
      <div className="flex-1" />

      {/* Delete confirmation */}
      {showDeleteConfirm && perms.can_delete && (
        <div className="mb-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 space-y-2">
          <p className="text-xs text-destructive font-medium">
            Type <code className="font-mono bg-destructive/10 px-1 py-0.5 rounded">{shop.name}</code> to confirm:
          </p>
          <input
            type="text"
            value={deleteTyped}
            onChange={(e) => setDeleteTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleDelete(); if (e.key === 'Escape') { setShowDeleteConfirm(false); setDeleteTyped(''); } }}
            placeholder={shop.name}
            className="w-full rounded-md border border-destructive/40 bg-input px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-destructive/60 transition-all"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleDelete}
              disabled={busy || deleteTyped !== shop.name}
              className="inline-flex items-center gap-1 rounded-md bg-destructive text-destructive-foreground px-2 py-1 text-xs font-medium hover:bg-destructive/90 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
            <button
              onClick={() => { setShowDeleteConfirm(false); setDeleteTyped(''); }}
              className="rounded-md px-2 py-1 text-xs bg-secondary hover:bg-accent border border-border/60 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {shop.status !== 'running' && (
          <PermButton
            allowed={perms.can_edit_ui}
            disabled={busy}
            onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'start' })}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
          >
            <Play className="h-3 w-3" /> Start
          </PermButton>
        )}



        <div className="flex-1" />

        <PermLink
          allowed={perms.can_view_orders}
          to={`/shops/${shop.slug}/orders`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
        >
          <ShoppingCart className="h-3 w-3" /> Orders
        </PermLink>
        <Link
          to={`/shops/${shop.slug}/catalog`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
        >
          <Package className="h-3 w-3" /> Catalog
        </Link>
        <Link
          to={`/shops/${shop.slug}/analytics`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
        >
          <BarChart3 className="h-3 w-3" /> Analytics
        </Link>
        <PermLink
          allowed={perms.can_edit_ui}
          to={`/shops/${shop.slug}/settings`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
        >
          <Settings className="h-3 w-3" /> Settings
        </PermLink>

      </div>
    </div>
  );
}
