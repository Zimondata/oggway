import { useEffect, useState } from 'react';
import { MCIcon } from '../components/MCIcon';

interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: TreeNode[];
}

interface FileContent {
  path: string;
  size: number;
  mtime: string;
  content: string;
}

export function MemoryPage() {
  const [groups, setGroups] = useState<string[]>([]);
  const [group, setGroup] = useState<string>('personal');
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [opened, setOpened] = useState<FileContent | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['memory', 'memory/topics', 'memory/daily']));
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/groups')
      .then((r) => r.json())
      .then((d: { groups: Array<{ folder: string }> }) => {
        const folders = (d.groups || []).map((g) => g.folder);
        setGroups(folders);
        if (folders.length && !folders.includes(group)) setGroup(folders[0]);
      })
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    if (!group) return;
    setTree(null);
    fetch(`/api/memory/tree?group=${encodeURIComponent(group)}`)
      .then((r) => r.json())
      .then((d) => setTree(d.tree || []))
      .catch(() => setTree([]));
  }, [group]);

  const openFile = (path: string) => {
    fetch(`/api/memory/file?group=${encodeURIComponent(group)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => setOpened(d))
      .catch(() => setOpened(null));
  };

  const toggle = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 animate-fade-in min-h-[600px]">
      <aside className="rounded-xl border border-white/5 bg-[#0d1220] flex flex-col">
        <div className="px-3 py-2.5 border-b border-white/5 space-y-2">
          <select
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              setOpened(null);
            }}
            className="w-full bg-black/30 border border-white/10 rounded text-[12px] text-gray-200 px-2 py-1.5 focus:outline-none focus:border-cyan-500/50"
          >
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full bg-black/30 border border-white/10 rounded text-[12px] text-gray-200 px-2 py-1.5 focus:outline-none focus:border-cyan-500/50"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-1 max-h-[600px]">
          {tree === null ? (
            <div className="text-[11px] text-gray-500 p-2">Loading…</div>
          ) : (
            <TreeView
              nodes={tree}
              expanded={expanded}
              onToggle={toggle}
              onOpen={openFile}
              activePath={opened?.path}
              filter={filter.toLowerCase()}
            />
          )}
        </div>
      </aside>

      <main className="rounded-xl border border-white/5 bg-[#0d1220] flex flex-col">
        {opened ? (
          <>
            <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[12px] font-mono text-gray-300 truncate">{opened.path}</div>
                <div className="text-[10px] text-gray-500">
                  {(opened.size / 1024).toFixed(1)} KB · modified {new Date(opened.mtime).toLocaleString()}
                </div>
              </div>
              <button onClick={() => setOpened(null)} className="text-[12px] text-gray-500 hover:text-gray-300">
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto p-4 text-[12px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed max-h-[700px]">
              {opened.content}
            </pre>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-[12px]">
            <div className="text-center">
              <MCIcon name="brain" size={28} className="mx-auto mb-3 text-gray-600" />
              <div>Select a file from the tree</div>
              <div className="text-[10px] text-gray-600 mt-1">Read-only view of agent memory</div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function TreeView({
  nodes,
  expanded,
  onToggle,
  onOpen,
  activePath,
  filter,
  depth = 0,
}: {
  nodes: TreeNode[];
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  activePath?: string;
  filter: string;
  depth?: number;
}) {
  const matchesFilter = (n: TreeNode): boolean => {
    if (!filter) return true;
    if (n.name.toLowerCase().includes(filter)) return true;
    if (n.children) return n.children.some(matchesFilter);
    return false;
  };

  return (
    <ul className="text-[12px]">
      {nodes.filter(matchesFilter).map((n) => (
        <li key={n.path}>
          {n.type === 'dir' ? (
            <>
              <button
                onClick={() => onToggle(n.path)}
                className="w-full text-left flex items-center gap-1 px-2 py-1 hover:bg-white/[0.03] rounded text-gray-400"
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
              >
                <span className="text-[10px] w-3">{expanded.has(n.path) ? '▾' : '▸'}</span>
                <MCIcon name="folder" size={12} className="text-amber-500/70" />
                <span className="truncate">{n.name}</span>
              </button>
              {expanded.has(n.path) && n.children && (
                <TreeView
                  nodes={n.children}
                  expanded={expanded}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  activePath={activePath}
                  filter={filter}
                  depth={depth + 1}
                />
              )}
            </>
          ) : (
            <button
              onClick={() => onOpen(n.path)}
              className={`w-full text-left flex items-center gap-1 px-2 py-1 rounded ${
                activePath === n.path ? 'bg-cyan-500/10 text-cyan-300' : 'hover:bg-white/[0.03] text-gray-300'
              }`}
              style={{ paddingLeft: `${depth * 12 + 24}px` }}
            >
              <MCIcon name="file" size={11} className="text-gray-500" />
              <span className="truncate">{n.name}</span>
              {n.size !== undefined && (
                <span className="ml-auto text-[9px] text-gray-600">
                  {n.size < 1024 ? `${n.size}B` : `${(n.size / 1024).toFixed(1)}K`}
                </span>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
