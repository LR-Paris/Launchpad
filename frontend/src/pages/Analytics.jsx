import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, BarChart3, Eye, Users, Globe, Monitor, Smartphone, Tablet,
  TrendingUp, Package, ExternalLink, RefreshCw, MousePointerClick
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area, BarChart, Bar, Cell
} from 'recharts';
import { getAnalyticsOverview } from '../lib/api';

const RANGES = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
];

function MetricCard({ icon: Icon, label, value, sub, color = 'text-[#c9d1d9]' }) {
  return (
    <div className="lp-card p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-mono tracking-wider uppercase">{label}</span>
      </div>
      <div className={`text-[28px] font-bold font-mono ${color}`}>{value}</div>
      {sub && <span className="text-[11px] font-mono text-muted-foreground">{sub}</span>}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#0d1520] border border-[#1b2333] rounded-lg px-3 py-2 shadow-xl">
      <p className="text-[11px] font-mono text-muted-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-[12px] font-mono" style={{ color: p.color }}>
          {p.name}: {p.value.toLocaleString()}
        </p>
      ))}
    </div>
  );
}

function CountryRow({ country, flag, views, visitors, percentage, maxViews }) {
  const barPct = maxViews > 0 ? (views / maxViews) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-2 px-3 hover:bg-muted/5 transition-colors">
      <span className="text-[16px] w-7 text-center">{flag}</span>
      <span className="text-[12px] font-mono text-[#c9d1d9] w-[44px]">{country || 'N/A'}</span>
      <div className="flex-1 h-[6px] rounded-full overflow-hidden bg-muted/10">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(2, barPct)}%`, background: 'hsl(188 100% 42% / 0.6)' }}
        />
      </div>
      <span className="text-[11px] font-mono text-muted-foreground w-[48px] text-right">{views.toLocaleString()}</span>
      <span className="text-[11px] font-mono text-muted-foreground/60 w-[36px] text-right">{percentage}%</span>
    </div>
  );
}

function DeviceBreakdown({ devices }) {
  const total = devices.total || 1;
  const items = [
    { label: 'Desktop', icon: Monitor, count: devices.desktop, color: '#39C5BB' },
    { label: 'Tablet', icon: Tablet, count: devices.tablet, color: '#818cf8' },
    { label: 'Mobile', icon: Smartphone, count: devices.mobile, color: '#fbbf24' },
  ];
  return (
    <div className="flex gap-4">
      {items.map(d => {
        const pct = Math.round((d.count / total) * 100) || 0;
        return (
          <div key={d.label} className="flex-1 lp-card p-3 text-center">
            <d.icon className="h-4 w-4 mx-auto mb-1.5" style={{ color: d.color }} />
            <div className="text-[18px] font-bold font-mono text-[#c9d1d9]">{pct}%</div>
            <div className="text-[10px] font-mono text-muted-foreground">{d.label}</div>
            <div className="text-[10px] font-mono text-muted-foreground/60">{d.count.toLocaleString()}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Analytics() {
  const { slug } = useParams();
  const [range, setRange] = useState('7d');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['analytics-overview', slug, range],
    queryFn: () => getAnalyticsOverview(slug, range),
    refetchInterval: 60000,
  });

  const overview = data || {};
  const timeseries = overview.timeseries || [];
  const topPages = overview.topPages || [];
  const topCountries = overview.topCountries || [];
  const topProducts = overview.topProducts || [];
  const devices = overview.devices || { mobile: 0, tablet: 0, desktop: 0, total: 0 };
  const topReferrers = overview.topReferrers || [];
  const maxCountryViews = topCountries.length > 0 ? topCountries[0].views : 0;

  // Build chart data with short labels
  const chartData = timeseries.map(p => ({
    ...p,
    label: range === '24h'
      ? p.period.split(' ')[1]?.slice(0, 5) || p.period
      : p.period.length > 10 ? p.period.slice(5) : p.period,
  }));

  // Bar chart data for products
  const productChartData = topProducts.slice(0, 8).map(p => ({
    name: (p.name || p.productSlug || '').slice(0, 16),
    views: p.views,
  }));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to={`/shops/${slug}/orders`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-primary" />
              Analytics
            </h1>
            <p className="text-sm text-muted-foreground font-mono mt-0.5">{slug}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/10 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
          <div className="flex rounded-lg border border-border/50 overflow-hidden">
            {RANGES.map(r => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={`px-3 py-1.5 text-[11px] font-mono font-bold tracking-wider transition-colors ${
                  range === r.value
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/10'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-20">
          <RefreshCw className="h-6 w-6 text-primary animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-muted-foreground">Loading analytics...</p>
        </div>
      ) : (
        <>
          {/* Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              icon={Eye}
              label="Total Views"
              value={(overview.totalViews || 0).toLocaleString()}
              color="text-primary"
            />
            <MetricCard
              icon={Users}
              label="Unique Visitors"
              value={(overview.uniqueVisitors || 0).toLocaleString()}
              color="text-[#c9d1d9]"
            />
            <MetricCard
              icon={TrendingUp}
              label="Avg / Day"
              value={(overview.avgViewsPerDay || 0).toLocaleString()}
              color="text-emerald-400"
            />
            <MetricCard
              icon={Globe}
              label="Countries"
              value={topCountries.length}
              color="text-amber-400"
            />
          </div>

          {/* Views Line Chart */}
          <div className="lp-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5" /> Traffic Over Time
              </h2>
              <div className="flex items-center gap-4 text-[11px] font-mono">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#39C5BB' }} />
                  Views
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#818cf8' }} />
                  Visitors
                </span>
              </div>
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                  <defs>
                    <linearGradient id="viewsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#39C5BB" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#39C5BB" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="visitorsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#818cf8" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#818cf8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 6" stroke="hsl(220 20% 14%)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fill: '#484f58' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fill: '#484f58' }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    type="monotone" dataKey="views" name="Views"
                    stroke="#39C5BB" strokeWidth={2} fill="url(#viewsGrad)" dot={false}
                  />
                  <Area
                    type="monotone" dataKey="visitors" name="Visitors"
                    stroke="#818cf8" strokeWidth={1.5} fill="url(#visitorsGrad)" dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[280px] text-muted-foreground text-sm font-mono">
                No traffic data yet for this period
              </div>
            )}
          </div>

          {/* Two column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top Countries */}
            <div className="lp-card p-4">
              <h2 className="text-sm font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-2 mb-3 px-3">
                <Globe className="h-3.5 w-3.5" /> Top Countries
              </h2>
              {topCountries.length > 0 ? (
                <div className="space-y-0">
                  {topCountries.slice(0, 10).map((c, i) => (
                    <CountryRow key={i} {...c} maxViews={maxCountryViews} />
                  ))}
                </div>
              ) : (
                <p className="text-center py-8 text-sm font-mono text-muted-foreground">No country data yet</p>
              )}
            </div>

            {/* Top Pages */}
            <div className="lp-card p-4">
              <h2 className="text-sm font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-2 mb-3 px-3">
                <MousePointerClick className="h-3.5 w-3.5" /> Top Pages
              </h2>
              {topPages.length > 0 ? (
                <div className="space-y-0">
                  {topPages.slice(0, 10).map((p, i) => (
                    <div key={i} className="flex items-center gap-3 py-2 px-3 hover:bg-muted/5 transition-colors">
                      <span className="text-[11px] font-mono text-muted-foreground/60 w-[18px]">{i + 1}</span>
                      <span className="text-[12px] font-mono text-[#c9d1d9] flex-1 truncate">{p.path}</span>
                      <span className="text-[11px] font-mono text-primary w-[48px] text-right">{p.views.toLocaleString()}</span>
                      <span className="text-[11px] font-mono text-muted-foreground/60 w-[48px] text-right">{p.uniqueVisitors} uv</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center py-8 text-sm font-mono text-muted-foreground">No page data yet</p>
              )}
            </div>
          </div>

          {/* Popular Products + Devices + Referrers */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Popular Products */}
            <div className="lp-card p-4 lg:col-span-2">
              <h2 className="text-sm font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-2 mb-3">
                <Package className="h-3.5 w-3.5" /> Most Viewed Products
              </h2>
              {productChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={productChartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }} layout="vertical">
                    <CartesianGrid strokeDasharray="3 6" stroke="hsl(220 20% 14%)" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fill: '#484f58' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      dataKey="name"
                      type="category"
                      tick={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fill: '#8b949e' }}
                      axisLine={false}
                      tickLine={false}
                      width={120}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="views" name="Views" radius={[0, 4, 4, 0]}>
                      {productChartData.map((_, i) => (
                        <Cell key={i} fill={i === 0 ? '#39C5BB' : 'hsl(188 100% 42% / 0.4)'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[220px] text-muted-foreground text-sm font-mono">
                  No product view data yet
                </div>
              )}
            </div>

            {/* Devices */}
            <div className="lp-card p-4">
              <h2 className="text-sm font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-2 mb-3">
                <Monitor className="h-3.5 w-3.5" /> Devices
              </h2>
              {devices.total > 0 ? (
                <DeviceBreakdown devices={devices} />
              ) : (
                <p className="text-center py-8 text-sm font-mono text-muted-foreground">No device data yet</p>
              )}

              {/* Referrers */}
              {topReferrers.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border/30">
                  <h3 className="text-[11px] font-mono font-bold tracking-wider uppercase text-muted-foreground mb-2 flex items-center gap-1.5">
                    <ExternalLink className="h-3 w-3" /> Top Referrers
                  </h3>
                  {topReferrers.slice(0, 5).map((r, i) => (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <span className="text-[11px] font-mono text-[#c9d1d9] flex-1 truncate">
                        {(() => { try { return new URL(r.referrer).hostname; } catch { return r.referrer; } })()}
                      </span>
                      <span className="text-[11px] font-mono text-muted-foreground">{r.views}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
