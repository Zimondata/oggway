import type { GroupEntry } from '../lib/types';

interface Props {
  groups: GroupEntry[];
}

const MODEL_BADGE_COLORS: Record<string, string> = {
  opus: 'bg-purple-500/20 text-purple-300',
  sonnet: 'bg-green-500/20 text-green-300',
  haiku: 'bg-gray-500/20 text-gray-300',
};

function getModelBadge(model: string) {
  const key = model.toLowerCase();
  for (const [m, cls] of Object.entries(MODEL_BADGE_COLORS)) {
    if (key.includes(m)) return cls;
  }
  return 'bg-gray-500/20 text-gray-300';
}

function getBarColor(index: number) {
  const colors = [
    'bg-blue-500',
    'bg-purple-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-cyan-500',
    'bg-rose-500',
    'bg-indigo-500',
    'bg-teal-500',
  ];
  return colors[index % colors.length];
}

function getBarGradient(index: number) {
  const gradients = [
    'from-blue-500 to-blue-400',
    'from-purple-500 to-purple-400',
    'from-emerald-500 to-emerald-400',
    'from-amber-500 to-amber-400',
    'from-cyan-500 to-cyan-400',
    'from-rose-500 to-rose-400',
    'from-indigo-500 to-indigo-400',
    'from-teal-500 to-teal-400',
  ];
  return gradients[index % gradients.length];
}

export function GroupBreakdown({ groups }: Props) {
  const sorted = [...groups].sort((a, b) => b.cost - a.cost);
  const maxCost = Math.max(...sorted.map((g) => g.cost), 0.01);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-medium text-gray-400 mb-4">Groups</h2>
      <div className="space-y-4">
        {sorted.map((g, i) => (
          <div key={g.folder} className="group">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${getBarColor(i)}`}
                />
                <span className="text-sm text-gray-200 font-medium truncate">
                  {g.folder}
                </span>
              </div>
              <span className="text-sm text-gray-300 font-medium tabular-nums ml-2 flex-shrink-0">
                ${g.cost.toFixed(2)}
              </span>
            </div>
            <div className="w-full bg-gray-800/60 rounded-full h-1.5 mb-1.5">
              <div
                className={`h-1.5 rounded-full bg-gradient-to-r ${getBarGradient(i)} transition-all duration-500`}
                style={{ width: `${Math.max((g.cost / maxCost) * 100, 2)}%` }}
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>{g.runs} runs</span>
              <span>{(g.avgDuration / 1000).toFixed(1)}s avg</span>
              {g.successRate !== undefined && (
                <span className={g.successRate >= 0.9 ? 'text-emerald-500' : g.successRate >= 0.7 ? 'text-amber-500' : 'text-red-500'}>
                  {(g.successRate * 100).toFixed(0)}% ok
                </span>
              )}
              {g.dominantModel && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getModelBadge(g.dominantModel)}`}>
                  {g.dominantModel.replace(/^claude-\d+-\d+-/, '').replace(/^claude-\d+-/, '').split('-')[0]}
                </span>
              )}
            </div>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="text-center text-gray-500 text-sm py-8">
            No groups with activity
          </div>
        )}
      </div>
    </div>
  );
}
