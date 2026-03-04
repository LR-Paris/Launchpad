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
// Palantir-style 3D Globe — continent dot cloud, HQ city markers, arcs, rockets
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;

// HQ city locations
const HQ_CITIES = [
  { lat: 40.71, lon: -74.01, label: 'NYC' },
  { lat: 38.91, lon: -77.04, label: 'DC' },
  { lat: 48.86, lon: 2.35, label: 'PARIS' },
  { lat: 13.76, lon: 100.50, label: 'BKK' },
];

// Simplified continent dot cloud — ~190 points for recognizable landmasses
// prettier-ignore
const LAND_DOTS = [
  // North America
  [64,-165],[62,-150],[60,-140],[58,-135],[55,-130],[50,-125],[48,-123],[45,-124],
  [42,-124],[38,-122],[35,-120],[33,-117],[32,-114],[30,-110],[28,-105],[26,-98],
  [25,-90],[28,-82],[30,-81],[27,-80],[25,-80],[42,-70],[41,-72],[40,-74],
  [43,-69],[45,-67],[47,-53],[44,-63],[47,-70],[48,-88],[47,-92],[42,-83],
  [41,-87],[55,-80],[58,-95],[60,-115],[62,-130],[64,-160],[52,-57],[50,-65],
  [68,-135],[70,-150],[65,-170],[72,-80],[75,-95],[70,-60],[50,-100],[45,-100],
  [40,-100],[35,-100],[30,-95],[25,-100],[20,-102],[18,-96],[16,-90],
  // South America
  [12,-72],[10,-75],[8,-77],[5,-77],[2,-80],[-2,-80],[-5,-79],[-8,-77],
  [-10,-77],[-13,-76],[-16,-73],[-18,-70],[-22,-70],[-25,-65],[-28,-65],
  [-33,-71],[-36,-73],[-40,-72],[-45,-74],[-50,-75],[-54,-68],[-5,-35],
  [-10,-37],[-15,-39],[-20,-43],[-23,-46],[-25,-49],[-3,-60],[-8,-63],
  [-15,-55],[-20,-57],[-28,-58],[-32,-62],
  // Europe
  [60,5],[58,-5],[55,-8],[52,-10],[50,-6],[48,-5],[44,-8],[42,-9],[37,-10],
  [36,-5],[38,0],[40,0],[42,3],[43,5],[44,8],[45,12],[42,12],[38,14],
  [37,15],[40,18],[42,15],[44,12],[46,7],[48,2],[50,2],[51,1],[52,5],
  [54,10],[56,12],[58,16],[60,20],[62,20],[64,22],[66,14],[68,16],[70,25],
  [60,30],[56,24],[54,20],[50,15],[48,10],
  // Africa
  [35,-5],[33,0],[35,10],[32,13],[30,10],[25,33],[20,37],[15,40],[12,43],
  [10,40],[5,42],[0,42],[-5,39],[-10,40],[-15,40],[-20,35],[-25,33],
  [-28,30],[-30,28],[-34,18],[-33,26],[-28,15],[-20,12],[-15,12],[-10,14],
  [-5,12],[0,10],[5,5],[10,0],[15,-15],[20,-17],[25,-15],[30,-10],[35,0],
  [37,10],[33,35],[10,10],[5,20],[0,30],[-5,25],[-15,28],[-20,25],
  // Asia
  [42,30],[40,45],[38,48],[35,52],[30,48],[25,55],[20,58],[15,55],[10,50],
  [5,103],[10,105],[15,108],[20,106],[22,108],[25,110],[28,120],[30,104],
  [35,105],[38,110],[40,115],[42,130],[44,132],[46,135],[50,140],[52,140],
  [55,135],[58,130],[60,140],[62,150],[65,170],[68,170],[70,140],[68,70],
  [65,60],[60,50],[55,40],[50,30],[45,35],[43,40],[25,68],[23,72],[20,75],
  [15,80],[10,78],[8,80],[12,100],[28,48],[32,35],[36,36],[38,60],[42,60],
  [45,90],[50,80],[55,73],[60,70],[55,90],[50,105],[45,80],[48,65],
  // Australia & Oceania
  [-12,130],[-15,128],[-18,122],[-22,118],[-25,114],[-28,114],[-32,116],
  [-35,117],[-35,137],[-38,145],[-37,150],[-33,152],[-28,153],[-25,152],
  [-20,149],[-16,146],[-12,142],[-12,136],[-20,134],[-25,133],[-30,135],
  [-42,172],[-38,176],[-44,168],
];

