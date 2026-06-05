import type { Summary, Trends } from '../lib/types';
import {
  Activity,
  DollarSign,
  Cpu,
  Clock,
  CheckCircle,
  Users,
  TrendingUp,
  TrendingDown,
} from '../lib/icons';

interface Props {
  stats: Summary;
  trends?: Trends;
}

interface CardDef {
  label: string;
  value: string;
  sub?: string;
  trend?: number;
  icon: React.ReactNode;
  iconBg: string;
  trendInverted?: boolean; // true = down is good (e.g. cost)
}

function TrendBadge({ value, inverted }: { value: number; inverted?: boolean }) {
  if (value === 0) return null;

  const isPositive = inverted ? value < 0 : value > 0;
  const absValue = Math.abs(value);
  const colorClass = isPositive ? 'text-emerald-400' : 'text-red-400';
  const bgClass = isPositive ? 'bg-emerald-400/10' : 'bg-red-400/10';
  const IconComponent = value > 0 ? TrendingUp : TrendingDown;

  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md ${colorClass} ${bgClass}`}>
      <IconComponent size={12} />
      {absValue.toFixed(1)}%
    </span>
  );
}

function Card({ label, value, sub, trend, icon, iconBg, trendInverted }: CardDef) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 card-hover animate-fade-in">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        {trend !== undefined && <TrendBadge value={trend} inverted={trendInverted} />}
      </div>
      <div className="text-2xl font-bold text-gray-100 tracking-tight">{value}</div>
      <div className="text-sm text-gray-400 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function StatsCards({ stats, trends }: Props) {
  const cards: CardDef[] = [
    {
      label: 'Total Runs',
      value: stats.totalRuns.toLocaleString(),
      icon: <Activity size={20} className="text-blue-400" />,
      iconBg: 'bg-blue-500/15',
      trend: trends?.runs,
    },
    {
      label: 'Total Cost',
      value: `$${stats.totalCost.toFixed(2)}`,
      sub: `$${(stats.totalCost / Math.max(stats.totalRuns, 1)).toFixed(3)}/run`,
      icon: <DollarSign size={20} className="text-emerald-400" />,
      iconBg: 'bg-emerald-500/15',
      trend: trends?.cost,
      trendInverted: true,
    },
    {
      label: 'Tokens Used',
      value: formatTokens(stats.totalTokens),
      icon: <Cpu size={20} className="text-purple-400" />,
      iconBg: 'bg-purple-500/15',
      trend: trends?.tokens,
    },
    {
      label: 'Avg Duration',
      value: `${(stats.avgDuration / 1000).toFixed(1)}s`,
      icon: <Clock size={20} className="text-amber-400" />,
      iconBg: 'bg-amber-500/15',
      trend: trends?.duration,
      trendInverted: true,
    },
    {
      label: 'Success Rate',
      value: `${(stats.successRate * 100).toFixed(1)}%`,
      icon: <CheckCircle size={20} className="text-green-400" />,
      iconBg: 'bg-green-500/15',
      trend: trends?.successRate,
    },
    {
      label: 'Active Groups',
      value: String(stats.activeGroups),
      sub: `${stats.uptimeHours.toFixed(0)}h uptime`,
      icon: <Users size={20} className="text-cyan-400" />,
      iconBg: 'bg-cyan-500/15',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
      {cards.map((card) => (
        <Card key={card.label} {...card} />
      ))}
    </div>
  );
}
