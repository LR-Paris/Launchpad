import { useState, useEffect, useRef, useMemo, useCallback, Component } from 'react';
import {
  Folder, Plus, Trash2, Save, Upload, ImageIcon, X, Check, Lock,
  Package, FolderPlus, Pencil, Star, Copy, MoveRight, Search,
  AlertTriangle, Eye, EyeOff, Keyboard, GripVertical, MoreVertical,
} from 'lucide-react';
import {
  DndContext, useSensor, useSensors, PointerSensor, KeyboardSensor,
  useDraggable, useDroppable, closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, sortableKeyboardCoordinates,
  verticalListSortingStrategy, rectSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  listShopFiles, readShopFile, writeShopFile, deleteShopFile,
  uploadShopFiles, replaceShopFile, getShopImageUrl,
  renameShopFile, moveShopFile, copyShopFile,
} from '../lib/api';
import {
  renderMarkdown, validateItem, sortPhotos, nextDuplicateName,
} from '../lib/catalog-utils';

const DETAIL_FIELDS = {
  'Name.txt':        { type: 'text',     label: 'Name' },
  'Description.txt': { type: 'textarea', label: 'Description', rows: 3 },
  'SKU.txt':         { type: 'text',     label: 'SKU', mono: true },
  'ItemCost.txt':    { type: 'number',   label: 'Item Cost',     step: '0.01', prefix: '$' },
  'BoxCost.txt':     { type: 'number',   label: 'Box Cost',      step: '0.01', prefix: '$' },
  'UnitsPerBox.txt': { type: 'number',   label: 'Units Per Box', step: '1' },
};
const FIELD_ORDER = ['Name.txt', 'Description.txt', 'SKU.txt', 'ItemCost.txt', 'BoxCost.txt', 'UnitsPerBox.txt'];
const ORDER_MANIFEST_PATH = 'DATABASE/ShopCollections/.order.json';