// Great-circle arc interpolation (slerp)
function arcPoints(lat1, lon1, lat2, lon2, steps) {
  const toVec = (la, lo) => {
    const p = la * DEG, l = lo * DEG;
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  };
  const p1 = toVec(lat1, lon1), p2 = toVec(lat2, lon2);
  const dot = p1[0]*p2[0] + p1[1]*p2[1] + p1[2]*p2[2];
  const omega = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinO = Math.sin(omega);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    let x, y, z;
    if (sinO < 0.001) {
      x = p1[0]*(1-f) + p2[0]*f; y = p1[1]*(1-f) + p2[1]*f; z = p1[2]*(1-f) + p2[2]*f;
    } else {
      const a = Math.sin((1-f)*omega)/sinO, b = Math.sin(f*omega)/sinO;
      x = a*p1[0]+b*p2[0]; y = a*p1[1]+b*p2[1]; z = a*p1[2]+b*p2[2];
    }
    const lat = Math.asin(z) / DEG;
    const lon = Math.atan2(y, x) / DEG;
    pts.push([lat, lon]);
  }
  return pts;
}

// Pre-compute arcs between all HQ pairs
const HQ_ARCS = [];
for (let i = 0; i < HQ_CITIES.length; i++) {
  for (let j = i + 1; j < HQ_CITIES.length; j++) {
    const a = HQ_CITIES[i], b = HQ_CITIES[j];
    HQ_ARCS.push({ from: i, to: j, points: arcPoints(a.lat, a.lon, b.lat, b.lon, 40) });
  }
}

