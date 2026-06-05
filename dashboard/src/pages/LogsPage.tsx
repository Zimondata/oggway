import { useEffect, useRef, useState } from 'react';
import { MCIcon } from '../components/MCIcon';

interface LogFile {
  name: string;
  size: number;
  mtime: string;
}

interface LogsResponse {
  file: string;
  size: number;
  mtime: string;
  lines: string[];
  files: LogFile[];
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function LogsPage() {
  const [data, setData] = useState<LogsResponse | null>(null);
  const [file, setFile] = useState<string>('claudeclaw.log');
  const [tail, setTail] = useState<number>(300);
  const [follow, setFollow] = useState<boolean>(true);
  const [filter, setFilter] = useState<string>('');
  const [level, setLevel] = useState<'all' | 'INFO' | 'WARN' | 'ERROR'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/logs?file=${encodeURIComponent(file)}&tail=${tail}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => !cancelled && setData(null));
    };
    load();
    if (!follow) return;
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [file, tail, follow]);

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data, follow]);

  const lines = (data?.lines || []).filter((l) => {
    const clean = l.replace(ANSI_RE, '');
    if (filter && !clean.toLowerCase().includes(filter.toLowerCase())) return false;
    if (level === 'all') return true;
    return clean.includes(level);
  });

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={file}
          onChange={(e) => setFile(e.target.value)}
          className="bg-black/30 border border-white/10 rounded text-[12px] text-gray-200 px-2 py-1.5 focus:outline-none focus:border-cyan-500/50"
        >
          {(data?.files || [{ name: file, size: 0, mtime: '' }]).map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} {f.size ? `(${(f.size / 1024).toFixed(0)}K)` : ''}
            </option>
          ))}
        </select>

        <select
          value={tail}
          onChange={(e) => setTail(Number(e.target.value))}
          className="bg-black/30 border border-white/10 rounded text-[12px] text-gray-200 px-2 py-1.5 focus:outline-none focus:border-cyan-500/50"
        >
          <option value={100}>100 lines</option>
          <option value={300}>300 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1000 lines</option>
          <option value={2000}>2000 lines</option>
        </select>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="flex-1 min-w-[150px] bg-black/30 border border-white/10 rounded text-[12px] text-gray-200 px-2 py-1.5 focus:outline-none focus:border-cyan-500/50"
        />

        <div className="flex items-center gap-1 rounded border border-white/10 overflow-hidden">
          {(['all', 'INFO', 'WARN', 'ERROR'] as const).map((lv) => (
            <button
              key={lv}
              onClick={() => setLevel(lv)}
              className={`text-[10px] px-2 py-1.5 ${
                level === lv ? 'bg-cyan-500/20 text-cyan-300' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {lv}
            </button>
          ))}
        </div>

        <button
          onClick={() => setFollow((f) => !f)}
          className={`text-[11px] px-3 py-1.5 rounded border ${
            follow
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'border-white/10 text-gray-400 hover:border-white/20'
          }`}
        >
          {follow ? '● live' : '○ paused'}
        </button>
      </div>

      <div className="rounded-xl border border-white/5 bg-[#06080f] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 text-[11px]">
          <div className="text-gray-500 font-mono">
            {data ? `${file} · ${(data.size / 1024).toFixed(0)} KB` : 'Loading…'}
          </div>
          <div className="text-gray-500">
            {lines.length} / {data?.lines.length ?? 0} lines
          </div>
        </div>
        <div ref={scrollRef} className="overflow-y-auto h-[600px] p-3 font-mono text-[11px] leading-relaxed">
          {lines.map((l, i) => (
            <LogLine key={i} text={l} />
          ))}
          {lines.length === 0 && (
            <div className="text-gray-600 text-center py-8 italic">No matching lines</div>
          )}
        </div>
      </div>
    </div>
  );
}

function LogLine({ text }: { text: string }) {
  // Strip ANSI codes but keep level highlighting
  const clean = text.replace(ANSI_RE, '');
  let color = 'text-gray-300';
  if (clean.includes('ERROR') || clean.includes('error') || clean.includes('FATAL')) color = 'text-rose-400';
  else if (clean.includes('WARN') || clean.includes('warn')) color = 'text-amber-400';
  else if (clean.includes('INFO')) color = 'text-gray-300';
  else if (clean.includes('DEBUG')) color = 'text-gray-500';
  return <div className={`whitespace-pre-wrap break-all ${color}`}>{clean || '\u00A0'}</div>;
}
