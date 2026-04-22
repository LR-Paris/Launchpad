import { useState, useEffect, useRef } from 'react';
import { Save, Eye, EyeOff, Copy, Upload, Check } from 'lucide-react';
import { getShopImageUrl } from '../lib/api';

const HIDDEN_FILES = new Set(['readme.md', 'readme.txt', '.gitkeep', '.ds_store']);

function isKeyValueFile(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;
  const kvLines = lines.filter(l => l.includes(':'));
  return kvLines.length / lines.length >= 0.5;
}

function parseKeyValue(content) {
  return content.trim().split('\n')
    .filter(l => l.trim())
    .map(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return { key: line.trim(), value: '' };
      return { key: line.substring(0, idx).trim(), value: line.substring(idx + 1).trim() };
    });
}

function reconstructKeyValue(pairs) {
  return pairs.map(p => `${p.key}: ${p.value}`).join('\n') + '\n';
}

function getFieldType(key, value) {
  const v = value.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(v)) return 'color';
  if (/corner\s*radius|borderRadius/i.test(key)) return 'cornerRadius';
  return 'text';
}

function friendlyLabel(filename) {
  const name = filename.replace(/\.[^.]+$/, '');
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim();
}

export default function KeyValueEditor({
  slug,
  entries,
  basePath,
  values,
  originalValues,
  onValueChange,
  onSave,
  saving,
  onImageReplace,
  replacingImage,
  imageTimestamps,
  hiddenFiles = [],
}) {
  const [passwordShown, setPasswordShown] = useState({});
  const imageInputRefs = useRef({});

  const allHidden = new Set([...HIDDEN_FILES, ...hiddenFiles.map(f => f.toLowerCase())]);
  const visibleEntries = entries.filter(e => !e.isDirectory && !allHidden.has(e.name.toLowerCase()));
  const textEntries = visibleEntries.filter(e => e.readable);
  const imageEntries = visibleEntries.filter(e => e.isImage);

  return (
    <div className="p-5 space-y-6">
      {textEntries.map(entry => {
        const filePath = `${basePath}/${entry.name}`;
        const content = values[filePath] ?? '';
        const original = originalValues[filePath] ?? '';
        const isDirty = content !== original;
        const isSaving = saving[filePath];
        const label = friendlyLabel(entry.name);
        const isPassword = /password/i.test(entry.name);
        const useKV = isKeyValueFile(content);

        if (useKV) {
          const pairs = parseKeyValue(content);
          const updatePair = (idx, newValue) => {
            const updated = pairs.map((p, i) => i === idx ? { ...p, value: newValue } : p);
            onValueChange(filePath, reconstructKeyValue(updated));
          };
          const updatePairFromPicker = (idx, hexColor) => {
            const updated = pairs.map((p, i) => i === idx ? { ...p, value: hexColor.toUpperCase() } : p);
            onValueChange(filePath, reconstructKeyValue(updated));
          };

          return (
            <div key={entry.name}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>{label}</h3>
                <span className="text-[10px] text-muted-foreground font-mono opacity-60">{entry.name}</span>
              </div>
              <div className="space-y-2.5 rounded-lg border border-border/40 bg-muted/20 p-4">
                {pairs.map((pair, idx) => {
                  const fieldType = getFieldType(pair.key, pair.value);
                  return (
                    <div key={idx} className="flex items-center gap-3">
                      <label className="text-xs font-medium text-muted-foreground w-28 flex-shrink-0 text-right font-mono">
                        {pair.key}
                      </label>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <input
                          type="text"
                          value={pair.value}
                          onChange={(e) => updatePair(idx, e.target.value)}
                          className="flex-1 rounded-md border border-border/60 bg-input px-3 py-1.5 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
                        />
                        {fieldType === 'color' && (
                          <>
                            <input
                              type="color"
                              value={pair.value}
                              onChange={(e) => updatePairFromPicker(idx, e.target.value)}
                              className="w-8 h-8 rounded border border-border/60 cursor-pointer bg-transparent p-0.5"
                              title="Pick color"
                            />
                            <div
                              className="w-6 h-6 rounded border border-border/40 flex-shrink-0"
                              style={{ backgroundColor: pair.value }}
                              title={pair.value}
                            />
                          </>
                        )}
                        {fieldType === 'cornerRadius' && (
                          <div
                            className="w-10 h-10 border-2 border-primary/60 bg-primary/10 flex-shrink-0 transition-all"
                            style={{ borderRadius: `${pair.value}px` }}
                            title={`${pair.value}px radius`}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 mt-2">
                {isDirty && <span className="text-xs text-amber-400 font-mono">unsaved changes</span>}
                <div className="flex-1" />
                <button
                  onClick={() => onSave(filePath)}
                  disabled={!isDirty || isSaving}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <Save className="h-3 w-3" />
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          );
        }

        // Simple single-value file
        const pwVisible = passwordShown[filePath];
        return (
          <div key={entry.name}>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium" style={{ fontFamily: 'Syne, sans-serif' }}>{label}</label>
              <span className="text-[10px] text-muted-foreground font-mono opacity-60">{entry.name}</span>
            </div>
            {isPassword ? (
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={pwVisible ? 'text' : 'password'}
                    value={content}
                    onChange={(e) => onValueChange(filePath, e.target.value)}
                    className="w-full rounded-md border border-border/60 bg-input px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all pr-10"
                    placeholder="Enter password..."
                  />
                  <button
                    type="button"
                    onClick={() => setPasswordShown(prev => ({ ...prev, [filePath]: !prev[filePath] }))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary transition-colors"
                  >
                    {pwVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(content)}
                  className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0 p-2"
                  title="Copy"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <input
                type="text"
                value={content}
                onChange={(e) => onValueChange(filePath, e.target.value)}
                className="w-full rounded-md border border-border/60 bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/60 transition-all"
                placeholder={`Enter ${label.toLowerCase()}...`}
              />
            )}
            <div className="flex items-center gap-2 mt-2">
              {isDirty && <span className="text-xs text-amber-400 font-mono">unsaved changes</span>}
              <div className="flex-1" />
              <button
                onClick={() => onSave(filePath)}
                disabled={!isDirty || isSaving}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <Save className="h-3 w-3" />
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        );
      })}

      {/* Image files */}
      {imageEntries.length > 0 && (
        <div className="border-t border-border/40 pt-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Images</p>
          <div className="space-y-5">
            {imageEntries.map(entry => {
              const filePath = `${basePath}/${entry.name}`;
              const label = friendlyLabel(entry.name);
              const isReplacing = replacingImage === filePath;
              const ts = imageTimestamps[filePath];
              const imgUrl = getShopImageUrl(slug, filePath) + (ts ? `&_t=${ts}` : '');

              return (
                <div key={entry.name}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium" style={{ fontFamily: 'Syne, sans-serif' }}>{label}</label>
                    <span className="text-[10px] text-muted-foreground font-mono opacity-60">{entry.name}</span>
                  </div>
                  <div className="rounded-lg border border-border/40 bg-muted/30 p-4 flex flex-col items-center gap-3">
                    <img src={imgUrl} alt={label} className="max-h-40 max-w-full object-contain rounded-md border border-border/30" />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => imageInputRefs.current[filePath]?.click()}
                        disabled={isReplacing}
                        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all disabled:opacity-50"
                      >
                        <Upload className="h-3 w-3" />
                        {isReplacing ? 'Replacing...' : 'Replace Image'}
                      </button>
                      <input
                        ref={el => { imageInputRefs.current[filePath] = el; }}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0]) onImageReplace(filePath, e.target.files[0]);
                          e.target.value = '';
                        }}
                      />
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {entry.size > 1024 ? `${(entry.size / 1024).toFixed(1)} KB` : `${entry.size} B`}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">Max 1 GB</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