function Globe({ className, rocketCount = 1 }) {
  const canvasRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rocketCountRef = useRef(rocketCount);
  rocketCountRef.current = rocketCount;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w: rect.width, h: rect.height };
    };
    resize();
    const resizeTimer = setTimeout(resize, 100);
    window.addEventListener('resize', resize);

    // Orbit palette
    const ORBIT_COLORS = [
      '57,197,187', '147,130,255', '255,170,80', '99,210,130',
      '255,120,150', '100,180,255', '220,200,80', '180,130,220',
      '255,150,60', '130,220,200',
    ];

    // Project lat/lon to screen coords with rotation
    const project = (lat, lon, rot, cx, cy, R) => {
      const phi = lat * DEG;
      const lambda = lon * DEG + rot;
      const x3d = Math.cos(phi) * Math.sin(lambda);
      const y3d = -Math.sin(phi);
      const z3d = Math.cos(phi) * Math.cos(lambda);
      return { sx: cx + x3d * R, sy: cy + y3d * R, z: z3d };
    };

    const draw = (time) => {
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) { animId = requestAnimationFrame(draw); return; }
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.38;
      const t = time * 0.001;
      const rot = t * 0.12; // slow globe rotation

      ctx.clearRect(0, 0, w, h);

      // ── Ambient glow ──
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.8);
      glow.addColorStop(0, 'rgba(57,197,187,0.05)');
      glow.addColorStop(0.5, 'rgba(57,197,187,0.02)');
      glow.addColorStop(1, 'rgba(57,197,187,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // ── Outer atmosphere ──
      const atmo = ctx.createRadialGradient(cx, cy, R, cx, cy, R + 25);
      atmo.addColorStop(0, 'rgba(57,197,187,0.08)');
      atmo.addColorStop(0.5, 'rgba(57,197,187,0.03)');
      atmo.addColorStop(1, 'rgba(57,197,187,0)');
      ctx.fillStyle = atmo;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 25, 0, Math.PI * 2);
      ctx.fill();

      // ── Globe filled base ──
      const globeBg = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
      globeBg.addColorStop(0, 'rgba(15,25,40,0.95)');
      globeBg.addColorStop(1, 'rgba(6,10,18,0.98)');
      ctx.fillStyle = globeBg;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // ── Latitude grid lines ──
      ctx.lineWidth = 0.4;
      for (let i = -3; i <= 3; i++) {
        const lat = (i / 4) * 80;
        ctx.strokeStyle = 'rgba(57,197,187,0.04)';
        ctx.beginPath();
        let started = false;
        for (let j = 0; j <= 120; j++) {
          const lon = (j / 120) * 360 - 180;
          const p = project(lat, lon, rot, cx, cy, R);
          if (p.z < -0.05) { started = false; continue; }
          if (!started) { ctx.moveTo(p.sx, p.sy); started = true; }
          else ctx.lineTo(p.sx, p.sy);
        }
        ctx.stroke();
      }

      // ── Longitude grid lines ──
      for (let i = 0; i < 12; i++) {
        const lon = (i / 12) * 360 - 180;
        ctx.strokeStyle = 'rgba(57,197,187,0.04)';
        ctx.beginPath();
        let started = false;
        for (let j = 0; j <= 80; j++) {
          const lat = (j / 80) * 180 - 90;
          const p = project(lat, lon, rot, cx, cy, R);
          if (p.z < -0.05) { started = false; continue; }
          if (!started) { ctx.moveTo(p.sx, p.sy); started = true; }
          else ctx.lineTo(p.sx, p.sy);
        }
        ctx.stroke();
      }

      // ── Continent dot cloud ──
      for (const [lat, lon] of LAND_DOTS) {
        const p = project(lat, lon, rot, cx, cy, R);
        if (p.z < -0.05) continue;
        const alpha = 0.08 + Math.max(0, p.z) * 0.35;
        const dotR = 1.0 + p.z * 0.6;
        ctx.fillStyle = `rgba(57,197,187,${alpha})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, Math.max(0.5, dotR), 0, Math.PI * 2);
        ctx.fill();
      }

      // ── HQ connection arcs (drawn as elevated dotted lines) ──
      for (const arc of HQ_ARCS) {
        ctx.beginPath();
        let started = false;
        for (let k = 0; k < arc.points.length; k++) {
          const [lat, lon] = arc.points[k];
          const p = project(lat, lon, rot, cx, cy, R);
          if (p.z < 0) { started = false; continue; }
          // Elevate arc above surface (peaks in middle)
          const mid = Math.sin((k / arc.points.length) * Math.PI);
          const elev = 1 + mid * 0.08;
          const ex = cx + (p.sx - cx) * elev;
          const ey = cy + (p.sy - cy) * elev;
          if (!started) { ctx.moveTo(ex, ey); started = true; }
          else ctx.lineTo(ex, ey);
        }
        ctx.strokeStyle = 'rgba(255,180,80,0.12)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Animated pulse dot traveling along the arc
        const pulseIdx = Math.floor((t * 8 + arc.from * 7) % arc.points.length);
        const [plat, plon] = arc.points[pulseIdx];
        const pp = project(plat, plon, rot, cx, cy, R);
        if (pp.z > 0) {
          const mid2 = Math.sin((pulseIdx / arc.points.length) * Math.PI);
          const elev2 = 1 + mid2 * 0.08;
          const px = cx + (pp.sx - cx) * elev2;
          const py = cy + (pp.sy - cy) * elev2;
          ctx.fillStyle = 'rgba(255,200,100,0.6)';
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ── HQ City markers (pulsing) ──
      for (const city of HQ_CITIES) {
        const p = project(city.lat, city.lon, rot, cx, cy, R);
        if (p.z < -0.05) continue;
        const depthAlpha = 0.3 + Math.max(0, p.z) * 0.7;
        const pulse = 0.5 + Math.sin(t * 2.5 + city.lon * 0.1) * 0.5;
        const blink = Math.sin(t * 4 + city.lat * 0.2) > 0.3 ? 1 : 0.4;

        // Outer pulsing ring
        const ringR = 6 + pulse * 8;
        ctx.strokeStyle = `rgba(255,200,80,${0.15 * pulse * depthAlpha})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Glow
        const cGlow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, 14);
        cGlow.addColorStop(0, `rgba(255,200,80,${0.25 * depthAlpha * blink})`);
        cGlow.addColorStop(1, 'rgba(255,200,80,0)');
        ctx.fillStyle = cGlow;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 14, 0, Math.PI * 2);
        ctx.fill();

        // Core dot
        ctx.fillStyle = `rgba(255,220,120,${(0.7 + pulse * 0.3) * depthAlpha * blink})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Label
        if (p.z > 0.2) {
          ctx.fillStyle = `rgba(255,220,120,${(0.5 + pulse * 0.3) * depthAlpha})`;
          ctx.font = '9px monospace';
          ctx.fillText(city.label, p.sx + 8, p.sy + 3);
        }
      }

      // ── Globe edge highlight ──
      ctx.strokeStyle = 'rgba(57,197,187,0.12)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // ── Orbiting Rockets ──
      const count = Math.min(Math.max(rocketCountRef.current, 1), 10);
      for (let idx = 0; idx < count; idx++) {
        const phi = idx * 2.399963;
        const orbitRx = R * (1.2 + (idx % 3) * 0.15);
        const orbitRy = R * (0.35 + ((idx * 0.618) % 1) * 0.3);
        const tilt = -0.9 + phi * 0.4;
        const speed = 0.4 + (idx % 2 === 0 ? 0.25 : -0.15) * (1 + idx * 0.08);
        const color = ORBIT_COLORS[idx % ORBIT_COLORS.length];
        const rs = Math.max(5, 9 - idx * 0.5);
        const cosT = Math.cos(tilt);
        const sinT = Math.sin(tilt);

        // Orbit path (dashed)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        ctx.strokeStyle = `rgba(${color},0.05)`;
        ctx.lineWidth = 0.6;
        ctx.setLineDash([3, 8]);
        ctx.beginPath();
        ctx.ellipse(0, 0, orbitRx, orbitRy, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        const rocketAngle = t * speed + idx * 1.2;

        // Depth check: sin(rocketAngle) < 0 means behind the globe for our orbit convention
        // Only fade when the screen position is actually inside the globe disc
        const screenPos = (angle) => {
          const lx = Math.cos(angle) * orbitRx;
          const ly = Math.sin(angle) * orbitRy;
          const sx = cx + lx * cosT - ly * sinT;
          const sy = cy + lx * sinT + ly * cosT;
          const dist = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
          const behind = Math.sin(angle) < 0 && dist < R * 0.97;
          // Smooth fade based on how far behind
          const fade = behind ? Math.max(0.06, 0.15 + Math.sin(angle) * 0.5) : 1.0;
          return { sx, sy, dist, behind, fade };
        };

        // Exhaust trail — 30 particles for long comet tail
        for (let i = 1; i <= 30; i++) {
          const ta = rocketAngle - i * 0.035;
          const tp = screenPos(ta);
          const a = (0.55 - i * 0.017) * tp.fade;
          if (a > 0.01) {
            ctx.fillStyle = `rgba(${color},${a})`;
            ctx.beginPath();
            ctx.arc(tp.sx, tp.sy, Math.max(0.3, rs * 0.38 - i * 0.07), 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Rocket position & depth
        const rp = screenPos(rocketAngle);

        // Rocket heading
        const tangentLX = -Math.sin(rocketAngle) * orbitRx;
        const tangentLY = Math.cos(rocketAngle) * orbitRy;
        const heading = Math.atan2(
          tangentLX * sinT + tangentLY * cosT,
          tangentLX * cosT - tangentLY * sinT
        );

        ctx.save();
        ctx.translate(rp.sx, rp.sy);
        ctx.rotate(heading);
        ctx.globalAlpha = rp.fade;
        ctx.fillStyle = `rgba(${color},0.85)`;
        ctx.beginPath();
        ctx.moveTo(rs * 1.5, 0);
        ctx.lineTo(-rs * 0.8, -rs * 0.5);
        ctx.lineTo(-rs * 0.3, 0);
        ctx.lineTo(-rs * 0.8, rs * 0.5);
        ctx.closePath();
        ctx.fill();

        // Glow
        const rGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, rs * 3.5);
        rGlow.addColorStop(0, `rgba(${color},${0.2 * rp.fade})`);
        rGlow.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = rGlow;
        ctx.beginPath();
        ctx.arc(0, 0, rs * 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
        ctx.restore();
      }

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animId); clearTimeout(resizeTimer); window.removeEventListener('resize', resize); };
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
            <p className="text-[12px] font-semibold text-emerald-300">New Order</p>
            <p className="text-[11px] text-[#8b949e] font-mono truncate">{n.shop}{n.orderId ? ` — ${n.orderId}` : ''}</p>
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
    <span className={`text-[9px] font-mono font-bold tracking-widest px-1.5 py-0.5 rounded border ${styles[status] || styles.none}`}>
      {labels[status] || status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Mission Control
// ---------------------------------------------------------------------------
export default function MissionControl() {
  const [expandedShops, setExpandedShops] = useState(new Set());
  const [shopLogs, setShopLogs] = useState({});
  const [shopLogLoading, setShopLogLoading] = useState(null);
  const [selectedPanel, setSelectedPanel] = useState('alerts');
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
    setExpandedShops(prev => {
      const next = new Set(prev);
      if (next.has(slug)) { next.delete(slug); }
      else { next.add(slug); if (!shopLogs[slug]) loadShopLogs(slug); }
      return next;
    });
  };

  const utc = now.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
  const local = now.toLocaleTimeString('en-US', { hour12: false });

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: '#080c14' }}>
      {/* ── TOP STATUS BAR ── */}
      <div className="flex items-center justify-between px-4 h-11 flex-shrink-0 border-b"
           style={{ borderColor: '#151b27', background: '#0a0f1a' }}>
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 group">
            <Rocket className="h-4 w-4 text-[#39C5BB]" />
            <span className="text-[13px] font-bold tracking-wider text-[#39C5BB]" style={{ fontFamily: 'Syne, sans-serif' }}>
              MISSION CONTROL
            </span>
          </Link>
          <div className="h-4 w-px bg-[#1b2333]" />
          <span className="text-[11px] font-mono text-[#484f58] flex items-center gap-1.5">
            <Clock className="h-3 w-3" /> {utc}
          </span>
          <span className="text-[11px] font-mono text-[#484f58]">LOCAL {local}</span>
        </div>
        <div className="flex items-center gap-5">
          {totalErrors > 0 && (
            <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1 animate-pulse">
              <AlertTriangle className="h-3 w-3" /> {totalErrors} ALERT{totalErrors !== 1 ? 'S' : ''}
            </span>
          )}
          <span className={`text-[11px] font-mono flex items-center gap-1 ${runningShops.length > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {runningShops.length > 0 ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {runningShops.length}/{shops.length} ONLINE
          </span>
          <button
            onClick={() => { refetchOverview(); refetchSysLogs(); refetchErrors(); }}
            className="text-[11px] font-mono text-[#484f58] hover:text-[#8b949e] flex items-center gap-1 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${overviewLoading ? 'animate-spin' : ''}`} /> SYNC
          </button>
          <Link to="/" className="text-[11px] font-mono text-[#484f58] hover:text-[#8b949e] flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> EXIT
          </Link>
        </div>
      </div>

      {/* ── MAIN AREA: LEFT PANEL | GLOBE | RIGHT PANEL ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* LEFT PANEL — Shops List */}
        <div className="w-[320px] flex-shrink-0 border-r flex flex-col overflow-hidden"
             style={{ borderColor: '#151b27', background: '#0a0f1a' }}>
          <div className="flex items-center justify-between px-3 py-2.5 border-b" style={{ borderColor: '#151b27' }}>
            <span className="text-[10px] font-mono font-bold tracking-[0.2em] text-[#484f58]">FLEET STATUS</span>
            <span className="text-[10px] font-mono text-[#39C5BB]">{shops.length} UNIT{shops.length !== 1 ? 'S' : ''}</span>
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
                      <span className="text-[12px] font-semibold text-[#c9d1d9] truncate">{shop.name}</span>
                      <LifecycleBadge status={shop.lifecycleStatus} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] font-mono text-[#484f58]">:{shop.port}</span>
                      <span className="text-[10px] font-mono text-[#484f58] truncate">{shop.subdomain}</span>
                      {shop.errorCount > 0 && (
                        <span className="text-[10px] font-mono text-amber-400">{shop.errorCount}ERR</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Link
                      to={`/shops/${shop.slug}/orders`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
                    >
                      ORD
                    </Link>
                    {expandedShops.has(shop.slug)
                      ? <ChevronUp className="h-3 w-3 text-[#484f58]" />
                      : <ChevronDown className="h-3 w-3 text-[#484f58]" />}
                  </div>
                </div>
                {expandedShops.has(shop.slug) && (
                  <div className="lp-fadein" style={{ borderColor: '#151b27' }}>
                    {/* Recent orders */}
                    {shop.recentOrders && shop.recentOrders.length > 0 && (
                      <div className="px-3 py-2 border-b" style={{ borderColor: '#151b27' }}>
                        <span className="text-[10px] font-mono font-bold tracking-[0.15em] text-[#484f58]">RECENT ORDERS</span>
                        <div className="mt-1.5 space-y-1">
                          {shop.recentOrders.map((ord, j) => {
                            const st = (ord.status || '').toLowerCase();
                            const stColor = st === 'shipped' ? 'text-emerald-400' : st.includes('cancel') ? 'text-red-400' : 'text-amber-400';
                            return (
                              <div key={j} className="flex items-center gap-2">
                                <span className="text-[11px] font-mono text-[#8b949e] flex-1 truncate">
                                  {ord.orderId || '—'}
                                </span>
                                <span className="text-[11px] font-mono text-[#484f58] truncate max-w-[80px]">
                                  {ord.customer || '—'}
                                </span>
                                <span className={`text-[10px] font-mono font-bold ${stColor}`}>
                                  {ord.status || 'Pending'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {/* Errors */}
                    {shop.recentErrors.length > 0 && (
                      <div className="px-3 py-2 bg-red-500/5 border-b" style={{ borderColor: '#151b27' }}>
                        {shop.recentErrors.slice(0, 3).map((err, j) => (
                          <p key={j} className="text-[11px] font-mono text-red-400/70 leading-relaxed truncate">{err}</p>
                        ))}
                      </div>
                    )}
                    {/* Docker logs */}
                    <div className="bg-[#060a12] text-[#8b949e] font-mono text-[11px] p-2 max-h-[140px] overflow-auto whitespace-pre-wrap leading-relaxed mc-scroll">
                      {shopLogLoading === shop.slug && !shopLogs[shop.slug] && (
                        <span className="text-[#484f58]">Loading...</span>
                      )}
                      {shopLogs[shop.slug] || ''}
                    </div>
                    <div className="flex items-center px-3 py-1 bg-[#0a0f1a]">
                      <button
                        onClick={() => loadShopLogs(shop.slug)}
                        className="flex items-center gap-1 text-[10px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
                      >
                        <RefreshCw className={`h-3 w-3 ${shopLogLoading === shop.slug ? 'animate-spin' : ''}`} /> RELOAD
                      </button>
                      <Link
                        to={`/shops/${shop.slug}/settings`}
                        className="ml-auto text-[10px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
                      >
                        CONFIG
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!shops.length && !overviewLoading && (
              <div className="text-center py-8 text-[#484f58] text-[11px] font-mono">NO FLEET UNITS DETECTED</div>
            )}
            {overviewLoading && !shops.length && (
              <div className="text-center py-8 text-[#484f58] text-[11px] font-mono animate-pulse">SCANNING...</div>
            )}
          </div>
        </div>

        {/* CENTER — Globe + Overlays */}
        <div className="flex-1 relative overflow-hidden" style={{ background: '#080c14' }}>
          <Globe className="absolute inset-0 w-full h-full" rocketCount={shops.length || 1} />

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
                <div className="text-[24px] font-bold font-mono" style={{ color: m.color }}>{m.value}</div>
                <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">{m.label}</div>
              </div>
            ))}
          </div>

          {/* Order notifications on globe */}
          {orderNotifications.length > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-none">
              {orderNotifications.slice(0, 3).map((n, i) => (
                <div key={n.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full lp-fadein"
                     style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}>
                  <Package className="h-3 w-3 text-emerald-400" />
                  <span className="text-[11px] font-mono text-emerald-300">NEW ORDER — {n.shop}</span>
                </div>
              ))}
            </div>
          )}

          {/* Bottom-left: Launchpad branding */}
          <div className="absolute bottom-3 left-3 pointer-events-none">
            <span className="text-[10px] font-mono text-[#1b2333]">LAUNCHPAD {typeof __APP_VERSION__ !== 'undefined' ? `LC-${__APP_VERSION__}` : ''}</span>
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
                className={`flex-1 text-[10px] font-mono font-bold tracking-[0.15em] py-2 transition-colors ${
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
                    <p className="text-[11px] font-mono text-emerald-400/60">ALL SYSTEMS NOMINAL</p>
                  </div>
                )}

                {/* Container down alerts */}
                {errors.filter(e => e.type === 'container_down').map((err, i) => (
                  <div key={`c-${i}`} className="flex items-start gap-2 px-3 py-2.5 border-b" style={{ borderColor: '#151b27' }}>
                    <div className="w-1 h-1 rounded-full bg-red-400 mt-1.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Server className="h-2.5 w-2.5 text-red-400" />
                        <span className="text-[11px] font-mono font-bold text-red-400">CONTAINER DOWN</span>
                      </div>
                      <p className="text-[10px] font-mono text-[#8b949e] mt-0.5">{err.name || err.slug}</p>
                      <p className="text-[10px] font-mono text-[#484f58]">{err.message}</p>
                    </div>
                  </div>
                ))}

                {/* System log warnings */}
                {errors.filter(e => e.type === 'system').map((err, i) => (
                  <div key={`s-${i}`} className="flex items-start gap-2 px-3 py-2 border-b" style={{ borderColor: '#151b27' }}>
                    <div className="w-1 h-1 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-mono text-amber-400/80 leading-relaxed break-all">{err.message}</p>
                    </div>
                  </div>
                ))}

                {/* Per-shop errors */}
                {shops.filter(s => s.errorCount > 0).map(shop => (
                  <div key={shop.slug} className="border-b" style={{ borderColor: '#151b27' }}>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117]">
                      <Store className="h-2.5 w-2.5 text-amber-400" />
                      <span className="text-[10px] font-mono font-bold text-[#c9d1d9]">{shop.name}</span>
                      <span className="text-[9px] font-mono text-amber-400 ml-auto">{shop.errorCount}</span>
                    </div>
                    <div className="px-3 py-1.5">
                      {shop.recentErrors.slice(0, 3).map((err, j) => (
                        <p key={j} className="text-[10px] font-mono text-red-400/60 leading-relaxed truncate">{err}</p>
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
                      <span className="text-[11px] font-mono text-[#8b949e] flex-1 truncate">{shop.name}</span>
                      <span className="text-[11px] font-mono text-[#484f58]">{count} ord</span>
                    </div>
                  );
                })}
                {!shops.length && (
                  <div className="text-center py-8 text-[#484f58] text-[11px] font-mono">NO ACTIVITY</div>
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
            <Terminal className="h-3 w-3 text-[#39C5BB]" />
            <span className="text-[10px] font-mono font-bold tracking-[0.2em] text-[#484f58]">SYSTEM LOG</span>
            {sysLogLoading && <RefreshCw className="h-2.5 w-2.5 text-[#39C5BB] animate-spin" />}
          </div>
          <button
            onClick={() => refetchSysLogs()}
            className="text-[9px] font-mono text-[#484f58] hover:text-[#39C5BB] transition-colors"
          >
            REFRESH
          </button>
        </div>
        <div
          ref={sysLogRef}
          className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed px-3 py-1 mc-scroll"
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
