import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  PieChart as RechartsPieChart,
  Pie,
} from 'recharts';
import type { CostsData } from '../lib/types';
import { DollarSign, Target, Zap, Hash } from '../lib/icons';

interface Props {
  data: CostsData;
}

// ── Summary Cards ──

interface CostCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  iconBg: string;
}

function CostCard({ label, value, sub, icon, iconBg }: CostCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 card-hover">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      <div className="text-2xl font-bold text-gray-100 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

// ── Area tooltip ──

function AreaTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 shadow-xl">
      <div className="text-sm text-gray-300 font-medium mb-1">{label}</div>
      <div className="text-sm text-gray-200 tabular-nums">${payload[0].value.toFixed(3)}</div>
      {payload[0]?.payload?.runs !== undefined && (
        <div className="text-xs text-gray-500 mt-0.5">{payload[0].payload.runs} runs</div>
      )}
    </div>
  );
}

// ── Model colors ──

const MODEL_COLORS: Record<string, string> = {
  opus: '#8b5cf6',
  sonnet: '#22c55e',
  haiku: '#6b7280',
};

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return '#3b82f6';
}

function getModelLabel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  return model;
}

// ── Token distribution donut ──

const TOKEN_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b'];
const TOKEN_LABELS = ['Input', 'Output', 'Cache Read', 'Cache Create'];

