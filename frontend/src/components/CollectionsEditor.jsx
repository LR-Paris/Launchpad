import { useState, useEffect, useRef } from 'react';
import {
  Folder, Plus, Trash2, Save, Upload, ImageIcon, X, ChevronRight,
  Package, FolderPlus, Check,
} from 'lucide-react';
import {
  listShopFiles, readShopFile, writeShopFile, deleteShopFile,
  uploadShopFiles, replaceShopFile, getShopImageUrl,
} from '../lib/api';

const DETAIL_FIELDS = {
  'Name.txt':        { type: 'text',     label: 'Name' },
  'Description.txt': { type: 'textarea', label: 'Description', rows: 3 },
  'SKU.txt':         { type: 'text',     label: 'SKU', mono: true },
  'ItemCost.txt':    { type: 'number',   label: 'Item Cost',     step: '0.01', prefix: '$' },
  'BoxCost.txt':     { type: 'number',   label: 'Box Cost',      step: '0.01', prefix: '$' },
  'UnitsPerBox.txt': { type: 'number',   label: 'Units Per Box', step: '1' },
};

const FIELD_ORDER = ['Name.txt', 'Description.txt', 'SKU.txt', 'ItemCost.txt', 'BoxCost.txt', 'UnitsPerBox.txt'];

function friendlyLabel(filename) {
  const name = filename.replace(/\.[^.]+$/, '');
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim();
}

