import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Activity, AlertTriangle, Server, ScrollText, RefreshCw,
  ChevronDown, ChevronUp, Circle, Terminal, Eye, ShieldAlert, Store
} from 'lucide-react';
import { getMissionOverview, getSystemLogs, getShopMissionLogs, getMissionErrors } from '../lib/api';

function StatusDot({ status }) {
  const color = status === 'running' ? 'bg-emerald-500' : 'bg-red-500';
  const pulse = status === 'running' ? 'animate-pulse' : '';
  return <span className={`inline-block w-2 h-2 rounded-full ${color} ${pulse}`} />;
}

function LifecycleBadge({ status }) {
  const styles = {
    active: 'bg-emerald-500/15 text-emerald-400',
    testing: 'bg-amber-500/15 text-amber-400',
    development: 'bg-blue-500/15 text-blue-400',
    closed: 'bg-red-500/15 text-red-400',
    none: 'bg-muted text-muted-foreground',
  };
  const labels = {
    active: 'Active', testing: 'Testing', development: 'Development',
    closed: 'Closed', none: 'No Status',
  };
  return (
    <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full ${styles[status] || styles.none}`}>
      {labels[status] || status}
    </span>
  );
}

function LogViewer({ logs, title, icon: Icon, autoScroll = true, loading }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="lp-card rounded-xl border border-border/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 bg-muted/20">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold" style={{ fontFamily: 'Syne, sans-serif' }}>{title}</span>
        {loading && <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin ml-auto" />}
      </div>
      <div
        ref={containerRef}
        className="bg-[#0d1117] text-[#c9d1d9] font-mono text-xs p-4 overflow-auto max-h-[400px] min-h-[200px] whitespace-pre-wrap leading-relaxed"
      >
        {logs || <span className="text-muted-foreground/50">No logs available</span>}
      </div>
    </div>
  );
}

export default function MissionControl() {
  const [expandedShop, setExpandedShop] = useState(null);
  const [shopLogs, setShopLogs] = useState({});
  const [shopLogLoading, setShopLogLoading] = useState(null);
  const [tab, setTab] = useState('overview'); // overview | system-logs | errors

  // Fetch overview — poll every 30s
  const { data: overviewData, isLoading: overviewLoading, refetch: refetchOverview } = useQuery({
    queryKey: ['mission-overview'],
    queryFn: getMissionOverview,
    refetchInterval: 30000,
  });

  // Fetch system logs — poll every 10s
  const { data: sysLogData, isLoading: sysLogLoading, refetch: refetchSysLogs } = useQuery({
    queryKey: ['mission-system-logs'],
    queryFn: () => getSystemLogs(300),
    refetchInterval: 10000,
  });

  // Fetch errors — poll every 30s
  const { data: errorsData, isLoading: errorsLoading, refetch: refetchErrors } = useQuery({
    queryKey: ['mission-errors'],
    queryFn: getMissionErrors,
    refetchInterval: 30000,
  });

  const shops = overviewData?.shops || [];
  const runningShops = shops.filter(s => s.containerStatus === 'running');
  const stoppedShops = shops.filter(s => s.containerStatus !== 'running');
  const totalErrors = (errorsData?.count || 0) + shops.reduce((sum, s) => sum + s.errorCount, 0);
  const systemLogs = sysLogData?.logs || '';
  const errors = errorsData?.errors || [];

  const loadShopLogs = async (slug) => {
    setShopLogLoading(slug);
    try {
      const data = await getShopMissionLogs(slug, 150);
      setShopLogs(prev => ({ ...prev, [slug]: data.logs }));
    } catch {
      setShopLogs(prev => ({ ...prev, [slug]: 'Failed to load logs' }));
    } finally {
      setShopLogLoading(null);
    }
  };

  const handleToggleShop = (slug) => {
    if (expandedShop === slug) {
      setExpandedShop(null);
    } else {
      setExpandedShop(slug);
      if (!shopLogs[slug]) loadShopLogs(slug);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Activity className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: 'Syne, sans-serif' }}>
          Mission Control
        </h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="lp-card rounded-xl border border-border/40 p-4">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">Total Shops</div>
          <div className="text-2xl font-bold">{shops.length}</div>
        </div>
        <div className="lp-card rounded-xl border border-border/40 p-4">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">Running</div>
          <div className="text-2xl font-bold text-emerald-400">{runningShops.length}</div>
        </div>
        <div className="lp-card rounded-xl border border-border/40 p-4">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">Stopped</div>
          <div className="text-2xl font-bold text-red-400">{stoppedShops.length}</div>
        </div>
        <div className="lp-card rounded-xl border border-border/40 p-4">
          <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">Issues</div>
          <div className={`text-2xl font-bold ${totalErrors > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>{totalErrors}</div>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-5 border-b border-border/40 pb-px">
        {[
          { id: 'overview', label: 'Shop Status', icon: Server },
          { id: 'system-logs', label: 'System Logs', icon: ScrollText },
          { id: 'errors', label: `Issues${totalErrors > 0 ? ` (${totalErrors})` : ''}`, icon: AlertTriangle },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-t-md transition-all border-b-2 -mb-px ${
              tab === t.id
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
        <button
          onClick={() => { refetchOverview(); refetchSysLogs(); refetchErrors(); }}
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/50 transition-colors"
          title="Refresh all"
        >
          <RefreshCw className={`h-3 w-3 ${overviewLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="space-y-2">
          {overviewLoading && !shops.length && (
            <div className="text-center py-12 text-muted-foreground text-sm">Loading shops...</div>
          )}
          {!overviewLoading && !shops.length && (
            <div className="text-center py-12 text-muted-foreground text-sm">No shops found.</div>
          )}
          {shops.map(shop => (
            <div key={shop.slug} className="lp-card rounded-xl border border-border/40 overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/10 transition-colors"
                onClick={() => handleToggleShop(shop.slug)}
              >
                <StatusDot status={shop.containerStatus} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold truncate">{shop.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{shop.slug}</span>
                    <LifecycleBadge status={shop.lifecycleStatus} />
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-[10px] font-mono text-muted-foreground">
                      :{shop.port}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {shop.subdomain}
                    </span>
                    {shop.errorCount > 0 && (
                      <span className="text-[10px] font-mono text-amber-400 flex items-center gap-0.5">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {shop.errorCount} error{shop.errorCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    to={`/shops/${shop.slug}/settings`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-muted-foreground hover:text-primary px-2 py-1 rounded-md hover:bg-primary/10 transition-colors"
                  >
                    Settings
                  </Link>
                  <Link
                    to={`/shops/${shop.slug}/orders`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-muted-foreground hover:text-primary px-2 py-1 rounded-md hover:bg-primary/10 transition-colors"
                  >
                    Orders
                  </Link>
                  {expandedShop === shop.slug ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>

              {/* Expanded: show errors + Docker logs */}
              {expandedShop === shop.slug && (
                <div className="border-t border-border/30 lp-fadein">
                  {/* Recent errors from this shop */}
                  {shop.recentErrors.length > 0 && (
                    <div className="px-4 py-3 bg-red-500/5 border-b border-border/20">
                      <div className="flex items-center gap-1.5 mb-2">
                        <ShieldAlert className="h-3.5 w-3.5 text-red-400" />
                        <span className="text-xs font-semibold text-red-400">Recent Errors</span>
                      </div>
                      <div className="space-y-1">
                        {shop.recentErrors.map((err, j) => (
                          <p key={j} className="text-[11px] font-mono text-red-300/80 leading-relaxed break-all">{err}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Docker logs */}
                  <div className="bg-[#0d1117] text-[#c9d1d9] font-mono text-xs p-4 max-h-[300px] overflow-auto whitespace-pre-wrap leading-relaxed">
                    {shopLogLoading === shop.slug && !shopLogs[shop.slug] && (
                      <span className="text-muted-foreground/50">Loading logs...</span>
                    )}
                    {shopLogs[shop.slug] || ''}
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2 bg-muted/10 border-t border-border/20">
                    <button
                      onClick={() => loadShopLogs(shop.slug)}
                      className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors"
                    >
                      <RefreshCw className={`h-2.5 w-2.5 ${shopLogLoading === shop.slug ? 'animate-spin' : ''}`} />
                      Refresh Logs
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'system-logs' && (
        <LogViewer
          logs={systemLogs}
          title="Launchpad System Log"
          icon={Terminal}
          loading={sysLogLoading}
        />
      )}

      {tab === 'errors' && (
        <div className="space-y-3">
          {errorsLoading && !errors.length && (
            <div className="text-center py-12 text-muted-foreground text-sm">Scanning for issues...</div>
          )}
          {!errorsLoading && !errors.length && !shops.some(s => s.errorCount > 0) && (
            <div className="lp-card rounded-xl border border-border/40 p-8 text-center">
              <Eye className="h-8 w-8 text-emerald-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-emerald-400">All Clear</p>
              <p className="text-xs text-muted-foreground mt-1">No issues detected across the platform.</p>
            </div>
          )}

          {/* Container issues */}
          {errors.filter(e => e.type === 'container_down').length > 0 && (
            <div className="lp-card rounded-xl border border-red-500/30 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border-b border-red-500/20">
                <Server className="h-4 w-4 text-red-400" />
                <span className="text-sm font-semibold text-red-400">Container Issues</span>
              </div>
              <div className="divide-y divide-border/20">
                {errors.filter(e => e.type === 'container_down').map((err, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <StatusDot status="stopped" />
                    <div className="flex-1">
                      <span className="text-sm font-medium">{err.name || err.slug}</span>
                      <p className="text-xs text-muted-foreground">{err.message}</p>
                    </div>
                    <Link
                      to={`/shops/${err.slug}/settings`}
                      className="text-xs text-primary hover:underline"
                    >
                      View Shop
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* System errors */}
          {errors.filter(e => e.type === 'system').length > 0 && (
            <div className="lp-card rounded-xl border border-amber-500/30 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-amber-500/10 border-b border-amber-500/20">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-semibold text-amber-400">System Log Warnings</span>
              </div>
              <div className="bg-[#0d1117] p-4 max-h-[300px] overflow-auto">
                {errors.filter(e => e.type === 'system').map((err, i) => (
                  <p key={i} className="text-[11px] font-mono text-amber-300/80 leading-relaxed">{err.message}</p>
                ))}
              </div>
            </div>
          )}

          {/* Per-shop errors */}
          {shops.filter(s => s.errorCount > 0).map(shop => (
            <div key={shop.slug} className="lp-card rounded-xl border border-amber-500/20 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-amber-500/5 border-b border-border/20">
                <Store className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-semibold">{shop.name}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{shop.slug}</span>
                <span className="text-[10px] font-mono text-amber-400 ml-auto">{shop.errorCount} error{shop.errorCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="bg-[#0d1117] p-4 max-h-[200px] overflow-auto">
                {shop.recentErrors.map((err, j) => (
                  <p key={j} className="text-[11px] font-mono text-red-300/80 leading-relaxed break-all">{err}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