function friendlyLabel(filename) {
  const name = filename.replace(/\.[^.]+$/, '');
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Sortable collection sidebar entry
// ────────────────────────────────────────────────────────────────────────────
function SortableCollectionRow({
  col, isSelected, isDropTarget, disabled, onSelect, onDelete, onStartRename,
}) {
  const { setNodeRef: setSortRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: `col:${col.name}`, disabled });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `coldrop:${col.name}`,
    disabled,
  });

  const setRefs = (el) => { setSortRef(el); setDropRef(el); };
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <li ref={setRefs} style={style} className="group relative">
      <button
        onClick={() => onSelect(col.name)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors pr-12 ${
          isSelected
            ? 'bg-primary/10 text-primary font-medium'
            : 'hover:bg-foreground/5 text-foreground'
        } ${(isOver || isDropTarget) ? 'ring-1 ring-primary/40 bg-primary/5' : ''}`}
      >
        {!disabled && (
          <span
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder"
          >
            <GripVertical className="h-3 w-3" />
          </span>
        )}
        <Folder className="h-3 w-3 flex-shrink-0 text-yellow-400/80" />
        <span className="truncate">{col.name}</span>
      </button>
      {!disabled && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
          <button
            onClick={(e) => { e.stopPropagation(); onStartRename(col.name); }}
            className="text-muted-foreground hover:text-primary"
            title="Rename"
          ><Pencil className="h-3 w-3" /></button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(col.name); }}
            className="text-muted-foreground hover:text-destructive"
            title="Delete"
          ><Trash2 className="h-3 w-3" /></button>
        </div>
      )}
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Draggable item card (also acts as a checkbox for bulk select)
// ────────────────────────────────────────────────────────────────────────────
function DraggableItemCard({
  item, slug, photoTimestamps, isExpanded, isSelected,
  bulkMode, validationIssues, disabled,
  onClick, onToggleSelect, onKebab,
}) {
  const { setNodeRef, attributes, listeners, transform, isDragging } =
    useDraggable({ id: `item:${item.dirName}`, disabled: disabled || bulkMode });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    cursor: disabled || bulkMode ? 'default' : 'grab',
  };

  const ts = item.thumbnailFile ? photoTimestamps[item.thumbnailFile] : null;
  const imgUrl = item.thumbnailFile
    ? getShopImageUrl(slug, item.thumbnailFile) + (ts ? `&_t=${ts}` : '')
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (e.target.closest('[data-no-drag]')) return;
        onClick();
      }}
      className={`relative rounded-lg border p-3 text-left transition-all ${
        isExpanded
          ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
          : isSelected
            ? 'border-primary/50 bg-primary/10'
            : 'border-border/40 hover:border-primary/30 bg-card'
      }`}
    >
      {bulkMode && (
        <button
          data-no-drag
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          className="absolute top-2 left-2 z-10 h-5 w-5 rounded border border-primary/60 bg-background/80 backdrop-blur-sm flex items-center justify-center"
        >
          {isSelected && <Check className="h-3 w-3 text-primary" />}
        </button>
      )}
      {!bulkMode && !disabled && (
        <button
          data-no-drag
          onClick={(e) => { e.stopPropagation(); onKebab(e); }}
          className="absolute top-1 right-1 z-10 h-6 w-6 rounded hover:bg-foreground/10 text-muted-foreground transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      )}
      {imgUrl ? (
        <img
          src={imgUrl}
          alt={item.name}
          className="w-full aspect-square object-cover rounded-md mb-2 border border-border/30"
          draggable={false}
        />
      ) : (
        <div className="w-full aspect-square rounded-md mb-2 bg-muted/50 flex items-center justify-center border border-border/30">
          <ImageIcon className="h-8 w-8 text-muted-foreground/30" />
        </div>
      )}
      <p className="text-sm font-medium truncate" style={{ fontFamily: 'Syne, sans-serif' }}>
        {item.name}
      </p>
      {item.price && (
        <p className="text-xs text-primary font-mono mt-0.5">${item.price}</p>
      )}
      {validationIssues.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {validationIssues.slice(0, 3).map(issue => (
            <span
              key={issue}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400/80 border border-amber-400/20"
            >
              {issue}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sortable photo tile
// ────────────────────────────────────────────────────────────────────────────
function SortablePhoto({
  photo, slug, isMain, ts, disabled,
  onSetMain, onRename, onDelete, onReplace,
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: `photo:${photo.path}`, disabled });
  const replaceInputRef = useRef(null);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const imgUrl = getShopImageUrl(slug, photo.path) + (ts ? `&_t=${ts}` : '');

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative group rounded-md border border-border/40 overflow-hidden"
    >
      {!disabled && (
        <span
          {...attributes}
          {...listeners}
          className="absolute top-1 left-1 z-10 cursor-grab active:cursor-grabbing rounded bg-black/50 text-white/80 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Drag to reorder"
        >
          <GripVertical className="h-3 w-3" />
        </span>
      )}
      {isMain && (
        <span className="absolute top-1 right-1 z-10 rounded-full bg-primary/90 text-primary-foreground px-1.5 py-0.5 text-[9px] font-bold flex items-center gap-0.5">
          <Star className="h-2.5 w-2.5 fill-current" /> MAIN
        </span>
      )}
      <img src={imgUrl} alt={photo.name} className="w-full h-28 object-cover" draggable={false} />
      {!disabled && (
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5">
          {!isMain && (
            <button
              onClick={() => onSetMain(photo)}
              className="rounded-md bg-primary/40 backdrop-blur-sm px-2 py-1 text-[10px] text-white hover:bg-primary/60 transition-colors flex items-center gap-1"
              title="Set as main photo"
            >
              <Star className="h-2.5 w-2.5" /> Main
            </button>
          )}
          <button
            onClick={() => onRename(photo)}
            className="rounded-md bg-white/20 backdrop-blur-sm px-2 py-1 text-[10px] text-white hover:bg-white/30 transition-colors"
          >
            Rename
          </button>
          <button
            onClick={() => replaceInputRef.current?.click()}
            className="rounded-md bg-white/20 backdrop-blur-sm px-2 py-1 text-[10px] text-white hover:bg-white/30 transition-colors"
          >
            Replace
          </button>
          <button
            onClick={() => onDelete(photo)}
            className="rounded-md bg-red-500/40 backdrop-blur-sm px-2 py-1 text-[10px] text-white hover:bg-red-500/60 transition-colors"
          >
            Delete
          </button>
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) onReplace(photo, e.target.files[0]);
              e.target.value = '';
            }}
          />
        </div>
      )}
      <div className="px-2 py-1 bg-card">
        <p className="text-[10px] font-mono text-muted-foreground truncate">{photo.name}</p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Move item modal
// ────────────────────────────────────────────────────────────────────────────
function MoveItemModal({ collections, currentCollection, count, onCancel, onConfirm }) {
  const [target, setTarget] = useState('');
  const options = collections.filter(c => c.name !== currentCollection);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="lp-card rounded-xl w-full max-w-md p-5 lp-fadein">
        <div className="flex items-center gap-2 mb-3">
          <MoveRight className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
            Move {count > 1 ? `${count} items` : 'item'}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground font-mono mb-3">
          Past orders will keep the old product IDs and may show placeholder images.
        </p>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-full rounded-md border border-border/60 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 mb-4"
        >
          <option value="">Choose destination collection...</option>
          {options.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs bg-secondary hover:bg-accent rounded-md transition-colors">Cancel</button>
          <button
            onClick={() => target && onConfirm(target)}
            disabled={!target}
            className="btn-launch rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          >Move</button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts overlay
// ────────────────────────────────────────────────────────────────────────────
function KeyboardOverlay({ onClose }) {
  const rows = [
    ['/',   'Focus search'],
    ['J / K', 'Next / previous item'],
    ['E',   'Edit selected item'],
    ['M',   'Move selected item'],
    ['D',   'Duplicate selected item'],
    ['Del', 'Delete selected item'],
    ['Esc', 'Close item / dialog'],
    ['?',   'Toggle this help overlay'],
  ];
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="lp-card rounded-xl w-full max-w-md p-5 lp-fadein">
        <div className="flex items-center gap-2 mb-3">
          <Keyboard className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Keyboard shortcuts</h3>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([key, desc]) => (
              <tr key={key}>
                <td className="py-1.5 pr-4 font-mono"><kbd className="px-1.5 py-0.5 rounded bg-secondary border border-border/60 text-[10px]">{key}</kbd></td>
                <td className="text-muted-foreground">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Close</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Main editor
// ════════════════════════════════════════════════════════════════════════════
// Catches any unexpected render/runtime error inside the catalog editor so a
// bug here degrades to an inline message instead of white-screening the SPA.
class CollectionsEditorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('CollectionsEditor crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="lp-card rounded-xl p-6 text-center">
          <p className="text-sm font-semibold mb-1">The catalog editor hit an error.</p>
          <p className="text-xs text-muted-foreground font-mono mb-3">{String(this.state.error?.message || this.state.error)}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-all"
          >
            Reload editor
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function CollectionsEditor(props) {
  return (
    <CollectionsEditorBoundary key={props.slug}>
      <CollectionsEditorInner {...props} />
    </CollectionsEditorBoundary>
  );
}

function CollectionsEditorInner({ slug, locked = false }) {
  // Collections list
  const [collections, setCollections] = useState([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState(null);

  // Items in selected collection
  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  // Expanded item
  const [editingItem, setEditingItem] = useState(null);
  const [itemDetails, setItemDetails] = useState({});
  const [itemOriginal, setItemOriginal] = useState({});
  const [itemPhotos, setItemPhotos] = useState([]);
  const [photoTimestamps, setPhotoTimestamps] = useState({});
  const [autoSaveStatus, setAutoSaveStatus] = useState(''); // '' | 'saving' | 'saved'
  const [itemDetailsLoading, setItemDetailsLoading] = useState(false);

  // Add dialogs (collection / item)
  const [showAddCollection, setShowAddCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');

  // Inline rename state — keyed by what's being renamed
  const [renaming, setRenaming] = useState(null); // { kind:'collection'|'item'|'photo', original, value }

  // Bulk select
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [moveTarget, setMoveTarget] = useState(null); // { ids: [] }

  // UI extras
  const [search, setSearch] = useState('');
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [descPreview, setDescPreview] = useState(false);
  const [photoDropActive, setPhotoDropActive] = useState(false);

  // Item kebab menu
  const [kebabFor, setKebabFor] = useState(null); // dirName
  const [kebabPos, setKebabPos] = useState({ x: 0, y: 0 });

  // Messages
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  // Refs
  const photoUploadRef = useRef(null);
  const searchInputRef = useRef(null);
  const autoSaveTimer = useRef(null);
  const autoSaveSeq = useRef(0);
  const loadGenRef = useRef(0);
  const loadAbortRef = useRef(null);
  const loadSeqRef = useRef(0);
  const currentColRef = useRef(null);
  const collectionsRef = useRef([]);

  const ALL_COL = '__all__';
  const disabled = locked;

  const flashSuccess = useCallback((msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(''), 3000);
  }, []);

  // ── Collections: load + apply manifest order ────────────────────────────
  const loadCollections = useCallback(async () => {
    setCollectionsLoading(true);
    try {
      const data = await listShopFiles(slug, 'DATABASE/ShopCollections');
      const dirs = (data.entries || []).filter(e => e.isDirectory);
      let ordered = dirs;
      try {
        const manifest = await readShopFile(slug, ORDER_MANIFEST_PATH);
        const order = JSON.parse(manifest.content || '{}').order || [];
        const byName = new Map(dirs.map(d => [d.name, d]));
        ordered = [
          ...order.filter(n => byName.has(n)).map(n => byName.get(n)),
          ...dirs.filter(d => !order.includes(d.name)),
        ];
      } catch { /* no manifest yet — alphabetical */ }
      setCollections(ordered);
    } catch {
      setCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }, [slug]);

  useEffect(() => { loadCollections(); }, [loadCollections]);

  // Keep a ref so loadItems always reads the latest collections without being
  // recreated every time collections changes (avoids double-load race on ALL_COL).
  useEffect(() => { collectionsRef.current = collections; }, [collections]);

  // ── Items: load one collection (batched 5 at a time, abort-aware) ──────────
  const loadSingleCollection = useCallback(async (colName, signal) => {
    const colPath = `DATABASE/ShopCollections/${colName}`;
    const data = await listShopFiles(slug, colPath, { signal });
    const itemDirs = (data.entries || []).filter(e => e.isDirectory);
    const BATCH = 5;
    const results = [];
    for (let i = 0; i < itemDirs.length; i += BATCH) {
      if (signal?.aborted) return results;
      const batch = itemDirs.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (dir) => {
        const basePath = `${colPath}/${dir.name}`;
        const [nameRes, priceRes, descRes, photosRes] = await Promise.allSettled([
          readShopFile(slug, `${basePath}/Details/Name.txt`, { signal }),
          readShopFile(slug, `${basePath}/Details/ItemCost.txt`, { signal }),
          readShopFile(slug, `${basePath}/Details/Description.txt`, { signal }),
          listShopFiles(slug, `${basePath}/Photos`, { signal }),
        ]);
        const name = (nameRes.status === 'fulfilled' ? nameRes.value.content.trim() : '') || dir.name;
        const price = priceRes.status === 'fulfilled' ? priceRes.value.content.trim() : '';
        const description = descRes.status === 'fulfilled' ? descRes.value.content.trim() : '';
        let thumbnailFile = null;
        if (photosRes.status === 'fulfilled') {
          const sorted = sortPhotos((photosRes.value.entries || []).filter(e => e.isImage));
          if (sorted.length) thumbnailFile = `${basePath}/Photos/${sorted[0].name}`;
        }
        return { dirName: dir.name, name, price, description, thumbnailFile, basePath, collectionName: colName };
      }));
      results.push(...batchResults);
    }
    return results;
  }, [slug]);

  // ── Items: load when collection selected (handles ALL_COL too) ───────────
  // Uses AbortController to cancel in-flight requests when switching collections,
  // and collectionsRef to always read the latest collections without recreating.
  const loadItems = useCallback(async (colName) => {
    currentColRef.current = colName;

    // ALWAYS cancel any in-flight load — a new load fully supersedes it.
    // (Previously same-collection re-triggers replaced the controller
    // without aborting, orphaning loads that could never be cancelled;
    // rapid collection switching stacked them into a request/render storm
    // that froze the UI.) The seq token guarantees a superseded load can
    // never write state, even if its abort signal is somehow missed.
    if (loadAbortRef.current) loadAbortRef.current.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const seq = ++loadSeqRef.current;
    const { signal } = controller;
    const isStale = () => signal.aborted || seq !== loadSeqRef.current;

    if (!colName) { setItems([]); return; }
    setItemsLoading(true);
    setEditingItem(null);
    setSelectedIds(new Set());
    try {
      let itemsData;
      if (colName === ALL_COL) {
        // Use collections directly from closure (it's in deps) so this always
        // has the latest list — fixes "All Collections showing 0 items" when
        // collections hadn't loaded yet on the first trigger.
        if (collections.length === 0) { setItems([]); return; }
        const all = [];
        for (const col of collections) {
          if (isStale()) return;
          const colItems = await loadSingleCollection(col.name, signal);
          all.push(...colItems);
        }
        itemsData = all;
      } else {
        itemsData = await loadSingleCollection(colName, signal);
      }
      if (isStale()) return;
      setItems(itemsData);
    } catch (err) {
      // Ignore abort errors — they're expected when switching collections
      if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED' || isStale()) return;
      setItems([]);
    } finally {
      if (!isStale()) setItemsLoading(false);
    }
  }, [slug, collections, loadSingleCollection]);

  // Debounced: rapid collection jumping only loads the finally-selected
  // collection (the spinner still appears instantly via selectCollection).
  useEffect(() => {
    const t = setTimeout(() => { loadItems(selectedCollection); }, 150);
    return () => clearTimeout(t);
  }, [selectedCollection, loadItems]);

  // Cancel any in-flight load on unmount
  useEffect(() => () => { loadAbortRef.current?.abort(); }, []);

  // Wrapper so itemsLoading=true fires in the same render as the collection change,
  // preventing the "(0 items) / No items" flash before loadItems runs.
  const selectCollection = useCallback((name) => {
    if (name) setItemsLoading(true);
    setItems([]);
    setSelectedCollection(name);
  }, []);

  // ── Item details: load on expand ────────────────────────────────────────
  const loadItemDetails = useCallback(async (item) => {
    setEditingItem(item.basePath);
    setItemDetails({});
    setItemOriginal({});
    setItemPhotos([]);
    setItemDetailsLoading(true);
    setAutoSaveStatus('');
    setDescPreview(false);
    const detailsPath = `${item.basePath}/Details`;
    const photosPath = `${item.basePath}/Photos`;
    try {
      const listing = await listShopFiles(slug, detailsPath);
      const textFiles = (listing.entries || []).filter(e => e.readable && !e.isDirectory);
      const details = {};
      const original = {};
      await Promise.all(textFiles.map(async (entry) => {
        try {
          const data = await readShopFile(slug, `${detailsPath}/${entry.name}`);
          details[entry.name] = data.content.trim();
          original[entry.name] = data.content.trim();
        } catch {
          details[entry.name] = '';
          original[entry.name] = '';
        }
      }));
      setItemDetails(details);
      setItemOriginal(original);
    } catch {
      setItemDetails({});
      setItemOriginal({});
    }
    try {
      const photoListing = await listShopFiles(slug, photosPath);
      const photoEntries = (photoListing.entries || [])
        .filter(e => e.isImage)
        .map(e => ({ name: e.name, path: `${photosPath}/${e.name}`, size: e.size }));
      setItemPhotos(sortPhotos(photoEntries));
    } catch {
      setItemPhotos([]);
    }
    setItemDetailsLoading(false);
  }, [slug]);

  // ── Auto-save with debounce ─────────────────────────────────────────────
  useEffect(() => {
    if (!editingItem || disabled) return;
    const dirty = Object.keys(itemDetails).filter(f => itemDetails[f] !== itemOriginal[f]);
    if (dirty.length === 0) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    setAutoSaveStatus('saving');
    const seq = ++autoSaveSeq.current;
    autoSaveTimer.current = setTimeout(async () => {
      const item = items.find(i => i.basePath === editingItem);
      if (!item) return;
      try {
        await Promise.all(dirty.map(f =>
          writeShopFile(slug, `${item.basePath}/Details/${f}`, itemDetails[f])
        ));
        if (seq !== autoSaveSeq.current) return; // a newer save started
        setItemOriginal(prev => ({ ...prev, ...Object.fromEntries(dirty.map(f => [f, itemDetails[f]])) }));
        setItems(prev => prev.map(i => {
          if (i.basePath !== editingItem) return i;
          return {
            ...i,
            name: itemDetails['Name.txt']?.trim() || i.name,
            price: itemDetails['ItemCost.txt']?.trim() || i.price,
          };
        }));
        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus(''), 1500);
      } catch (err) {
        if (seq !== autoSaveSeq.current) return;
        setAutoSaveStatus('');
        setError(err.response?.data?.error || 'Auto-save failed');
      }
    }, 1000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [itemDetails, itemOriginal, editingItem, items, slug, disabled]);

  // ── Search-filtered items / collections ─────────────────────────────────
  const visibleItems = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.dirName.toLowerCase().includes(q) ||
      (i.collectionName && i.collectionName.toLowerCase().includes(q))
    );
  }, [items, search]);

  // ── Persist collection order to .order.json ────────────────────────────
  const persistCollectionOrder = useCallback(async (ordered) => {
    try {
      await writeShopFile(slug, ORDER_MANIFEST_PATH, JSON.stringify({ order: ordered.map(c => c.name) }, null, 2));
    } catch { /* best-effort */ }
  }, [slug]);

  // ── Mutations ───────────────────────────────────────────────────────────
  const handleAddCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) return;
    setError('');
    try {
      await writeShopFile(slug, `DATABASE/ShopCollections/${name}/.gitkeep`, '');
      const next = [...collections, { name, isDirectory: true }];
      setCollections(next);
      persistCollectionOrder(next);
      setSelectedCollection(name);
      setShowAddCollection(false);
      setNewCollectionName('');
      flashSuccess(`Collection "${name}" created.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create collection');
    }
  };

  const handleAddItem = async () => {
    const name = newItemName.trim();
    if (!name || !selectedCollection) return;
    const basePath = `DATABASE/ShopCollections/${selectedCollection}/${name}`;
    setError('');
    try {
      await Promise.all([
        writeShopFile(slug, `${basePath}/Details/Name.txt`, name),
        writeShopFile(slug, `${basePath}/Details/Description.txt`, ''),
        writeShopFile(slug, `${basePath}/Details/SKU.txt`, ''),
        writeShopFile(slug, `${basePath}/Details/ItemCost.txt`, '0.00'),
        writeShopFile(slug, `${basePath}/Details/BoxCost.txt`, '0.00'),
        writeShopFile(slug, `${basePath}/Details/UnitsPerBox.txt`, '1'),
      ]);
      await writeShopFile(slug, `${basePath}/Photos/.gitkeep`, '');
      const newItem = { dirName: name, name, price: '0.00', thumbnailFile: null, basePath };
      setItems(prev => [...prev, newItem]);
      setShowAddItem(false);
      setNewItemName('');
      flashSuccess(`Item "${name}" created.`);
      loadItemDetails(newItem);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create item');
    }
  };

  const handleDeleteItem = async (item) => {
    if (!window.confirm(`Delete item "${item.name}"? This removes all its files and photos.`)) return;
    setError('');
    try {
      await deleteShopFile(slug, item.basePath);
      setItems(prev => prev.filter(i => i.dirName !== item.dirName));
      if (editingItem === item.basePath) setEditingItem(null);
      flashSuccess(`Item "${item.name}" deleted.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete item');
    }
  };

  const handleDeleteCollection = async (colName) => {
    if (!window.confirm(`Delete collection "${colName}" and ALL its items? This cannot be undone.`)) return;
    setError('');
    try {
      await deleteShopFile(slug, `DATABASE/ShopCollections/${colName}`);
      const next = collections.filter(c => c.name !== colName);
      setCollections(next);
      persistCollectionOrder(next);
      if (selectedCollection === colName) {
        setSelectedCollection(null);
        setItems([]);
        setEditingItem(null);
      }
      flashSuccess(`Collection "${colName}" deleted.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete collection');
    }
  };

  const handleRenameCollection = async (oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) { setRenaming(null); return; }
    setError('');
    try {
      await renameShopFile(slug, `DATABASE/ShopCollections/${oldName}`, `DATABASE/ShopCollections/${trimmed}`);
      const next = collections.map(c => c.name === oldName ? { ...c, name: trimmed } : c);
      setCollections(next);
      persistCollectionOrder(next);
      if (selectedCollection === oldName) setSelectedCollection(trimmed);
      setRenaming(null);
      flashSuccess(`Renamed to "${trimmed}". Inventory updated.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Rename failed');
    }
  };

  const handleRenameItem = async (oldDir, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldDir) { setRenaming(null); return; }
    const item = items.find(i => i.dirName === oldDir);
    if (!item) { setRenaming(null); return; }
    setError('');
    try {
      const newBasePath = `DATABASE/ShopCollections/${selectedCollection}/${trimmed}`;
      await renameShopFile(slug, item.basePath, newBasePath);
      // Also bump Name.txt to match the new dirName
      try { await writeShopFile(slug, `${newBasePath}/Details/Name.txt`, trimmed); } catch {}
      setItems(prev => prev.map(i =>
        i.dirName === oldDir
          ? { ...i, dirName: trimmed, name: trimmed, basePath: newBasePath, thumbnailFile: i.thumbnailFile?.replace(item.basePath, newBasePath) || null }
          : i
      ));
      if (editingItem === item.basePath) setEditingItem(newBasePath);
      setRenaming(null);
      flashSuccess(`Renamed to "${trimmed}". Inventory updated.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Rename failed');
    }
  };

  const handleRenamePhoto = async (photo, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === photo.name) { setRenaming(null); return; }
    const dir = photo.path.slice(0, photo.path.lastIndexOf('/'));
    const newPath = `${dir}/${trimmed}`;
    setError('');
    try {
      await renameShopFile(slug, photo.path, newPath);
      setItemPhotos(prev => sortPhotos(prev.map(p =>
        p.path === photo.path ? { ...p, name: trimmed, path: newPath } : p
      )));
      setRenaming(null);
      flashSuccess(`Photo renamed to "${trimmed}".`);
    } catch (err) {
      setError(err.response?.data?.error || 'Photo rename failed');
    }
  };

  const handleSetMainPhoto = async (photo) => {
    const dir = photo.path.slice(0, photo.path.lastIndexOf('/'));
    const ext = (photo.name.match(/\.([^.]+)$/) || [])[1] || 'jpg';
    const targetMain = `main.${ext.toLowerCase()}`;
    const existingMain = itemPhotos.find(p => /^main\.(jpg|jpeg|png|webp)$/i.test(p.name));
    setError('');
    try {
      // If there's already a main, rename it back to its original or to a numbered fallback
      if (existingMain && existingMain.path !== photo.path) {
        const fallback = existingMain.name.replace(/^main\./i, 'photo_').replace(/\.([^.]+)$/, (m) => m); // photo_jpg style
        const safeFallback = fallback === existingMain.name ? `photo_${Date.now()}.${(existingMain.name.match(/\.([^.]+)$/) || [])[1] || 'jpg'}` : fallback;
        await renameShopFile(slug, existingMain.path, `${dir}/${safeFallback}`);
      }
      await renameShopFile(slug, photo.path, `${dir}/${targetMain}`);
      // Reload photos to reflect the swap
      const photoListing = await listShopFiles(slug, dir);
      const fresh = (photoListing.entries || [])
        .filter(e => e.isImage)
        .map(e => ({ name: e.name, path: `${dir}/${e.name}`, size: e.size }));
      setItemPhotos(sortPhotos(fresh));
      // Bust thumbnail cache for the affected item
      const affected = items.find(i => editingItem === i.basePath);
      if (affected) {
        const newThumb = `${dir}/${targetMain}`;
        setItems(prev => prev.map(i => i.dirName === affected.dirName
          ? { ...i, thumbnailFile: newThumb }
          : i));
        setPhotoTimestamps(prev => ({ ...prev, [newThumb]: Date.now() }));
      }
      flashSuccess(`Set "${photo.name}" as the main photo.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to set main photo');
    }
  };

  const handleDuplicateItem = async (item) => {
    const newName = nextDuplicateName(items, item.name);
    const newBasePath = `DATABASE/ShopCollections/${selectedCollection}/${newName}`;
    setError('');
    try {
      await copyShopFile(slug, item.basePath, newBasePath);
      try { await writeShopFile(slug, `${newBasePath}/Details/Name.txt`, newName); } catch {}
      const newItem = {
        dirName: newName, name: newName, price: item.price,
        thumbnailFile: item.thumbnailFile?.replace(item.basePath, newBasePath) || null,
        basePath: newBasePath,
      };
      setItems(prev => [...prev, newItem]);
      flashSuccess(`Duplicated as "${newName}".`);
      loadItemDetails(newItem);
      // Open inline rename so the user can edit the suggested name immediately
      setRenaming({ kind: 'item', original: newName, value: newName });
    } catch (err) {
      setError(err.response?.data?.error || 'Duplicate failed');
    }
  };

  const handleMoveItems = async (targetCollection, ids) => {
    setError('');
    let movedCount = 0;
    for (const dirName of ids) {
      const item = items.find(i => i.dirName === dirName);
      if (!item) continue;
      const dest = `DATABASE/ShopCollections/${targetCollection}/${dirName}`;
      try {
        await moveShopFile(slug, item.basePath, dest);
        movedCount++;
      } catch (err) {
        setError(err.response?.data?.error || `Failed to move "${item.name}"`);
        break;
      }
    }
    if (movedCount > 0) {
      setItems(prev => prev.filter(i => !ids.includes(i.dirName)));
      if (editingItem && items.some(i => i.basePath === editingItem && ids.includes(i.dirName))) setEditingItem(null);
      setSelectedIds(new Set());
      setBulkMode(false);
      setMoveTarget(null);
      flashSuccess(`Moved ${movedCount} item${movedCount === 1 ? '' : 's'} to "${targetCollection}".`);
    } else {
      setMoveTarget(null);
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} item${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setError('');
    let deletedCount = 0;
    for (const dirName of ids) {
      const item = items.find(i => i.dirName === dirName);
      if (!item) continue;
      try {
        await deleteShopFile(slug, item.basePath);
        deletedCount++;
      } catch (err) {
        setError(err.response?.data?.error || `Failed to delete "${item.name}"`);
        break;
      }
    }
    if (deletedCount > 0) {
      setItems(prev => prev.filter(i => !ids.includes(i.dirName)));
      if (editingItem && items.some(i => i.basePath === editingItem && ids.includes(i.dirName))) setEditingItem(null);
      setSelectedIds(new Set());
      setBulkMode(false);
      flashSuccess(`Deleted ${deletedCount} item${deletedCount === 1 ? '' : 's'}.`);
    }
  };

  const uploadPhotosFromList = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const item = items.find(i => i.basePath === editingItem);
    if (!item) return;
    const photosPath = `${item.basePath}/Photos`;
    const formData = new FormData();
    for (const f of fileList) formData.append('files', f);
    setError('');
    try {
      await uploadShopFiles(slug, photosPath, formData);
      const listing = await listShopFiles(slug, photosPath);
      const fresh = (listing.entries || [])
        .filter(e => e.isImage)
        .map(e => ({ name: e.name, path: `${photosPath}/${e.name}`, size: e.size }));
      setItemPhotos(sortPhotos(fresh));
      flashSuccess(`${fileList.length} photo(s) uploaded.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
    }
  };

  const handlePhotoUpload = async (e) => {
    await uploadPhotosFromList(e.target.files);
    if (photoUploadRef.current) photoUploadRef.current.value = '';
  };

  const handlePhotoReplace = async (photo, file) => {
    if (!file) return;
    setError('');
    try {
      await replaceShopFile(slug, photo.path, file);
      setPhotoTimestamps(prev => ({ ...prev, [photo.path]: Date.now() }));
      flashSuccess(`${photo.name} replaced.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to replace photo');
    }
  };

  const handlePhotoDelete = async (photo) => {
    if (!window.confirm(`Delete "${photo.name}"?`)) return;
    setError('');
    try {
      await deleteShopFile(slug, photo.path);
      setItemPhotos(prev => prev.filter(p => p.path !== photo.path));
      flashSuccess(`${photo.name} deleted.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete photo');
    }
  };

  // Photo reorder: rewrite filenames as 01_, 02_, etc.
  const handlePhotoReorder = async (newOrder) => {
    const item = items.find(i => i.basePath === editingItem);
    if (!item) return;
    setError('');
    setItemPhotos(newOrder); // optimistic
    // For each non-main photo in newOrder, ensure its filename starts with NN_
    let counter = 1;
    for (const photo of newOrder) {
      if (/^main\./i.test(photo.name)) continue;
      const ext = (photo.name.match(/\.([^.]+)$/) || [])[1] || 'jpg';
      const stripped = photo.name.replace(/^\d+_/, '');
      const targetName = `${String(counter).padStart(2, '0')}_${stripped}`;
      counter++;
      if (targetName === photo.name) continue;
      const dir = photo.path.slice(0, photo.path.lastIndexOf('/'));
      try {
        await renameShopFile(slug, photo.path, `${dir}/${targetName}`);
      } catch {
        // If rename collides or fails, just stop reordering — we already
        // updated UI optimistically; the next page load will reconcile.
        break;
      }
    }
    // Reload from server to get the canonical list
    try {
      const photosPath = `${item.basePath}/Photos`;
      const listing = await listShopFiles(slug, photosPath);
      const fresh = (listing.entries || [])
        .filter(e => e.isImage)
        .map(e => ({ name: e.name, path: `${photosPath}/${e.name}`, size: e.size }));
      setItemPhotos(sortPhotos(fresh));
    } catch { /* keep optimistic */ }
  };

  // ── DnD handlers ────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleCollectionDragEnd = ({ active, over }) => {
    if (!over || disabled) return;
    if (!active.id.startsWith('col:') || !over.id.startsWith('col:')) return;
    const fromName = active.id.slice(4);
    const toName = over.id.slice(4);
    if (fromName === toName) return;
    const oldIdx = collections.findIndex(c => c.name === fromName);
    const newIdx = collections.findIndex(c => c.name === toName);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(collections, oldIdx, newIdx);
    setCollections(next);
    persistCollectionOrder(next);
  };

  const handleItemDragEnd = async ({ active, over }) => {
    if (!over || disabled) return;
    if (!active.id.startsWith('item:')) return;
    if (!over.id.startsWith('coldrop:')) return;
    const dirName = active.id.slice(5);
    const targetCol = over.id.slice('coldrop:'.length);
    if (targetCol === selectedCollection) return;
    await handleMoveItems(targetCol, [dirName]);
  };

  const handlePhotoDragEnd = ({ active, over }) => {
    if (!over || disabled) return;
    if (!active.id.startsWith('photo:') || !over.id.startsWith('photo:')) return;
    const fromPath = active.id.slice('photo:'.length);
    const toPath = over.id.slice('photo:'.length);
    if (fromPath === toPath) return;
    const oldIdx = itemPhotos.findIndex(p => p.path === fromPath);
    const newIdx = itemPhotos.findIndex(p => p.path === toPath);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(itemPhotos, oldIdx, newIdx);
    handlePhotoReorder(next);
  };

  // ── Photo panel: drag-to-upload ─────────────────────────────────────────
  const photoDragHandlers = {
    onDragEnter: (e) => { e.preventDefault(); if (!disabled) setPhotoDropActive(true); },
    onDragOver:  (e) => { e.preventDefault(); },
    onDragLeave: (e) => {
      // only flip off when leaving the panel itself, not children
      if (e.currentTarget === e.target) setPhotoDropActive(false);
    },
    onDrop: async (e) => {
      e.preventDefault();
      setPhotoDropActive(false);
      if (disabled) return;
      const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
      if (files.length) await uploadPhotosFromList(files);
    },
  };

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const inField = ['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable;
      if (e.key === '?' && !inField) {
        setShowKeyboardHelp(s => !s);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (showKeyboardHelp) setShowKeyboardHelp(false);
        else if (moveTarget) setMoveTarget(null);
        else if (renaming) setRenaming(null);
        else if (editingItem) setEditingItem(null);
        return;
      }
      if (inField) return;
      if (e.key === '/') {
        searchInputRef.current?.focus();
        e.preventDefault();
        return;
      }
      if (!visibleItems.length) return;
      const idx = visibleItems.findIndex(i => i.basePath === editingItem);
      if (e.key === 'j') {
        const next = visibleItems[Math.min(visibleItems.length - 1, (idx < 0 ? 0 : idx + 1))];
        if (next) loadItemDetails(next);
        e.preventDefault();
      } else if (e.key === 'k') {
        const next = visibleItems[Math.max(0, (idx < 0 ? 0 : idx - 1))];
        if (next) loadItemDetails(next);
        e.preventDefault();
      } else if (e.key === 'e') {
        const target = visibleItems[idx >= 0 ? idx : 0];
        if (target) loadItemDetails(target);
      } else if (e.key === 'd' && editingItem) {
        const target = items.find(i => i.basePath === editingItem);
        if (target && !disabled) handleDuplicateItem(target);
      } else if (e.key === 'm' && editingItem) {
        { const __eit = items.find(i => i.basePath === editingItem); if (__eit && !disabled) setMoveTarget({ ids: [__eit.dirName] }); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && editingItem) {
        const target = items.find(i => i.basePath === editingItem);
        if (target && !disabled) handleDeleteItem(target);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visibleItems, items, editingItem, renaming, moveTarget, showKeyboardHelp, loadItemDetails, disabled]);

  // Close kebab menu on outside click
  useEffect(() => {
    if (!kebabFor) return;
    const close = () => setKebabFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [kebabFor]);

  // ── Render helpers ──────────────────────────────────────────────────────
  const orderedDetailFiles = () => {
    const known = FIELD_ORDER.filter(f => f in itemDetails);
    const unknown = Object.keys(itemDetails).filter(f => !FIELD_ORDER.includes(f)).sort();
    return [...known, ...unknown];
  };

  const isAnyDirty = editingItem && Object.keys(itemDetails).some(f => itemDetails[f] !== itemOriginal[f]);
  const editingItemPhotos = editingItem ? itemPhotos : [];
  const editingItemValidation = useMemo(() => {
    if (!editingItem) return [];
    return validateItem({ details: itemDetails, photos: editingItemPhotos });
  }, [editingItem, itemDetails, editingItemPhotos]);

  // ════════════════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="lp-card rounded-xl overflow-hidden">
      {/* Locked banner */}
      {locked && (
        <div className="px-5 py-2.5 bg-amber-400/10 border-b border-amber-400/30 flex items-center gap-2 text-xs text-amber-300">
          <Lock className="h-3.5 w-3.5" />
          <span className="font-mono">This shuttle is launching — catalog is read-only until build completes.</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40 flex-wrap">
        <Package className="h-4 w-4 text-primary/70" />
        <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Product Catalog</h2>
        <span className="text-xs text-muted-foreground font-mono ml-1">Manage collections &amp; items</span>

        <div className="flex-1" />

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/60" />
          <input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="rounded-md border border-border/60 bg-input pl-7 pr-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60 w-44"
          />
        </div>

        {/* Bulk-mode toggle */}
        {!disabled && selectedCollection !== ALL_COL && (
          <button
            onClick={() => { setBulkMode(b => !b); setSelectedIds(new Set()); }}
            className={`text-xs px-2 py-1 rounded-md border transition-all ${
              bulkMode ? 'bg-primary/15 border-primary/40 text-primary' : 'border-border/60 text-muted-foreground hover:text-foreground'
            }`}
          >
            {bulkMode ? 'Cancel select' : 'Select'}
          </button>
        )}

        <button
          onClick={() => setShowKeyboardHelp(true)}
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </button>

        {!disabled && selectedCollection !== ALL_COL && (
          showAddCollection ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddCollection(); if (e.key === 'Escape') setShowAddCollection(false); }}
                placeholder="Collection name..."
                className="rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60 w-40"
              />
              <button
                onClick={handleAddCollection}
                disabled={!newCollectionName.trim()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-all"
              >
                <Check className="h-3 w-3" /> Create
              </button>
              <button onClick={() => { setShowAddCollection(false); setNewCollectionName(''); }}
                className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddCollection(true)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <FolderPlus className="h-3 w-3" /> Add Collection
            </button>
          )
        )}
      </div>

      {/* Bulk action bar */}
      {bulkMode && selectedIds.size > 0 && (
        <div className="px-5 py-2 bg-primary/5 border-b border-primary/20 flex items-center gap-3 text-xs">
          <span className="text-primary font-medium">{selectedIds.size} selected</span>
          <button
            onClick={() => setMoveTarget({ ids: [...selectedIds] })}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
          >
            <MoveRight className="h-3 w-3" /> Move
          </button>
          <button
            onClick={handleBulkDelete}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      )}

      {/* Messages */}
      {success && (
        <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] flex items-center gap-1.5">
          <Check className="h-3 w-3" /> {success}
        </div>
      )}
      {error && (
        <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20 flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" /> {error}
        </div>
      )}

      {/* Body */}
      {collectionsLoading ? (
        <div className="px-5 py-8 text-center">
          <p className="text-xs text-muted-foreground font-mono">Loading collections...</p>
        </div>
      ) : collections.length === 0 && !showAddCollection ? (
        <div className="px-5 py-8 text-center">
          <p className="text-xs text-muted-foreground font-mono">No collections found.</p>
          <p className="text-xs text-muted-foreground font-mono mt-1">Create a collection to start adding items.</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(ev) => {
            const id = ev.active?.id || '';
            if (id.startsWith('col:')) handleCollectionDragEnd(ev);
            else if (id.startsWith('item:')) handleItemDragEnd(ev);
            else if (id.startsWith('photo:')) handlePhotoDragEnd(ev);
          }}
        >
          <div className="flex" style={{ minHeight: '400px' }}>
            {/* Collections sidebar (sortable + drop targets) */}
            <div className="w-56 border-r border-border/40 overflow-y-auto flex-shrink-0 bg-card">
              {/* All Collections shortcut */}
              <button
                onClick={() => selectCollection(ALL_COL)}
                className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors flex items-center gap-2 border-b border-border/30 ${
                  selectedCollection === ALL_COL
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                <span className="font-mono">☰</span> All Collections
              </button>
              <SortableContext
                items={collections.map(c => `col:${c.name}`)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="py-1">
                  {collections.map(col => (
                    renaming?.kind === 'collection' && renaming.original === col.name ? (
                      <li key={col.name} className="px-3 py-1.5">
                        <input
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameCollection(col.name, renaming.value);
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => handleRenameCollection(col.name, renaming.value)}
                          className="w-full rounded-md border border-primary/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
                        />
                      </li>
                    ) : (
                      <SortableCollectionRow
                        key={col.name}
                        col={col}
                        isSelected={selectedCollection === col.name}
                        isDropTarget={false}
                        disabled={disabled}
                        onSelect={selectCollection}
                        onDelete={handleDeleteCollection}
                        onStartRename={(name) => setRenaming({ kind: 'collection', original: name, value: name })}
                      />
                    )
                  ))}
                </ul>
              </SortableContext>
            </div>

            {/* Main content */}
            <div className="flex-1 overflow-y-auto">
              {!selectedCollection ? (
                <div className="flex-1 flex items-center justify-center h-full text-xs text-muted-foreground font-mono py-12">
                  Select a collection to view items, or use All Collections
                </div>
              ) : itemsLoading ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-xs text-muted-foreground font-mono">Loading items...</p>
                </div>
              ) : (
                <div className="p-5">
                  {/* Collection header */}
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      {renaming?.kind === 'collection-header' ? (
                        <input
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameCollection(selectedCollection, renaming.value);
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => handleRenameCollection(selectedCollection, renaming.value)}
                          className="rounded-md border border-primary/60 bg-input px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary/60"
                        />
                      ) : (
                        <>
                          <h3 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>{selectedCollection === ALL_COL ? 'All Collections' : selectedCollection}</h3>
                          {!disabled && selectedCollection !== ALL_COL && (
                            <button
                              onClick={() => setRenaming({ kind: 'collection-header', original: selectedCollection, value: selectedCollection })}
                              className="text-muted-foreground hover:text-primary transition-colors"
                              title="Rename collection"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </>
                      )}
                      <span className="text-xs text-muted-foreground font-mono">({visibleItems.length}{search.trim() ? ` of ${items.length}` : ''} items)</span>
                    </div>
                    {!disabled && selectedCollection !== ALL_COL && (
                      showAddItem ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            value={newItemName}
                            onChange={(e) => setNewItemName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleAddItem(); if (e.key === 'Escape') setShowAddItem(false); }}
                            placeholder="Item name..."
                            className="rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60 w-36"
                          />
                          <button
                            onClick={handleAddItem}
                            disabled={!newItemName.trim()}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-all"
                          >
                            <Check className="h-3 w-3" /> Add
                          </button>
                          <button onClick={() => { setShowAddItem(false); setNewItemName(''); }}
                            className="text-muted-foreground hover:text-foreground transition-colors">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowAddItem(true)}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                          <Plus className="h-3 w-3" /> Add Item
                        </button>
                      )
                    )}
                  </div>

                  {/* Items grid */}
                  {visibleItems.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-xs text-muted-foreground font-mono">
                        {search.trim() ? 'No items match your search.' : 'No items in this collection.'}
                      </p>
                    </div>
                  ) : selectedCollection === ALL_COL ? (
                    /* All Collections grouped view */
                    (() => {
                      const seen = new Map();
                      for (const item of visibleItems) {
                        const col = item.collectionName || '';
                        if (!seen.has(col)) seen.set(col, []);
                        seen.get(col).push(item);
                      }
                      const groups = [...seen.entries()].sort((a, b) => {
                        const ai = collections.findIndex(c => c.name === a[0]);
                        const bi = collections.findIndex(c => c.name === b[0]);
                        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
                      });
                      return (
                        <div className="space-y-6 mb-4">
                          {groups.map(([col, groupItems]) => (
                            <div key={col}>
                              <div className="flex items-center gap-2 mb-3">
                                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground/70" style={{ fontFamily: 'Syne, sans-serif' }}>{col}</h4>
                                <span className="text-[10px] text-muted-foreground/50 font-mono">({groupItems.length})</span>
                                <div className="flex-1 border-t border-border/30" />
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 group">
                                {groupItems.map(item => {
                                  const issues = validateItem({
                                    details: { 'Name.txt': item.name, 'ItemCost.txt': item.price, 'Description.txt': item.description || '' },
                                    photos: item.thumbnailFile ? [{ name: item.thumbnailFile.split('/').pop() }] : [],
                                  });
                                  return (
                                    <DraggableItemCard
                                      key={item.basePath}
                                      item={item}
                                      slug={slug}
                                      photoTimestamps={photoTimestamps}
                                      isExpanded={editingItem === item.basePath}
                                      isSelected={false}
                                      bulkMode={false}
                                      disabled={disabled}
                                      validationIssues={issues}
                                      onClick={() => editingItem === item.basePath ? setEditingItem(null) : loadItemDetails(item)}
                                      onToggleSelect={() => {}}
                                      onKebab={(e) => {
                                        e.stopPropagation();
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setKebabPos({ x: rect.right, y: rect.bottom });
                                        setKebabFor(kebabFor === item.dirName ? null : item.dirName);
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4 group">
                      {visibleItems.map(item => {
                        const issues = validateItem({
                          details: { 'Name.txt': item.name, 'ItemCost.txt': item.price, 'Description.txt': item.description || '' },
                          photos: item.thumbnailFile ? [{ name: item.thumbnailFile.split('/').pop() }] : [],
                        });
                        return (
                          <DraggableItemCard
                            key={item.basePath}
                            item={item}
                            slug={slug}
                            photoTimestamps={photoTimestamps}
                            isExpanded={editingItem === item.basePath}
                            isSelected={selectedIds.has(item.dirName)}
                            bulkMode={bulkMode}
                            disabled={disabled}
                            validationIssues={issues}
                            onClick={() => editingItem === item.basePath ? setEditingItem(null) : loadItemDetails(item)}
                            onToggleSelect={() => {
                              setSelectedIds(prev => {
                                const next = new Set(prev);
                                if (next.has(item.dirName)) next.delete(item.dirName); else next.add(item.dirName);
                                return next;
                              });
                            }}
                            onKebab={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setKebabPos({ x: rect.right, y: rect.bottom });
                              setKebabFor(kebabFor === item.dirName ? null : item.dirName);
                            }}
                          />
                        );
                      })}
                    </div>
                  )}

                  {/* Item kebab menu */}
                  {kebabFor && !disabled && (() => {
                    const item = items.find(i => i.dirName === kebabFor);
                    if (!item) return null;
                    return (
                      <div
                        className="fixed z-40 lp-card rounded-md w-44 py-1 lp-fadein"
                        style={{ top: kebabPos.y + 4, left: Math.min(kebabPos.x - 176, window.innerWidth - 184) }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => { setRenaming({ kind: 'item', original: item.dirName, value: item.dirName }); setKebabFor(null); }}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center gap-2"
                        ><Pencil className="h-3 w-3" /> Rename</button>
                        <button
                          onClick={() => { handleDuplicateItem(item); setKebabFor(null); }}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center gap-2"
                        ><Copy className="h-3 w-3" /> Duplicate</button>
                        <button
                          onClick={() => { setMoveTarget({ ids: [item.dirName] }); setKebabFor(null); }}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center gap-2"
                        ><MoveRight className="h-3 w-3" /> Move to...</button>
                        <button
                          onClick={() => { handleDeleteItem(item); setKebabFor(null); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 flex items-center gap-2"
                        ><Trash2 className="h-3 w-3" /> Delete</button>
                      </div>
                    );
                  })()}

                  {/* Expanded item editor */}
                  {editingItem && (
                    <div className="border-t border-border/40 pt-5 mt-2">
                      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          {renaming?.kind === 'item' && renaming.original === items.find(i=>i.basePath===editingItem)?.dirName ? (
                            <input
                              autoFocus
                              value={renaming.value}
                              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRenameItem(editingItem, renaming.value);
                                if (e.key === 'Escape') setRenaming(null);
                              }}
                              onBlur={() => handleRenameItem(editingItem, renaming.value)}
                              className="rounded-md border border-primary/60 bg-input px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary/60"
                            />
                          ) : (
                            <>
                              <h4 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
                                Editing: {itemDetails['Name.txt'] || editingItem}
                              </h4>
                              {!disabled && (
                                <button
                                  onClick={() => setRenaming({ kind: 'item', original: editingItem, value: editingItem })}
                                  className="text-muted-foreground hover:text-primary transition-colors"
                                  title="Rename item"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}
                            </>
                          )}
                          {editingItemValidation.length > 0 && !itemDetailsLoading && (
                            <div className="flex flex-wrap gap-1">
                              {editingItemValidation.map(v => (
                                <span key={v} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20">
                                  {v}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {autoSaveStatus === 'saving' && (
                            <span className="text-[10px] text-muted-foreground font-mono">saving...</span>
                          )}
                          {autoSaveStatus === 'saved' && (
                            <span className="text-[10px] text-[hsl(142,70%,50%)] font-mono flex items-center gap-1">
                              <Check className="h-2.5 w-2.5" /> saved
                            </span>
                          )}
                          {isAnyDirty && autoSaveStatus !== 'saving' && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" title="Unsaved changes" />
                          )}
                          {!disabled && (
                            <button
                              onClick={() => handleDeleteItem(items.find(i => i.basePath === editingItem))}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-all"
                            >
                              <Trash2 className="h-3 w-3" /> Delete
                            </button>
                          )}
                          <button
                            onClick={() => setEditingItem(null)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Left: detail fields */}
                        <div className="space-y-4">
                          {orderedDetailFiles().map(fileName => {
                            const field = DETAIL_FIELDS[fileName] || { type: 'text', label: friendlyLabel(fileName) };
                            const isDirty = itemDetails[fileName] !== itemOriginal[fileName];
                            const isDescription = fileName === 'Description.txt';
                            return (
                              <div key={fileName}>
                                <div className="flex items-center justify-between mb-1.5">
                                  <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
                                  <div className="flex items-center gap-2">
                                    {isDescription && (
                                      <button
                                        onClick={() => setDescPreview(p => !p)}
                                        className="text-[10px] text-muted-foreground hover:text-primary inline-flex items-center gap-1 transition-colors"
                                        title={descPreview ? 'Edit' : 'Preview markdown'}
                                      >
                                        {descPreview ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                                        {descPreview ? 'Edit' : 'Preview'}
                                      </button>
                                    )}
                                    <span className="text-[10px] text-muted-foreground font-mono opacity-50">{fileName}</span>
                                  </div>
                                </div>
                                {isDescription && descPreview ? (
                                  <div
                                    className="rounded-md border border-border/60 bg-input px-3 py-2 text-sm leading-relaxed prose prose-invert prose-sm max-w-none"
                                    dangerouslySetInnerHTML={{ __html: renderMarkdown(itemDetails[fileName] || '') }}
                                  />
                                ) : (
                                  <div className="flex items-center gap-2">
                                    {field.prefix && (
                                      <span className="text-xs font-mono text-muted-foreground">{field.prefix}</span>
                                    )}
                                    {field.type === 'textarea' ? (
                                      <textarea
                                        disabled={disabled}
                                        value={itemDetails[fileName] ?? ''}
                                        onChange={(e) => setItemDetails(prev => ({ ...prev, [fileName]: e.target.value }))}
                                        className="flex-1 rounded-md border border-border/60 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all resize-y leading-relaxed disabled:opacity-50"
                                        rows={field.rows || 2}
                                      />
                                    ) : (
                                      <input
                                        type="text"
                                        disabled={disabled}
                                        value={itemDetails[fileName] ?? ''}
                                        onChange={(e) => setItemDetails(prev => ({ ...prev, [fileName]: e.target.value }))}
                                        className={`flex-1 rounded-md border border-border/60 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all disabled:opacity-50 ${field.mono ? 'font-mono' : ''}`}
                                      />
                                    )}
                                  </div>
                                )}
                                {isDirty && (
                                  <span className="text-[10px] text-amber-400 font-mono">unsaved — auto-saving</span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* Right: photos (sortable + drag-to-upload) */}
                        <div
                          className={`relative rounded-lg transition-all ${photoDropActive ? 'ring-2 ring-primary/40 bg-primary/5' : ''}`}
                          {...photoDragHandlers}
                        >
                          <div className="flex items-center justify-between mb-3">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Photos ({itemPhotos.length})</p>
                            <div className="flex items-center gap-2">
                              {!disabled && (
                                <button
                                  onClick={() => photoUploadRef.current?.click()}
                                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                                >
                                  <Upload className="h-3 w-3" /> Upload
                                </button>
                              )}
                              <span className="text-[10px] text-muted-foreground/60">drag &amp; drop or click</span>
                            </div>
                            <input
                              ref={photoUploadRef}
                              type="file"
                              accept="image/*"
                              multiple
                              className="hidden"
                              onChange={handlePhotoUpload}
                            />
                          </div>
                          {itemPhotos.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-6 text-center">
                              <ImageIcon className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                              <p className="text-xs text-muted-foreground font-mono">No photos yet</p>
                              {!disabled && (
                                <button
                                  onClick={() => photoUploadRef.current?.click()}
                                  className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 mt-2 transition-colors"
                                >
                                  <Upload className="h-3 w-3" /> Upload photos
                                </button>
                              )}
                            </div>
                          ) : (
                            <SortableContext
                              items={itemPhotos.map(p => `photo:${p.path}`)}
                              strategy={rectSortingStrategy}
                            >
                              <div className="grid grid-cols-2 gap-2">
                                {itemPhotos.map(photo => {
                                  const ts = photoTimestamps[photo.path];
                                  const isMain = /^main\.(jpg|jpeg|png|webp)$/i.test(photo.name);
                                  if (renaming?.kind === 'photo' && renaming.original === photo.path) {
                                    return (
                                      <div key={photo.path} className="rounded-md border border-primary/40 p-2">
                                        <input
                                          autoFocus
                                          value={renaming.value}
                                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleRenamePhoto(photo, renaming.value);
                                            if (e.key === 'Escape') setRenaming(null);
                                          }}
                                          onBlur={() => handleRenamePhoto(photo, renaming.value)}
                                          className="w-full rounded-md border border-border/60 bg-input px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary/60"
                                        />
                                      </div>
                                    );
                                  }
                                  return (
                                    <SortablePhoto
                                      key={photo.path}
                                      photo={photo}
                                      slug={slug}
                                      isMain={isMain}
                                      ts={ts}
                                      disabled={disabled}
                                      onSetMain={handleSetMainPhoto}
                                      onRename={(p) => setRenaming({ kind: 'photo', original: p.path, value: p.name })}
                                      onDelete={handlePhotoDelete}
                                      onReplace={handlePhotoReplace}
                                    />
                                  );
                                })}
                              </div>
                            </SortableContext>
                          )}
                          {photoDropActive && (
                            <div className="absolute inset-0 rounded-lg border-2 border-dashed border-primary/60 bg-primary/10 flex items-center justify-center pointer-events-none">
                              <p className="text-xs text-primary font-mono">Drop images to upload</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </DndContext>
      )}

      {moveTarget && (
        <MoveItemModal
          collections={collections}
          currentCollection={selectedCollection}
          count={moveTarget.ids.length}
          onCancel={() => setMoveTarget(null)}
          onConfirm={(target) => handleMoveItems(target, moveTarget.ids)}
        />
      )}

      {showKeyboardHelp && <KeyboardOverlay onClose={() => setShowKeyboardHelp(false)} />}
    </div>
  );
}
