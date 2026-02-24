import { useState, useMemo } from 'react';
import { ArrowUpDown, FileDown } from 'lucide-react';
import { getPoFileUrl } from '../lib/api';

export default function OrderTable({ orders, slug }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const columns = useMemo(() => {
    if (!orders.length) return [];
    return Object.keys(orders[0]);
  }, [orders]);

  const sorted = useMemo(() => {
    if (!sortKey) return orders;
    return [...orders].sort((a, b) => {
      const aVal = a[sortKey] || '';
      const bVal = b[sortKey] || '';
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [orders, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  if (!orders.length) {
    return <p className="text-muted-foreground text-sm">No orders found.</p>;
  }

  const renderCell = (col, value) => {
    // Render PO File column as a download link
    if (col === 'PO File' && value && slug) {
      return (
        <a
          href={getPoFileUrl(slug, value)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <FileDown className="h-3 w-3" />
          {value}
        </a>
      );
    }
    return value;
  };

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {columns.map((col) => (
              <th
                key={col}
                onClick={() => toggleSort(col)}
                className="px-4 py-3 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground"
              >
                <span className="inline-flex items-center gap-1">
                  {col}
                  <ArrowUpDown className="h-3 w-3" />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
              {columns.map((col) => (
                <td key={col} className="px-4 py-2.5">
                  {renderCell(col, row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