export default function CollectionsEditor({ slug }) {
  // Collections list
  const [collections, setCollections] = useState([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState(null);

  // Items within selected collection
  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  // Expanded item editor
  const [editingItem, setEditingItem] = useState(null);
  const [itemDetails, setItemDetails] = useState({});
  const [itemOriginal, setItemOriginal] = useState({});
  const [itemPhotos, setItemPhotos] = useState([]);
  const [itemSaving, setItemSaving] = useState({});
  const [photoTimestamps, setPhotoTimestamps] = useState({});

  // Add dialogs
  const [showAddCollection, setShowAddCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [addingCollection, setAddingCollection] = useState(false);
  const [addingItem, setAddingItem] = useState(false);

  // Messages
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const photoUploadRef = useRef(null);
  const photoReplaceRefs = useRef({});

  // Load collections
  useEffect(() => {
    setCollectionsLoading(true);
    listShopFiles(slug, 'DATABASE/ShopCollections')
      .then(data => {
        const dirs = (data.entries || []).filter(e => e.isDirectory);
        setCollections(dirs);
        setCollectionsLoading(false);
      })
      .catch(() => {
        setCollections([]);
        setCollectionsLoading(false);
      });
  }, [slug]);

  // Load items when collection selected
  useEffect(() => {
    if (!selectedCollection) { setItems([]); return; }
    setItemsLoading(true);
    setEditingItem(null);
    const colPath = `DATABASE/ShopCollections/${selectedCollection}`;
    listShopFiles(slug, colPath)
      .then(async (data) => {
        const itemDirs = (data.entries || []).filter(e => e.isDirectory);
        const itemsData = await Promise.all(itemDirs.map(async (dir) => {
          const basePath = `${colPath}/${dir.name}`;
          let name = dir.name;
          let price = '';
          let thumbnailFile = null;
          try {
            const d = await readShopFile(slug, `${basePath}/Details/Name.txt`);
            name = d.content.trim() || dir.name;
          } catch {}
          try {
            const d = await readShopFile(slug, `${basePath}/Details/ItemCost.txt`);
            price = d.content.trim();
          } catch {}
          try {
            const photos = await listShopFiles(slug, `${basePath}/Photos`);
            const img = (photos.entries || []).find(e => e.isImage && e.name.toLowerCase().startsWith('main'));
            if (img) thumbnailFile = `${basePath}/Photos/${img.name}`;
          } catch {}
          return { dirName: dir.name, name, price, thumbnailFile, basePath };
        }));
        setItems(itemsData);
        setItemsLoading(false);
      })
      .catch(() => {
        setItems([]);
        setItemsLoading(false);
      });
  }, [slug, selectedCollection]);

  // Load full item details
  const loadItemDetails = async (item) => {
    setEditingItem(item.dirName);
    setItemSaving({});
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
      setItemPhotos(
        (photoListing.entries || [])
          .filter(e => e.isImage)
          .map(e => ({ name: e.name, path: `${photosPath}/${e.name}`, size: e.size }))
      );
    } catch {
      setItemPhotos([]);
    }
  };

  const saveItemDetail = async (fileName) => {
    const item = items.find(i => i.dirName === editingItem);
    if (!item) return;
    const filePath = `${item.basePath}/Details/${fileName}`;
    setItemSaving(prev => ({ ...prev, [fileName]: true }));
    setError('');
    try {
      await writeShopFile(slug, filePath, itemDetails[fileName]);
      setItemOriginal(prev => ({ ...prev, [fileName]: itemDetails[fileName] }));
      setSuccess(`${DETAIL_FIELDS[fileName]?.label || friendlyLabel(fileName)} saved.`);
      if (fileName === 'Name.txt' || fileName === 'ItemCost.txt') {
        setItems(prev => prev.map(i => {
          if (i.dirName !== editingItem) return i;
          return {
            ...i,
            name: fileName === 'Name.txt' ? itemDetails[fileName].trim() : i.name,
            price: fileName === 'ItemCost.txt' ? itemDetails[fileName].trim() : i.price,
          };
        }));
      }
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
    } finally {
      setItemSaving(prev => ({ ...prev, [fileName]: false }));
    }
  };

  const saveAllItemDetails = async () => {
    const dirtyFiles = Object.keys(itemDetails).filter(f => itemDetails[f] !== itemOriginal[f]);
    if (dirtyFiles.length === 0) return;
    const item = items.find(i => i.dirName === editingItem);
    if (!item) return;
    const savingState = {};
    dirtyFiles.forEach(f => { savingState[f] = true; });
    setItemSaving(savingState);
    setError('');
    try {
      await Promise.all(dirtyFiles.map(f =>
        writeShopFile(slug, `${item.basePath}/Details/${f}`, itemDetails[f])
      ));
      setItemOriginal({ ...itemDetails });
      setItems(prev => prev.map(i => {
        if (i.dirName !== editingItem) return i;
        return {
          ...i,
          name: itemDetails['Name.txt']?.trim() ?? i.name,
          price: itemDetails['ItemCost.txt']?.trim() ?? i.price,
        };
      }));
      setSuccess(`Saved ${dirtyFiles.length} field(s).`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
    } finally {
      setItemSaving({});
    }
  };

  const handleAddCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) return;
    setAddingCollection(true);
    setError('');
    try {
      await writeShopFile(slug, `DATABASE/ShopCollections/${name}/.gitkeep`, '');
      setCollections(prev => [...prev, { name, isDirectory: true }]);
      setSelectedCollection(name);
      setShowAddCollection(false);
      setNewCollectionName('');
      setSuccess(`Collection "${name}" created.`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create collection');
    } finally {
      setAddingCollection(false);
    }
  };

  const handleAddItem = async () => {
    const name = newItemName.trim();
    if (!name || !selectedCollection) return;
    setAddingItem(true);
    setError('');
    const basePath = `DATABASE/ShopCollections/${selectedCollection}/${name}`;
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
      setSuccess(`Item "${name}" created.`);
      setTimeout(() => setSuccess(''), 3000);
      loadItemDetails(newItem);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create item');
    } finally {
      setAddingItem(false);
    }
  };

  const handleDeleteItem = async (item) => {
    if (!window.confirm(`Delete item "${item.name}"? This removes all its files and photos.`)) return;
    setError('');
    try {
      await deleteShopFile(slug, item.basePath);
      setItems(prev => prev.filter(i => i.dirName !== item.dirName));
      if (editingItem === item.dirName) setEditingItem(null);
      setSuccess(`Item "${item.name}" deleted.`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete item');
    }
  };

  const handleDeleteCollection = async (colName) => {
    if (!window.confirm(`Delete collection "${colName}" and ALL its items? This cannot be undone.`)) return;
    setError('');
    try {
      await deleteShopFile(slug, `DATABASE/ShopCollections/${colName}`);
      setCollections(prev => prev.filter(c => c.name !== colName));
      if (selectedCollection === colName) {
        setSelectedCollection(null);
        setItems([]);
        setEditingItem(null);
      }
      setSuccess(`Collection "${colName}" deleted.`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete collection');
    }
  };

  const handlePhotoUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const item = items.find(i => i.dirName === editingItem);
    if (!item) return;
    const photosPath = `${item.basePath}/Photos`;
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    setError('');
    try {
      await uploadShopFiles(slug, photosPath, formData);
      const listing = await listShopFiles(slug, photosPath);
      setItemPhotos(
        (listing.entries || [])
          .filter(en => en.isImage)
          .map(en => ({ name: en.name, path: `${photosPath}/${en.name}`, size: en.size }))
      );
      setSuccess(`${files.length} photo(s) uploaded.`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
    } finally {
      if (photoUploadRef.current) photoUploadRef.current.value = '';
    }
  };

  const handlePhotoReplace = async (photo, file) => {
    if (!file) return;
    setError('');
    try {
      await replaceShopFile(slug, photo.path, file);
      setPhotoTimestamps(prev => ({ ...prev, [photo.path]: Date.now() }));
      setSuccess(`${photo.name} replaced.`);
      setTimeout(() => setSuccess(''), 3000);
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
      setSuccess(`${photo.name} deleted.`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete photo');
    }
  };

  const hasDirtyFields = editingItem && Object.keys(itemDetails).some(f => itemDetails[f] !== itemOriginal[f]);

  // Ordered detail fields: known fields first, then unknown
  const orderedDetailFiles = () => {
    const known = FIELD_ORDER.filter(f => f in itemDetails);
    const unknown = Object.keys(itemDetails).filter(f => !FIELD_ORDER.includes(f)).sort();
    return [...known, ...unknown];
  };

  return (
    <div className="lp-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
        <Package className="h-4 w-4 text-primary/70" />
        <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Product Catalog</h2>
        <span className="text-xs text-muted-foreground font-mono ml-1">Manage collections &amp; items</span>
        <div className="flex-1" />
        {showAddCollection ? (
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
              disabled={addingCollection || !newCollectionName.trim()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-all"
            >
              <Check className="h-3 w-3" /> {addingCollection ? '...' : 'Create'}
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
        )}
      </div>

      {/* Messages */}
      {success && (
        <div className="px-5 py-2 text-xs text-[hsl(142,70%,50%)] border-b border-[hsl(142,70%,20%)] bg-[hsl(142,70%,5%)] flex items-center gap-1.5">
          <Check className="h-3 w-3" /> {success}
        </div>
      )}
      {error && (
        <div className="px-5 py-2 text-xs text-destructive bg-destructive/5 border-b border-destructive/20">{error}</div>
      )}

      {/* Content */}
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
        <div className="flex" style={{ minHeight: '400px' }}>
          {/* Collections sidebar */}
          <div className="w-52 border-r border-border/40 overflow-y-auto flex-shrink-0 bg-card">
            <ul className="py-1">
              {collections.map(col => (
                <li key={col.name} className="group relative">
                  <button
                    onClick={() => setSelectedCollection(col.name)}
                    className={`w-full flex items-center gap-2 px-4 py-2 text-xs transition-colors pr-8 ${
                      selectedCollection === col.name
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-foreground/5 text-foreground'
                    }`}
                  >
                    <Folder className="h-3 w-3 flex-shrink-0 text-yellow-400/80" />
                    <span className="truncate">{col.name}</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteCollection(col.name); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    title="Delete collection"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Main content */}
          <div className="flex-1 overflow-y-auto">
            {!selectedCollection ? (
              <div className="flex-1 flex items-center justify-center h-full text-xs text-muted-foreground font-mono">
                Select a collection to view items
              </div>
            ) : itemsLoading ? (
              <div className="px-5 py-8 text-center">
                <p className="text-xs text-muted-foreground font-mono">Loading items...</p>
              </div>
            ) : (
              <div className="p-5">
                {/* Collection header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>{selectedCollection}</h3>
                    <span className="text-xs text-muted-foreground font-mono">({items.length} items)</span>
                  </div>
                  {showAddItem ? (
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
                        disabled={addingItem || !newItemName.trim()}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-all"
                      >
                        <Check className="h-3 w-3" /> {addingItem ? '...' : 'Add'}
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
                  )}
                </div>

                {/* Items grid */}
                {items.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-xs text-muted-foreground font-mono">No items in this collection.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                    {items.map(item => {
                      const isExpanded = editingItem === item.dirName;
                      return (
                        <button
                          key={item.dirName}
                          onClick={() => isExpanded ? setEditingItem(null) : loadItemDetails(item)}
                          className={`rounded-lg border p-3 text-left transition-all ${
                            isExpanded
                              ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                              : 'border-border/40 hover:border-primary/30 bg-card'
                          }`}
                        >
                          {item.thumbnailFile ? (
                            <img
                              src={getShopImageUrl(slug, item.thumbnailFile)}
                              alt={item.name}
                              className="w-full h-24 object-cover rounded-md mb-2 border border-border/30"
                            />
                          ) : (
                            <div className="w-full h-24 rounded-md mb-2 bg-muted/50 flex items-center justify-center border border-border/30">
                              <ImageIcon className="h-8 w-8 text-muted-foreground/30" />
                            </div>
                          )}
                          <p className="text-sm font-medium truncate" style={{ fontFamily: 'Syne, sans-serif' }}>
                            {item.name}
                          </p>
                          {item.price && (
                            <p className="text-xs text-primary font-mono mt-0.5">${item.price}</p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Expanded item editor */}
                {editingItem && (
                  <div className="border-t border-border/40 pt-5 mt-2">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
                        Editing: {itemDetails['Name.txt'] || editingItem}
                      </h4>
                      <div className="flex items-center gap-2">
                        {hasDirtyFields && (
                          <button
                            onClick={saveAllItemDetails}
                            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-all"
                          >
                            <Save className="h-3 w-3" /> Save All
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteItem(items.find(i => i.dirName === editingItem))}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-all"
                        >
                          <Trash2 className="h-3 w-3" /> Delete Item
                        </button>
                        <button
                          onClick={() => setEditingItem(null)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Left: Detail fields */}
                      <div className="space-y-4">
                        {orderedDetailFiles().map(fileName => {
                          const field = DETAIL_FIELDS[fileName] || { type: 'text', label: friendlyLabel(fileName) };
                          const isDirty = itemDetails[fileName] !== itemOriginal[fileName];
                          const isSaving = itemSaving[fileName];

                          return (
                            <div key={fileName}>
                              <div className="flex items-center justify-between mb-1.5">
                                <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
                                <span className="text-[10px] text-muted-foreground font-mono opacity-50">{fileName}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {field.prefix && (
                                  <span className="text-xs font-mono text-muted-foreground">{field.prefix}</span>
                                )}
                                {field.type === 'textarea' ? (
                                  <textarea
                                    value={itemDetails[fileName] ?? ''}
                                    onChange={(e) => setItemDetails(prev => ({ ...prev, [fileName]: e.target.value }))}
                                    className="flex-1 rounded-md border border-border/60 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all resize-y leading-relaxed"
                                    rows={field.rows || 2}
                                  />
                                ) : (
                                  <input
                                    type={field.type === 'number' ? 'text' : 'text'}
                                    value={itemDetails[fileName] ?? ''}
                                    onChange={(e) => setItemDetails(prev => ({ ...prev, [fileName]: e.target.value }))}
                                    className={`flex-1 rounded-md border border-border/60 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all ${field.mono ? 'font-mono' : ''}`}
                                  />
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                {isDirty && <span className="text-[10px] text-amber-400 font-mono">unsaved</span>}
                                <div className="flex-1" />
                                <button
                                  onClick={() => saveItemDetail(fileName)}
                                  disabled={!isDirty || isSaving}
                                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                                >
                                  <Save className="h-2.5 w-2.5" />
                                  {isSaving ? '...' : 'Save'}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Right: Photos */}
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Photos</p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => photoUploadRef.current?.click()}
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                            >
                              <Upload className="h-3 w-3" /> Upload
                            </button>
                            <span className="text-[10px] text-muted-foreground/60">Max 1 GB</span>
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
                            <button
                              onClick={() => photoUploadRef.current?.click()}
                              className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 mt-2 transition-colors"
                            >
                              <Upload className="h-3 w-3" /> Upload photos
                            </button>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            {itemPhotos.map(photo => {
                              const ts = photoTimestamps[photo.path];
                              const imgUrl = getShopImageUrl(slug, photo.path) + (ts ? `&_t=${ts}` : '');
                              return (
                                <div key={photo.name} className="relative group rounded-md border border-border/40 overflow-hidden">
                                  <img
                                    src={imgUrl}
                                    alt={photo.name}
                                    className="w-full h-28 object-cover"
                                  />
                                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                    <button
                                      onClick={() => photoReplaceRefs.current[photo.path]?.click()}
                                      className="rounded-md bg-white/20 backdrop-blur-sm px-2 py-1 text-[10px] text-white hover:bg-white/30 transition-colors"
                                    >
                                      Replace
                                    </button>
                                    <button
                                      onClick={() => handlePhotoDelete(photo)}
                                      className="rounded-md bg-red-500/40 backdrop-blur-sm px-2 py-1 text-[10px] text-white hover:bg-red-500/60 transition-colors"
                                    >
                                      Delete
                                    </button>
                                    <input
                                      ref={el => { photoReplaceRefs.current[photo.path] = el; }}
                                      type="file"
                                      accept="image/*"
                                      className="hidden"
                                      onChange={(e) => {
                                        if (e.target.files?.[0]) handlePhotoReplace(photo, e.target.files[0]);
                                        e.target.value = '';
                                      }}
                                    />
                                  </div>
                                  <div className="px-2 py-1 bg-card">
                                    <p className="text-[10px] font-mono text-muted-foreground truncate">{photo.name}</p>
                                  </div>
                                </div>
                              );
                            })}
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
      )}
    </div>
  );
}
