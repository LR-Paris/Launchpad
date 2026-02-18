import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { shopAction, deleteShop } from '../lib/api';
import StatusBadge from './StatusBadge';
import { Play, Square, RotateCcw, Trash2, ShoppingCart, Settings } from 'lucide-react';

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

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-base">{shop.name}</h3>
          <p className="text-sm text-muted-foreground">{shop.slug}.localhost:{shop.port}</p>
        </div>
        <StatusBadge status={shop.status} />
      </div>

      <div className="flex items-center gap-1 mt-4">
        {shop.status !== 'running' && (
          <button
            disabled={busy}
            onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'start' })}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent transition-colors disabled:opacity-50"
          >
            <Play className="h-3 w-3" /> Start
          </button>
        )}
        {shop.status === 'running' && (
          <button
            disabled={busy}
            onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'stop' })}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent transition-colors disabled:opacity-50"
          >
            <Square className="h-3 w-3" /> Stop
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => actionMutation.mutate({ slug: shop.slug, action: 'restart' })}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent transition-colors disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" /> Restart
        </button>

        <div className="flex-1" />

        <Link
          to={`/shops/${shop.slug}/orders`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent transition-colors"
        >
          <ShoppingCart className="h-3 w-3" /> Orders
        </Link>
        <Link
          to={`/shops/${shop.slug}/settings`}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-accent transition-colors"
        >
          <Settings className="h-3 w-3" /> Settings
        </Link>
        <button
          disabled={busy}
          onClick={handleDelete}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-destructive bg-secondary hover:bg-red-100 transition-colors disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
