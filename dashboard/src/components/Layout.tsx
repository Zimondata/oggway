import { useState } from 'react';
import { MCIcon } from './MCIcon';
import { NAV_SECTIONS, PAGE_TITLES } from '../lib/nav';
import type { TabId } from '../lib/types';

// ── Sidebar ──

interface SidebarProps {
  active: TabId;
  onSelect: (id: TabId) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({ active, onSelect, collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={`flex flex-col bg-[#0a0e1a] border-r border-white/5 ${
        collapsed ? 'w-14' : 'w-56'
      } flex-shrink-0 transition-[width] duration-200`}
    >
      {/* Logo / titlebar safe area on macOS */}
      <div className="h-12 flex items-center px-4 border-b border-white/5 select-none [app-region:drag]">
        <div className="flex items-center gap-2 [app-region:no-drag]">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 via-purple-500 to-cyan-500 flex items-center justify-center text-[10px] font-bold text-white">
            CC
          </div>
          {!collapsed && (
            <div>
              <div className="text-[13px] font-semibold text-gray-100 leading-none">
                Mission<span className="text-cyan-400">.</span>
              </div>
              <div className="text-[9px] text-gray-500 tracking-wider mt-0.5">v0.1.0</div>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_SECTIONS.map((section, i) => (
          <div key={i} className="mb-3">
            {section.label && !collapsed && (
              <div className="px-4 pt-2 pb-1 text-[10px] font-semibold tracking-[0.12em] text-gray-600 uppercase">
                {section.label}
              </div>
            )}
            {section.items.map((item) => {
              const isActive = active === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-1.5 text-[13px] transition-colors ${
                    isActive
                      ? 'bg-cyan-400/10 text-cyan-300 border-l-2 border-cyan-400'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.03] border-l-2 border-transparent'
                  } ${collapsed ? 'justify-center px-0' : ''}`}
                  title={collapsed ? item.label : undefined}
                >
                  <MCIcon name={item.icon} size={16} className={isActive ? 'text-cyan-400' : ''} />
                  {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
                  {!collapsed && item.badge !== undefined && item.badge > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer pills */}
      {!collapsed && (
        <div className="border-t border-white/5 p-3 space-y-1.5">
          <div className="text-[10px] px-2 py-1 rounded bg-cyan-500/10 text-cyan-300 inline-block">
            CLI
          </div>
          <div className="text-[10px] text-gray-600 leading-tight">
            A power tools for agents
          </div>
        </div>
      )}

      {onToggle && (
        <button
          onClick={onToggle}
          className="border-t border-white/5 py-2 text-gray-600 hover:text-gray-300 flex items-center justify-center"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <MCIcon name="chevron" size={14} className={collapsed ? '' : 'rotate-180'} />
        </button>
      )}
    </aside>
  );
}

// ── Top bar (search + status) ──

export function TopBar({
  active,
  onCommand,
}: {
  active: TabId;
  onCommand?: (text: string) => void;
}) {
  const meta = PAGE_TITLES[active] ?? { title: active };
  const [q, setQ] = useState('');
  return (
    <header className="h-12 flex items-center gap-4 px-6 border-b border-white/5 bg-[#0a0e1a] flex-shrink-0 [app-region:drag]">
      <div className="flex items-center gap-2 [app-region:no-drag]">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
          Локальный
        </span>
      </div>
      <div className="flex-1 max-w-2xl [app-region:no-drag]">
        <div className="relative">
          <MCIcon
            name="search"
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim() && onCommand) {
                onCommand(q.trim());
                setQ('');
              }
            }}
            placeholder="Перейти к странице, задаче, агенту..."
            className="w-full bg-white/[0.03] border border-white/5 rounded-md pl-9 pr-12 py-1.5 text-[13px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/40 focus:bg-white/[0.05]"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
            ⌘K
          </kbd>
        </div>
      </div>
      <div className="flex items-center gap-4 text-[11px] text-gray-500 tabular-nums [app-region:no-drag]">
        <span>
          Сессии <span className="text-gray-300">3/100</span>
        </span>
        <span>
          События <span className="text-emerald-400">● Жив</span>
        </span>
        <span className="text-gray-400">{new Date().toTimeString().slice(0, 5)}</span>
      </div>
      <div className="ml-auto text-[11px] text-gray-500 [app-region:no-drag]">
        <h1 className="text-[13px] font-medium text-gray-200">{meta.title}</h1>
      </div>
    </header>
  );
}

// ── Alert bar ──

export interface Alert {
  id: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  body?: string;
  actions?: { label: string; onClick?: () => void; primary?: boolean }[];
}

export function AlertBar({ alerts, onDismiss }: { alerts: Alert[]; onDismiss?: (id: string) => void }) {
  if (!alerts.length) return null;
  return (
    <div className="flex-shrink-0">
      {alerts.map((a) => {
        const styles =
          a.level === 'error'
            ? 'bg-red-950/40 border-red-500/30 text-red-200'
            : a.level === 'warn'
              ? 'bg-amber-950/40 border-amber-500/30 text-amber-200'
              : 'bg-blue-950/40 border-blue-500/30 text-blue-200';
        return (
          <div
            key={a.id}
            className={`px-6 py-2.5 border-b ${styles} flex items-start gap-3 text-[12px]`}
          >
            <span className="mt-0.5">●</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium">{a.title}</div>
              {a.body && <div className="opacity-80 mt-0.5 text-[11px]">{a.body}</div>}
            </div>
            <div className="flex items-center gap-2">
              {a.actions?.map((act, i) => (
                <button
                  key={i}
                  onClick={act.onClick}
                  className={`text-[11px] px-2.5 py-1 rounded ${
                    act.primary
                      ? 'bg-white/10 hover:bg-white/15 text-white'
                      : 'border border-white/10 hover:bg-white/5'
                  }`}
                >
                  {act.label}
                </button>
              ))}
              {onDismiss && (
                <button
                  onClick={() => onDismiss(a.id)}
                  className="text-[11px] text-gray-400 hover:text-gray-200 px-1"
                  aria-label="dismiss"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Status footer ──

export function StatusFooter() {
  return (
    <footer className="h-8 flex items-center gap-6 px-6 border-t border-white/5 bg-[#0a0e1a] text-[10px] text-gray-500 flex-shrink-0">
      <span className="font-medium text-gray-400">System</span>
      <span>
        Mem <span className="text-gray-300">69%</span>
      </span>
      <span>
        Disk <span className="text-gray-300">12%</span>
      </span>
      <span>
        Uptime <span className="text-gray-300">8h</span>
      </span>
      <span>
        AC <span className="text-emerald-400">● OK</span>
      </span>
      <div className="ml-auto flex items-center gap-4">
        <span>v0.1.0 · Tauri</span>
      </div>
    </footer>
  );
}

// ── Page wrapper ──

export function PageHeader({ id }: { id: TabId }) {
  const meta = PAGE_TITLES[id] ?? { title: id };
  return (
    <div className="mb-6">
      <h2 className="text-[22px] font-bold text-gray-100 leading-tight">{meta.title}</h2>
      {meta.subtitle && <p className="text-[13px] text-gray-500 mt-1">{meta.subtitle}</p>}
    </div>
  );
}
