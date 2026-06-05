import type { SystemHealth as SystemHealthType } from '../lib/types';
import { Wifi, Database, Terminal, Calendar, Clock } from '../lib/icons';

interface Props {
  health: SystemHealthType;
}

function formatUptime(hours: number): string {
  if (hours < 1) return `${Math.floor(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const remaining = hours % 24;
  return `${days}d ${remaining.toFixed(0)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

export function SystemHealth({ health }: Props) {
  return (
    <div className="space-y-4">
      {/* Service Status */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Service
        </h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-dot" />
              <span className="text-sm text-gray-300">Online</span>
            </div>
            <span className="text-xs text-gray-500 tabular-nums">
              {formatUptime(health.serviceUptime)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal size={14} className="text-gray-500" />
              <span className="text-sm text-gray-400">Runtime</span>
            </div>
            <span className="text-xs text-gray-300 bg-gray-800 px-2 py-0.5 rounded capitalize">
              {health.runtime}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database size={14} className="text-gray-500" />
              <span className="text-sm text-gray-400">Database</span>
            </div>
            <span className="text-xs text-gray-300 tabular-nums">
              {formatBytes(health.dbSizeBytes)}
            </span>
          </div>
        </div>
      </div>

      {/* Groups */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Groups
        </h3>
        <div className="space-y-2">
          {health.registeredGroups.map((g) => (
            <div key={g.folder} className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    g.hasActiveSession ? 'bg-emerald-400 animate-pulse-dot' : 'bg-gray-600'
                  }`}
                />
                <span className="text-sm text-gray-300 truncate">{g.folder}</span>
              </div>
              <span className="text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded flex-shrink-0 ml-2">
                {g.channel}
              </span>
            </div>
          ))}
          {health.registeredGroups.length === 0 && (
            <div className="text-xs text-gray-500 text-center py-2">No groups registered</div>
          )}
        </div>
      </div>

      {/* Scheduled Tasks */}
      {health.scheduledTasks.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
            Scheduled
          </h3>
          <div className="space-y-2.5">
            {health.scheduledTasks.slice(0, 5).map((t) => (
              <div key={t.id} className="flex items-start gap-2">
                <Calendar size={13} className="text-gray-500 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs text-gray-300 truncate">{t.prompt}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-500 font-mono">{t.cron}</span>
                    {t.nextRun && (
                      <span className="text-[10px] text-gray-500">
                        next: {new Date(t.nextRun).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                    {!t.enabled && (
                      <span className="text-[10px] text-amber-500">paused</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
