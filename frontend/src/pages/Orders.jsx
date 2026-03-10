import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getOrders, getOrdersDownloadUrl } from '../lib/api';
import OrderTable from '../components/OrderTable';
import OrderCards from '../components/OrderCards';
import { ArrowLeft, Download, ShoppingBag, RefreshCw, LayoutGrid, Table, BarChart3 } from 'lucide-react';

export default function Orders() {
  const { slug } = useParams();
  const [view, setView] = useState('cards');
  const [statusFilter, setStatusFilter] = useState('all');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['orders', slug],
    queryFn: () => getOrders(slug),
    refetchInterval: 15000,
  });

  const orders = data?.orders || [];

  const filteredOrders = useMemo(() => {
    if (statusFilter === 'all') return orders;
    return orders.filter(o => {
      const status = (o['Status'] || 'Pending').toLowerCase();
      if (statusFilter === 'cancelled') return status.includes('cancel');
      if (statusFilter === 'pending') return status === 'pending' || status === '';
      return status === statusFilter;
    });
  }, [orders, statusFilter]);

  const pendingCount = useMemo(() => orders.filter(o => {
    const s = (o['Status'] || 'Pending').toLowerCase();
    return s === 'pending' || s === '';
  }).length, [orders]);
  const shippedCount = useMemo(() => orders.filter(o => (o['Status'] || '').toLowerCase() === 'shipped').length, [orders]);
  const cancelledCount = useMemo(() => orders.filter(o => (o['Status'] || '').toLowerCase().includes('cancel')).length, [orders]);

  return (
    <div className="max-w-6xl lp-fadein">
      <div className="flex items-center gap-3 mb-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
        <div>
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Orders</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>{slug}</h1>
        </div>
        <div className="flex-1" />
        <Link
          to={`/shops/${slug}/analytics`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors border border-border/40 rounded-md px-2.5 py-1.5"
        >
          <BarChart3 className="h-3 w-3" /> Analytics
        </Link>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors border border-border/40 rounded-md px-2.5 py-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
        {orders.length > 0 && (
          <div className="flex items-center rounded-lg border border-border/40 overflow-hidden">
            {[
              ['all', 'All', orders.length],
              ['pending', 'Pending', pendingCount],
              ['shipped', 'Shipped', shippedCount],
              ...(cancelledCount > 0 ? [['cancelled', 'Cancelled', cancelledCount]] : []),
            ].map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                className={`px-2.5 py-1.5 text-xs font-medium transition-all ${
                  statusFilter === value
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                } ${value !== 'all' ? 'border-l border-border/40' : ''}`}
              >
                {label}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}
        <a
          href={getOrdersDownloadUrl(slug)}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            orders.length > 0
              ? 'btn-launch'
              : 'bg-secondary/50 text-muted-foreground cursor-not-allowed pointer-events-none border border-border/40'
          }`}
          aria-disabled={orders.length === 0}
        >
          <Download className="h-3.5 w-3.5" />
          Download CSV
        </a>
      </div>

      {isLoading && (
        <div className="lp-card rounded-xl p-8 text-center">
          <p className="text-muted-foreground text-sm font-mono">Loading orders<span className="term-cursor" /></p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          Failed to load orders. The CSV file may not exist yet.
        </div>
      )}

      {!isLoading && !error && orders.length === 0 && (
        <div className="lp-card rounded-xl p-12 text-center">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4"
               style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
            <ShoppingBag className="h-6 w-6 lp-glow" />
          </div>
          <p className="text-sm font-semibold mb-1" style={{ fontFamily: 'Syne, sans-serif' }}>No orders yet</p>
          <p className="text-xs text-muted-foreground font-mono">
            Orders will appear here from <code>DATABASE/Orders/orders.csv</code>
          </p>
        </div>
      )}

      {!isLoading && orders.length > 0 && (
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <ShoppingBag className="h-4 w-4 text-primary/70" />
            <span className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
              {filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''}
              {statusFilter !== 'all' && <span className="text-muted-foreground font-normal ml-1">({statusFilter})</span>}
            </span>
            <div className="flex-1" />
            <div className="flex items-center rounded-lg border border-border/40 overflow-hidden">
              <button
                onClick={() => setView('cards')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all ${
                  view === 'cards'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                }`}
              >
                <LayoutGrid className="h-3 w-3" />
                Orders
              </button>
              <button
                onClick={() => setView('table')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all border-l border-border/40 ${
                  view === 'table'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                }`}
              >
                <Table className="h-3 w-3" />
                Spreadsheet
              </button>
            </div>
          </div>
          {view === 'cards' ? (
            <OrderCards orders={filteredOrders} slug={slug} />
          ) : (
            <OrderTable orders={filteredOrders} slug={slug} />
          )}
        </div>
      )}
    </div>
  );
}
