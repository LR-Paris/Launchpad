import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deployShop, deleteShop, getShopLogs } from '../lib/api';
import { ArrowLeft, Rocket, Trash2, Terminal as TerminalIcon, RefreshCw } from 'lucide-react';
import Terminal from '../components/Terminal';
import DatabaseEditor from '../components/DatabaseEditor';

export default function Settings() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [showLogs, setShowLogs] = useState(false);

  const deployMutation = useMutation({
    mutationFn: () => deployShop(slug),
    onSuccess: (data) => {
      setMessage(data.message);
      queryClient.invalidateQueries({ queryKey: ['shops'] });
    },
    onError: (err) => setMessage(err.response?.data?.error || 'Deploy failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteShop(slug, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      navigate('/');
    },
    onError: (err) => setMessage(err.response?.data?.error || 'Delete failed'),
  });

  const { data: logsData, refetch: refetchLogs, isFetching: logsFetching } = useQuery({
    queryKey: ['shop-logs', slug],
    queryFn: () => getShopLogs(slug),
    enabled: showLogs,
  });

  const handleDelete = () => {
    if (window.confirm(`Permanently delete shop "${slug}" and all its files?`)) {
      deleteMutation.mutate();
    }
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-xl font-semibold">Settings — {slug}</h1>
      </div>

      {message && (
        <div className="rounded-md border bg-muted px-4 py-3 text-sm mb-4">{message}</div>
      )}

      <div className="space-y-6">
        {/* Database Editor */}
        <DatabaseEditor slug={slug} />

        {/* Container Logs */}
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <TerminalIcon className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-medium">Container Logs</h2>
            </div>
            <div className="flex items-center gap-2">
              {showLogs && (
                <button
                  onClick={() => refetchLogs()}
                  disabled={logsFetching}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${logsFetching ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              )}
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {showLogs ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          {showLogs && (
            <Terminal logs={logsData?.logs} title={`${slug} logs`} />
          )}
          {!showLogs && (
            <p className="text-sm text-muted-foreground">
              View live container output to debug issues.
            </p>
          )}
        </div>

        {/* Redeploy */}
        <div className="rounded-lg border bg-card p-5">
          <h2 className="font-medium mb-2">Redeploy</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Pull latest changes and rebuild the shop container.
          </p>
          <button
            onClick={() => deployMutation.mutate()}
            disabled={deployMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Rocket className="h-4 w-4" />
            {deployMutation.isPending ? 'Deploying...' : 'Redeploy'}
          </button>
        </div>

        {/* Danger Zone */}
        <div className="rounded-lg border border-destructive/30 bg-card p-5">
          <h2 className="font-medium text-destructive mb-2">Danger Zone</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Permanently delete this shop, its container, and all associated files.
          </p>
          <button
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-2 text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            {deleteMutation.isPending ? 'Deleting...' : 'Delete Shop'}
          </button>
        </div>
      </div>
    </div>
  );
}
