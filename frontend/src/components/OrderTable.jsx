import { useState, useMemo } from 'react';
import { ArrowUpDown, EyeOff, Eye, FileText, X, Download, ExternalLink, Package } from 'lucide-react';
import { getPoFileUrl, getProductImageUrl } from '../lib/api';

// Try to parse a JSON string; returns null on failure
function tryParseJson(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// Renders a single parsed item row with an optional product photo
function ItemRow({ item, slug }) {
  const [imgError, setImgError] = useState(false);
  const imgSrc = slug && item.productId ? getProductImageUrl(slug, item.productId) : null;

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      {imgSrc && !imgError ? (
        <img
          src={imgSrc}
          alt={item.productName || item.name || ''}
          onError={() => setImgError(true)}
          className="w-8 h-8 rounded object-cover border border-border/40 flex-shrink-0"
        />
      ) : (
        <div className="w-8 h-8 rounded bg-muted/50 flex items-center justify-center flex-shrink-0 border border-border/30">
          <Package className="h-3.5 w-3.5 text-muted-foreground/50" />
        </div>
      )}
      <div className="min-w-0">
        <span className="text-xs font-medium block truncate">
          {item.productName || item.name || item.productId || 'Item'}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono block">
          {item.quantity && `${item.quantity}× `}
          {item.boxCost != null && `$${Number(item.boxCost).toFixed(2)}/box`}
          {item.sku && ` · ${item.sku}`}
        </span>
      </div>
    </div>
  );
}

// Renders the parsed items list for an order
function ItemsList({ items, slug }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {items.map((item, i) => (
        <ItemRow key={item.productId || i} item={item} slug={slug} />
      ))}
    </div>
  );
}

export default function OrderTable({ orders, slug }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [poModal, setPoModal] = useState(null);

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
    if (!poFile || !slug) return;
    const ext = poFile.split('.').pop()?.toLowerCase();
    const viewable = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'html', 'htm'].includes(ext);
    if (viewable) {
      setPoModal(poFile);
    } else {
      window.open(getPoFileUrl(slug, poFile), '_blank', 'noopener,noreferrer');
    }
  };

  const isItemsCol = (col) => col === 'Items';

  const renderCell = (col, value) => {
    // Items column: parse JSON and render rich item cards with photos
    if (isItemsCol(col)) {
      const parsed = tryParseJson(value);
      if (parsed) {
        return <ItemsList items={Array.isArray(parsed) ? parsed : [parsed]} slug={slug} />;
      }
      // Fallback: show raw value truncated
      return (
        <span className="text-xs text-muted-foreground font-mono break-all line-clamp-2">
          {value}
        </span>
      );
    }

    // Status column: render as colored badge
    if (/^(status|order[\s_-]?status)$/i.test(col)) {
      const isShipped = value?.trim().toLowerCase() === 'shipped';
      return (
        <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full ${
          isShipped
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-amber-500/15 text-amber-400'
        }`}>
          {value || 'Pending'}
        </span>
      );
    }

    // PO File column: render as a link
    if (col === 'PO File' && value?.trim() && slug) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-mono text-primary">
          <FileText className="h-3 w-3" />
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
                  className={`px-4 py-3 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground ${
                    isItemsCol(col) ? 'min-w-[240px]' : ''
                  }`}
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
                    <td key={col} className={`px-4 ${isItemsCol(col) ? 'py-1.5' : 'py-2.5'}`}>
                      {renderCell(col, row[col])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* PO File inline viewer modal */}
      {poModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setPoModal(null)}
        >
          <div
            className="bg-card border border-border/60 rounded-xl shadow-2xl w-[90vw] max-w-4xl h-[80vh] flex flex-col overflow-hidden lp-fadein"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 bg-muted/30">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold font-mono">{poModal}</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={getPoFileUrl(slug, poModal)}
                  download
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-1 rounded-md hover:bg-primary/10"
                >
                  <Download className="h-3 w-3" />
                  Download
                </a>
                <a
                  href={getPoFileUrl(slug, poModal)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-1 rounded-md hover:bg-primary/10"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open
                </a>
                <button
                  onClick={() => setPoModal(null)}
                  className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {/\.(png|jpe?g|gif|webp)$/i.test(poModal) ? (
                <div className="w-full h-full flex items-center justify-center p-4 overflow-auto bg-muted/20">
                  <img
                    src={getPoFileUrl(slug, poModal)}
                    alt={poModal}
                    className="max-w-full max-h-full object-contain rounded-md"
                  />
                </div>
              ) : (
                <iframe
                  src={getPoFileUrl(slug, poModal)}
                  title={poModal}
                  className="w-full h-full border-0"
                  sandbox="allow-same-origin"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
