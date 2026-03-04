import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Activity, AlertTriangle, Server, ScrollText, RefreshCw,
  ChevronDown, ChevronUp, Terminal, Eye, ShieldAlert, Store, ShoppingCart, X
} from 'lucide-react';
import { getMissionOverview, getSystemLogs, getShopMissionLogs, getMissionErrors, getOrders } from '../lib/api';

// ---------------------------------------------------------------------------
// Wireframe Globe with orbiting rocket — pure Canvas 3D
// ---------------------------------------------------------------------------
function GlobeBanner({ shopCount, runningCount, orderNotifications }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (time) => {
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.32;
      const t = time * 0.001;

      ctx.clearRect(0, 0, w, h);

      // Glow behind globe
      const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.4);
      glow.addColorStop(0, 'rgba(57,197,187,0.08)');
      glow.addColorStop(1, 'rgba(57,197,187,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(57,197,187,0.18)';
      ctx.lineWidth = 0.8;

      // Longitude lines (rotating)
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI + t * 0.3;
        ctx.beginPath();
        for (let j = 0; j <= 60; j++) {
          const lat = (j / 60) * Math.PI * 2;
          const x3d = Math.cos(lat) * Math.sin(angle);
          const y3d = Math.sin(lat);
          const z3d = Math.cos(lat) * Math.cos(angle);
          // Simple perspective
          const scale = 1 / (1 + z3d * 0.3);
          const sx = cx + x3d * R * scale;
          const sy = cy + y3d * R * scale;
          if (j === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Latitude lines
      for (let i = 1; i < 6; i++) {
        const lat = (i / 6) * Math.PI - Math.PI / 2;
        const r = Math.cos(lat) * R;
        const yOff = Math.sin(lat) * R;
        ctx.beginPath();
        for (let j = 0; j <= 60; j++) {
          const ang = (j / 60) * Math.PI * 2 + t * 0.3;
          const x3d = Math.cos(ang);
          const z3d = Math.sin(ang);
          const scale = 1 / (1 + z3d * 0.3);
          const sx = cx + x3d * r * scale;
          const sy = cy + yOff * scale;
          if (j === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Outer ring
      ctx.strokeStyle = 'rgba(57,197,187,0.25)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // Orbit path (tilted ellipse)
      const orbitRx = R * 1.35;
      const orbitRy = R * 0.45;
      const orbitTilt = -0.25;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(orbitTilt);
      ctx.strokeStyle = 'rgba(57,197,187,0.12)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.ellipse(0, 0, orbitRx, orbitRy, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Rocket position on orbit
      const rocketAngle = t * 0.8;
      const rocketLocalX = Math.cos(rocketAngle) * orbitRx;
      const rocketLocalY = Math.sin(rocketAngle) * orbitRy;
      // Apply tilt rotation
      const cosT = Math.cos(orbitTilt);
      const sinT = Math.sin(orbitTilt);
      const rocketX = cx + rocketLocalX * cosT - rocketLocalY * sinT;
      const rocketY = cy + rocketLocalX * sinT + rocketLocalY * cosT;

      // Rocket exhaust trail
      for (let i = 1; i <= 8; i++) {
        const trailAngle = rocketAngle - i * 0.06;
        const tlx = Math.cos(trailAngle) * orbitRx;
        const tly = Math.sin(trailAngle) * orbitRy;
        const tx = cx + tlx * cosT - tly * sinT;
        const ty = cy + tlx * sinT + tly * cosT;
        const alpha = 0.4 - i * 0.045;
        if (alpha > 0) {
          ctx.fillStyle = `rgba(57,197,187,${alpha})`;
          ctx.beginPath();
          ctx.arc(tx, ty, 2.5 - i * 0.25, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Rocket body (triangle pointing along orbit tangent)
      const tangentAngle = rocketAngle + Math.PI / 2;
      const tangentLocalX = -Math.sin(rocketAngle) * orbitRx;
      const tangentLocalY = Math.cos(rocketAngle) * orbitRy;
      const headingAngle = Math.atan2(
        tangentLocalX * sinT + tangentLocalY * cosT,
        tangentLocalX * cosT - tangentLocalY * sinT
      );

      ctx.save();
      ctx.translate(rocketX, rocketY);
      ctx.rotate(headingAngle);

      // Rocket shape
      const rs = 8;
      ctx.fillStyle = 'rgba(57,197,187,0.9)';
      ctx.beginPath();
      ctx.moveTo(rs * 1.5, 0);
      ctx.lineTo(-rs, -rs * 0.6);
      ctx.lineTo(-rs * 0.5, 0);
      ctx.lineTo(-rs, rs * 0.6);
      ctx.closePath();
      ctx.fill();

      // Rocket glow
      const rGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, rs * 3);
      rGlow.addColorStop(0, 'rgba(57,197,187,0.25)');
      rGlow.addColorStop(1, 'rgba(57,197,187,0)');
      ctx.fillStyle = rGlow;
      ctx.beginPath();
      ctx.arc(0, 0, rs * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // Small dots scattered on globe (stars/nodes)
      for (let i = 0; i < 12; i++) {
        const seed = i * 137.508;
        const lat2 = Math.asin(2 * ((i + 0.5) / 12) - 1);
        const lon2 = seed + t * 0.3;
        const x3d = Math.cos(lat2) * Math.sin(lon2);
        const y3d = Math.sin(lat2);
        const z3d = Math.cos(lat2) * Math.cos(lon2);
        if (z3d < -0.1) continue; // behind globe
        const scale = 1 / (1 + z3d * 0.3);
        const sx = cx + x3d * R * scale;
        const sy = cy + y3d * R * scale;
        ctx.fillStyle = `rgba(57,197,187,${0.3 + z3d * 0.4})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 1.8 * scale, 0, Math.PI * 2);
        ctx.fill();
      }

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="relative rounded-2xl overflow-hidden mb-6 border border-border/30" style={{ background: 'linear-gradient(135deg, #0a0f1a 0%, #0d1520 50%, #091018 100%)' }}>
      <canvas ref={canvasRef} className="w-full" style={{ height: '220px' }} />
      {/* Overlay text */}
      <div className="absolute inset-0 flex items-center justify-between px-8 pointer-events-none">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1" style={{ fontFamily: 'Syne, sans-serif' }}>
            Mission Control
          </h1>
          <p className="text-xs text-[#39C5BB]/70 font-mono">
            {runningCount} active {runningCount === 1 ? 'shop' : 'shops'} in orbit
            {shopCount > runningCount && ` / ${shopCount} total`}
          </p>
        </div>
        <div className="text-right">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-4 w-4 text-[#39C5BB]" />
            <span className="text-sm font-semibold text-white" style={{ fontFamily: 'Syne, sans-serif' }}>LAUNCHPAD</span>
          </div>
          <p className="text-[10px] text-[#39C5BB]/50 font-mono uppercase tracking-widest">Global Operations</p>
        </div>
      </div>
      {/* Order notification badges */}
      {orderNotifications.length > 0 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-auto">
          {orderNotifications.slice(0, 3).map((n, i) => (
            <div key={i} className="flex items-center gap-1.5 bg-emerald-500/20 border border-emerald-500/30 backdrop-blur-sm text-emerald-300 text-[10px] font-mono px-2.5 py-1 rounded-full lp-fadein">
              <ShoppingCart className="h-2.5 w-2.5" />
              New order — {n.shop}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order notification toast
// ---------------------------------------------------------------------------
function OrderToast({ notifications, onDismiss }) {
  if (!notifications.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="flex items-center gap-3 bg-card border border-emerald-500/30 rounded-xl px-4 py-3 shadow-lg lp-fadein min-w-[280px]"
        >
          <div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
            <ShoppingCart className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold">New Order Received</p>
            <p className="text-[10px] text-muted-foreground font-mono truncate">{n.shop} — {n.orderId || 'Order'}</p>
          </div>
          <button onClick={() => onDismiss(n.id)} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable components
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function MissionControl() {
  const queryClient = useQueryClient();
  const [expandedShop, setExpandedShop] = useState(null);
  const [shopLogs, setShopLogs] = useState({});
  const [shopLogLoading, setShopLogLoading] = useState(null);
  const [tab, setTab] = useState('overview');
  const [orderNotifications, setOrderNotifications] = useState([]);
  const prevOrderCountsRef = useRef({});
  const notifIdRef = useRef(0);

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

  // Poll orders for all shops to detect new orders
  useEffect(() => {
    if (!shops.length) return;
    let mounted = true;

    const checkOrders = async () => {
      for (const shop of shops) {
        try {
          const data = await getOrders(shop.slug);
          const count = data.orders?.length || 0;
          const prev = prevOrderCountsRef.current[shop.slug];

          if (prev !== undefined && count > prev) {
            const diff = count - prev;
            for (let i = 0; i < diff; i++) {
              if (!mounted) return;
              const id = ++notifIdRef.current;
              const latestOrder = data.orders[data.orders.length - 1 - i];
              const orderId = latestOrder?.['Order ID'] || latestOrder?.['order_id'] || '';
              setOrderNotifications(prev => [...prev.slice(-4), { id, shop: shop.name, orderId }]);
              // Auto-dismiss after 8 seconds
              setTimeout(() => {
                if (mounted) setOrderNotifications(prev => prev.filter(n => n.id !== id));
              }, 8000);
            }
          }
          prevOrderCountsRef.current[shop.slug] = count;
        } catch { /* skip */ }
      }
    };

    checkOrders();
    const interval = setInterval(checkOrders, 15000);
    return () => { mounted = false; clearInterval(interval); };
  }, [shops.length]);

  const dismissNotification = useCallback((id) => {
    setOrderNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

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
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Back button */}
      <div className="flex items-center gap-2 mb-4">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
      </div>

      {/* 3D Globe Banner */}
      <GlobeBanner
        shopCount={shops.length}
        runningCount={runningShops.length}
        orderNotifications={orderNotifications}
      />

      {/* Order toast notifications */}
      <OrderToast notifications={orderNotifications} onDismiss={dismissNotification} />

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

              {expandedShop === shop.slug && (
                <div className="border-t border-border/30 lp-fadein">
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
