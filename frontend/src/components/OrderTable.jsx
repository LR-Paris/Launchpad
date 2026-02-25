import { useState, useMemo } from 'react';
import { ArrowUpDown, FileDown, FileSpreadsheet } from 'lucide-react';
import { getPoFileUrl } from '../lib/api';

export default function OrderTable({ orders, slug }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const columns = useMemo(() => {
    if (!orders.length) return [];
    return Object.keys(orders[0]);
  }, [orders]);

  // Check if any order has a PO File value
  const hasPo = useMemo(() => {
    return orders.some(row => row['PO File'] && row['PO File'].trim());
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
    // Render PO File column as the filename text (the button is in the dedicated column)
    if (col === 'PO File' && value && slug) {
      return (
        <span className="text-xs font-mono text-muted-foreground">{value}</span>
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
            {hasPo && (
              <th className="px-4 py-3 text-left font-medium text-muted-foreground select-none" title="Supports PDF, HTML, Excel, and image files">
                <span className="inline-flex items-center gap-1">
                  <FileSpreadsheet className="h-3 w-3" />
                  Open PO
                </span>
              </th>
            )}
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
              {hasPo && (
                <td className="px-4 py-2.5">
                  {row['PO File'] && row['PO File'].trim() ? (
                    <a
                      href={getPoFileUrl(slug, row['PO File'])}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 border border-primary/20 hover:border-primary/40 transition-all"
                    >
                      <FileDown className="h-3.5 w-3.5" />
                      Open PO
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground/50">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
