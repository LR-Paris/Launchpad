import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, AlertTriangle, Server, RefreshCw,
  ChevronDown, ChevronUp, Terminal, ShieldAlert, Store, ShoppingCart, X,
  Rocket, Clock, Radio, Wifi, WifiOff, Package, Shield, Lock, Eye, Users,
  BarChart3, Globe as GlobeIcon, Smartphone, Monitor, TrendingUp, Activity
} from 'lucide-react';
import { getMissionOverview, getSystemLogs, getShopMissionLogs, getMissionErrors, getMissionSecurity, getMissionAnalytics, getOrders } from '../lib/api';

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

// Continent dot cloud — Natural Earth 110m land data, 585 points
// prettier-ignore
const LAND_DOTS = [
  // South America (tip)
  [-53.8,-67.7],[-55.1,-71],[-52.8,-74.7],[-51.1,-58.5],
  // Australia
  [-40.8,145.4],[-40.9,148.3],[-40.9,173],[-43.9,173.1],[-46.4,169.8],[-46.2,166.7],[-36.2,174.6],[-38,177.4],
  [-41.3,176],
  // Madagascar
  [-13.6,50.1],[-16.5,49.9],[-20.5,48.5],[-23.8,47.5],[-25,44],[-22.1,43.3],[-19,44.2],[-16.2,44.4],
  // Australia coast
  [-13.8,143.6],[-16.8,145.6],[-20,148.2],[-23.5,150.9],[-26.6,153.2],[-29.5,153.3],[-32.6,152.5],[-35.7,150.3],
  [-37.9,145],[-38.4,142.2],[-35.7,139.1],[-32.9,137.8],[-33.2,134.6],[-31.5,131.3],[-31.9,128.2],[-32.7,125.1],
  [-34,122.2],[-34.5,119.3],[-34.4,115.6],[-30.6,115.2],[-27.3,114],[-24.4,113.4],[-21.5,115.5],[-20.3,118.8],
  [-18.7,121.7],[-15.6,124.4],[-14.3,127.8],[-12.2,131.2],[-12,134.4],[-15,135.5],[-16.8,138.3],[-11,142.1],
  // Indonesia
  [-10.2,120.7],[-10.1,124.4],[-8.4,127.3],[-9,117.3],[-6.8,108.6],[-6.9,112.6],[-6.9,105.4],[-6.2,134.7],
  // Pacific islands
  [-5.9,154.7],[-5.6,151.5],[-5.7,148.3],[-3.5,127.2],[-3.1,130.5],[-2.7,150.7],[-1.2,134.1],[-1.7,137.4],
  [-2.6,141],[-3.9,144.6],[-9.1,148.7],[-7.6,144.7],[-8.1,139.1],
  // SE Asia islands
  [1.4,125.2],[0.4,121.1],[-3.2,122.5],[-5.4,119.4],[1.1,128.7],[-4.2,102.6],[-0.7,100.1],[2.5,97.7],
  [5.5,95.3],[2.1,100.6],[0.1,103.8],[-3.1,106.1],[1.8,117.9],[-1.5,116.6],[-3.1,113.3],[-2.9,110.2],
  [0.4,109],[3.1,113],[6.1,116.2],[5.4,119.2],[8.4,126.4],[5.6,125.4],[6.9,122.1],
  // Sri Lanka
  [6.2,81.2],[9.8,80.1],
  // Philippines + misc
  [10,123.6],[9.3,118.5],[13.1,121.5],[18.5,121.3],
  // Caribbean
  [10.1,-60.9],[18.2,-65.6],[17.9,-76.9],[19.9,-72.6],[19.3,-69.2],
  // Taiwan
  [18.7,110.3],[22.8,121.2],
  // Japan
  [34.1,134.6],[37.1,141],[33.9,131],[31,130.7],[37.3,136.7],[40.6,139.9],[44.2,143.9],
  // N America (east)
  [26.6,-77.8],[46.6,-63.7],[49.9,-64.5],[48.5,-123.5],[49.5,-126.9],[50.7,-56.1],[48.7,-53.1],[46.9,-56],
  [47.6,-59.3],
  // Russia Pacific
  [50.7,143.6],[47.9,142.6],[53.8,142.6],
  // British Isles
  [52.3,-6.8],[51.8,-10],[55.1,-7.6],
  // Europe (central)
  [55.6,12.7],[54,-132.7],
  // Alaska
  [57.1,-153],[58.6,-3],[54.6,-1.1],[52.7,1.7],[50.5,-2.5],[55.5,-4.7],
  // N America (various)
  [59.9,-165.6],[62.2,-79.3],[62.2,-83.1],[63.8,-171.7],[63.3,-168.7],[65.7,-85.2],
  // Iceland
  [66.5,-14.5],[63.7,-17.8],[64,-22.8],
  // N America (arctic)
  [67.1,-75.9],[66.6,-175],[66.9,-171.9],[65.4,-178.4],[69,-180],[69.1,-95.6],[69,-98.4],
  // Russia (far east)
  [70.8,180],[69.5,-90.5],[68.8,-85.6],[69.7,-82.6],
  // N America interior
  [64.1,-88.5],[62.8,-91.9],[58.9,-94.7],[57.3,-90.9],[56.5,-88],[55.3,-85],[53.3,-82.1],[51.5,-79.1],
  [55.1,-78.2],[58.1,-77.3],[62.3,-75.7],[61.5,-71.7],[58.8,-68.4],[59.9,-65.2],[57,-61.4],[54.9,-58],
  [49.1,-68.5],[43.5,-65.4],[44,-69.1],[41.3,-71.9],[38.9,-74.9],[35.6,-75.7],[33.9,-78.6],[30.7,-81.5],
  [25.6,-81.3],[29.6,-85.1],[30.4,-88.4],[29.7,-91.6],[29.5,-94.7],[26.7,-97.4],[22.9,-97.8],[19.9,-96.5],
  [18.4,-93.5],[19.9,-90.5],[21.5,-87.1],[17,-88.2],[15.9,-85.2],[13.1,-83.6],[10,-83],[9.3,-79.9],
  [8.6,-76.8],[11.2,-73.4],[11.4,-70.2],[10.5,-67.3],[10.4,-64.3],[7.3,-58.5],
  // South America
  [6,-55],[4.6,-51.8],[1.7,-50],[-1.2,-48.6],[-1.6,-44.9],[-2.9,-41.5],[-3.7,-38.5],[-5.1,-35.6],
  [-9,-35.1],[-12.2,-37.7],[-15.7,-38.9],[-19.6,-39.8],[-23,-42],[-23.8,-45.4],[-25.9,-48.5],[-28.7,-48.9],
  [-31.8,-51.6],[-35,-54.9],[-34.5,-57.8],[-38.2,-57.7],[-38.9,-61.2],[-40.8,-64.7],[-44.5,-65.3],[-48.1,-66],
  [-50.7,-69.1],[-48.7,-75.6],[-45.8,-74.7],[-42.4,-72.7],[-39.3,-73.2],[-35.5,-72.6],[-32.4,-71.4],
  [-28.9,-71.5],[-25.7,-70.7],[-21.4,-70.1],[-18.3,-70.4],[-16.4,-73.4],[-13.8,-76.4],[-10.4,-78.1],
  [-7.2,-79.8],[-4,-81.1],[-1.1,-80.9],[1.7,-79],[4.7,-77.3],
  // Central America
  [11.8,-86.5],[13.5,-89.8],[15.7,-96.6],[16.7,-99.7],[18.3,-103.5],[21.1,-105.3],[24.5,-107.9],[27.9,-110.6],
  [30.8,-113.2],[24,-110.9],[26.8,-113.5],[30.8,-116.3],[33.6,-117.9],[36.2,-121.7],[39.8,-123.9],[42.8,-124.5],
  // NW America
  [52.8,-129.1],[57.2,-133.5],[58.2,-136.6],[59.5,-139.9],[60,-144],[60.9,-147.1],[60.7,-151.4],[57.4,-156.3],
  [55.6,-159.6],[54.7,-163.1],[58.9,-159.7],[60,-162.5],[63.1,-164.6],[63.5,-161.5],[66.6,-164.5],[69.4,-163.2],
  [70.9,-159],[71.1,-155.1],[70.8,-152.2],[70.2,-147.6],[70.2,-143.6],[69.5,-139.1],[69.3,-135.6],[69.9,-131.4],
  [70,-128.4],[70.2,-124.4],[69.8,-121.5],[69,-117.6],[68.4,-113.9],[67.8,-110.8],[67.9,-107.8],[68,-104.3],
  // N Canada arctic
  [71.9,-95.2],[73.1,-114.2],[72.5,-111.1],[71.7,-108.2],[71.7,-104.8],[72.3,-118.6],[73.1,-76.3],[72.7,-79.5],
  [73.2,-86.6],[71.6,-72.2],[70.5,-68.8],[67.8,-64.9],[66.9,-61.9],[66.3,-68],[63.4,-64.7],[67.3,-72.7],
  [73.1,-89.4],[73.8,-100.4],
  // Russia arctic
  [73.2,143.6],[73.3,140],[73.7,-123.9],[75.1,150.7],[75.5,146.4],[75,-93.6],[74.9,-96.8],[75.3,137],
  [75.8,-107.8],[75.2,-117.7],[75.5,-110.8],[70.7,57.5],[70.8,53.7],[73.7,53.5],[75.6,57.9],[75.7,64.6],
  [75.3,61.6],[75.8,-82.8],[75.8,114.1],[74.5,110.2],[73.6,118.8],[73,123.2],[73.6,127],[70.8,131.3],
  [71.7,135.6],[72.2,149.5],[70.8,153],[71,157],[70.5,159.8],[69.7,164.1],[69.6,167.8],[69,170.8],
  [69.9,175.7],
  // Russia / E Asia coast
  [65,180],[61.8,174.6],[60.3,170.7],[59.8,166.3],[59.9,163.5],[56.2,163.1],[53.2,160],[51,156.8],
  [55.4,155.4],[58.1,158.4],[61.8,159.3],[59.8,154.2],[58.8,151.3],[59.2,148.5],[59.3,145.5],[59,142.2],
  [57.1,139],[54.7,135.1],[53.8,138.2],[47,138.6],[44,135.5],[43.3,132.3],[40.7,129.2],[37.4,129.2],
  [34.5,127.4],[37.7,126.2],[39.6,122.9],[39.9,119.6],[36.7,121.1],[33.4,120.6],[30.1,121.5],[27.1,120.4],
  [23.6,117.3],[22.2,114.2],[21.7,108.5],
  // SE Asia mainland
  [18,106.4],[13.4,109.3],[10.4,107.2],[10.5,104.3],[12.6,100.8],[9.2,99.2],[6.2,102.1],[3.4,103.4],
  [14.8,97.8],[15.8,94.8],[19.4,93.5],[22.2,91.8],[21.7,88.9],[19.5,85.1],[17,82.2],[13.8,80.2],
  // India
  [8.9,76.6],[11.8,75.4],[16,73.5],[19.2,72.8],[22.1,69.2],[25.4,66.4],[25.2,62.9],[25.4,59.6],
  // Middle East
  [27.1,56.5],[26.8,53.5],[30.1,50.1],[27.1,49.5],[24,51.8],[24.2,56.8],[22.5,59.8],[19.7,57.7],
  [17,54.8],[15.2,51.2],[13.9,48.2],[13,45.4],[15.9,42.8],[19.5,40.9],[22.6,39.1],[25.6,36.9],
  [28.6,34.8],
  // Horn of Africa / E Africa
  [19.8,37.1],[15.9,39.3],[12,51.1],[9.2,50.6],[5.3,48.6],[2,45.6],[-0.9,42],[-3.7,39.8],
  [-6.5,38.8],[-10.1,39.9],[-14.2,40.6],[-17.1,38.5],[-19.6,35.2],
  // Southern Africa
  [-23.1,35.5],[-25.7,32.6],[-28.8,32.2],[-32.2,28.9],[-33.7,25.9],[-33.9,23],[-34.8,20.1],
  // West Africa coast
  [-31.7,18.2],[-28.6,16.3],[-25.4,14.7],[-22.1,14.3],[-19,12.6],[-15.8,11.8],[-12.5,13.3],[-9.2,12.9],
  [-6.3,12.2],[-3,10.1],[0.3,9.3],[3.1,9.8],[4.2,6.7],[6.3,3.6],[5.3,-0.5],[5,-3.3],
  [4.7,-6.5],[5.6,-9.9],[7.8,-12.9],[10.7,-14.7],[13.6,-16.7],[16.7,-16.5],[19.6,-16.4],[22.7,-16.3],
  [25.6,-14.8],[28.1,-11.7],[31.2,-9.8],
  // North Africa coast
  [34.1,-6.9],[35.4,-3.6],[35.9,-0.1],[36.8,3.2],[37.1,6.3],[37.4,9.5],[34.3,10.1],[32.9,13.1],
  [31.2,16.6],[30.5,19.6],[32.6,22.9],[31.6,26.5],[31.2,29.7],[31.5,34.6],
  // Turkey / Black Sea
  [36.6,31.7],[36.7,28.7],[40.4,27.3],[41.1,31.1],[42,35.2],[40.9,38.3],[41.5,41.6],[44.3,38.7],
  [47.3,39.1],[46.6,35.8],[45.3,32.5],[45.3,29.6],
  // Balkans / Greece
  [40.7,23.7],[38.8,20.7],[41.7,19.5],[43.5,16],[45.7,13.1],
  // Italy
  [41.3,12.9],[38.2,15.5],[37.6,12.4],[35.7,23.7],[35.7,34.6],
  // W Europe
  [44.4,8.9],[43.4,4.6],[41,0.8],[37.1,-7.5],[40.2,-9],[43.7,-8],[43.4,-4.3],[44,-1.4],
  [47.1,-2.2],[53.1,4.7],[53.7,7.9],[56.8,8.3],
  // Baltics / E Europe
  [54.5,16.4],[54.4,19.7],[57.4,21.6],[59.5,24.6],[59.5,28],[60.7,21.3],[63.8,22.4],[65.1,25.4],
  // Scandinavia
  [62.7,17.8],[59,17.9],[59.7,5.3],[62.6,5.9],[64.5,10.5],[67.8,14.8],[69.8,19.2],[70.2,23],
  [71,26.4],[70.5,31.3],
  // Russia west / Caucasus
  [69.1,36.5],[67.9,40.3],[66.6,33.2],[64.1,36.2],[64.5,39.6],[66.1,43.9],[67.7,46.8],[68,50.2],
  [68.9,61.1],[69.2,64.9],[68.1,68.5],[71.9,68.5],[72.8,72.6],[69,72.6],[72.3,75.7],[72.3,79.7],
  [73.8,84.7],[75.1,88.3],[75.8,92.9],[75.9,96.7],
  // Central Asia / Caspian
  [41.3,49.1],[38.3,48.9],[36.7,52.3],[40,53.4],[44.3,50.3],[46.2,53.2],[44.6,46.7],
  // Greenland
  [75.2,-19.6],[73.3,-23.6],[70.2,-26.4],[70.1,-22.3],[68.1,-30.7],[66.7,-34.2],[65.7,-38.4],
  [63.5,-41.2],[60.1,-43.4],[60.9,-46.3],[61.4,-49.2],[64.3,-52.1],[67.2,-54],[69.1,-51.1],
  [70.3,-54.8],[73.6,-56.1],
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

// Country code → flag emoji
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
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
  const { data: securityData, refetch: refetchSecurity } = useQuery({
    queryKey: ['mission-security'], queryFn: getMissionSecurity, refetchInterval: 30000,
  });
  const { data: analyticsData, refetch: refetchAnalytics } = useQuery({
    queryKey: ['mission-analytics'], queryFn: getMissionAnalytics, refetchInterval: 15000,
  });

  const security = securityData || {};
  const analytics = analyticsData || {};
  const liveVisitors = analytics.liveVisitors || 0;
  const totalViews24h = analytics.totalViews || 0;
  const totalVisitors24h = analytics.totalVisitors || 0;
  const shopTraffic = analytics.shopBreakdown || [];
  const trafficTimeseries = analytics.timeseries || [];
  const trafficCountries = analytics.topCountries || [];
  const trafficPages = analytics.topPages || [];
  const trafficProducts = analytics.topProducts || [];
  const trafficDevices = analytics.devices || { mobile: 0, tablet: 0, desktop: 0, total: 0 };
  const recentPageViews = analytics.recentViews || [];
  const hourlyHeatmap = analytics.hourlyHeatmap || [];

  // Build traffic lookup per shop slug for left panel
  const shopTrafficMap = {};
  for (const s of shopTraffic) shopTrafficMap[s.slug] = s;
  const securityScore = security.securityScore ?? 100;
  const recentSecEvents = security.recentEvents || [];
  const stats24h = security.stats24h || {};
  const failedLogins = security.failedLogins || [];
  const activeSessions = security.activeSessions ?? 0;

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
          <span className={`text-[11px] font-mono flex items-center gap-1 ${
            securityScore >= 80 ? 'text-emerald-400' : securityScore >= 50 ? 'text-amber-400' : 'text-red-400'
          }`}>
            <Shield className="h-3 w-3" /> SEC {securityScore}
          </span>
          <span className={`text-[11px] font-mono flex items-center gap-1 ${liveVisitors > 0 ? 'text-cyan-400' : 'text-[#484f58]'}`}>
            <Eye className="h-3 w-3" /> {liveVisitors} LIVE
          </span>
          <span className="text-[11px] font-mono flex items-center gap-1 text-[#484f58]">
            <BarChart3 className="h-3 w-3" /> {totalViews24h.toLocaleString()} VW
          </span>
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
            onClick={() => { refetchOverview(); refetchSysLogs(); refetchErrors(); refetchSecurity(); refetchAnalytics(); }}
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
                      {shopTrafficMap[shop.slug] && (
                        <span className="text-[10px] font-mono text-cyan-400/70">
                          {shopTrafficMap[shop.slug].views}vw
                        </span>
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
              { label: 'SECURITY', value: securityScore, color: securityScore >= 80 ? '#34d399' : securityScore >= 50 ? '#fbbf24' : '#f87171' },
              { label: 'VISITORS', value: liveVisitors, color: liveVisitors > 0 ? '#22d3ee' : '#484f58' },
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
              { id: 'analytics', label: 'TRAFFIC', count: liveVisitors || 0 },
              { id: 'security', label: 'SECURITY', count: stats24h.loginFailed || 0 },
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

            {selectedPanel === 'analytics' && (
              <>
                {/* Live + 24h summary */}
                <div className="grid grid-cols-3 border-b" style={{ borderColor: '#151b27' }}>
                  <div className="text-center py-3 border-r" style={{ borderColor: '#151b27' }}>
                    <div className={`text-[18px] font-bold font-mono ${liveVisitors > 0 ? 'text-cyan-400' : 'text-[#484f58]'}`}>
                      {liveVisitors}
                    </div>
                    <div className="text-[8px] font-mono tracking-[0.15em] text-[#484f58]">LIVE NOW</div>
                  </div>
                  <div className="text-center py-3 border-r" style={{ borderColor: '#151b27' }}>
                    <div className="text-[18px] font-bold font-mono text-[#c9d1d9]">{totalViews24h.toLocaleString()}</div>
                    <div className="text-[8px] font-mono tracking-[0.15em] text-[#484f58]">VIEWS 24H</div>
                  </div>
                  <div className="text-center py-3">
                    <div className="text-[18px] font-bold font-mono text-[#c9d1d9]">{totalVisitors24h.toLocaleString()}</div>
                    <div className="text-[8px] font-mono tracking-[0.15em] text-[#484f58]">VISITORS</div>
                  </div>
                </div>

                {/* Hourly sparkline (CSS-based) */}
                <div className="px-3 py-3 border-b" style={{ borderColor: '#151b27' }}>
                  <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58] mb-2">TRAFFIC 24H</div>
                  {trafficTimeseries.length > 0 ? (
                    <div className="flex items-end gap-px h-[48px]">
                      {(() => {
                        const maxV = Math.max(...trafficTimeseries.map(t => t.views), 1);
                        return trafficTimeseries.map((t, i) => {
                          const h = Math.max(2, (t.views / maxV) * 100);
                          const isRecent = i >= trafficTimeseries.length - 2;
                          return (
                            <div key={i} className="flex-1 flex flex-col items-center justify-end group relative">
                              <div
                                className="w-full rounded-t-sm transition-all duration-300 min-h-[2px]"
                                style={{
                                  height: `${h}%`,
                                  background: isRecent ? '#22d3ee' : 'rgba(57,197,187,0.4)',
                                }}
                              />
                              <div className="absolute bottom-full mb-1 hidden group-hover:block px-1.5 py-0.5 rounded text-[9px] font-mono text-[#c9d1d9] whitespace-nowrap z-10"
                                   style={{ background: '#0d1520', border: '1px solid #1b2333' }}>
                                {t.period.split(' ')[1] || t.period} — {t.views}vw / {t.visitors}uv
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  ) : (
                    <div className="h-[48px] flex items-center justify-center text-[10px] font-mono text-[#484f58]">
                      NO TRAFFIC DATA
                    </div>
                  )}
                </div>

                {/* Per-shop traffic breakdown */}
                <div className="border-b" style={{ borderColor: '#151b27' }}>
                  <div className="px-3 py-2">
                    <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">SHOP TRAFFIC</div>
                  </div>
                  {shopTraffic.length > 0 ? shopTraffic.map((s, i) => {
                    const maxViews = shopTraffic[0]?.views || 1;
                    const barPct = Math.max(3, (s.views / maxViews) * 100);
                    return (
                      <div key={i} className="px-3 py-1.5 border-t hover:bg-[#0d1520] transition-colors" style={{ borderColor: '#151b27' }}>
                        <div className="flex items-center gap-2 mb-1">
                          <Store className="h-2.5 w-2.5 text-[#39C5BB]" />
                          <span className="text-[10px] font-mono font-bold text-[#c9d1d9] flex-1 truncate">{s.name}</span>
                          {s.topCountry && (
                            <span className="text-[10px]" title={s.topCountry}>{countryFlag(s.topCountry)}</span>
                          )}
                          <span className="text-[10px] font-mono text-cyan-400">{s.views}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-[4px] rounded-full overflow-hidden" style={{ background: '#151b27' }}>
                            <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: 'rgba(34,211,238,0.5)' }} />
                          </div>
                          <span className="text-[9px] font-mono text-[#484f58]">{s.visitors}uv</span>
                        </div>
                      </div>
                    );
                  }) : (
                    <div className="text-center py-4 text-[10px] font-mono text-[#484f58]">NO SHOP TRAFFIC</div>
                  )}
                </div>

                {/* Top Countries */}
                <div className="border-b" style={{ borderColor: '#151b27' }}>
                  <div className="px-3 py-2">
                    <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">TOP COUNTRIES</div>
                  </div>
                  {trafficCountries.length > 0 ? trafficCountries.slice(0, 8).map((c, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1 border-t" style={{ borderColor: '#151b27' }}>
                      <span className="text-[12px] w-5 text-center">{c.flag}</span>
                      <span className="text-[10px] font-mono text-[#8b949e] w-[32px]">{c.country}</span>
                      <div className="flex-1 h-[4px] rounded-full overflow-hidden" style={{ background: '#151b27' }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.max(3, c.percentage)}%`, background: 'rgba(57,197,187,0.5)' }} />
                      </div>
                      <span className="text-[9px] font-mono text-[#484f58] w-[36px] text-right">{c.views}</span>
                      <span className="text-[9px] font-mono text-[#484f58] w-[28px] text-right">{c.percentage}%</span>
                    </div>
                  )) : (
                    <div className="text-center py-4 text-[10px] font-mono text-[#484f58]">NO GEO DATA</div>
                  )}
                </div>

                {/* Device Breakdown */}
                <div className="border-b" style={{ borderColor: '#151b27' }}>
                  <div className="px-3 py-2">
                    <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">DEVICES</div>
                  </div>
                  {trafficDevices.total > 0 ? (
                    <div className="px-3 pb-2.5">
                      <div className="flex h-[6px] rounded-full overflow-hidden mb-2" style={{ background: '#151b27' }}>
                        {trafficDevices.desktop > 0 && (
                          <div style={{ width: `${(trafficDevices.desktop / trafficDevices.total) * 100}%`, background: '#39C5BB' }} />
                        )}
                        {trafficDevices.tablet > 0 && (
                          <div style={{ width: `${(trafficDevices.tablet / trafficDevices.total) * 100}%`, background: '#818cf8' }} />
                        )}
                        {trafficDevices.mobile > 0 && (
                          <div style={{ width: `${(trafficDevices.mobile / trafficDevices.total) * 100}%`, background: '#fbbf24' }} />
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <Monitor className="h-2.5 w-2.5 text-[#39C5BB]" />
                          <span className="text-[9px] font-mono text-[#8b949e]">
                            {Math.round((trafficDevices.desktop / trafficDevices.total) * 100)}%
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-mono text-[#8b949e]" style={{ color: '#818cf8' }}>TAB</span>
                          <span className="text-[9px] font-mono text-[#8b949e]">
                            {Math.round((trafficDevices.tablet / trafficDevices.total) * 100)}%
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Smartphone className="h-2.5 w-2.5 text-amber-400" />
                          <span className="text-[9px] font-mono text-[#8b949e]">
                            {Math.round((trafficDevices.mobile / trafficDevices.total) * 100)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-3 text-[10px] font-mono text-[#484f58]">NO DEVICE DATA</div>
                  )}
                </div>

                {/* Top Products */}
                {trafficProducts.length > 0 && (
                  <div className="border-b" style={{ borderColor: '#151b27' }}>
                    <div className="px-3 py-2">
                      <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">POPULAR PRODUCTS</div>
                    </div>
                    {trafficProducts.slice(0, 6).map((p, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-1 border-t" style={{ borderColor: '#151b27' }}>
                        <span className="text-[9px] font-mono text-[#484f58] w-[14px]">{i + 1}</span>
                        <span className="text-[10px] font-mono text-[#8b949e] flex-1 truncate">{p.product_slug}</span>
                        <span className="text-[9px] font-mono text-[#484f58] truncate max-w-[60px]">{p.shopName}</span>
                        <span className="text-[10px] font-mono text-cyan-400">{p.views}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Hourly Heatmap (7d) */}
                {hourlyHeatmap.length > 0 && (
                  <div className="border-b" style={{ borderColor: '#151b27' }}>
                    <div className="px-3 py-2">
                      <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">WEEKLY HEATMAP</div>
                    </div>
                    <div className="px-3 pb-2.5">
                      <div className="flex gap-px">
                        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, dow) => {
                          const dayData = hourlyHeatmap.filter(h => h.dow === dow);
                          return (
                            <div key={dow} className="flex-1 flex flex-col gap-px items-center">
                              <span className="text-[7px] font-mono text-[#484f58] mb-0.5">{day}</span>
                              {Array.from({ length: 24 }, (_, hour) => {
                                const cell = dayData.find(d => d.hour === hour);
                                const maxH = Math.max(...hourlyHeatmap.map(h => h.views), 1);
                                const intensity = cell ? cell.views / maxH : 0;
                                return (
                                  <div
                                    key={hour}
                                    className="w-full aspect-square rounded-[1px]"
                                    style={{
                                      background: intensity > 0
                                        ? `rgba(34,211,238,${0.1 + intensity * 0.8})`
                                        : '#0d1117',
                                    }}
                                    title={`${day} ${hour}:00 — ${cell?.views || 0} views`}
                                  />
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Live Feed — Recent Page Views */}
                <div>
                  <div className="px-3 py-2 border-b" style={{ borderColor: '#151b27' }}>
                    <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">LIVE FEED</div>
                  </div>
                  {recentPageViews.length > 0 ? recentPageViews.map((v, i) => {
                    const time = v.timestamp ? new Date(v.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
                    return (
                      <div key={i} className="flex items-start gap-2 px-3 py-1.5 border-b hover:bg-[#0d1520] transition-colors" style={{ borderColor: '#151b27' }}>
                        <div className="w-1 h-1 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0" style={{ opacity: i === 0 ? 1 : 0.4 + (1 - i / 20) * 0.6 }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-cyan-400/80 truncate">{v.shopName}</span>
                            <span className="text-[9px] font-mono text-[#484f58] ml-auto">{time}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-mono text-[#8b949e] truncate">{v.path}</span>
                            {v.flag && <span className="text-[10px]">{v.flag}</span>}
                            <span className="text-[8px] font-mono text-[#484f58] ml-auto">{v.visitorId}</span>
                          </div>
                          {v.productSlug && (
                            <span className="text-[9px] font-mono text-amber-400/60">product: {v.productSlug}</span>
                          )}
                        </div>
                      </div>
                    );
                  }) : (
                    <div className="text-center py-8 text-[#484f58] text-[11px] font-mono">NO PAGE VIEWS YET</div>
                  )}
                </div>
              </>
            )}

            {selectedPanel === 'security' && (
              <>
                {/* Security Score */}
                <div className="flex flex-col items-center py-5 border-b" style={{ borderColor: '#151b27' }}>
                  <div className="relative w-16 h-16 flex items-center justify-center">
                    <svg className="absolute inset-0 w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                      <circle cx="32" cy="32" r="28" fill="none" stroke="#151b27" strokeWidth="3" />
                      <circle cx="32" cy="32" r="28" fill="none"
                        stroke={securityScore >= 80 ? '#34d399' : securityScore >= 50 ? '#fbbf24' : '#f87171'}
                        strokeWidth="3" strokeLinecap="round"
                        strokeDasharray={`${securityScore * 1.76} 176`} />
                    </svg>
                    <span className={`text-[18px] font-bold font-mono ${
                      securityScore >= 80 ? 'text-emerald-400' : securityScore >= 50 ? 'text-amber-400' : 'text-red-400'
                    }`}>{securityScore}</span>
                  </div>
                  <span className="text-[10px] font-mono tracking-[0.2em] text-[#484f58] mt-2">SECURITY SCORE</span>
                </div>

                {/* Quick stats row */}
                <div className="grid grid-cols-3 border-b" style={{ borderColor: '#151b27' }}>
                  <div className="text-center py-2.5 border-r" style={{ borderColor: '#151b27' }}>
                    <div className="text-[16px] font-bold font-mono text-[#c9d1d9]">{activeSessions}</div>
                    <div className="text-[8px] font-mono tracking-[0.15em] text-[#484f58]">SESSIONS</div>
                  </div>
                  <div className="text-center py-2.5 border-r" style={{ borderColor: '#151b27' }}>
                    <div className="text-[16px] font-bold font-mono text-[#c9d1d9]">{stats24h.uniqueIPs || 0}</div>
                    <div className="text-[8px] font-mono tracking-[0.15em] text-[#484f58]">UNIQUE IPS</div>
                  </div>
                  <div className="text-center py-2.5">
                    <div className="text-[16px] font-bold font-mono text-[#c9d1d9]">{stats24h.totalEvents || 0}</div>
                    <div className="text-[8px] font-mono tracking-[0.15em] text-[#484f58]">EVENTS 24H</div>
                  </div>
                </div>

                {/* 24h Event Breakdown */}
                <div className="px-3 py-3 border-b" style={{ borderColor: '#151b27' }}>
                  <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58] mb-2.5">24H EVENT BREAKDOWN</div>
                  {[
                    { label: 'LOGIN OK', value: stats24h.loginSuccess || 0, color: '#34d399' },
                    { label: 'LOGIN FAIL', value: stats24h.loginFailed || 0, color: '#f87171' },
                    { label: 'PW CHANGES', value: stats24h.passwordChanges || 0, color: '#fbbf24' },
                    { label: 'SHOP OPS', value: stats24h.shopActions || 0, color: '#39C5BB' },
                    { label: 'FILE OPS', value: stats24h.fileOperations || 0, color: '#818cf8' },
                  ].map(row => {
                    const maxVal = stats24h.totalEvents || 1;
                    const pct = Math.max(2, (row.value / maxVal) * 100);
                    return (
                      <div key={row.label} className="flex items-center gap-2 mb-1.5">
                        <span className="text-[9px] font-mono text-[#484f58] w-[72px] shrink-0">{row.label}</span>
                        <div className="flex-1 h-[6px] rounded-full overflow-hidden" style={{ background: '#151b27' }}>
                          {row.value > 0 && (
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${pct}%`, background: row.color, opacity: 0.8 }} />
                          )}
                        </div>
                        <span className="text-[10px] font-mono text-[#8b949e] w-[24px] text-right">{row.value}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Failed Login Attempts */}
                <div className="border-b" style={{ borderColor: '#151b27' }}>
                  <div className="px-3 py-2">
                    <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">FAILED LOGIN ATTEMPTS</div>
                  </div>
                  {failedLogins.length === 0 ? (
                    <div className="text-center py-4 pb-5">
                      <Lock className="h-4 w-4 text-emerald-400/40 mx-auto mb-1" />
                      <p className="text-[10px] font-mono text-emerald-400/60">NO FAILED LOGINS (24H)</p>
                    </div>
                  ) : (
                    failedLogins.map((fl, i) => (
                      <div key={i} className="flex items-start gap-2 px-3 py-2 border-t" style={{ borderColor: '#151b27' }}>
                        <div className="w-1 h-1 rounded-full bg-red-400 mt-1.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-red-400">{fl.actor || 'unknown'}</span>
                            <span className="text-[9px] font-mono text-[#484f58] ml-auto">
                              {fl.timestamp ? new Date(fl.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''}
                            </span>
                          </div>
                          <span className="text-[9px] font-mono text-[#484f58]">IP: {fl.ip || 'unknown'}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Recent Security Events */}
                <div>
                  <div className="px-3 py-2 border-b" style={{ borderColor: '#151b27' }}>
                    <div className="text-[9px] font-mono tracking-[0.2em] text-[#484f58]">RECENT EVENTS</div>
                  </div>
                  {recentSecEvents.length === 0 ? (
                    <div className="text-center py-8 text-[#484f58] text-[11px] font-mono">NO AUDIT DATA</div>
                  ) : (
                    recentSecEvents.map((evt, i) => {
                      const isFailure = /failed/.test(evt.event);
                      const isDestructive = /deleted|wiped|password_changed/.test(evt.event);
                      const isSuccess = /login_success/.test(evt.event);
                      const dotColor = isFailure ? 'bg-red-400' : isDestructive ? 'bg-amber-400' : isSuccess ? 'bg-emerald-400' : 'bg-cyan-400';
                      const textColor = isFailure ? 'text-red-400' : isDestructive ? 'text-amber-400' : isSuccess ? 'text-emerald-400/80' : 'text-[#8b949e]';
                      const eventLabel = evt.event.replace(/_/g, ' ').toUpperCase();
                      const time = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
                      return (
                        <div key={i} className="flex items-start gap-2 px-3 py-1.5 border-b hover:bg-[#0d1520] transition-colors" style={{ borderColor: '#151b27' }}>
                          <div className={`w-1 h-1 rounded-full ${dotColor} mt-1.5 flex-shrink-0`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-[10px] font-mono font-bold ${textColor}`}>{eventLabel}</span>
                              <span className="text-[9px] font-mono text-[#484f58] ml-auto">{time}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-mono text-[#484f58]">{evt.actor || 'system'}</span>
                              {evt.ip && <span className="text-[9px] font-mono text-[#484f58]">{evt.ip}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
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
