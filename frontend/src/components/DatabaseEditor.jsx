import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getShopDatabases, getShopTables, getShopRows,
  updateShopRow, insertShopRow, deleteShopRow,
} from '../lib/api';
import { Plus, Trash2, Save, X, Database } from 'lucide-react';

export default function DatabaseEditor({ slug }) {
  const queryClient = useQueryClient();
  const [selectedDb, setSelectedDb] = useState('');
  const [selectedTable, setSelectedTable] = useState('');
  const [editingRow, setEditingRow] = useState(null);
  const [newRow, setNewRow] = useState(null);

  const { data: dbData } = useQuery({
    queryKey: ['shop-db', slug],
    queryFn: () => getShopDatabases(slug),
  });

  const databases = dbData?.databases || [];

  useEffect(() => {
    if (databases.length > 0 && !selectedDb) {
      setSelectedDb(databases[0]);
    }
  }, [databases, selectedDb]);

  const { data: tableData } = useQuery({
    queryKey: ['shop-db-tables', slug, selectedDb],
    queryFn: () => getShopTables(slug, selectedDb),
    enabled: !!selectedDb,
  });

  const tables = tableData?.tables || [];

  useEffect(() => {
    if (tables.length > 0 && !tables.includes(selectedTable)) {
      setSelectedTable(tables[0]);
    }
  }, [tables, selectedTable]);

  const { data: rowData, isLoading: rowsLoading } = useQuery({
    queryKey: ['shop-db-rows', slug, selectedDb, selectedTable],
    queryFn: () => getShopRows(slug, selectedDb, selectedTable),
    enabled: !!selectedDb && !!selectedTable,
  });

  const columns = (rowData?.columns || []).filter(c => c.name !== 'rowid');
  const rows = rowData?.rows || [];

  const invalidateRows = () =>
    queryClient.invalidateQueries({ queryKey: ['shop-db-rows', slug, selectedDb, selectedTable] });

  const updateMutation = useMutation({
    mutationFn: ({ rowid, data }) => updateShopRow(slug, selectedDb, selectedTable, rowid, data),
    onSuccess: () => { invalidateRows(); setEditingRow(null); },
  });

  const insertMutation = useMutation({
    mutationFn: (data) => insertShopRow(slug, selectedDb, selectedTable, data),
    onSuccess: () => { invalidateRows(); setNewRow(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: (rowid) => deleteShopRow(slug, selectedDb, selectedTable, rowid),
    onSuccess: invalidateRows,
  });

  if (databases.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2 mb-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-medium">Database</h2>
        </div>
        <p className="text-sm text-muted-foreground">No database files found in this shop.</p>
      </div>
    );
  }

  const startEdit = (row) => {
    const data = {};
    columns.forEach(col => { data[col.name] = row[col.name]; });
    setEditingRow({ rowid: row.rowid, data });
  };

  const startNewRow = () => {
    const data = {};
    columns.forEach(col => { data[col.name] = ''; });
    setNewRow({ data });
  };

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Database className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-medium">Database</h2>
        {databases.length > 1 && (
          <select
            value={selectedDb}
            onChange={(e) => { setSelectedDb(e.target.value); setSelectedTable(''); }}
            className="ml-auto rounded-md border bg-background px-2 py-1 text-sm"
          >
            {databases.map(db => <option key={db} value={db}>{db}</option>)}
          </select>
        )}
        {databases.length === 1 && (
          <span className="ml-auto text-xs text-muted-foreground font-mono">{selectedDb}</span>
        )}
      </div>

      {tables.length > 1 && (
        <div className="flex gap-1 mb-4 border-b">
          {tables.map(t => (
            <button
              key={t}
              onClick={() => { setSelectedTable(t); setEditingRow(null); setNewRow(null); }}
              className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                selectedTable === t
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {tables.length === 1 && (
        <p className="text-xs text-muted-foreground mb-3">Table: <code className="bg-muted px-1 rounded">{selectedTable}</code></p>
      )}

      {tables.length === 0 && (
        <p className="text-sm text-muted-foreground">No tables found.</p>
      )}

      {selectedTable && (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {columns.map(col => (
                    <th key={col.name} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">
                      {col.name}
                      {col.type && <span className="text-[10px] ml-1 opacity-40">{col.type}</span>}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.rowid} className="border-b last:border-0 hover:bg-muted/30">
                    {editingRow?.rowid === row.rowid ? (
                      <>
                        {columns.map(col => (
                          <td key={col.name} className="px-2 py-1.5">
                            <input
                              value={editingRow.data[col.name] ?? ''}
                              onChange={(e) => setEditingRow({
                                ...editingRow,
                                data: { ...editingRow.data, [col.name]: e.target.value }
                              })}
                              className="w-full min-w-[80px] rounded border bg-background px-2 py-1 text-sm"
                            />
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <button
                            onClick={() => updateMutation.mutate({ rowid: row.rowid, data: editingRow.data })}
                            disabled={updateMutation.isPending}
                            className="text-primary hover:text-primary/80 p-1"
                            title="Save"
                          >
                            <Save className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setEditingRow(null)} className="text-muted-foreground hover:text-foreground p-1" title="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        {columns.map(col => (
                          <td
                            key={col.name}
                            className="px-3 py-2 cursor-pointer"
                            onDoubleClick={() => startEdit(row)}
                          >
                            {row[col.name] !== null && row[col.name] !== undefined
                              ? String(row[col.name])
                              : <span className="text-muted-foreground italic text-xs">null</span>}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => {
                              if (window.confirm('Delete this row?')) deleteMutation.mutate(row.rowid);
                            }}
                            disabled={deleteMutation.isPending}
                            className="text-destructive hover:text-destructive/80 p-1"
                            title="Delete row"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
                {newRow && (
                  <tr className="border-b bg-muted/20">
                    {columns.map(col => (
                      <td key={col.name} className="px-2 py-1.5">
                        <input
                          value={newRow.data[col.name] ?? ''}
                          onChange={(e) => setNewRow({
                            ...newRow,
                            data: { ...newRow.data, [col.name]: e.target.value }
                          })}
                          placeholder={col.name}
                          className="w-full min-w-[80px] rounded border bg-background px-2 py-1 text-sm"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => insertMutation.mutate(newRow.data)}
                        disabled={insertMutation.isPending}
                        className="text-primary hover:text-primary/80 p-1"
                        title="Save"
                      >
                        <Save className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setNewRow(null)} className="text-muted-foreground hover:text-foreground p-1" title="Cancel">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3 mt-3">
            {!newRow && (
              <button
                onClick={startNewRow}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add row
              </button>
            )}
            {rowsLoading && <span className="text-sm text-muted-foreground">Loading...</span>}
            {!rowsLoading && rows.length === 0 && !newRow && (
              <span className="text-sm text-muted-foreground">No rows in this table.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
