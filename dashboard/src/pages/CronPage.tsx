import { useEffect, useState } from 'react';
import { MCIcon } from '../components/MCIcon';

interface CronTask {
  id: string;
  groupFolder: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: string;
  model: string | null;
  contextMode: string | null;
  createdAt: string;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'overdue';
  if (ms < 60_000) return 'soon';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function CronPage() {
  const [tasks, setTasks] = useState<CronTask[] | null>(null);
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [opened, setOpened] = useState<CronTask | null>(null);

  useEffect(() => {
    const load = () => fetch('/api/cron').then((r) => r.json()).then((d) => setTasks(d.tasks || []));
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (!tasks) return <div className="text-gray-500 text-[12px] py-12 text-center">Loading scheduled tasks…</div>;

  const groups = Array.from(new Set(tasks.map((t) => t.groupFolder))).sort();
  const filtered = groupFilter === 'all' ? tasks : tasks.filter((t) => t.groupFolder === groupFilter);
  const active = filtered.filter((t) => t.status === 'active');
  const paused = filtered.filter((t) => t.status !== 'active');

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setGroupFilter('all')}
          className={`text-[11px] px-3 py-1 rounded-full border ${
            groupFilter === 'all'
              ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
              : 'border-white/10 text-gray-400 hover:border-white/20'
          }`}
        >
          all ({tasks.length})
        </button>
        {groups.map((g) => (
          <button
            key={g}
            onClick={() => setGroupFilter(g)}
            className={`text-[11px] px-3 py-1 rounded-full border ${
              groupFilter === g
                ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                : 'border-white/10 text-gray-400 hover:border-white/20'
            }`}
          >
            {g} ({tasks.filter((t) => t.groupFolder === g).length})
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Total" value={tasks.length} />
        <Stat label="Active" value={tasks.filter((t) => t.status === 'active').length} accent="emerald" />
        <Stat label="Paused" value={tasks.filter((t) => t.status === 'paused').length} accent="amber" />
        <Stat
          label="Overdue"
          value={tasks.filter((t) => t.nextRun && new Date(t.nextRun) < new Date()).length}
          accent="rose"
        />
      </div>

      <Section title="Active" tasks={active} onOpen={setOpened} />
      {paused.length > 0 && <Section title="Paused / inactive" tasks={paused} onOpen={setOpened} muted />}

      {opened && <CronDetailModal task={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'emerald' | 'amber' | 'rose' }) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    rose: 'text-rose-400',
  };
  return (
    <div className="rounded-xl border border-white/5 bg-[#0d1220] p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-[22px] font-semibold mt-1 ${accent ? colors[accent] : 'text-gray-200'}`}>{value}</div>
    </div>
  );
}

function Section({
  title,
  tasks,
  onOpen,
  muted,
}: {
  title: string;
  tasks: CronTask[];
  onOpen: (t: CronTask) => void;
  muted?: boolean;
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">{title}</div>
      <div className="rounded-xl border border-white/5 bg-[#0d1220] overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-white/[0.02]">
            <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Group</th>
              <th className="px-3 py-2">Schedule</th>
              <th className="px-3 py-2">Next</th>
              <th className="px-3 py-2">Last</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr
                key={t.id}
                onClick={() => onOpen(t)}
                className={`border-t border-white/5 cursor-pointer hover:bg-white/[0.02] ${muted ? 'opacity-60' : ''}`}
              >
                <td className="px-3 py-2 font-mono text-[11px] text-gray-400 truncate max-w-[200px]">{t.id}</td>
                <td className="px-3 py-2 text-gray-300">{t.groupFolder}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-cyan-300/80 truncate max-w-[140px]">
                  {t.scheduleValue}
                </td>
                <td className="px-3 py-2 text-gray-300">
                  <span className={t.nextRun && new Date(t.nextRun) < new Date() ? 'text-rose-400' : ''}>
                    {timeUntil(t.nextRun)}
                  </span>
                </td>
                <td className="px-3 py-2 text-gray-500">{timeAgo(t.lastRun)}</td>
                <td className="px-3 py-2">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider ${
                      t.status === 'active'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-gray-500/10 text-gray-400'
                    }`}
                  >
                    {t.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CronDetailModal({ task, onClose }: { task: CronTask; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#0d1220] w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="flex items-center gap-2 text-[13px] text-gray-200">
            <MCIcon name="clock" size={14} className="text-cyan-400" />
            <span className="font-mono">{task.id}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3 text-[12px]">
            <Field label="Group" value={task.groupFolder} />
            <Field label="Status" value={task.status} />
            <Field label="Schedule" value={`${task.scheduleType}: ${task.scheduleValue}`} mono />
            <Field label="Model" value={task.model || 'default'} />
            <Field label="Context" value={task.contextMode || 'isolated'} />
            <Field label="Created" value={new Date(task.createdAt).toLocaleString()} />
            <Field label="Next run" value={task.nextRun ? new Date(task.nextRun).toLocaleString() : '-'} mono />
            <Field label="Last run" value={task.lastRun ? new Date(task.lastRun).toLocaleString() : '-'} mono />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Prompt</div>
            <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap bg-black/30 rounded p-3 border border-white/5 max-h-[300px] overflow-y-auto">
              {task.prompt}
            </pre>
          </div>
          {task.lastResult && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Last result</div>
              <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap bg-black/30 rounded p-3 border border-white/5 max-h-[200px] overflow-y-auto">
                {task.lastResult}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-[12px] text-gray-200 ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
