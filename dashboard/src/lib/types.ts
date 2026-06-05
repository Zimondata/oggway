// ── Core dashboard data ──

export interface DashboardData {
  summary: Summary;
  daily: DailyEntry[];
  groups: GroupEntry[];
  recentRuns: AgentRun[];
  modelBreakdown: ModelBreakdown[];
  systemHealth: SystemHealth;
  trends: Trends;
}

export interface Summary {
  totalRuns: number;
  totalCost: number;
  totalTokens: number;
  avgDuration: number;
  activeGroups: number;
  uptimeHours: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface Trends {
  runs: number;       // % change vs previous period
  cost: number;
  tokens: number;
  duration: number;
  successRate: number;
}

export interface DailyEntry {
  date: string;
  runs: number;
  cost: number;
  tokens: number;
  opusRuns: number;
  sonnetRuns: number;
  haikuRuns: number;
  opusCost: number;
  sonnetCost: number;
  haikuCost: number;
}

export interface GroupEntry {
  folder: string;
  runs: number;
  cost: number;
  avgDuration: number;
  successRate: number;
  dominantModel: string;
}

export interface AgentRun {
  id: number;
  groupFolder: string;
  triggerType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;
  durationMs: number;
  turns: number;
  status: string;
  runAt: string;
}

export interface ModelBreakdown {
  model: string;
  runs: number;
  cost: number;
  tokens: number;
  avgDuration: number;
}

export interface SystemHealth {
  serviceUptime: number;
  runtime: string;
  registeredGroups: GroupStatus[];
  scheduledTasks: ScheduledTask[];
  dbSizeBytes: number;
}

export interface GroupStatus {
  folder: string;
  channel: string;
  hasActiveSession: boolean;
  lastRunAt: string | null;
}

export interface ScheduledTask {
  id: string;
  groupFolder: string;
  cron: string;
  prompt: string;
  nextRun: string | null;
  enabled: boolean;
}

// ── Costs data ──

export interface CostsData {
  summary: CostsSummary;
  daily: CostsDailyEntry[];
  byModel: CostsByModel[];
  byGroup: CostsByGroup[];
  tokenDistribution: TokenDistribution;
}

export interface CostsSummary {
  totalCost: number;
  costPerRun: number;
  cacheHitRate: number;
  costPerMessage: number;
}

export interface CostsDailyEntry {
  date: string;
  cost: number;
  runs: number;
}

export interface CostsByModel {
  model: string;
  cost: number;
  runs: number;
  percentage: number;
}

export interface CostsByGroup {
  folder: string;
  cost: number;
  runs: number;
}

export interface TokenDistribution {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// ── Incidents / Self-heal ──

export interface Incident {
  id: string;
  group: string;
  title: string;
  symptoms: string;
  proposedFix: string;
  status: IncidentStatus;
  reportedAt: string;
  approvedAt: string | null;
  fixedAt: string | null;
  logs: string;
}

export type IncidentStatus =
  | 'pending_approval'
  | 'approved'
  | 'fixing'
  | 'fixed'
  | 'failed';

export interface IncidentsData {
  incidents: Incident[];
  stats: IncidentStats;
}

export interface IncidentStats {
  total: number;
  autoFixed: number;
  successRate: number;
  pending: number;
}

// ── Navigation ──

export type TabId =
  | 'overview'
  | 'agents'
  | 'tasks'
  | 'chat'
  | 'skills'
  | 'memory'
  | 'activity'
  | 'logs'
  | 'costs'
  | 'office'
  | 'monitor'
  | 'cron'
  | 'webhooks'
  | 'alerts'
  | 'github'
  | 'security'
  | 'users'
  | 'audit'
  | 'integrations'
  | 'debug'
  | 'settings'
  | 'selfheal';

export interface NavEntry {
  id: TabId;
  label: string;
  icon: string;
  badge?: number;
}

export interface NavSection {
  label: string | null;
  items: NavEntry[];
}
