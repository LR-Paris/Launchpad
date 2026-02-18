import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getShops } from '../lib/api';
import ShopCard from '../components/ShopCard';
import { Plus } from 'lucide-react';

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
    refetchInterval: 10000,
  });

  const shops = data?.shops || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Shops</h1>
        <Link
          to="/shops/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Shop
        </Link>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading shops...</p>}
      {error && <p className="text-destructive">Failed to load shops.</p>}

      {!isLoading && shops.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-muted-foreground mb-3">No shops deployed yet.</p>
          <Link
            to="/shops/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Deploy your first shop
          </Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {shops.map((shop) => (
          <ShopCard key={shop.id} shop={shop} />
        ))}
      </div>
    </div>
  );
}
