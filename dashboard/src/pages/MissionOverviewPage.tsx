import { useEffect, useState } from 'react';
import { MCIcon } from '../components/MCIcon';

interface OverviewData {
  summary?: {
    totalRuns?: number;
    totalCost?: number;
    totalTokens?: number;
    activeGroups?: number;
    uptimeHours?: number;
    successRate?: number;
  };
  recentRuns?: Array<{
    runAt: string;
    triggerType?: string;
    turns?: number;
    estimatedCost?: number;
    status?: string;
    groupFolder?: string;
  }>;
  systemHealth?: {
    runtime?: string;
    registeredGroups?: Array<{
      folder: string;
      hasActiveSession: boolean;
    }>;
  };
}

export function MissionOverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats?period=7d')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, []);

  const activeGroups = data?.summary?.activeGroups ?? 0;
  const totalCost = data?.summary?.totalCost ?? 0;
  const totalRuns = data?.summary?.totalRuns ?? 0;
  const uptime = data?.summary?.uptimeHours ?? 0;
  const sessions = data?.systemHealth?.registeredGroups?.length ?? 0;
  const claudeActive = (data?.systemHealth?.registeredGroups || []).filter((g) => g.hasActiveSession).length;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Launch Sequence */}
      <section>
        <div className="text-center mb-5">
          <h2 className="text-[18px] font-semibold text-gray-200">Launch Sequence</h2>
          <p className="text-[12px] text-gray-500">Complete each step to bring your station online.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <LaunchCard
            step="01"
            done={activeGroups > 0}
            title="Agent Runtimes"
            body={
              <>
                <div className="flex items-center gap-2 text-[12px] text-emerald-400">
                  <span>●</span> ClaudeClaw {data?.systemHealth?.runtime ?? 'sandbox'}
                </div>
                <div className="flex items-center gap-2 text-[12px] text-emerald-400 mt-1">
                  <span>●</span> Claude Code authenticated
                </div>
                <a className="text-[11px] text-cyan-400 hover:underline mt-2 inline-block" href="#">
                  + Install more runtimes
                </a>
              </>
            }
          />
          <LaunchCard
            step="02"
            active
            done={false}
            title="Dock an Agent"
            body={
              <p className="text-[12px] text-gray-500 leading-relaxed">
                Register your first agent. Choose a template and configure its capabilities.
              </p>
            }
            cta="Create Agent"
          />
          <LaunchCard
            step="03"
            done={false}
            title="Dispatch a Task"
            body={
              <p className="text-[12px] text-gray-600 leading-relaxed">
                Create a task and assign it to your agent.
              </p>
            }
            cta="Create Task"
            disabled
          />
        </div>
        <div className="text-right text-[10px] text-gray-600 mt-2">1/3</div>
      </section>

      {/* Quick stats strip */}
      <section className="border-y border-white/5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] text-gray-400">
        <span className="text-emerald-400">● {claudeActive} active sessions</span>
        <span className="text-gray-500">● 0 tasks running</span>
        <span>{sessions} sessions today</span>
        <span className="tabular-nums">{(data?.summary?.totalTokens ?? 0).toLocaleString()} tokens</span>
        <span className="tabular-nums">${totalCost.toFixed(2)} spent</span>
        <span className="ml-auto">
          Memory <span className="text-gray-300">69%</span>{' '}
          <span className="inline-block w-24 h-1 bg-white/5 rounded ml-2 align-middle">
            <span className="block h-full w-[69%] bg-gradient-to-r from-cyan-400 to-emerald-400 rounded" />
          </span>
        </span>
      </section>

      {/* Activity + Fleet */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Activity" right={<span className="text-[10px] text-emerald-400">● Live</span>} className="lg:col-span-2">
          {loading && <div className="text-gray-500 text-[12px]">Loading…</div>}
          {!loading && (data?.recentRuns?.length ?? 0) === 0 && (
            <div className="text-gray-600 text-[12px] py-6 text-center">No activity yet.</div>
          )}
          <div className="divide-y divide-white/5">
            {data?.recentRuns?.slice(0, 6).map((r, i) => (
              <div key={i} className="flex items-center gap-3 py-2 text-[11px]">
                <span className="text-gray-600 w-12 tabular-nums">
                  {timeAgo(r.runAt)}
                </span>
                <span className="text-gray-300 w-16 truncate">{r.groupFolder ?? 'main'}</span>
                <span className="text-gray-500 flex-1 truncate">
                  {r.triggerType ?? 'message'} · {r.turns ?? 0} turns
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    r.status === 'success' || !r.status
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : 'bg-red-500/10 text-red-300'
                  }`}
                >
                  {r.status ?? 'Done'}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Fleet Status">
          <div className="space-y-3 text-[12px]">
            <FleetRow label="Claude" value={claudeActive} unit="active" total={totalRuns} cost={totalCost} color="text-cyan-400" />
            <FleetRow label="Codex" value={0} unit="active" total={0} cost={0} color="text-emerald-400" />
            <FleetRow label="Hermes" value={0} unit="active" total={0} cost={0} color="text-purple-400" />
          </div>
        </Card>
      </div>

      {/* Task Pipeline */}
      <Card title="Task Pipeline" right={<span className="text-[11px] text-gray-500">0 tasks</span>}>
        <div className="text-[12px] text-gray-600 text-center py-12">No tasks yet</div>
      </Card>

      <div className="text-[10px] text-gray-600">Uptime {uptime.toFixed(0)}h</div>
    </div>
  );
}

// ── Subcomponents ──

function LaunchCard({
  step,
  title,
  body,
  cta,
  done,
  active,
  disabled,
}: {
  step: string;
  title: string;
  body: React.ReactNode;
  cta?: string;
  done?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border bg-[#0d1220] p-5 ${
        active ? 'border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]' : 'border-white/5'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span
          className={`text-[10px] font-mono ${
            done ? 'text-emerald-400' : active ? 'text-amber-400' : 'text-gray-600'
          }`}
        >
          {done ? '✓' : step}
        </span>
        {done && <span className="text-[10px] text-emerald-400">DONE</span>}
        {active && <span className="text-[10px] text-amber-400">CURRENT</span>}
      </div>
      <h3 className={`text-[14px] font-semibold mb-2 ${done ? 'text-emerald-300' : active ? 'text-amber-200' : 'text-gray-300'}`}>
        {title}
      </h3>
      <div className="mb-3">{body}</div>
      {cta && (
        <button
          disabled={disabled}
          className={`w-full text-[12px] py-2 rounded-md ${
            disabled
              ? 'bg-white/[0.03] text-gray-600 cursor-not-allowed'
              : active
                ? 'bg-amber-500 hover:bg-amber-400 text-black font-medium'
                : 'bg-white/5 hover:bg-white/10 text-gray-300'
          }`}
        >
          {cta}
        </button>
      )}
    </div>
  );
}

function Card({
  title,
  right,
  children,
  className = '',
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-white/5 bg-[#0d1220] p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-gray-200">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function FleetRow({
  label,
  value,
  unit,
  total,
  cost,
  color,
}: {
  label: string;
  value: number;
  unit: string;
  total: number;
  cost: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`text-[12px] font-medium w-16 ${color}`}>{label}</span>
      <span className="text-gray-500 w-20 tabular-nums">
        {value} {unit}
      </span>
      <div className="flex-1 h-6 bg-white/[0.02] rounded">
        <div
          className={`h-full rounded ${color.replace('text-', 'bg-').replace('-400', '-500/40')}`}
          style={{ width: `${Math.min(100, (value / Math.max(1, total)) * 100)}%` }}
        />
      </div>
      <span className="text-gray-600 text-[11px] tabular-nums w-20 text-right">
        ${cost.toFixed(2)}
      </span>
    </div>
  );
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
