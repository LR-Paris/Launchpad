import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createShop } from '../lib/api';
import Terminal from '../components/Terminal';

export default function NewShop() {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [error, setError] = useState('');
  const [deployResult, setDeployResult] = useState(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: createShop,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      setDeployResult({ shop: data.shop, logs: data.logs, success: true });
    },
    onError: (err) => {
      const errData = err.response?.data;
      setError(errData?.error || 'Failed to create shop');
      if (errData?.logs) {
        setDeployResult({ logs: errData.logs, success: false });
      }
    },
  });

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    setDeployResult(null);
    const payload = { name };
    if (folderPath.trim()) {
      payload.folderPath = folderPath.trim();
    }
    mutation.mutate(payload);
  };

  if (deployResult) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold mb-6">
          {deployResult.success ? 'Shop Deployed' : 'Deployment Failed'}
        </h1>

        {deployResult.success && (
          <div className="rounded-md border bg-green-50 text-green-800 px-4 py-3 text-sm mb-4">
            Shop <strong>{deployResult.shop?.name}</strong> created successfully on port {deployResult.shop?.port}.
          </div>
        )}

        {error && (
          <div className="rounded-md border bg-red-50 text-red-800 px-4 py-3 text-sm mb-4">
            {error}
          </div>
        )}

        <Terminal logs={deployResult.logs} title="deploy output" />

        <div className="flex gap-3 mt-4">
          <button
            onClick={() => navigate('/')}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Go to Dashboard
          </button>
          {!deployResult.success && (
            <button
              onClick={() => { setDeployResult(null); setError(''); }}
              className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-semibold mb-6">Deploy New Shop</h1>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <label className="block text-sm font-medium mb-1.5" htmlFor="name">
            Shop Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Awesome Shop"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            required
          />
          {slug && (
            <p className="text-xs text-muted-foreground mt-1">
              Slug: <code className="bg-muted px-1 rounded">{slug}</code>
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" htmlFor="folderPath">
            Local Folder Path <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <input
            id="folderPath"
            type="text"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="/path/to/local/shop"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Leave empty to clone from the Shuttle template repository.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {mutation.isPending && (
          <Terminal logs="> Deploying shop..." title="deploy output" />
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? 'Deploying...' : 'Deploy Shop'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            disabled={mutation.isPending}
            className="rounded-md bg-secondary text-secondary-foreground px-4 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
