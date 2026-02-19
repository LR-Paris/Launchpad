import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { shopAction, deleteShop } from '../lib/api';
import { Play, Square, RotateCcw, Trash2, ShoppingCart, Settings, ExternalLink } from 'lucide-react';

const STATUS_COLORS = {
  running: 'text-[hsl(142,70%,50%)]',
  error:   'text-destructive',
  stopped: 'text-muted-foreground',
};

export default function ShopCard({ shop }) {
  const queryClient = useQueryClient();

  const actionMutation = useMutation({
    mutationFn: ({ slug, action }) => shopAction(slug, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shops'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (slug) => deleteShop(slug, true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shops'] }),
  });

  const handleDelete = () => {
    if (window.confirm(`Delete shop "${shop.name}"? This will remove all files.`)) {
      deleteMutation.mutate(shop.slug);
    }
  };

  const busy = actionMutation.isPending || deleteMutation.isPending;
  const statusColor = STATUS_COLORS[shop.status] || STATUS_COLORS.stopped;

  return (
    <div className="rounded-xl p-5 flex flex-col gap-4 border border-border/60 hover:border-primary/25 transition-all duration-300"
         style={{
           background: 'hsl(var(--card) / 0.65)',
           backdropFilter: 'blur(12px)',
           WebkitBackdropFilter: 'blur(12px)',
           boxShadow: '0 4px 24px hsl(0 0% 0% / 0.08), inset 0 1px 0 hsl(var(--card) / 0.3)',
         }}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
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
        </div>
        {/* Status */}
        <div className="flex items-center gap-1.5 shrink-0">
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

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {shop.status !== 'running' && (
          <button
            disabled={busy}
            onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'start' })}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
          >
            <Play className="h-3 w-3" /> Start
          </button>
        )}
        {shop.status === 'running' && (
          <button
            disabled={busy}
            onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'stop' })}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
          >
            <Square className="h-3 w-3" /> Stop
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'restart' })}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 transition-all disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" /> Restart
        </button>

        <div className="flex-1" />

        <Link
          to={`/shops/${shop.slug}/orders`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
        >
          <ShoppingCart className="h-3 w-3" /> Orders
        </Link>
        <Link
          to={`/shops/${shop.slug}/settings`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
        >
          <Settings className="h-3 w-3" /> Settings
        </Link>
        <button
          disabled={busy}
          onClick={handleDelete}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-destructive bg-secondary hover:bg-destructive/10 border border-border/60 hover:border-destructive/40 transition-all disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
