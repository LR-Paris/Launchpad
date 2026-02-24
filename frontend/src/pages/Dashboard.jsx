import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getShops } from '../lib/api';
import ShopCard from '../components/ShopCard';
import { Plus, Rocket, Activity, RefreshCw } from 'lucide-react';

export default function Dashboard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
    refetchInterval: 10000,
  });

  const shops = data?.shops || [];
  const running = shops.filter(s => s.status === 'running').length;

  return (
    <div className="lp-fadein">
      {/* Page header */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <p className="text-xs font-mono text-muted-foreground mb-1 tracking-widest uppercase">
            Mission Control
          </p>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
            Launched Shops
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {shops.length > 0 && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <Activity className="h-3.5 w-3.5 text-[hsl(142,70%,50%)]" />
              <span className="text-muted-foreground">
                <span className="text-[hsl(142,70%,50%)] font-semibold">{running}</span>
                {' / '}{shops.length} running
              </span>
            </div>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh shops"
            className="flex items-center justify-center w-8 h-8 text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/40 rounded-md transition-all disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
          <Link
            to="/shops/new"
            className="btn-launch inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm disabled:opacity-50"
          >
            <Rocket className="h-4 w-4" />
            Launch Shop
          </Link>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <span className="term-cursor" />
          Loading shops...
        </div>
      )}
      {error && (
        <p className="text-destructive text-sm py-8 text-center">Failed to load shops.</p>
      )}

      {!isLoading && shops.length === 0 && (
        <div className="lp-card rounded-xl p-12 text-center">
          <div className="w-14 h-14 rounded-xl mx-auto mb-4 flex items-center justify-center"
               style={{ background: 'linear-gradient(135deg, hsl(188 100% 38% / 0.15), hsl(210 100% 52% / 0.1))' }}>
            <Rocket className="h-7 w-7 lp-glow" />
          </div>
          <h2 className="font-bold text-lg mb-2" style={{ fontFamily: 'Syne, sans-serif' }}>
            No shops launched yet
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            Launch your first shop to get started.
          </p>
          <Link
            to="/shops/new"
            className="btn-launch inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-sm"
          >
            <Rocket className="h-4 w-4" />
            Launch your first shop
          </Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
        {shops.map((shop, i) => (
          <div key={shop.id} style={{ animationDelay: `${i * 60}ms` }} className="lp-fadein">
            <ShopCard shop={shop} />
          </div>
        ))}
      </div>
    </div>
  );
}
