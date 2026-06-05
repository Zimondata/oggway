import type { AgentRun } from '../lib/types';
import { Clock } from '../lib/icons';

interface Props {
  runs: AgentRun[];
}

const statusConfig: Record<string, { dot: string; label: string }> = {
  success: { dot: 'bg-emerald-400', label: 'Success' },
  error: { dot: 'bg-red-400', label: 'Error' },
  timeout: { dot: 'bg-amber-400', label: 'Timeout' },
};

function getModelBadge(model: string): { bg: string; text: string; label: string } {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return { bg: 'bg-purple-500/15', text: 'text-purple-300', label: 'opus' };
  if (lower.includes('sonnet')) return { bg: 'bg-green-500/15', text: 'text-green-300', label: 'sonnet' };
  if (lower.includes('haiku')) return { bg: 'bg-gray-500/15', text: 'text-gray-300', label: 'haiku' };
  return { bg: 'bg-blue-500/15', text: 'text-blue-300', label: model.split('-').pop() || model };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RunCard({ run }: { run: AgentRun }) {
  const status = statusConfig[run.status] || { dot: 'bg-gray-400', label: run.status };
  const modelBadge = getModelBadge(run.model);
  const totalTokens = (run.inputTokens + run.outputTokens) / 1000;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 card-hover animate-fade-in">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${status.dot}`} />
          <span className="text-sm font-medium text-gray-200 truncate">
            {run.groupFolder}
          </span>
          <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
            {run.triggerType}
          </span>
        </div>
        <span className="text-xs text-gray-500 flex-shrink-0 tabular-nums">
          {formatTime(run.runAt)}
        </span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${modelBadge.bg} ${modelBadge.text}`}>
          {modelBadge.label}
        </span>

        <div className="flex items-center gap-1 text-xs text-gray-400">
          <Clock size={12} />
          <span className="tabular-nums">{(run.durationMs / 1000).toFixed(1)}s</span>
        </div>

        <span className="text-xs text-gray-400 tabular-nums">
          {totalTokens.toFixed(1)}K tok
        </span>

        <span className="text-xs text-gray-300 font-medium tabular-nums ml-auto">
          ${run.estimatedCost.toFixed(3)}
        </span>
      </div>

      {run.turns > 0 && (
        <div className="mt-2 text-xs text-gray-500">
          {run.turns} turn{run.turns !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

export function RecentRuns({ runs }: Props) {
  const limited = runs.slice(0, 10);

  return (
    <div>
      <h2 className="text-sm font-medium text-gray-400 mb-4">Recent Runs</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {limited.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </div>
      {limited.length === 0 && (
        <div className="text-center text-gray-500 text-sm py-12 bg-gray-900 border border-gray-800 rounded-xl">
          No runs recorded yet
        </div>
      )}
    </div>
  );
}
