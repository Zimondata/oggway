import { useEffect, useState } from 'react';
import { MCIcon } from '../components/MCIcon';

interface GroupRow {
  folder: string;
  name: string;
  runtime: string;
  isMain: boolean;
  requiresTrigger: boolean;
  registered: boolean;
  addedAt: string | null;
  claudeMdBytes: number;
  claudeMdPreview: string;
  memoryFiles: number;
  totalRuns: number;
  totalCost: number;
  lastRunAt: string | null;
  agentConfig: { model?: string; allowedDomains?: string[]; maxTurns?: number } | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function AgentsPage() {
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [selected, setSelected] = useState<GroupRow | null>(null);

  useEffect(() => {
    fetch('/api/groups')
      .then((r) => r.json())
      .then((d) => setGroups(d.groups || []))
      .catch(() => setGroups([]));
  }, []);

  if (groups === null) {
    return <div className="text-gray-500 text-[12px] py-12 text-center">Loading agents…</div>;
  }

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center max-w-md">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.03] border border-white/5 mb-4 text-gray-500">
            <MCIcon name="users" size={22} />
          </div>
          <h3 className="text-[15px] font-semibold text-gray-300 mb-1">No agents yet</h3>
          <p className="text-[12px] text-gray-500">
            Create a folder under <code className="text-cyan-400">groups/</code> with a CLAUDE.md to register
            an agent.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {groups.map((g) => (
          <button
            key={g.folder}
            onClick={() => setSelected(g)}
            className={`text-left rounded-xl border p-4 transition ${
              selected?.folder === g.folder
                ? 'border-cyan-500/50 bg-cyan-500/5'
                : 'border-white/5 bg-[#0d1220] hover:border-white/10'
            }`}
          >
            <div className="flex items-start justify-between mb-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-gray-200 truncate">{g.name}</span>
                  {g.isMain && (
                    <span className="text-[9px] uppercase tracking-wider text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">
                      main
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-gray-500 font-mono truncate">groups/{g.folder}</div>
              </div>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  g.runtime === 'sandbox'
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'bg-blue-500/10 text-blue-400'
                }`}
              >
                {g.runtime}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center mt-3">
              <div className="rounded bg-white/[0.02] py-1.5">
                <div className="text-[14px] font-semibold text-gray-200">{g.totalRuns}</div>
                <div className="text-[9px] text-gray-600 uppercase tracking-wider">runs</div>
              </div>
              <div className="rounded bg-white/[0.02] py-1.5">
                <div className="text-[14px] font-semibold text-gray-200">${g.totalCost.toFixed(2)}</div>
                <div className="text-[9px] text-gray-600 uppercase tracking-wider">cost</div>
              </div>
              <div className="rounded bg-white/[0.02] py-1.5">
                <div className="text-[14px] font-semibold text-gray-200">{g.memoryFiles}</div>
                <div className="text-[9px] text-gray-600 uppercase tracking-wider">files</div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between text-[11px] text-gray-500">
              <span>Last: {timeAgo(g.lastRunAt)}</span>
              <span>
                {g.requiresTrigger ? (
                  <>
                    <MCIcon name="bell" size={10} /> trigger
                  </>
                ) : (
                  'auto-respond'
                )}
              </span>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="rounded-xl border border-white/5 bg-[#0d1220] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <div>
              <div className="text-[13px] font-semibold text-gray-200">{selected.name}</div>
              <div className="text-[11px] text-gray-500 font-mono">groups/{selected.folder}/CLAUDE.md</div>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-gray-500 hover:text-gray-300 text-[12px]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-0">
            <div className="p-4 border-r border-white/5 space-y-3">
              <DetailRow label="Runtime" value={selected.runtime} />
              <DetailRow label="Main" value={selected.isMain ? 'yes' : 'no'} />
              <DetailRow label="Trigger" value={selected.requiresTrigger ? 'required' : 'auto'} />
              <DetailRow label="Registered" value={selected.addedAt?.slice(0, 10) ?? '-'} />
              <DetailRow label="CLAUDE.md" value={`${(selected.claudeMdBytes / 1024).toFixed(1)} KB`} />
              <DetailRow label="Memory files" value={String(selected.memoryFiles)} />
              <DetailRow label="Total runs" value={String(selected.totalRuns)} />
              <DetailRow label="Total cost" value={`$${selected.totalCost.toFixed(2)}`} />

              {selected.agentConfig && (
                <div className="pt-3 mt-3 border-t border-white/5 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-600">agentConfig</div>
                  {selected.agentConfig.model && (
                    <DetailRow label="model" value={selected.agentConfig.model} />
                  )}
                  {selected.agentConfig.maxTurns !== undefined && (
                    <DetailRow label="maxTurns" value={String(selected.agentConfig.maxTurns)} />
                  )}
                  {selected.agentConfig.allowedDomains && (
                    <DetailRow
                      label="allowed domains"
                      value={`${selected.agentConfig.allowedDomains.length} entries`}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="lg:col-span-2 p-4">
              <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-2">CLAUDE.md preview</div>
              <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto bg-black/30 rounded p-3 border border-white/5">
                {selected.claudeMdPreview}
                {selected.claudeMdBytes > 2000 && (
                  <span className="text-gray-600">
                    {'\n\n'}…{((selected.claudeMdBytes - 2000) / 1024).toFixed(1)} KB more
                  </span>
                )}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 font-mono">{value}</span>
    </div>
  );
}
