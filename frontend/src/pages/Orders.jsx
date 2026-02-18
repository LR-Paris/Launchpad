import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getOrders, getOrdersDownloadUrl } from '../lib/api';
import OrderTable from '../components/OrderTable';
import { ArrowLeft, Download } from 'lucide-react';

export default function Orders() {
  const { slug } = useParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', slug],
    queryFn: () => getOrders(slug),
  });

  const orders = data?.orders || [];

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-xl font-semibold">Orders — {slug}</h1>
        <div className="flex-1" />
        {orders.length > 0 && (
          <a
            href={getOrdersDownloadUrl(slug)}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary text-secondary-foreground px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            <Download className="h-4 w-4" />
            Download CSV
          </a>
        )}
      </div>

      {isLoading && <p className="text-muted-foreground">Loading orders...</p>}
      {error && <p className="text-destructive">Failed to load orders.</p>}
      {!isLoading && <OrderTable orders={orders} />}
    </div>
  );
}
