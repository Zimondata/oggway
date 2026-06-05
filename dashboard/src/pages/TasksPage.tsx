import { useEffect, useState } from 'react';
import { MCIcon } from '../components/MCIcon';

interface ScheduledTask {
  id: string;
  groupFolder: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  nextRun: string | null;
  lastRun: string | null;
  status: string;
  model: string | null;
}

interface RunRow {
  id: number;
  groupFolder: string;
  triggerType: string;
  model: string;
  status: string;
  runAt: string;
  durationMs: number;
  turns: number;
  estimatedCost: number;
}

interface IncidentRow {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface TasksData {
  scheduled: ScheduledTask[];
  running: RunRow[];
  done: RunRow[];
  failed: RunRow[];
  incidents: IncidentRow[];
  counts: { scheduled: number; running: number; done: number; failed: number; incidents: number };
}

function timeAgo(iso: string | null): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return `in ${Math.floor(-ms / 60_000)}m`;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'overdue';
  if (ms < 60_000) return 'soon';
  if (ms < 3_600_000) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `in ${Math.floor(ms / 3_600_000)}h`;
  return `in ${Math.floor(ms / 86_400_000)}d`;
}

export function TasksPage() {
  const [data, setData] = useState<TasksData | null>(null);

  useEffect(() => {
    const load = () => fetch('/api/tasks').then((r) => r.json()).then(setData).catch(() => setData(null));
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!data) return <div className="text-gray-500 text-[12px] py-12 text-center">Loading tasks…</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 animate-fade-in">
      <Column title="Scheduled" count={data.counts.scheduled} accent="cyan" icon="clock">
        {data.scheduled.slice(0, 12).map((t) => (
          <div key={t.id} className="rounded-lg bg-white/[0.02] border border-white/5 p-3 hover:border-white/10">
            <div className="text-[11px] font-mono text-gray-400 truncate">{t.groupFolder}</div>
            <div className="text-[12px] text-gray-200 line-clamp-2 mt-0.5">{t.prompt.slice(0, 100)}</div>
            <div className="flex items-center justify-between mt-2 text-[10px] text-gray-500">
              <span className="font-mono">{t.scheduleValue}</span>
              <span className={t.nextRun && new Date(t.nextRun) < new Date() ? 'text-amber-400' : ''}>
                {timeUntil(t.nextRun)}
              </span>
            </div>
          </div>
        ))}
        {data.scheduled.length === 0 && <Empty>No scheduled tasks</Empty>}
      </Column>

      <Column title="Running" count={data.counts.running} accent="amber" icon="activity">
        {data.running.slice(0, 12).map((r) => (
          <div key={r.id} className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
            <div className="flex items-center gap-2 text-[11px] font-mono text-amber-400">
              <span className="inline-block w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
              {r.groupFolder}
            </div>
            <div className="text-[11px] text-gray-300 mt-1">
              {r.triggerType} · {r.turns ?? 0} turns
            </div>
            <div className="text-[10px] text-gray-500 mt-1">{timeAgo(r.runAt)}</div>
          </div>
        ))}
        {data.running.length === 0 && <Empty>Nothing in flight</Empty>}
      </Column>

      <Column title="Done" count={data.counts.done} accent="emerald" icon="check">
        {data.done.slice(0, 12).map((r) => (
          <div key={r.id} className="rounded-lg bg-white/[0.02] border border-white/5 p-3">
            <div className="text-[11px] font-mono text-gray-400 truncate">{r.groupFolder}</div>
            <div className="flex items-center justify-between text-[10px] text-gray-500 mt-1">
              <span>
                {r.turns ?? 0} turns · ${r.estimatedCost?.toFixed(3) ?? '0.000'}
              </span>
              <span>{timeAgo(r.runAt)}</span>
            </div>
          </div>
        ))}
        {data.done.length === 0 && <Empty>No completions</Empty>}
      </Column>

      <Column title="Failed" count={data.counts.failed} accent="rose" icon="bell">
        {data.failed.slice(0, 12).map((r) => (
          <div key={r.id} className="rounded-lg bg-rose-500/5 border border-rose-500/20 p-3">
            <div className="text-[11px] font-mono text-rose-300 truncate">{r.groupFolder}</div>
            <div className="text-[10px] text-gray-500 mt-1">
              {r.status} · {timeAgo(r.runAt)}
            </div>
          </div>
        ))}
        {data.failed.length === 0 && <Empty>Clean</Empty>}
      </Column>

      <Column title="Incidents" count={data.counts.incidents} accent="violet" icon="shield">
        {data.incidents.slice(0, 12).map((inc) => (
          <div key={inc.id} className="rounded-lg bg-violet-500/5 border border-violet-500/20 p-3">
            <div className="text-[11px] font-mono text-violet-300 truncate">{inc.id}</div>
            <div className="text-[12px] text-gray-200 line-clamp-2 mt-1">{inc.title}</div>
            <div className="flex items-center justify-between text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider">{inc.status}</span>
              <span>{timeAgo(inc.createdAt)}</span>
            </div>
          </div>
        ))}
        {data.incidents.length === 0 && <Empty>No open incidents</Empty>}
      </Column>
    </div>
  );
}

function Column({
  title,
  count,
  accent,
  icon,
  children,
}: {
  title: string;
  count: number;
  accent: 'cyan' | 'amber' | 'emerald' | 'rose' | 'violet';
  icon: string;
  children: React.ReactNode;
}) {
  const accents: Record<string, string> = {
    cyan: 'text-cyan-400',
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    rose: 'text-rose-400',
    violet: 'text-violet-400',
  };
  return (
    <div className="rounded-xl border border-white/5 bg-[#0a0e1a] flex flex-col min-h-[300px]">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
        <div className={`flex items-center gap-2 text-[12px] font-semibold ${accents[accent]}`}>
          <MCIcon name={icon} size={13} />
          {title}
        </div>
        <span className="text-[10px] text-gray-500 font-mono">{count}</span>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[600px]">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-gray-600 text-center py-6 italic">{children}</div>;
}
