import { Component, useEffect, useState, type ReactNode } from 'react';
import { Sidebar, TopBar, AlertBar, StatusFooter, PageHeader, type Alert } from './components/Layout';
import { OnboardingWizard } from './components/OnboardingWizard';
import { ChatPage } from './pages/ChatPage';
import { CostsPage } from './pages/CostsPage';
import { SelfHealPage } from './pages/SelfHealPage';
import { MissionOverviewPage } from './pages/MissionOverviewPage';
import type { CostsData, IncidentsData } from './lib/types';
import { AgentsPage } from './pages/AgentsPage';
import { TasksPage } from './pages/TasksPage';
import { MemoryPage } from './pages/MemoryPage';
import { CronPage } from './pages/CronPage';
import { LogsPage } from './pages/LogsPage';
import {
  SkillsPage,
  ActivityPage,
  OfficePage,
  MonitorPage,
  WebhooksPage,
  AlertsPage,
  GitHubPage,
  SecurityPage,
  UsersPage,
  AuditPage,
  IntegrationsPage,
  DebugPage,
  SettingsPage,
} from './pages/StubPages';
import type { TabId } from './lib/types';

const ONBOARDING_KEY = 'cc-onboarding-done';

class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        this.props.fallback || (
          <div className="flex items-center justify-center py-32 text-gray-500 text-sm">
            <div className="text-center">
              <p className="mb-2">Failed to load this page</p>
              <p className="text-xs text-gray-600">{this.state.error.message}</p>
              <button
                onClick={() => this.setState({ error: null })}
                className="mt-3 text-xs text-cyan-400 hover:text-cyan-300"
              >
                Retry
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [tab, setTab] = useState<TabId>(() => {
    const fromUrl = new URLSearchParams(location.search).get('tab') as TabId | null;
    return fromUrl || 'overview';
  });
  const [collapsed, setCollapsed] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem(ONBOARDING_KEY));

  // Surface gateway / drift alerts on first load.
  useEffect(() => {
    setAlerts([
      {
        id: 'gateway',
        level: 'info',
        title: 'Шлюз не обнаружен',
        body: 'Работа в локальном режиме. Мониторим сессии Claude Code, задачи и локальные данные.',
        actions: [{ label: 'Настроить шлюз', primary: true }],
      },
    ]);
  }, []);

  const dismissAlert = (id: string) => setAlerts((a) => a.filter((x) => x.id !== id));

  const finishOnboarding = (mode: 'light' | 'full') => {
    localStorage.setItem(ONBOARDING_KEY, mode);
    setShowOnboarding(false);
  };

  return (
    <div className="flex h-screen bg-[#06080f] text-gray-100 overflow-hidden">
      <Sidebar
        active={tab}
        onSelect={setTab}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <TopBar active={tab} />
        <AlertBar alerts={alerts} onDismiss={dismissAlert} />

        <div className="flex-1 overflow-y-auto px-8 py-6 bg-[#06080f]">
          <ErrorBoundary>
            {tab !== 'overview' && tab !== 'chat' && <PageHeader id={tab} />}
            <PageRouter tab={tab} />
          </ErrorBoundary>
        </div>

        <StatusFooter />
      </main>

      {showOnboarding && (
        <OnboardingWizard
          onComplete={finishOnboarding}
          onSkip={() => {
            localStorage.setItem(ONBOARDING_KEY, 'skipped');
            setShowOnboarding(false);
          }}
        />
      )}
    </div>
  );
}

function PageRouter({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'overview':
      return <MissionOverviewPage />;
    case 'chat':
      return (
        <div className="h-full -mx-8 -my-6">
          <ChatPage />
        </div>
      );
    case 'costs':
      return <CostsPageWrapper />;
    case 'selfheal':
      return <SelfHealPageWrapper />;
    case 'agents':
      return <AgentsPage />;
    case 'tasks':
      return <TasksPage />;
    case 'skills':
      return <SkillsPage />;
    case 'memory':
      return <MemoryPage />;
    case 'activity':
      return <ActivityPage />;
    case 'logs':
      return <LogsPage />;
    case 'office':
      return <OfficePage />;
    case 'monitor':
      return <MonitorPage />;
    case 'cron':
      return <CronPage />;
    case 'webhooks':
      return <WebhooksPage />;
    case 'alerts':
      return <AlertsPage />;
    case 'github':
      return <GitHubPage />;
    case 'security':
      return <SecurityPage />;
    case 'users':
      return <UsersPage />;
    case 'audit':
      return <AuditPage />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'debug':
      return <DebugPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return null;
  }
}

function CostsPageWrapper() {
  const [data, setData] = useState<CostsData | null>(null);
  useEffect(() => {
    fetch('/api/costs?period=7d').then((r) => r.json()).then(setData).catch(() => setData(null));
  }, []);
  if (!data) return <div className="text-gray-500 text-[12px] py-12 text-center">Loading…</div>;
  return <CostsPage data={data} />;
}

function SelfHealPageWrapper() {
  const [data, setData] = useState<IncidentsData | null>(null);
  useEffect(() => {
    fetch('/api/incidents').then((r) => r.json()).then(setData).catch(() => setData(null));
  }, []);
  if (!data) return <div className="text-gray-500 text-[12px] py-12 text-center">Loading…</div>;
  return <SelfHealPage data={data} />;
}
