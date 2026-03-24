import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getUsers, getShops, createUserAccount, updateUserAccount, deleteUserAccount, setUserPermissions } from '../lib/api';
import { usePermissions } from '../lib/permissions';
import { ArrowLeft, Users, Plus, Trash2, Shield, ShieldCheck, User, Edit2, X, Check, ChevronDown, ChevronUp } from 'lucide-react';

const ROLE_DISPLAY = {
  super_admin: { label: 'Super Admin', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30', icon: ShieldCheck },
  admin: { label: 'Admin', cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30', icon: Shield },
  user: { label: 'User', cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30', icon: User },
};

const PERM_LABELS = {
  can_delete: { label: 'Delete', desc: 'Delete files, orders, shops' },
  can_edit_ui: { label: 'Edit Shop', desc: 'Access shop settings, files, and deploy' },
  can_edit_items: { label: 'Edit Items', desc: 'Edit catalog & inventory' },
  can_view_orders: { label: 'View Orders', desc: 'View & manage orders' },
};

function CreateUserModal({ shops, onClose, onCreated }) {
  const [form, setForm] = useState({ username: '', email: '', name: '', role: 'user' });
  const [shopPerms, setShopPerms] = useState({});
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data) => createUserAccount(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      onCreated?.();
      onClose();
    },
    onError: (err) => setError(err.response?.data?.error || 'Failed to create user'),
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    createMutation.mutate({
      ...form,
      shopPermissions: form.role === 'user' ? shopPerms : undefined,
    });
  };

  const togglePerm = (slug, perm) => {
    setShopPerms(prev => ({
      ...prev,
      [slug]: { ...prev[slug], [perm]: !prev[slug]?.[perm] },
    }));
  };

  const setAllPerms = (slug, value) => {
    setShopPerms(prev => ({
      ...prev,
      [slug]: { can_delete: value, can_edit_ui: value, can_edit_items: value, can_view_orders: value },
    }));
  };

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm">
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-xl border bg-card p-6 lp-fadein">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>Create User</h2>
            </div>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">Username</label>
                <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  className="w-full rounded-md border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 transition-all" required />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">Display Name</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-md border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 transition-all" required />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-muted-foreground">Email</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full rounded-md border bg-input px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/60 transition-all"
                placeholder="user@example.com" required />
              <p className="text-[10px] text-muted-foreground mt-1">Sign-in codes will be sent to this email.</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-muted-foreground">Role</label>
              <div className="flex rounded-lg border border-border/60 overflow-hidden">
                {['user', 'admin', 'super_admin'].map((r) => {
                  const rd = ROLE_DISPLAY[r];
                  return (
                    <button key={r} type="button" onClick={() => setForm(f => ({ ...f, role: r }))}
                      className={`flex-1 px-3 py-2 text-xs font-medium transition-all flex items-center justify-center gap-1.5 ${
                        form.role === r ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                      } ${r !== 'user' ? 'border-l border-border/60' : ''}`}>
                      <rd.icon className="h-3 w-3" />{rd.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                {form.role === 'super_admin' && 'Full access to everything including user management.'}
                {form.role === 'admin' && 'Full access to all shops. Cannot manage users.'}
                {form.role === 'user' && 'Access controlled by per-shop permissions below.'}
              </p>
            </div>
            {form.role === 'user' && shops.length > 0 && (
              <div>
                <label className="block text-xs font-medium mb-2 text-muted-foreground">Shop Permissions</label>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {shops.map(shop => {
                    const sp = shopPerms[shop.slug] || {};
                    const allOn = sp.can_delete && sp.can_edit_ui && sp.can_edit_items && sp.can_view_orders;
                    return (
                      <div key={shop.slug} className="rounded-lg border border-border/40 p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold">{shop.name}</span>
                          <button type="button" onClick={() => setAllPerms(shop.slug, !allOn)}
                            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-all ${
                              allOn ? 'bg-primary/15 text-primary border-primary/30' : 'text-muted-foreground border-border/40 hover:border-primary/30'
                            }`}>{allOn ? 'Full Access' : 'Grant All'}</button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(PERM_LABELS).map(([key, meta]) => (
                            <button key={key} type="button" onClick={() => togglePerm(shop.slug, key)} title={meta.desc}
                              className={`text-[10px] font-medium px-2 py-1 rounded border transition-all ${
                                sp[key] ? 'bg-primary/15 text-primary border-primary/30' : 'text-muted-foreground border-border/40 hover:border-primary/30'
                              }`}>{meta.label}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {error && <p className="text-xs text-destructive font-mono">{error}</p>}
            <div className="flex items-center gap-3 pt-2">
              <button type="submit" disabled={createMutation.isPending}
                className="btn-launch rounded-md px-5 py-2.5 text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {createMutation.isPending ? 'Creating...' : 'Create User'}
              </button>
              <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
}
function UserRow({ user: u, shops, currentUserId }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ username: u.username, email: u.email, name: u.name, role: u.role });
  const [shopPerms, setShopPerms] = useState(u.permissions || {});
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: (data) => updateUserAccount(u.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditing(false);
      setError('');
    },
    onError: (err) => setError(err.response?.data?.error || 'Failed to update user'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteUserAccount(u.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const permsMutation = useMutation({
    mutationFn: (perms) => setUserPermissions(u.id, perms),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const handleSave = () => {
    setError('');
    updateMutation.mutate({ ...editForm, shopPermissions: editForm.role === 'user' ? shopPerms : undefined });
  };

  const togglePerm = (slug, perm) => {
    const updated = {
      ...shopPerms,
      [slug]: { ...shopPerms[slug], [perm]: !shopPerms[slug]?.[perm] },
    };
    setShopPerms(updated);
    permsMutation.mutate(updated);
  };

  const setAllPerms = (slug, value) => {
    const updated = {
      ...shopPerms,
      [slug]: { can_delete: value, can_edit_ui: value, can_edit_items: value, can_view_orders: value },
    };
    setShopPerms(updated);
    permsMutation.mutate(updated);
  };

  const rd = ROLE_DISPLAY[u.role] || ROLE_DISPLAY.user;
  const RoleIcon = rd.icon;
  const isSelf = u.id === currentUserId;

  return (
    <div className="border-b border-border/30 last:border-0">
      <div className="flex items-center gap-3 px-5 py-3 hover:bg-foreground/[0.02] transition-colors">
        <div className="w-8 h-8 rounded-full bg-muted/50 flex items-center justify-center shrink-0">
          <RoleIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{u.name}</span>
            <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border ${rd.cls}`}>
              {rd.label}
            </span>
            {isSelf && <span className="text-[10px] text-primary font-mono">(you)</span>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            <span>{u.username}</span>
            <span className="text-border">·</span>
            <span>{u.email}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isSelf && (
            <button
              onClick={() => { if (window.confirm(`Delete user "${u.username}"?`)) deleteMutation.mutate(); }}
              disabled={deleteMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-destructive bg-secondary hover:bg-destructive/10 border border-border/60 hover:border-destructive/40 transition-all disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={() => { setEditing(!editing); setExpanded(!expanded); }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs bg-secondary hover:bg-accent border border-border/60 hover:border-primary/30 transition-all"
          >
            <Edit2 className="h-3 w-3" />
          </button>
          {u.role === 'user' && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground bg-secondary hover:bg-accent border border-border/60 transition-all"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Expanded edit / permissions panel */}
      {expanded && (
        <div className="px-5 pb-4 lp-fadein">
          {editing && (
            <div className="rounded-lg border border-border/40 p-4 mb-3 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] font-medium mb-1 text-muted-foreground">Username</label>
                  <input
                    value={editForm.username}
                    onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))}
                    className="w-full rounded-md border bg-input px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/60 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1 text-muted-foreground">Name</label>
                  <input
                    value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full rounded-md border bg-input px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/60 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1 text-muted-foreground">Email</label>
                  <input
                    value={editForm.email}
                    onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                    className="w-full rounded-md border bg-input px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/60 transition-all"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-medium mb-1 text-muted-foreground">Role</label>
                <div className="flex rounded-lg border border-border/60 overflow-hidden w-fit">
                  {['user', 'admin', 'super_admin'].map((r) => {
                    const roleD = ROLE_DISPLAY[r];
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setEditForm(f => ({ ...f, role: r }))}
                        className={`px-3 py-1.5 text-[10px] font-medium transition-all flex items-center gap-1 ${
                          editForm.role === r ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                        } ${r !== 'user' ? 'border-l border-border/60' : ''}`}
                      >
                        <roleD.icon className="h-2.5 w-2.5" />
                        {roleD.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {error && <p className="text-xs text-destructive font-mono">{error}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="inline-flex items-center gap-1 btn-launch rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  <Check className="h-3 w-3" />
                  {updateMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => { setEditing(false); setEditForm({ username: u.username, email: u.email, name: u.name, role: u.role }); setError(''); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Per-shop permissions (only for 'user' role) */}
          {u.role === 'user' && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">Shop Permissions</p>
              {shops.length === 0 ? (
                <p className="text-xs text-muted-foreground">No shops created yet.</p>
              ) : (
                shops.map(shop => {
                  const sp = shopPerms[shop.slug] || {};
                  const allOn = sp.can_delete && sp.can_edit_ui && sp.can_edit_items && sp.can_view_orders;
                  return (
                    <div key={shop.slug} className="rounded-lg border border-border/40 p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-semibold">{shop.name}</span>
                        <span className="text-[10px] text-muted-foreground font-mono ml-2">/{shop.slug}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAllPerms(shop.slug, !allOn)}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-all shrink-0 ${
                          allOn ? 'bg-primary/15 text-primary border-primary/30' : 'text-muted-foreground border-border/40 hover:border-primary/30'
                        }`}
                      >
                        {allOn ? 'Full' : 'All'}
                      </button>
                      <div className="flex gap-1">
                        {Object.entries(PERM_LABELS).map(([key, meta]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => togglePerm(shop.slug, key)}
                            title={meta.desc}
                            className={`text-[10px] font-medium px-2 py-1 rounded border transition-all ${
                              sp[key]
                                ? 'bg-primary/15 text-primary border-primary/30'
                                : 'text-muted-foreground border-border/40 hover:border-primary/30'
                            }`}
                          >
                            {meta.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
          {(u.role === 'admin' || u.role === 'super_admin') && !editing && (
            <p className="text-xs text-muted-foreground font-mono">
              {u.role === 'super_admin' ? 'Full access to all shops + user management.' : 'Full access to all shops.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminUsers() {
  const [showCreate, setShowCreate] = useState(false);
  const { user: currentUser } = usePermissions();

  const { data: usersData, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: getUsers,
  });

  const { data: shopsData } = useQuery({
    queryKey: ['shops'],
    queryFn: getShops,
  });

  const users = usersData?.users || [];
  const shops = shopsData?.shops || [];

  return (
    <div className="max-w-3xl lp-fadein">
      <div className="flex items-center gap-3 mb-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border/40 hover:border-primary/30 rounded-md px-3 py-1.5 transition-all"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
        <div>
          <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Admin</p>
          <h1 className="text-xl font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>User Management</h1>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setShowCreate(true)}
          className="btn-launch inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm"
        >
          <Plus className="h-4 w-4" />
          Create User
        </button>
      </div>

      {isLoading ? (
        <div className="lp-card rounded-xl p-8 text-center">
          <p className="text-muted-foreground text-sm font-mono">Loading users<span className="term-cursor" /></p>
        </div>
      ) : users.length === 0 ? (
        <div className="lp-card rounded-xl p-12 text-center">
          <Users className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
          <p className="text-sm font-semibold mb-1">No users yet</p>
          <p className="text-xs text-muted-foreground">Create your first user to get started.</p>
        </div>
      ) : (
        <div className="lp-card rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border/40">
            <Users className="h-4 w-4 text-primary/70" />
            <span className="text-sm font-bold" style={{ fontFamily: 'Syne, sans-serif' }}>
              {users.length} user{users.length !== 1 ? 's' : ''}
            </span>
          </div>
          {users.map((u) => (
            <UserRow key={u.id} user={u} shops={shops} currentUserId={currentUser?.id} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateUserModal
          shops={shops}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
