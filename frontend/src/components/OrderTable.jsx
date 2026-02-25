import { useState, useMemo } from 'react';
import { ArrowUpDown, EyeOff, Eye } from 'lucide-react';
import { getPoFileUrl } from '../lib/api';

export default function OrderTable({ orders, slug }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [hideEmpty, setHideEmpty] = useState(true);

  const allColumns = useMemo(() => {
    if (!orders.length) return [];
    return Object.keys(orders[0]);
  }, [orders]);

  // Determine which columns have at least one non-empty value
  const nonEmptyColumns = useMemo(() => {
    return allColumns.filter(col =>
      orders.some(row => row[col] != null && String(row[col]).trim() !== '')
    );
  }, [allColumns, orders]);

  const columns = hideEmpty ? nonEmptyColumns : allColumns;

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

  const handleRowClick = (row) => {
    const poFile = row['PO File']?.trim();
    if (poFile && slug) {
      window.open(getPoFileUrl(slug, poFile), '_blank');
    }
  };

  if (!orders.length) {
    return <p className="text-muted-foreground text-sm">No orders found.</p>;
  }

  const hiddenCount = allColumns.length - nonEmptyColumns.length;

  return (
    <div>
      {hiddenCount > 0 && (
        <div className="flex items-center justify-end px-4 py-2 border-b border-border/40">
          <button
            onClick={() => setHideEmpty(h => !h)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {hideEmpty ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {hideEmpty ? `Show ${hiddenCount} empty column${hiddenCount !== 1 ? 's' : ''}` : 'Hide empty columns'}
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
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
            {sorted.map((row, i) => {
              const hasPo = row['PO File']?.trim();
              return (
                <tr
                  key={i}
                  onClick={() => handleRowClick(row)}
                  className={`border-b last:border-0 hover:bg-muted/30 ${hasPo ? 'cursor-pointer' : ''}`}
                  title={hasPo ? `Open PO: ${row['PO File']}` : undefined}
                >
                  {columns.map((col) => (
                    <td key={col} className="px-4 py-2.5">
                      {col === 'PO File' && row[col]?.trim() ? (
                        <span className="text-xs font-mono text-primary underline">{row[col]}</span>
                      ) : (
                        row[col]
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
