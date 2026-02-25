import { useState, useMemo } from 'react';
import { ArrowUpDown, EyeOff, Eye, ExternalLink } from 'lucide-react';
import { getPoFileUrl } from '../lib/api';

export default function OrderTable({ orders, slug }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [hideEmpty, setHideEmpty] = useState(true);

  const columns = useMemo(() => {
    if (!orders.length) return [];
    return Object.keys(orders[0]);
  }, [orders]);

  // Columns where every row has an empty/blank value
  const emptyColumns = useMemo(() => {
    const empty = new Set();
    for (const col of columns) {
      if (orders.every(row => !row[col]?.toString().trim())) {
        empty.add(col);
      }
    }
    return empty;
  }, [orders, columns]);

  const visibleColumns = useMemo(() => {
    if (!hideEmpty) return columns;
    return columns.filter(col => !emptyColumns.has(col));
  }, [columns, emptyColumns, hideEmpty]);

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

  const handleRowClick = (row) => {
    const poFile = row['PO File']?.trim();
    if (poFile && slug) {
      window.open(getPoFileUrl(slug, poFile), '_blank', 'noopener,noreferrer');
    }
  };

  const renderCell = (col, value) => {
    if (col === 'PO File' && value?.trim() && slug) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-mono text-primary">
          <ExternalLink className="h-3 w-3" />
          {value}
        </span>
      );
    }
    return value;
  };

  return (
    <div>
      {emptyColumns.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/40 bg-muted/30">
          <button
            onClick={() => setHideEmpty(h => !h)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all border ${
              hideEmpty
                ? 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/20'
                : 'bg-secondary text-muted-foreground border-border/40 hover:bg-accent'
            }`}
          >
            {hideEmpty ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {hideEmpty
              ? `Hiding ${emptyColumns.size} empty column${emptyColumns.size !== 1 ? 's' : ''}`
              : 'Show all columns'}
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {visibleColumns.map((col) => (
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
              const hasPo = !!row['PO File']?.trim();
              return (
                <tr
                  key={i}
                  onClick={() => handleRowClick(row)}
                  className={`border-b last:border-0 transition-colors ${
                    hasPo
                      ? 'cursor-pointer hover:bg-primary/5'
                      : 'hover:bg-muted/30'
                  }`}
                  title={hasPo ? 'Click to open PO' : undefined}
                >
                  {visibleColumns.map((col) => (
                    <td key={col} className="px-4 py-2.5">
                      {renderCell(col, row[col])}
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
