import { useState, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Package, User, Hash, ChevronDown, ChevronUp, X, Download, ExternalLink, Truck, Send, Ban } from 'lucide-react';
import { getCatalogPhotos, getShopImageUrl, getPoFileUrl, getProductImageUrl, shipOrder, cancelOrder } from '../lib/api';

// Try to parse a JSON string; returns null on failure
function tryParseJson(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// Column classification helpers
const ITEM_COLS = /^(items?|products?|item[\s_-]?name|product[\s_-]?name)$/i;
const QTY_COLS = /^(qty|quantity|amount|count|units|#)$/i;
const SIZE_COLS = /^(size|dimensions?)$/i;
const COLOR_COLS = /^(colou?r|shade)$/i;
const PRICE_COLS = /^(price|cost|total|subtotal|amount[\s_-]?due|unit[\s_-]?price)$/i;
const NAME_COLS = /^(name|full[\s_-]?name|customer[\s_-]?name|first[\s_-]?name|buyer)$/i;
const EMAIL_COLS = /^(email|e[\s_-]?mail)$/i;
const PHONE_COLS = /^(phone|tel|telephone|mobile|cell)$/i;
const ADDRESS_COLS = /^(address|street|city|state|zip|postal|country|shipping[\s_-]?address)/i;
const PO_COL = /^(po[\s_-]?file|purchase[\s_-]?order|po)$/i;
const DATE_COLS = /^(date|order[\s_-]?date|created|timestamp|time)$/i;
const NOTE_COLS = /^(note|notes|comment|comments|extra[\s_-]?notes|message|special[\s_-]?instructions)$/i;
const HOTEL_COLS = /^(hotel|hotel[\s_-]?name|hotel[\s_-]?selection|accommodation)$/i;
const ID_COLS = /^(order[\s_-]?id|id|order[\s_-]?#|order[\s_-]?number|confirmation|ref)$/i;
const STATUS_COLS = /^(status|order[\s_-]?status)$/i;
const TRACKING_COLS = /^(tracking|tracking[\s_-]?number|tracking[\s_-]?#|shipment)$/i;

function classifyColumn(col) {
  if (ITEM_COLS.test(col)) return 'item';
  if (QTY_COLS.test(col)) return 'qty';
  if (SIZE_COLS.test(col)) return 'size';
  if (COLOR_COLS.test(col)) return 'color';
  if (PRICE_COLS.test(col)) return 'price';
  if (NAME_COLS.test(col)) return 'name';
  if (EMAIL_COLS.test(col)) return 'email';
  if (PHONE_COLS.test(col)) return 'phone';
  if (ADDRESS_COLS.test(col)) return 'address';
  if (PO_COL.test(col)) return 'po';
  if (DATE_COLS.test(col)) return 'date';
  if (NOTE_COLS.test(col)) return 'note';
  if (HOTEL_COLS.test(col)) return 'hotel';
  if (ID_COLS.test(col)) return 'id';
  if (STATUS_COLS.test(col)) return 'status';
  if (TRACKING_COLS.test(col)) return 'tracking';
  return 'other';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Renders a product image for an item with productId, falling back to catalog lookup
function ProductImage({ item, slug, catalog, className = 'w-10 h-10' }) {
  const [imgError, setImgError] = useState(false);

  // Prefer productId-based image (direct from ShopCollections)
  const productIdSrc = slug && item.productId ? getProductImageUrl(slug, item.productId) : null;

  // Fallback: catalog lookup by name/sku
  const catalogMatch = catalog[item.productName?.toLowerCase()] || catalog[item.name?.toLowerCase()] || catalog[item.sku?.toLowerCase()];
  const catalogSrc = catalogMatch?.photoPath ? getShopImageUrl(slug, catalogMatch.photoPath) : null;

  const src = (!imgError && productIdSrc) || catalogSrc;

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={item.productName || item.name || ''}
        onError={() => setImgError(true)}
        className={`${className} rounded-md object-cover border border-border/40`}
      />
    );
  }

  return (
    <div className={`${className} rounded-md bg-muted/40 flex items-center justify-center border border-border/30`}>
      <Package className="h-4 w-4 text-muted-foreground/40" />
    </div>
  );
}

// Parse the Items column from a row — returns array of item objects or null
function parseOrderItems(row, itemCols) {
  for (const col of itemCols) {
    const val = row[col];
    const parsed = tryParseJson(val);
    if (parsed) {
      return Array.isArray(parsed) ? parsed : [parsed];
    }
  }
  return null;
}

export default function OrderCards({ orders, slug }) {
  const queryClient = useQueryClient();
  const [catalog, setCatalog] = useState({});
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [poModal, setPoModal] = useState(null);
  const [shippingOrder, setShippingOrder] = useState(null);
  const [trackingInput, setTrackingInput] = useState('');
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState('');
  const [cancelLoading, setCancelLoading] = useState(null);
  const [cancelError, setCancelError] = useState('');

  useEffect(() => {
    if (slug) {
      getCatalogPhotos(slug)
        .then(data => setCatalog(data.products || {}))
        .catch(() => {});
    }
  }, [slug]);

  const columns = useMemo(() => {
    if (!orders.length) return [];
    return Object.keys(orders[0]);
  }, [orders]);

  const classified = useMemo(() => {
    const map = {};
    for (const col of columns) {
      map[col] = classifyColumn(col);
    }
    return map;
  }, [columns]);

  // Group columns by classification
  const colGroups = useMemo(() => {
    const groups = {};
    for (const col of columns) {
      const cls = classified[col];
      if (!groups[cls]) groups[cls] = [];
      groups[cls].push(col);
    }
    return groups;
  }, [columns, classified]);

  const findPhoto = (row) => {
    const itemCols = colGroups.item || [];
    for (const col of itemCols) {
      const val = row[col]?.trim().toLowerCase();
      if (val && catalog[val]) return catalog[val];
    }
    for (const col of columns) {
      const val = row[col]?.trim().toLowerCase();
      if (val && catalog[val]) return catalog[val];
    }
    return null;
  };

  const getItemName = (row) => {
    const itemCols = colGroups.item || [];
    for (const col of itemCols) {
      const val = row[col]?.trim();
      // Don't return raw JSON as a name
      if (val && !val.startsWith('[') && !val.startsWith('{')) return val;
    }
    return null;
  };

  const getQty = (row) => {
    const qtyCols = colGroups.qty || [];
    for (const col of qtyCols) {
      if (row[col]?.trim()) return row[col].trim();
    }
    return null;
  };

  const getCustomerName = (row) => {
    const nameCols = colGroups.name || [];
    for (const col of nameCols) {
      if (row[col]?.trim()) return row[col].trim();
    }
    return null;
  };

  const getOrderId = (row) => {
    const idCols = colGroups.id || [];
    for (const col of idCols) {
      if (row[col]?.trim()) return row[col].trim();
    }
    return null;
  };

  const getPoFile = (row) => {
    const poCols = colGroups.po || [];
    for (const col of poCols) {
      if (row[col]?.trim()) return row[col].trim();
    }
    return null;
  };

  const getStatus = (row) => {
    const statusCols = colGroups.status || [];
    for (const c of statusCols) {
      if (row[c]?.trim()) return row[c].trim();
    }
    return 'Pending';
  };

  const getTracking = (row) => {
    const trackingCols = colGroups.tracking || [];
    for (const c of trackingCols) {
      if (row[c]?.trim()) return row[c].trim();
    }
    return '';
  };

  const getDetailFields = (row) => {
    const skipTypes = new Set(['item', 'po', 'status', 'tracking']);
    const details = [];
    for (const col of columns) {
      if (skipTypes.has(classified[col])) continue;
      const val = row[col]?.trim();
      if (val) details.push({ label: col, value: val, type: classified[col] });
    }
    return details;
  };

  if (!orders.length) {
    return <p className="text-muted-foreground text-sm">No orders found.</p>;
  }

  const handlePoClick = (e, poFile) => {
    e.stopPropagation();
    const ext = poFile.split('.').pop()?.toLowerCase();
    const viewable = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'html', 'htm'].includes(ext);
    if (viewable) {
      setPoModal(poFile);
    } else {
      window.open(getPoFileUrl(slug, poFile), '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div>
      <div className="grid gap-3 p-4">
        {orders.map((row, i) => {
          const parsedItems = parseOrderItems(row, colGroups.item || []);
          const product = findPhoto(row);
          const itemName = getItemName(row);
          const qty = getQty(row);
          const customerName = getCustomerName(row);
          const orderId = getOrderId(row);
          const poFile = getPoFile(row);
          const details = getDetailFields(row);
          const isExpanded = expandedOrder === i;

          // Separate primary details from secondary
          const primaryTypes = new Set(['qty', 'size', 'color', 'price', 'date', 'id', 'name']);
          const primaryDetails = details.filter(d => primaryTypes.has(d.type));

          // Summary text for JSON items
          const itemsSummary = parsedItems
            ? parsedItems.length === 1
              ? parsedItems[0].productName || parsedItems[0].name || 'Item'
              : `${parsedItems.length} items`
            : itemName;

          // Total quantity from parsed items
          const totalQty = parsedItems
            ? parsedItems.reduce((sum, it) => sum + (it.quantity || 0), 0)
            : null;

          return (
            <div
              key={i}
              className="lp-card rounded-xl border border-border/40 overflow-hidden transition-all hover:border-primary/20"
            >
              <div
                className="flex items-start gap-4 p-4 cursor-pointer"
                onClick={() => setExpandedOrder(isExpanded ? null : i)}
              >
                {/* Product photo — show first parsed item or catalog match */}
                {parsedItems && parsedItems.length > 0 ? (
                  <div className="flex-shrink-0">
                    {parsedItems.length === 1 ? (
                      <ProductImage item={parsedItems[0]} slug={slug} catalog={catalog} className="w-16 h-16" />
                    ) : (
                      <div className="grid grid-cols-2 gap-0.5 w-16 h-16">
                        {parsedItems.slice(0, 4).map((item, j) => (
                          <ProductImage
                            key={item.productId || j}
                            item={item}
                            slug={slug}
                            catalog={catalog}
                            className="w-full h-full"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-16 h-16 rounded-lg border border-border/30 bg-muted/30 flex-shrink-0 overflow-hidden flex items-center justify-center">
                    {product?.photoPath ? (
                      <img
                        src={getShopImageUrl(slug, product.photoPath)}
                        alt={itemName || ''}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Package className="h-6 w-6 text-muted-foreground/40" />
                    )}
                  </div>
                )}

                {/* Order summary */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {itemsSummary && (
                      <span className="text-sm font-semibold truncate" style={{ fontFamily: 'Syne, sans-serif' }}>
                        {itemsSummary}
                      </span>
                    )}
                    {(totalQty || qty) && (
                      <span className="text-xs font-mono font-bold bg-primary/15 text-primary px-2 py-0.5 rounded-full flex-shrink-0">
                        {totalQty ? `${totalQty} units` : `x${qty}`}
                      </span>
                    )}
                  </div>

                  {/* Inline item names for multi-item orders */}
                  {parsedItems && parsedItems.length > 1 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {parsedItems.slice(0, 3).map((item, j) => (
                        <span key={item.productId || j} className="text-[10px] font-mono bg-muted/60 text-muted-foreground px-1.5 py-0.5 rounded">
                          {item.productName || item.name || 'Item'}{item.quantity ? ` ×${item.quantity}` : ''}
                        </span>
                      ))}
                      {parsedItems.length > 3 && (
                        <span className="text-[10px] font-mono text-muted-foreground/60 px-1.5 py-0.5">
                          +{parsedItems.length - 3} more
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                    {customerName && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {customerName}
                      </span>
                    )}
                    {orderId && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                        <Hash className="h-3 w-3" />
                        {orderId}
                      </span>
                    )}
                    {(() => {
                      const status = getStatus(row);
                      const sl = status.toLowerCase();
                      const isShipped = sl === 'shipped';
                      const isCancelled = sl === 'cancelled' || sl === 'canceled';
                      return (
                        <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full flex-shrink-0 inline-flex items-center gap-0.5 ${
                          isCancelled
                            ? 'bg-red-500/15 text-red-400'
                            : isShipped
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'bg-amber-500/15 text-amber-400'
                        }`}>
                          {isShipped && <Truck className="h-2.5 w-2.5" />}
                          {isCancelled && <Ban className="h-2.5 w-2.5" />}
                          {status}
                        </span>
                      );
                    })()}
                    {primaryDetails.filter(d => d.type !== 'qty' && d.type !== 'name' && d.type !== 'id').slice(0, 4).map(d => (
                      <span key={d.label} className="text-xs text-muted-foreground">
                        <span className="opacity-60">{d.label}:</span> {d.value}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Right side actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {poFile && (
                    <button
                      onClick={(e) => handlePoClick(e, poFile)}
                      className="inline-flex items-center gap-1 text-xs font-mono text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/20 px-2 py-1 rounded-md transition-all"
                      title="View Purchase Order"
                    >
                      <FileText className="h-3 w-3" />
                      PO
                    </button>
                  )}
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="border-t border-border/30 bg-muted/10 px-4 py-3 lp-fadein">
                  {/* Parsed items grid */}
                  {parsedItems && parsedItems.length > 0 && (
                    <div className="mb-3">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">
                        Items
                      </span>
                      <div className="mt-1.5 space-y-1.5">
                        {parsedItems.map((item, j) => (
                          <div key={item.productId || j} className="flex items-center gap-3 bg-background/50 rounded-lg p-2 border border-border/20">
                            <ProductImage item={item} slug={slug} catalog={catalog} className="w-10 h-10" />
                            <div className="flex-1 min-w-0">
                              <span className="text-xs font-medium block truncate">
                                {item.productName || item.name || item.productId || 'Item'}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {item.sku && `${item.sku} · `}
                                {item.quantity && `${item.quantity} box${item.quantity !== 1 ? 'es' : ''}`}
                                {item.unitsPerBox && ` (${item.quantity * item.unitsPerBox} units)`}
                              </span>
                            </div>
                            {item.boxCost != null && (
                              <span className="text-xs font-mono font-semibold flex-shrink-0">
                                ${(Number(item.boxCost) * (item.quantity || 1)).toFixed(2)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Other detail fields */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
                    {details.map(d => (
                      <div key={d.label}>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">
                          {d.label}
                        </span>
                        <p className="text-xs font-mono mt-0.5 break-words">
                          {d.type === 'po' && slug ? (
                            <button
                              onClick={(e) => handlePoClick(e, d.value)}
                              className="text-primary hover:underline inline-flex items-center gap-1"
                            >
                              <FileText className="h-3 w-3" />
                              {d.value}
                            </button>
                          ) : (
                            escapeHtml(d.value)
                          )}
                        </p>
                      </div>
                    ))}
                  </div>

                  {/* Actions — ship / cancel for pending orders */}
                  {(() => {
                    const sl = getStatus(row).toLowerCase();
                    const isPending = sl !== 'shipped' && sl !== 'cancelled' && sl !== 'canceled';
                    if (!isPending || !orderId) return null;
                    return (
                      <div className="mt-3 pt-3 border-t border-border/20">
                        {shippingOrder === i ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Tracking number (optional)"
                              value={trackingInput}
                              onChange={(e) => setTrackingInput(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-1 text-xs font-mono bg-background border border-border/60 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
                            />
                            <button
                              disabled={shipLoading}
                              onClick={async (e) => {
                                e.stopPropagation();
                                setShipError('');
                                setShipLoading(true);
                                try {
                                  await shipOrder(slug, orderId, trackingInput);
                                  queryClient.invalidateQueries({ queryKey: ['orders', slug] });
                                  setShippingOrder(null);
                                  setTrackingInput('');
                                } catch (err) {
                                  setShipError(err.response?.data?.error || 'Failed to ship');
                                } finally {
                                  setShipLoading(false);
                                }
                              }}
                              className="btn-launch text-xs px-3 py-1.5 rounded-md inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <Send className="h-3 w-3" /> Ship
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setShippingOrder(null); setTrackingInput(''); setShipError(''); }}
                              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5"
                            >
                              Back
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); setShippingOrder(i); }}
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/20 px-3 py-1.5 rounded-md transition-all"
                            >
                              <Truck className="h-3 w-3" /> Mark as Shipped
                            </button>
                            <button
                              disabled={cancelLoading === i}
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!window.confirm(`Cancel order ${orderId}? This will remove the order and notify the customer.`)) return;
                                setCancelError('');
                                setCancelLoading(i);
                                try {
                                  await cancelOrder(slug, orderId);
                                  queryClient.invalidateQueries({ queryKey: ['orders', slug] });
                                } catch (err) {
                                  setCancelError(err.response?.data?.error || 'Failed to cancel');
                                } finally {
                                  setCancelLoading(null);
                                }
                              }}
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 rounded-md transition-all disabled:opacity-50"
                            >
                              <Ban className="h-3 w-3" /> {cancelLoading === i ? 'Cancelling...' : 'Cancel Order'}
                            </button>
                          </div>
                        )}
                        {shipError && shippingOrder === i && (
                          <p className="text-xs text-destructive mt-1">{shipError}</p>
                        )}
                        {cancelError && cancelLoading === null && (
                          <p className="text-xs text-destructive mt-1">{cancelError}</p>
                        )}
                      </div>
                    );
                  })()}

                  {/* Show tracking number if shipped */}
                  {getStatus(row).toLowerCase() === 'shipped' && getTracking(row) && (
                    <div className="mt-3 pt-3 border-t border-border/20">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">Tracking Number</span>
                      <p className="text-xs font-mono mt-0.5">{getTracking(row)}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
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
