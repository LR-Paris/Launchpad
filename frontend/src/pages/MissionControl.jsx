import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, AlertTriangle, Server, RefreshCw,
  ChevronDown, ChevronUp, Terminal, ShieldAlert, Store, ShoppingCart, X,
  Rocket, Clock, Radio, Wifi, WifiOff, Package
} from 'lucide-react';
import { getMissionOverview, getSystemLogs, getShopMissionLogs, getMissionErrors, getOrders } from '../lib/api';

// ---------------------------------------------------------------------------
// 3D Wireframe Globe — Large centrepiece, Canvas-rendered
// ---------------------------------------------------------------------------
function Globe({ className }) {
  const canvasRef = useRef(null);

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
      const R = Math.min(w, h) * 0.40;
      const t = time * 0.001;

      ctx.clearRect(0, 0, w, h);

      // Ambient glow
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.8);
      glow.addColorStop(0, 'rgba(57,197,187,0.07)');
      glow.addColorStop(0.5, 'rgba(57,197,187,0.03)');
      glow.addColorStop(1, 'rgba(57,197,187,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // Outer atmosphere ring
      ctx.strokeStyle = 'rgba(57,197,187,0.06)';
      ctx.lineWidth = 20;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 15, 0, Math.PI * 2);
      ctx.stroke();

      // Globe wireframe — longitude lines
      ctx.lineWidth = 0.6;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI + t * 0.2;
        ctx.strokeStyle = `rgba(57,197,187,${0.12 + Math.sin(angle + t) * 0.04})`;
        ctx.beginPath();
        for (let j = 0; j <= 80; j++) {
          const lat = (j / 80) * Math.PI * 2;
          const x3d = Math.cos(lat) * Math.sin(angle);
          const y3d = Math.sin(lat);
          const z3d = Math.cos(lat) * Math.cos(angle);
          const scale = 1 / (1 + z3d * 0.35);
          const sx = cx + x3d * R * scale;
          const sy = cy + y3d * R * scale;
          if (j === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Latitude lines
      for (let i = 1; i < 8; i++) {
        const lat = (i / 8) * Math.PI - Math.PI / 2;
        const r = Math.cos(lat) * R;
        const yOff = Math.sin(lat) * R;
        ctx.strokeStyle = 'rgba(57,197,187,0.10)';
        ctx.beginPath();
        for (let j = 0; j <= 80; j++) {
          const ang = (j / 80) * Math.PI * 2 + t * 0.2;
          const x3d = Math.cos(ang);
          const z3d = Math.sin(ang);
          const scale = 1 / (1 + z3d * 0.35);
          const sx = cx + x3d * r * scale;
          const sy = cy + yOff * scale;
          if (j === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Globe edge
      ctx.strokeStyle = 'rgba(57,197,187,0.20)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // Surface dots (nodes)
      for (let i = 0; i < 20; i++) {
        const seed = i * 137.508;
        const lat2 = Math.asin(2 * ((i + 0.5) / 20) - 1);
        const lon2 = seed + t * 0.2;
        const x3d = Math.cos(lat2) * Math.sin(lon2);
        const y3d = Math.sin(lat2);
        const z3d = Math.cos(lat2) * Math.cos(lon2);
        if (z3d < -0.15) continue;
        const scale = 1 / (1 + z3d * 0.35);
        const sx = cx + x3d * R * scale;
        const sy = cy + y3d * R * scale;
        const alpha = 0.2 + z3d * 0.5;
        ctx.fillStyle = `rgba(57,197,187,${Math.max(0.05, alpha)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.2 * scale, 0, Math.PI * 2);
        ctx.fill();
        // Connection lines between nearby dots
        if (i % 3 === 0 && i + 1 < 20) {
          const lat3 = Math.asin(2 * ((i + 1.5) / 20) - 1);
          const lon3 = (i + 1) * 137.508 + t * 0.2;
          const x3b = Math.cos(lat3) * Math.sin(lon3);
          const y3b = Math.sin(lat3);
          const z3b = Math.cos(lat3) * Math.cos(lon3);
          if (z3b > -0.15) {
            const s2 = 1 / (1 + z3b * 0.35);
            ctx.strokeStyle = `rgba(57,197,187,${Math.max(0.02, alpha * 0.3)})`;
            ctx.lineWidth = 0.4;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(cx + x3b * R * s2, cy + y3b * R * s2);
            ctx.stroke();
          }
        }
      }

      // === Orbit 1 (main) ===
      const drawOrbit = (rx, ry, tilt, speed, color, rocketSize) => {
        const orbitRx = R * rx;
        const orbitRy = R * ry;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        ctx.strokeStyle = `rgba(${color},0.08)`;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 8]);
        ctx.beginPath();
        ctx.ellipse(0, 0, orbitRx, orbitRy, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        const rocketAngle = t * speed;
        const rlx = Math.cos(rocketAngle) * orbitRx;
        const rly = Math.sin(rocketAngle) * orbitRy;
        const cosT = Math.cos(tilt);
        const sinT = Math.sin(tilt);
        const rX = cx + rlx * cosT - rly * sinT;
        const rY = cy + rlx * sinT + rly * cosT;

        // Exhaust trail
        for (let i = 1; i <= 12; i++) {
          const ta = rocketAngle - i * 0.05;
          const tlx = Math.cos(ta) * orbitRx;
          const tly = Math.sin(ta) * orbitRy;
          const tx = cx + tlx * cosT - tly * sinT;
          const ty = cy + tlx * sinT + tly * cosT;
          const a = 0.5 - i * 0.04;
          if (a > 0) {
            ctx.fillStyle = `rgba(${color},${a})`;
            ctx.beginPath();
            ctx.arc(tx, ty, (rocketSize * 0.35) - i * 0.15, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Rocket heading
        const tangentLX = -Math.sin(rocketAngle) * orbitRx;
        const tangentLY = Math.cos(rocketAngle) * orbitRy;
        const heading = Math.atan2(
          tangentLX * sinT + tangentLY * cosT,
          tangentLX * cosT - tangentLY * sinT
        );

        ctx.save();
        ctx.translate(rX, rY);
        ctx.rotate(heading);
        const rs = rocketSize;
        ctx.fillStyle = `rgba(${color},0.9)`;
        ctx.beginPath();
        ctx.moveTo(rs * 1.6, 0);
        ctx.lineTo(-rs, -rs * 0.55);
        ctx.lineTo(-rs * 0.4, 0);
        ctx.lineTo(-rs, rs * 0.55);
        ctx.closePath();
        ctx.fill();

        // Glow
        const rGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, rs * 4);
        rGlow.addColorStop(0, `rgba(${color},0.2)`);
        rGlow.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = rGlow;
        ctx.beginPath();
        ctx.arc(0, 0, rs * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };

      drawOrbit(1.45, 0.5, -0.3, 0.7, '57,197,187', 9);
      drawOrbit(1.25, 0.65, 0.5, -0.5, '147,130,255', 6);
      drawOrbit(1.6, 0.35, -0.8, 0.4, '255,170,80', 5);

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }, []);

  return <canvas ref={canvasRef} className={className} />;
}

// ---------------------------------------------------------------------------
// Order notification toast
// ---------------------------------------------------------------------------
function OrderToast({ notifications, onDismiss }) {
  if (!notifications.length) return null;
  return (
    <div className="fixed bottom-16 right-4 z-50 space-y-2">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="flex items-center gap-3 bg-[#0d1520]/95 border border-emerald-500/30 rounded-lg px-4 py-3 shadow-lg lp-fadein min-w-[260px] backdrop-blur-sm"
        >
          <div className="w-7 h-7 rounded-full bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
            <ShoppingCart className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-emerald-300">New Order</p>
            <p className="text-[10px] text-[#8b949e] font-mono truncate">{n.shop}{n.orderId ? ` — ${n.orderId}` : ''}</p>
          </div>
          <button onClick={() => onDismiss(n.id)} className="text-[#484f58] hover:text-[#8b949e] p-0.5">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function StatusDot({ status, size = 'sm' }) {
  const s = size === 'lg' ? 'w-2.5 h-2.5' : 'w-1.5 h-1.5';
  const color = status === 'running' ? 'bg-emerald-400' : 'bg-red-400';
  const pulse = status === 'running' ? 'animate-pulse' : '';
  return <span className={`inline-block ${s} rounded-full ${color} ${pulse}`} />;
}

function LifecycleBadge({ status }) {
  const styles = {
    active: 'text-emerald-400 border-emerald-500/20', testing: 'text-amber-400 border-amber-500/20',
    development: 'text-blue-400 border-blue-500/20', closed: 'text-red-400 border-red-500/20',
    none: 'text-[#484f58] border-[#21262d]',
  };
  const labels = { active: 'ACTIVE', testing: 'TESTING', development: 'DEV', closed: 'CLOSED', none: '—' };
  return (
    <span className={`text-[8px] font-mono font-bold tracking-widest px-1.5 py-0.5 rounded border ${styles[status] || styles.none}`}>
      {labels[status] || status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Mission Control
// ---------------------------------------------------------------------------
export default function MissionControl() {
  const [expandedShop, setExpandedShop] = useState(null);
  const [shopLogs, setShopLogs] = useState({});
  const [shopLogLoading, setShopLogLoading] = useState(null);
  const [selectedPanel, setSelectedPanel] = useState('shops');
  const [orderNotifications, setOrderNotifications] = useState([]);
  const prevOrderCountsRef = useRef({});
  const notifIdRef = useRef(0);
  const sysLogRef = useRef(null);
  const [now, setNow] = useState(new Date());

  // Clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Data queries
  const { data: overviewData, isLoading: overviewLoading, refetch: refetchOverview } = useQuery({
    queryKey: ['mission-overview'], queryFn: getMissionOverview, refetchInterval: 30000,
  });
  const { data: sysLogData, isLoading: sysLogLoading, refetch: refetchSysLogs } = useQuery({
    queryKey: ['mission-system-logs'], queryFn: () => getSystemLogs(300), refetchInterval: 10000,
  });
  const { data: errorsData, refetch: refetchErrors } = useQuery({
    queryKey: ['mission-errors'], queryFn: getMissionErrors, refetchInterval: 30000,
  });

  const shops = overviewData?.shops || [];
  const runningShops = shops.filter(s => s.containerStatus === 'running');
  const stoppedShops = shops.filter(s => s.containerStatus !== 'running');
  const totalErrors = (errorsData?.count || 0) + shops.reduce((sum, s) => sum + s.errorCount, 0);
  const systemLogs = sysLogData?.logs || '';
  const errors = errorsData?.errors || [];

  // Auto-scroll system log
  useEffect(() => {
    if (sysLogRef.current) sysLogRef.current.scrollTop = sysLogRef.current.scrollHeight;
  }, [systemLogs]);

  // Order polling
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
            for (let i = 0; i < count - prev; i++) {
              if (!mounted) return;
              const id = ++notifIdRef.current;
              const latest = data.orders[data.orders.length - 1 - i];
              const orderId = latest?.['Order ID'] || latest?.['order_id'] || '';
              setOrderNotifications(p => [...p.slice(-4), { id, shop: shop.name, orderId }]);
              setTimeout(() => { if (mounted) setOrderNotifications(p => p.filter(n => n.id !== id)); }, 8000);
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

  const dismissNotif = useCallback((id) => setOrderNotifications(p => p.filter(n => n.id !== id)), []);

  const loadShopLogs = async (slug) => {
    setShopLogLoading(slug);
    try {
      const data = await getShopMissionLogs(slug, 150);
      setShopLogs(prev => ({ ...prev, [slug]: data.logs }));
    } catch { setShopLogs(prev => ({ ...prev, [slug]: 'Failed to load logs' })); }
    finally { setShopLogLoading(null); }
  };

  const toggleShop = (slug) => {
    if (expandedShop === slug) { setExpandedShop(null); }
    else { setExpandedShop(slug); if (!shopLogs[slug]) loadShopLogs(slug); }
  };

  const utc = now.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
  const local = now.toLocaleTimeString('en-US', { hour12: false });

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: '#080c14' }}>
      {/* ── TOP STATUS BAR ── */}
      <div className="flex items-center justify-between px-4 h-10 flex-shrink-0 border-b"
           style={{ borderColor: '#151b27', background: '#0a0f1a' }}>
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 group">
            <Rocket className="h-3.5 w-3.5 text-[#39C5BB]" />
            <span className="text-[11px] font-bold tracking-wider text-[#39C5BB]" style={{ fontFamily: 'Syne, sans-serif' }}>
              MISSION CONTROL
            </span>
          </Link>
          <div className="h-3 w-px bg-[#1b2333]" />
          <span className="text-[10px] font-mono text-[#484f58] flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" /> {utc}
          </span>
          <span className="text-[10px] font-mono text-[#484f58]">LOCAL {local}</span>
        </div>
        <div className="flex items-center gap-4">
          {totalErrors > 0 && (
            <span className="text-[10px] font-mono text-amber-400 flex items-center gap-1 animate-pulse">
              <AlertTriangle className="h-2.5 w-2.5" /> {totalErrors} ALERT{totalErrors !== 1 ? 'S' : ''}
            </span>
          )}
          <span className={`text-[10px] font-mono flex items-center gap-1 ${runningShops.length > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {runningShops.length > 0 ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
            {runningShops.length}/{shops.length} ONLINE
          </span>
          <button
            onClick={() => { refetchOverview(); refetchSysLogs(); refetchErrors(); }}
            className="text-[10px] font-mono text-[#484f58] hover:text-[#8b949e] flex items-center gap-1 transition-colors"
          >
            <RefreshCw className={`h-2.5 w-2.5 ${overviewLoading ? 'animate-spin' : ''}`} /> SYNC
          </button>
          <Link to="/" className="text-[10px] font-mono text-[#484f58] hover:text-[#8b949e] flex items-center gap-1">
            <ArrowLeft className="h-2.5 w-2.5" /> EXIT
          </Link>
        </div>
      </div>

      {/* ── MAIN AREA: LEFT PANEL | GLOBE | RIGHT PANEL ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* LEFT PANEL — Shops List */}
        <div className="w-[320px] flex-shrink-0 border-r flex flex-col overflow-hidden"
             style={{ borderColor: '#151b27', background: '#0a0f1a' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: '#151b27' }}>
            <span className="text-[9px] font-mono font-bold tracking-[0.2em] text-[#484f58]">FLEET STATUS</span>
            <span className="text-[9px] font-mono text-[#39C5BB]">{shops.length} UNIT{shops.length !== 1 ? 'S' : ''}</span>
          </div>
          <div className="flex-1 overflow-y-auto mc-scroll">
            {shops.map(shop => (
              <div key={shop.slug} style={{ borderColor: '#151b27' }} className="border-b">
                <div
                  className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[#0d1520] transition-colors"
                  onClick={() => toggleShop(shop.slug)}
                >
                  <StatusDot status={shop.containerStatus} size="lg" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-[#c9d1d9] truncate">{shop.name}</span>
                      <LifecycleBadge status={shop.lifecycleStatus} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[9px] font-mono text-[#484f58]">:{shop.port}</span>
                      <span className="text-[9px] font-mono text-[#484f58] truncate">{shop.subdomain}</span>
                      {shop.errorCount > 0 && (
                        <span className="text-[9px] font-mono text-amber-400">{shop.errorCount}ERR</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Link
                      to={`/shops/${shop.slug}/orders`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[9px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
                    >
                      ORD
                    </Link>
                    {expandedShop === shop.slug
                      ? <ChevronUp className="h-3 w-3 text-[#484f58]" />
                      : <ChevronDown className="h-3 w-3 text-[#484f58]" />}
                  </div>
                </div>
                {expandedShop === shop.slug && (
                  <div className="lp-fadein" style={{ borderColor: '#151b27' }}>
                    {shop.recentErrors.length > 0 && (
                      <div className="px-3 py-2 bg-red-500/5">
                        {shop.recentErrors.slice(0, 3).map((err, j) => (
                          <p key={j} className="text-[9px] font-mono text-red-400/70 leading-relaxed truncate">{err}</p>
                        ))}
                      </div>
                    )}
                    <div className="bg-[#060a12] text-[#8b949e] font-mono text-[10px] p-2 max-h-[140px] overflow-auto whitespace-pre-wrap leading-relaxed mc-scroll">
                      {shopLogLoading === shop.slug && !shopLogs[shop.slug] && (
                        <span className="text-[#484f58]">Loading...</span>
                      )}
                      {shopLogs[shop.slug] || ''}
                    </div>
                    <div className="flex items-center px-3 py-1 bg-[#0a0f1a]">
                      <button
                        onClick={() => loadShopLogs(shop.slug)}
                        className="flex items-center gap-1 text-[8px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
                      >
                        <RefreshCw className={`h-2 w-2 ${shopLogLoading === shop.slug ? 'animate-spin' : ''}`} /> RELOAD
                      </button>
                      <Link
                        to={`/shops/${shop.slug}/settings`}
                        className="ml-auto text-[8px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
                      >
                        CONFIG
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!shops.length && !overviewLoading && (
              <div className="text-center py-8 text-[#484f58] text-[10px] font-mono">NO FLEET UNITS DETECTED</div>
            )}
            {overviewLoading && !shops.length && (
              <div className="text-center py-8 text-[#484f58] text-[10px] font-mono animate-pulse">SCANNING...</div>
            )}
          </div>
        </div>

        {/* CENTER — Globe + Overlays */}
        <div className="flex-1 relative overflow-hidden" style={{ background: '#080c14' }}>
          <Globe className="absolute inset-0 w-full h-full" />

          {/* Summary metric cards overlaid on globe */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-3 pointer-events-none">
            {[
              { label: 'SHOPS', value: shops.length, color: '#c9d1d9' },
              { label: 'RUNNING', value: runningShops.length, color: '#34d399' },
              { label: 'STOPPED', value: stoppedShops.length, color: stoppedShops.length > 0 ? '#f87171' : '#484f58' },
              { label: 'ALERTS', value: totalErrors, color: totalErrors > 0 ? '#fbbf24' : '#484f58' },
            ].map(m => (
              <div key={m.label} className="text-center px-4 py-2 rounded-lg"
                   style={{ background: 'rgba(10,15,26,0.75)', border: '1px solid #151b27' }}>
                <div className="text-[22px] font-bold font-mono" style={{ color: m.color }}>{m.value}</div>
                <div className="text-[8px] font-mono tracking-[0.2em] text-[#484f58]">{m.label}</div>
              </div>
            ))}
          </div>

          {/* Order notifications on globe */}
          {orderNotifications.length > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-none">
              {orderNotifications.slice(0, 3).map((n, i) => (
                <div key={n.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full lp-fadein"
                     style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}>
                  <Package className="h-2.5 w-2.5 text-emerald-400" />
                  <span className="text-[10px] font-mono text-emerald-300">NEW ORDER — {n.shop}</span>
                </div>
              ))}
            </div>
          )}

          {/* Bottom-left: Launchpad branding */}
          <div className="absolute bottom-3 left-3 pointer-events-none">
            <span className="text-[9px] font-mono text-[#1b2333]">LAUNCHPAD {typeof __APP_VERSION__ !== 'undefined' ? `LC-${__APP_VERSION__}` : ''}</span>
          </div>
        </div>

        {/* RIGHT PANEL — Errors + Activity */}
        <div className="w-[320px] flex-shrink-0 border-l flex flex-col overflow-hidden"
             style={{ borderColor: '#151b27', background: '#0a0f1a' }}>

          {/* Panel tabs */}
          <div className="flex border-b" style={{ borderColor: '#151b27' }}>
            {[
              { id: 'alerts', label: 'ALERTS', count: totalErrors },
              { id: 'activity', label: 'ACTIVITY' },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedPanel(t.id)}
                className={`flex-1 text-[9px] font-mono font-bold tracking-[0.15em] py-2 transition-colors ${
                  selectedPanel === t.id
                    ? 'text-[#39C5BB] border-b border-[#39C5BB]'
                    : 'text-[#484f58] hover:text-[#8b949e]'
                }`}
              >
                {t.label}{t.count > 0 ? ` (${t.count})` : ''}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto mc-scroll">
            {selectedPanel === 'alerts' && (
              <>
                {!totalErrors && (
                  <div className="text-center py-12">
                    <Radio className="h-6 w-6 text-emerald-400/40 mx-auto mb-2" />
                    <p className="text-[10px] font-mono text-emerald-400/60">ALL SYSTEMS NOMINAL</p>
                  </div>
                )}

                {/* Container down alerts */}
                {errors.filter(e => e.type === 'container_down').map((err, i) => (
                  <div key={`c-${i}`} className="flex items-start gap-2 px-3 py-2.5 border-b" style={{ borderColor: '#151b27' }}>
                    <div className="w-1 h-1 rounded-full bg-red-400 mt-1.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Server className="h-2.5 w-2.5 text-red-400" />
                        <span className="text-[10px] font-mono font-bold text-red-400">CONTAINER DOWN</span>
                      </div>
                      <p className="text-[9px] font-mono text-[#8b949e] mt-0.5">{err.name || err.slug}</p>
                      <p className="text-[9px] font-mono text-[#484f58]">{err.message}</p>
                    </div>
                  </div>
                ))}

                {/* System log warnings */}
                {errors.filter(e => e.type === 'system').map((err, i) => (
                  <div key={`s-${i}`} className="flex items-start gap-2 px-3 py-2 border-b" style={{ borderColor: '#151b27' }}>
                    <div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] font-mono text-amber-400/80 leading-relaxed break-all">{err.message}</p>
                    </div>
                  </div>
                ))}

                {/* Per-shop errors */}
                {shops.filter(s => s.errorCount > 0).map(shop => (
                  <div key={shop.slug} className="border-b" style={{ borderColor: '#151b27' }}>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117]">
                      <Store className="h-2.5 w-2.5 text-amber-400" />
                      <span className="text-[9px] font-mono font-bold text-[#c9d1d9]">{shop.name}</span>
                      <span className="text-[8px] font-mono text-amber-400 ml-auto">{shop.errorCount}</span>
                    </div>
                    <div className="px-3 py-1.5">
                      {shop.recentErrors.slice(0, 3).map((err, j) => (
                        <p key={j} className="text-[9px] font-mono text-red-400/60 leading-relaxed truncate">{err}</p>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}

            {selectedPanel === 'activity' && (
              <div className="p-2">
                {/* Recent orders activity across shops placeholder — shows last known order IDs */}
                {shops.map(shop => {
                  const count = prevOrderCountsRef.current[shop.slug];
                  if (count === undefined) return null;
                  return (
                    <div key={shop.slug} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#0d1520] transition-colors">
                      <StatusDot status={shop.containerStatus} />
                      <span className="text-[10px] font-mono text-[#8b949e] flex-1 truncate">{shop.name}</span>
                      <span className="text-[10px] font-mono text-[#484f58]">{count} ord</span>
                    </div>
                  );
                })}
                {!shops.length && (
                  <div className="text-center py-8 text-[#484f58] text-[10px] font-mono">NO ACTIVITY</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── BOTTOM BAR — System Log Feed ── */}
      <div className="h-[120px] flex-shrink-0 border-t flex flex-col overflow-hidden"
           style={{ borderColor: '#151b27', background: '#0a0f1a' }}>
        <div className="flex items-center justify-between px-3 py-1 border-b" style={{ borderColor: '#151b27' }}>
          <div className="flex items-center gap-2">
            <Terminal className="h-2.5 w-2.5 text-[#39C5BB]" />
            <span className="text-[9px] font-mono font-bold tracking-[0.2em] text-[#484f58]">SYSTEM LOG</span>
            {sysLogLoading && <RefreshCw className="h-2 w-2 text-[#39C5BB] animate-spin" />}
          </div>
          <button
            onClick={() => refetchSysLogs()}
            className="text-[8px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
          >
            REFRESH
          </button>
        </div>
        <div
          ref={sysLogRef}
          className="flex-1 overflow-auto font-mono text-[10px] leading-relaxed px-3 py-1 mc-scroll"
          style={{ color: '#8b949e' }}
        >
          {systemLogs ? systemLogs.split('\n').map((line, i) => {
            const isErr = /\[(ERROR|FATAL)\]/.test(line);
            const isWarn = /\[WARN\]/.test(line);
            return (
              <div key={i} className={isErr ? 'text-red-400' : isWarn ? 'text-amber-400/70' : ''}>
                {line}
              </div>
            );
          }) : <span className="text-[#484f58]">Waiting for log data...</span>}
        </div>
      </div>

      {/* Toast notifications */}
      <OrderToast notifications={orderNotifications} onDismiss={dismissNotif} />

      {/* Custom scrollbar styles */}
      <style>{`
        .mc-scroll::-webkit-scrollbar { width: 4px; }
        .mc-scroll::-webkit-scrollbar-track { background: transparent; }
        .mc-scroll::-webkit-scrollbar-thumb { background: #1b2333; border-radius: 2px; }
        .mc-scroll::-webkit-scrollbar-thumb:hover { background: #2d3548; }
      `}</style>
    </div>
  );
}
