import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import type { DailyEntry } from '../lib/types';

interface Props {
  daily: DailyEntry[];
}

type ViewMode = 'runs' | 'cost';

const MODEL_COLORS = {
  opus: '#8b5cf6',
  sonnet: '#22c55e',
  haiku: '#6b7280',
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  const total = payload.reduce((sum: number, p: any) => sum + (p.value || 0), 0);

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 shadow-xl">
      <div className="text-sm text-gray-300 font-medium mb-2">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            <span className="text-gray-400 capitalize">
              {p.dataKey.replace(/Runs|Cost/, '')}
            </span>
          </div>
          <span className="text-gray-200 font-medium tabular-nums">
            {p.dataKey.includes('Cost') ? `$${p.value.toFixed(3)}` : p.value}
          </span>
        </div>
      ))}
      <div className="border-t border-gray-700 mt-2 pt-2 flex justify-between text-sm">
        <span className="text-gray-400">Total</span>
        <span className="text-gray-100 font-semibold tabular-nums">
          {payload[0]?.dataKey.includes('Cost') ? `$${total.toFixed(3)}` : total}
        </span>
      </div>
    </div>
  );
}

export function ActivityChart({ daily }: Props) {
  const [view, setView] = useState<ViewMode>('runs');

  const runsKeys = { opus: 'opusRuns', sonnet: 'sonnetRuns', haiku: 'haikuRuns' } as const;
  const costKeys = { opus: 'opusCost', sonnet: 'sonnetCost', haiku: 'haikuCost' } as const;
  const keys = view === 'runs' ? runsKeys : costKeys;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-gray-400">Daily Activity</h2>
        <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
          <button
            onClick={() => setView('runs')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              view === 'runs'
                ? 'bg-gray-700 text-gray-100'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Runs
          </button>
          <button
            onClick={() => setView('cost')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              view === 'cost'
                ? 'bg-gray-700 text-gray-100'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Cost
          </button>
        </div>
      </div>

      <div className="flex items-center gap-5 mb-3">
        {Object.entries(MODEL_COLORS).map(([model, color]) => (
          <div key={model} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-xs text-gray-400 capitalize">{model}</span>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={daily} barCategoryGap="20%">
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
            tickFormatter={(v: number) =>
              view === 'cost' ? `$${v < 1 ? v.toFixed(2) : v.toFixed(0)}` : String(v)
            }
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
          <Bar
            dataKey={keys.opus}
            stackId="a"
            fill={MODEL_COLORS.opus}
            radius={[0, 0, 0, 0]}
            name="Opus"
          />
          <Bar
            dataKey={keys.sonnet}
            stackId="a"
            fill={MODEL_COLORS.sonnet}
            radius={[0, 0, 0, 0]}
            name="Sonnet"
          />
          <Bar
            dataKey={keys.haiku}
            stackId="a"
            fill={MODEL_COLORS.haiku}
            radius={[3, 3, 0, 0]}
            name="Haiku"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
