import type { ReactNode } from 'react';
import { MCIcon } from '../components/MCIcon';
import { PAGE_TITLES } from '../lib/nav';
import type { TabId } from '../lib/types';

// Generic empty-state stub for pages not yet implemented.
function Stub({ id, hint, icon }: { id: TabId; hint?: ReactNode; icon: string }) {
  const meta = PAGE_TITLES[id];
  return (
    <div className="flex items-center justify-center py-24">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.03] border border-white/5 mb-4 text-gray-500">
          <MCIcon name={icon} size={22} />
        </div>
        <h3 className="text-[15px] font-semibold text-gray-300 mb-1">{meta?.title ?? id}</h3>
        <p className="text-[12px] text-gray-500 leading-relaxed">{hint ?? meta?.subtitle}</p>
        <div className="mt-4 text-[10px] text-gray-600">Coming in Phase 2</div>
      </div>
    </div>
  );
}

export const SkillsPage = () => <Stub id="skills" icon="sparkles" />;
export const ActivityPage = () => <Stub id="activity" icon="activity" />;
export const OfficePage = () => (
  <Stub id="office" icon="building" hint="2D-карта сессий агентов (как Mission Control office)." />
);
export const MonitorPage = () => (
  <Stub id="monitor" icon="monitor" hint="CPU, Memory, Disk, GPU, Network — Phase 3." />
);
export const WebhooksPage = () => (
  <Stub id="webhooks" icon="webhook" hint="Конфигурация WEBHOOK_PORT/WEBHOOK_SECRET." />
);
export const AlertsPage = () => <Stub id="alerts" icon="bell" />;
export const GitHubPage = () => <Stub id="github" icon="github" hint="Триаж issues/PRs через triage extension." />;
export const SecurityPage = () => <Stub id="security" icon="shield" />;
export const UsersPage = () => <Stub id="users" icon="usercog" />;
export const AuditPage = () => <Stub id="audit" icon="search" />;
export const IntegrationsPage = () => (
  <Stub id="integrations" icon="plug" hint="API ключи: Anthropic, OpenAI, GitHub, Brightdata и т.д." />
);
export const DebugPage = () => (
  <Stub id="debug" icon="bug" hint="Статус шлюза, здоровье runtime, тестовые запросы к моделям." />
);
export const SettingsPage = () => (
  <Stub id="settings" icon="cog" hint="Поведение Mission Control, бэкап, переустановка onboarding." />
);
