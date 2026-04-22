import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronUp, ChevronDown, Plus, Trash2, Save, ToggleLeft, ToggleRight, GripVertical } from 'lucide-react';
import { getCheckoutSchema, saveCheckoutSchema } from '@/lib/api';

const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox'];
const WIDTH_OPTIONS = ['half', 'full'];

function FieldRow({ field, onUpdate, onDelete, onMove, isFirst, isLast }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-border/40 rounded-lg bg-background/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"><ChevronUp size={14} /></button>
          <button onClick={() => onMove(1)} disabled={isLast} className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"><ChevronDown size={14} /></button>
        </div>
        <span className="flex-1 text-sm font-mono truncate text-foreground">{field.label || field.id}</span>
        <span className="text-xs font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">{field.type}</span>
        <span className="text-xs text-muted-foreground">{field.width}</span>
        <button onClick={() => setExpanded(e => !e)} className="text-xs text-primary hover:underline ml-1">{expanded ? 'close' : 'edit'}</button>
        <button onClick={onDelete} className="text-destructive hover:text-destructive/80 transition-colors ml-1"><Trash2 size={13} /></button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-2 border-t border-border/30 pt-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Label</label>
            <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50" value={field.label} onChange={e => onUpdate({ label: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Field ID</label>
            <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono" value={field.id} onChange={e => onUpdate({ id: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Type</label>
            <select className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none" value={field.type} onChange={e => onUpdate({ type: e.target.value })}>
              {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Width</label>
            <select className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none" value={field.width} onChange={e => onUpdate({ width: e.target.value })}>
              {WIDTH_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-muted-foreground mb-1">Placeholder</label>
            <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50" value={field.placeholder || ''} onChange={e => onUpdate({ placeholder: e.target.value })} />
          </div>
          {field.type === 'select' && (
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Options (one per line)</label>
              <textarea className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none font-mono" rows={3} value={(field.options || []).join('\n')} onChange={e => onUpdate({ options: e.target.value.split('\n').filter(Boolean) })} />
            </div>
          )}
          <div className="col-span-2 flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={!!field.required} onChange={e => onUpdate({ required: e.target.checked })} className="rounded" />
              Required
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function FreightSection({ section, onUpdate, onMove, isFirst, isLast }) {
  const [open, setOpen] = useState(true);

  const updateOwnField = (idx, patch) => {
    const updated = section.ownFields.map((f, i) => i === idx ? { ...f, ...patch } : f);
    onUpdate({ ownFields: updated });
  };
  const moveOwnField = (idx, dir) => {
    const arr = [...section.ownFields];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    onUpdate({ ownFields: arr });
  };
  const deleteOwnField = (idx) => {
    onUpdate({ ownFields: section.ownFields.filter((_, i) => i !== idx) });
  };
  const addOwnField = () => {
    onUpdate({ ownFields: [...(section.ownFields || []), { id: `field_${Date.now()}`, label: 'New Field', type: 'text', required: true, width: 'full', placeholder: '' }] });
  };

  return (
    <div className="border border-border/60 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-muted/30">
        <div className="flex flex-col gap-0.5">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronUp size={15} /></button>
          <button onClick={() => onMove(1)} disabled={isLast} className="text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronDown size={15} /></button>
        </div>
        <button onClick={() => onUpdate({ enabled: !section.enabled })} className="transition-colors">
          {section.enabled ? <ToggleRight size={18} className="text-primary" /> : <ToggleLeft size={18} className="text-muted-foreground" />}
        </button>
        <span className="flex-1 font-semibold text-sm text-foreground">{section.title} <span className="text-xs font-mono text-muted-foreground ml-1">freight</span></span>
        <button onClick={() => setOpen(o => !o)} className="text-xs text-primary hover:underline">{open ? 'collapse' : 'expand'}</button>
      </div>
      {open && section.enabled && (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">LR Paris Option Label</label>
              <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none" value={section.lrOption?.label || ''} onChange={e => onUpdate({ lrOption: { ...section.lrOption, label: e.target.value } })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">LR Paris Option Description</label>
              <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none" value={section.lrOption?.description || ''} onChange={e => onUpdate({ lrOption: { ...section.lrOption, description: e.target.value } })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Own Freight Label</label>
              <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none" value={section.ownOption?.label || ''} onChange={e => onUpdate({ ownOption: { ...section.ownOption, label: e.target.value } })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Own Freight Description</label>
              <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none" value={section.ownOption?.description || ''} onChange={e => onUpdate({ ownOption: { ...section.ownOption, description: e.target.value } })} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Own Freight Fields</span>
              <button onClick={addOwnField} className="flex items-center gap-1 text-xs text-primary hover:underline"><Plus size={12} /> Add Field</button>
            </div>
            <div className="space-y-2">
              {(section.ownFields || []).map((f, i) => (
                <FieldRow key={f.id + i} field={f} onUpdate={p => updateOwnField(i, p)} onDelete={() => deleteOwnField(i)} onMove={d => moveOwnField(i, d)} isFirst={i === 0} isLast={i === section.ownFields.length - 1} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldsSection({ section, onUpdate, onMove, isFirst, isLast }) {
  const [open, setOpen] = useState(true);

  const updateField = (idx, patch) => {
    const updated = section.fields.map((f, i) => i === idx ? { ...f, ...patch } : f);
    onUpdate({ fields: updated });
  };
  const moveField = (idx, dir) => {
    const arr = [...section.fields];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    onUpdate({ fields: arr });
  };
  const deleteField = (idx) => {
    onUpdate({ fields: section.fields.filter((_, i) => i !== idx) });
  };
  const addField = () => {
    onUpdate({ fields: [...(section.fields || []), { id: `field_${Date.now()}`, label: 'New Field', type: 'text', required: false, width: 'half', placeholder: '' }] });
  };

  return (
    <div className="border border-border/60 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-muted/30">
        <div className="flex flex-col gap-0.5">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronUp size={15} /></button>
          <button onClick={() => onMove(1)} disabled={isLast} className="text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronDown size={15} /></button>
        </div>
        <button onClick={() => onUpdate({ enabled: !section.enabled })} className="transition-colors">
          {section.enabled ? <ToggleRight size={18} className="text-primary" /> : <ToggleLeft size={18} className="text-muted-foreground" />}
        </button>
        <span className="flex-1 font-semibold text-sm text-foreground">{section.title}</span>
        <button onClick={() => setOpen(o => !o)} className="text-xs text-primary hover:underline">{open ? 'collapse' : 'expand'}</button>
      </div>
      {open && section.enabled && (
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Section Title</label>
              <input className="w-full text-sm border border-border/50 rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50" value={section.title} onChange={e => onUpdate({ title: e.target.value })} />
            </div>
          </div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fields</span>
            <button onClick={addField} className="flex items-center gap-1 text-xs text-primary hover:underline"><Plus size={12} /> Add Field</button>
          </div>
          <div className="space-y-2">
            {(section.fields || []).map((f, i) => (
              <FieldRow key={f.id + i} field={f} onUpdate={p => updateField(i, p)} onDelete={() => deleteField(i)} onMove={d => moveField(i, d)} isFirst={i === 0} isLast={i === section.fields.length - 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CheckoutEditor() {
  const { slug } = useParams();
  const queryClient = useQueryClient();
  const [localSchema, setLocalSchema] = useState(null);
  const [dirty, setDirty] = useState(false);

  const { data: schema, isLoading } = useQuery({
    queryKey: ['checkout-schema', slug],
    queryFn: () => getCheckoutSchema(slug),
  });

  useEffect(() => {
    if (schema && !dirty) setLocalSchema(JSON.parse(JSON.stringify(schema)));
  }, [schema]);

  const saveMutation = useMutation({
    mutationFn: (s) => saveCheckoutSchema(slug, s),
    onSuccess: () => {
      queryClient.invalidateQueries(['checkout-schema', slug]);
      setDirty(false);
    },
  });

  const updateSection = (idx, patch) => {
    setLocalSchema(prev => {
      const sections = prev.sections.map((s, i) => i === idx ? { ...s, ...patch } : s);
      return { ...prev, sections };
    });
    setDirty(true);
  };

  const moveSection = (idx, dir) => {
    setLocalSchema(prev => {
      const arr = [...prev.sections];
      const target = idx + dir;
      if (target < 0 || target >= arr.length) return prev;
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return { ...prev, sections: arr };
    });
    setDirty(true);
  };

  const addSection = () => {
    setLocalSchema(prev => ({
      ...prev,
      sections: [...prev.sections, {
        id: `section_${Date.now()}`,
        title: 'New Section',
        type: 'fields',
        enabled: true,
        fields: [],
      }]
    }));
    setDirty(true);
  };

  if (isLoading || !localSchema) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-16 bg-muted rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to={`/shops/${slug}/settings`} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">Checkout Editor</h1>
            <p className="text-xs text-muted-foreground font-mono">{slug}</p>
          </div>
        </div>
        <button
          onClick={() => saveMutation.mutate(localSchema)}
          disabled={!dirty || saveMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: dirty ? 'hsl(var(--primary))' : undefined, color: dirty ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))', border: dirty ? 'none' : '1px solid hsl(var(--border))' }}
        >
          <Save size={14} />
          {saveMutation.isPending ? 'Saving...' : dirty ? 'Save Changes' : 'Saved'}
        </button>
      </div>

      <div className="space-y-4">
        {localSchema.sections.map((section, idx) => (
          section.type === 'freight'
            ? <FreightSection key={section.id} section={section} onUpdate={p => updateSection(idx, p)} onMove={d => moveSection(idx, d)} isFirst={idx === 0} isLast={idx === localSchema.sections.length - 1} />
            : <FieldsSection key={section.id} section={section} onUpdate={p => updateSection(idx, p)} onMove={d => moveSection(idx, d)} isFirst={idx === 0} isLast={idx === localSchema.sections.length - 1} />
        ))}
      </div>

      <button onClick={addSection} className="mt-4 w-full border-2 border-dashed border-border/50 rounded-xl py-3 flex items-center justify-center gap-2 text-sm text-muted-foreground hover:border-primary/40 hover:text-primary transition-all">
        <Plus size={15} /> Add Section
      </button>

      {dirty && (
        <div className="fixed bottom-6 right-6 flex items-center gap-3 bg-card border border-border shadow-lg rounded-xl px-4 py-3">
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
          <button onClick={() => saveMutation.mutate(localSchema)} disabled={saveMutation.isPending} className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}