function DonutLabel({ viewBox, value }: any) {
  const { cx, cy } = viewBox;
  return (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
      <tspan x={cx} dy="-0.5em" fill="#e5e7eb" fontSize={18} fontWeight={700}>
        {value}
      </tspan>
      <tspan x={cx} dy="1.5em" fill="#6b7280" fontSize={11}>
        total tokens
      </tspan>
    </text>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── Component ──

export function CostsPage({ data }: Props) {
  const { summary, daily, byModel, byGroup, tokenDistribution } = data;

  const tokenData = [
    { name: 'Input', value: tokenDistribution.input },
    { name: 'Output', value: tokenDistribution.output },
    { name: 'Cache Read', value: tokenDistribution.cacheRead },
    { name: 'Cache Create', value: tokenDistribution.cacheCreation },
  ].filter((d) => d.value > 0);

  const totalTokens = tokenData.reduce((s, d) => s + d.value, 0);

  const groupColors = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#06b6d4', '#f43f5e', '#6366f1', '#14b8a6'];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <CostCard
          label="Total Cost"
          value={`$${summary.totalCost.toFixed(2)}`}
          icon={<DollarSign size={18} className="text-emerald-400" />}
          iconBg="bg-emerald-500/15"
        />
        <CostCard
          label="Cost / Run"
          value={`$${summary.costPerRun.toFixed(3)}`}
          icon={<Target size={18} className="text-blue-400" />}
          iconBg="bg-blue-500/15"
        />
        <CostCard
          label="Cache Hit Rate"
          value={`${(summary.cacheHitRate * 100).toFixed(1)}%`}
          sub="cache_read / (cache_read + input)"
          icon={<Zap size={18} className="text-amber-400" />}
          iconBg="bg-amber-500/15"
        />
        <CostCard
          label="Cost / Message"
          value={`$${summary.costPerMessage.toFixed(4)}`}
          icon={<Hash size={18} className="text-purple-400" />}
          iconBg="bg-purple-500/15"
        />
      </div>

      {/* Cost Over Time */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-gray-400 mb-4">Cost Over Time</h2>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={daily}>
            <defs>
              <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickFormatter={(v: string) => v.slice(5)}
              axisLine={{ stroke: '#1f2937' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(0)}`}
            />
            <Tooltip content={<AreaTooltip />} />
            <Area
              type="monotone"
              dataKey="cost"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#costGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Model Breakdown */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-400 mb-4">Cost by Model</h2>
          <div className="space-y-4">
            {byModel.map((m) => {
              const color = getModelColor(m.model);
              return (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-sm text-gray-200 font-medium">
                        {getModelLabel(m.model)}
                      </span>
                      <span className="text-xs text-gray-500">{m.runs} runs</span>
                    </div>
                    <span className="text-sm text-gray-200 font-medium tabular-nums">
                      ${m.cost.toFixed(2)}
                    </span>
                  </div>
                  <div className="w-full bg-gray-800/60 rounded-full h-2.5">
                    <div
                      className="h-2.5 rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.max(m.percentage * 100, 2)}%`,
                        backgroundColor: color,
                      }}
                    />
                  </div>
                  <div className="text-right text-xs text-gray-500 mt-0.5 tabular-nums">
                    {(m.percentage * 100).toFixed(1)}%
                  </div>
                </div>
              );
            })}
            {byModel.length === 0 && (
              <div className="text-sm text-gray-500 text-center py-6">No data</div>
            )}
          </div>
        </div>

        {/* By Group Bar Chart */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-400 mb-4">Cost by Group</h2>
          {byGroup.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(byGroup.length * 44, 160)}>
              <BarChart data={byGroup} layout="vertical" barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <YAxis
                  type="category"
                  dataKey="folder"
                  tick={{ fill: '#9ca3af', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  width={100}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: 8,
                  }}
                  formatter={(v: number) => [`$${v.toFixed(3)}`, 'Cost']}
                  labelStyle={{ color: '#d1d5db' }}
                />
                <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                  {byGroup.map((_, i) => (
                    <Cell key={i} fill={groupColors[i % groupColors.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-sm text-gray-500 text-center py-6">No data</div>
          )}
        </div>
      </div>

      {/* Token Distribution */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-gray-400 mb-4">Token Distribution</h2>
        <div className="flex flex-col lg:flex-row items-center gap-8">
          <div className="w-64 h-64 flex-shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <RechartsPieChart>
                <Pie
                  data={tokenData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={2}
                  label={false}
                >
                  {tokenData.map((_, i) => (
                    <Cell key={i} fill={TOKEN_COLORS[i % TOKEN_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: 8,
                  }}
                  formatter={(v: number) => [formatTokens(v), '']}
                  labelStyle={{ color: '#d1d5db' }}
                />
                <text
                  x="50%"
                  y="46%"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#e5e7eb"
                  fontSize={20}
                  fontWeight={700}
                >
                  {formatTokens(totalTokens)}
                </text>
                <text
                  x="50%"
                  y="56%"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#6b7280"
                  fontSize={11}
                >
                  total tokens
                </text>
              </RechartsPieChart>
            </ResponsiveContainer>
          </div>

          <div className="flex-1 grid grid-cols-2 gap-4 w-full">
            {tokenData.map((d, i) => {
              const pct = totalTokens > 0 ? (d.value / totalTokens) * 100 : 0;
              return (
                <div key={d.name} className="bg-gray-800/40 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: TOKEN_COLORS[i] }}
                    />
                    <span className="text-sm text-gray-300">{d.name}</span>
                  </div>
                  <div className="text-xl font-bold text-gray-100 tabular-nums">
                    {formatTokens(d.value)}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 tabular-nums">
                    {pct.toFixed(1)}% of total
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cache Efficiency */}
        {tokenDistribution.cacheRead > 0 && (
          <div className="mt-6 pt-5 border-t border-gray-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">Cache Efficiency</span>
              <span className="text-sm text-gray-200 font-medium tabular-nums">
                {(
                  (tokenDistribution.cacheRead /
                    (tokenDistribution.cacheRead + tokenDistribution.input)) *
                  100
                ).toFixed(1)}%
              </span>
            </div>
            <div className="w-full bg-gray-800/60 rounded-full h-3">
              <div
                className="h-3 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
                style={{
                  width: `${(
                    (tokenDistribution.cacheRead /
                      (tokenDistribution.cacheRead + tokenDistribution.input)) *
                    100
                  ).toFixed(1)}%`,
                }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>cache_read / (cache_read + input)</span>
              <span>
                {formatTokens(tokenDistribution.cacheRead)} / {formatTokens(tokenDistribution.cacheRead + tokenDistribution.input)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
