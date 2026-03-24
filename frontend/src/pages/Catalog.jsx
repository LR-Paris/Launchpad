import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getInventory, seedInventory, updateInventoryBulk } from '../lib/api';
import { usePermissions } from '../lib/permissions';
import CollectionsEditor from '../components/CollectionsEditor';
import {
  ArrowLeft, Package, BarChart3, Search, Filter, Save, RefreshCw,
  AlertTriangle, CheckCircle2, XCircle, Rocket, Lock,
} from 'lucide-react';

function stockStatus(stock) {
  const n = parseInt(stock, 10) || 0;
  if (n === 0) return 'depleted';
  if (n <= 5) return 'low-fuel';
  return 'nominal';
}

const STATUS_CONFIG = {
  'nominal':  { label: 'In Stock',  className: 'bg-[hsl(142,70%,50%)] text-white' },
  'low-fuel': { label: 'Low Stock', className: 'bg-amber-500 text-white' },
  'depleted': { label: 'Sold Out',  className: 'bg-red-600 text-white' },
};

export default function Catalog() {
  const { slug } = useParams();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('inventory');
  const { canShop } = usePermissions();
  const canEdit = canShop(slug, 'can_edit_items');

  // No permission = block access entirely
  if (!canEdit) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center lp-fadein">
        <Lock className="h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm font-semibold mb-1">Access Restricted</p>
        <p className="text-xs text-muted-foreground">You need Catalog permission to access this shop's catalog.</p>
      </div>
    );
  }

  // Inventory state
  const [editedRows, setEditedRows] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [collectionFilter, setCollectionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  const { data: inventoryData, isLoading: inventoryLoading, refetch: refetchInventory } = useQuery({
    queryKey: ['inventory', slug],
    queryFn: () => getInventory(slug),
    refetchInterval: 30000,
  });

  const inventory = inventoryData?.inventory || [];

  const seedMutation = useMutation({
    mutationFn: () => seedInventory(slug),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['inventory', slug] });
      setSaveMessage(data.message || 'Inventory seeded from catalog');
      setTimeout(() => setSaveMessage(''), 4000);
    },
    onError: (err) => {
      setSaveError(err.response?.data?.error || 'Failed to seed inventory');
      setTimeout(() => setSaveError(''), 4000);
    },
  });

  const saveMutation = useMutation({
    mutationFn: (updates) => updateInventoryBulk(slug, updates),
    onSuccess: (data) => {
      setEditedRows({});
      queryClient.invalidateQueries({ queryKey: ['inventory', slug] });
      setSaveMessage(data.message || 'Inventory updated successfully');
      setTimeout(() => setSaveMessage(''), 4000);
    },
    onError: (err) => {
      setSaveError(err.response?.data?.error || 'Failed to save changes');
      setTimeout(() => setSaveError(''), 4000);
    },
  });

  // Collections for filter dropdown
  const collections = useMemo(() => {
    const set = new Set(inventory.map(r => r['Collection']).filter(Boolean));
    return [...set].sort();
  }, [inventory]);

  // Filtered inventory
  const filtered = useMemo(() => {
    return inventory.filter(item => {
      if (collectionFilter !== 'all' && item['Collection'] !== collectionFilter) return false;
      if (statusFilter !== 'all') {
        const s = stockStatus(editedRows[item['Product ID']]?.stock ?? item['Stock']);
        if (statusFilter !== s) return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const name = (item['Product Name'] || '').toLowerCase();
        const sku = (item['SKU'] || '').toLowerCase();
        const pid = (item['Product ID'] || '').toLowerCase();
        if (!name.includes(q) && !sku.includes(q) && !pid.includes(q)) return false;
      }
      return true;
    });
  }, [inventory, collectionFilter, statusFilter, searchQuery, editedRows]);

  // Summary stats
  const summary = useMemo(() => {
    let nominal = 0, lowFuel = 0, depleted = 0;
    for (const item of inventory) {
      const s = stockStatus(editedRows[item['Product ID']]?.stock ?? item['Stock']);
      if (s === 'nominal') nominal++;
      else if (s === 'low-fuel') lowFuel++;
      else depleted++;
    }
    return { total: inventory.length, nominal, lowFuel, depleted };
  }, [inventory, editedRows]);

  const dirtyCount = Object.keys(editedRows).length;

  const handleStockChange = (productId, value) => {
    const original = inventory.find(r => r['Product ID'] === productId);
    const currentEdits = editedRows[productId] || {};
    const newStock = value === '' ? '' : value;
    const originalStock = original?.['Stock'] ?? '0';
    const originalNotes = original?.['Notes'] ?? '';

    const updatedEdits = { ...currentEdits, stock: newStock };

    // Remove from edits if back to original
    if (String(newStock) === String(originalStock) && (updatedEdits.notes === undefined || updatedEdits.notes === originalNotes)) {
      const { [productId]: _, ...rest } = editedRows;
      setEditedRows(rest);
    } else {
      setEditedRows(prev => ({ ...prev, [productId]: updatedEdits }));
    }
  };

  const handleNotesChange = (productId, value) => {
    const original = inventory.find(r => r['Product ID'] === productId);
    const currentEdits = editedRows[productId] || {};
    const originalStock = original?.['Stock'] ?? '0';
    const originalNotes = original?.['Notes'] ?? '';

    const updatedEdits = { ...currentEdits, notes: value };

    if ((updatedEdits.stock === undefined || String(updatedEdits.stock) === String(originalStock)) && value === originalNotes) {
      const { [productId]: _, ...rest } = editedRows;
      setEditedRows(rest);
    } else {
      setEditedRows(prev => ({ ...prev, [productId]: updatedEdits }));
    }
  };

  const handleSave = () => {
    const updates = Object.entries(editedRows).map(([productId, edits]) => ({
      productId,
      stock: edits.stock !== undefined ? parseInt(edits.stock, 10) || 0 : undefined,
      notes: edits.notes,
    }));
    saveMutation.mutate(updates);
  };

  return (
    <div className="lp-fadein" style={{ maxWidth: '100%' }}>
      {/* Page header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>
        <div>
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Catalog</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>{slug}</h1>
        </div>
        <div className="flex-1" />
        <Link
          to={`/shops/${slug}/orders`}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          Orders
        </Link>
        <Link
          to={`/shops/${slug}/settings`}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          Settings
        </Link>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 border-b border-border/40 pb-px">
        <button
          onClick={() => setActiveTab('inventory')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-all -mb-px ${
            activeTab === 'inventory'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/60'
          }`}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Inventory
        </button>
        <button
          onClick={() => setActiveTab('catalog')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-all -mb-px ${
            activeTab === 'catalog'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/60'
          }`}
        >
          <Package className="h-3.5 w-3.5" />
          Product Catalog
        </button>
      </div>

      {/* Inventory Tab */}
      {activeTab === 'inventory' && (
        <div className="lp-card rounded-xl overflow-hidden">
          {/* Inventory header */}
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <BarChart3 className="h-4 w-4 text-primary/70" />
            <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Inventory</h2>
            <span className="text-xs text-muted-foreground font-mono ml-1">Track & manage stock levels</span>
            <div className="flex-1" />
            <button
              onClick={() => refetchInventory()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
            <button
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending || !canEdit}
              title={!canEdit ? 'You don\'t have permission to edit items' : undefined}
              className={`inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary border border-border/40 hover:border-primary/30 rounded-md px-2.5 py-1 transition-all disabled:opacity-40 ${!canEdit ? 'cursor-not-allowed' : ''}`}
            >
              {!canEdit ? <Lock className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
              {seedMutation.isPending ? 'Loading...' : 'Seed from Catalog'}
            </button>
          </div>

          {/* Messages */}
          {saveMessage && (
            <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" /> {saveMessage}
            </div>
          )}
          {saveError && (
            <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20 flex items-center gap-1.5">
              <XCircle className="h-3 w-3" /> {saveError}
            </div>
          )}

          {/* Summary bar */}
          <div className="px-5 py-3 border-b border-border/40 flex items-center gap-4 flex-wrap text-xs font-mono">
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{summary.total}</span> products
            </span>
            <span className="text-[hsl(142,70%,50%)]">
              <CheckCircle2 className="h-3 w-3 inline mr-1" />
              {summary.nominal} in stock
            </span>
            <span className="text-amber-500">
              <AlertTriangle className="h-3 w-3 inline mr-1" />
              {summary.lowFuel} low stock
            </span>
            <span className="text-red-500">
              <XCircle className="h-3 w-3 inline mr-1" />
              {summary.depleted} sold out
            </span>
          </div>

          {/* Filters */}
          <div className="px-5 py-3 border-b border-border/40 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={collectionFilter}
                onChange={e => setCollectionFilter(e.target.value)}
                className="rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
              >
                <option value="all">All Collections</option>
                {collections.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
              >
                <option value="all">All Status</option>
                <option value="nominal">In Stock</option>
                <option value="low-fuel">Low Stock</option>
                <option value="depleted">Sold Out</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-[180px]">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search product name or SKU..."
                className="flex-1 rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>
          </div>

          {/* Table */}
          {inventoryLoading ? (
            <div className="px-5 py-12 text-center">
              <p className="text-xs text-muted-foreground font-mono">Loading inventory<span className="term-cursor" /></p>
            </div>
          ) : inventory.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4"
                   style={{ background: 'hsl(188 100% 42% / 0.1)' }}>
                <BarChart3 className="h-6 w-6 lp-glow" />
              </div>
              <p className="text-sm font-semibold mb-1" style={{ fontFamily: 'Syne, sans-serif' }}>No inventory data</p>
              <p className="text-xs text-muted-foreground font-mono mb-4">
                Seed inventory from your product catalog to start tracking stock levels.
              </p>
              <button
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
                className="btn-launch inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm disabled:opacity-50"
              >
                <Rocket className="h-4 w-4" />
                {seedMutation.isPending ? 'Loading...' : 'Seed Inventory'}
              </button>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40 bg-card">
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">Product</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">Collection</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">SKU</th>
                      <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground uppercase tracking-wider">Stock</th>
                      <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(item => {
                      const productId = item['Product ID'];
                      const edits = editedRows[productId];
                      const currentStock = edits?.stock !== undefined ? edits.stock : item['Stock'];
                      const currentNotes = edits?.notes !== undefined ? edits.notes : (item['Notes'] || '');
                      const status = stockStatus(currentStock);
                      const isDirty = !!edits;

                      return (
                        <tr
                          key={productId}
                          className={`border-b border-border/20 transition-colors ${
                            isDirty ? 'bg-primary/5' : 'hover:bg-foreground/[0.02]'
                          }`}
                        >
                          <td className="px-4 py-2.5">
                            <span className="font-medium" style={{ fontFamily: 'Syne, sans-serif' }}>
                              {item['Product Name']}
                            </span>
                            {isDirty && <span className="ml-1.5 text-[10px] text-amber-400 font-mono">modified</span>}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{item['Collection']}</td>
                          <td className="px-4 py-2.5 font-mono text-muted-foreground">{item['SKU']}</td>
                          <td className="px-4 py-2.5 text-center">
                            <input
                              type="number"
                              min="0"
                              value={currentStock}
                              onChange={e => handleStockChange(productId, e.target.value)}
                              disabled={!canEdit}
                              className={`w-16 text-center rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60 font-mono ${!canEdit ? 'opacity-50 cursor-not-allowed' : ''}`}
                            />
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CONFIG[status].className}`}>
                              {STATUS_CONFIG[status].label}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <input
                              type="text"
                              value={currentNotes}
                              onChange={e => handleNotesChange(productId, e.target.value)}
                              placeholder="Notes..."
                              disabled={!canEdit}
                              className={`w-full rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60 ${!canEdit ? 'opacity-50 cursor-not-allowed' : ''}`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden p-4 space-y-3">
                {filtered.map(item => {
                  const productId = item['Product ID'];
                  const edits = editedRows[productId];
                  const currentStock = edits?.stock !== undefined ? edits.stock : item['Stock'];
                  const currentNotes = edits?.notes !== undefined ? edits.notes : (item['Notes'] || '');
                  const status = stockStatus(currentStock);
                  const isDirty = !!edits;

                  return (
                    <div
                      key={productId}
                      className={`rounded-lg border p-3 transition-all ${
                        isDirty ? 'border-primary/40 bg-primary/5' : 'border-border/40 bg-card'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="text-sm font-medium" style={{ fontFamily: 'Syne, sans-serif' }}>
                            {item['Product Name']}
                          </p>
                          <p className="text-[10px] text-muted-foreground font-mono">{item['Collection']} · {item['SKU']}</p>
                        </div>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CONFIG[status].className}`}>
                          {STATUS_CONFIG[status].label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Stock</label>
                        <input
                          type="number"
                          min="0"
                          value={currentStock}
                          onChange={e => handleStockChange(productId, e.target.value)}
                          className="w-16 text-center rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60 font-mono"
                        />
                        <div className="flex-1">
                          <input
                            type="text"
                            value={currentNotes}
                            onChange={e => handleNotesChange(productId, e.target.value)}
                            placeholder="Notes..."
                            className="w-full rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Save bar */}
              <div className="px-5 py-3 border-t border-border/40 flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={dirtyCount === 0 || saveMutation.isPending || !canEdit}
                  className="btn-launch inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
                {dirtyCount > 0 && (
                  <span className="text-xs text-amber-400 font-mono">
                    {dirtyCount} item{dirtyCount !== 1 ? 's' : ''} modified
                  </span>
                )}
                {filtered.length < inventory.length && (
                  <span className="text-xs text-muted-foreground font-mono ml-auto">
                    Showing {filtered.length} of {inventory.length}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Catalog Tab */}
      {activeTab === 'catalog' && (
        <CollectionsEditor slug={slug} />
      )}
    </div>
  );
}
