import type { IncidentsData, Incident, IncidentStatus } from '../lib/types';
import { Shield, CheckCircle, XCircle, AlertTriangle, Clock, Wrench } from '../lib/icons';

interface Props {
  data: IncidentsData;
}

// ── Pipeline step definitions ──

const PIPELINE_STEPS = [
  { key: 'detected', label: 'Detected' },
  { key: 'reported', label: 'Reported' },
  { key: 'approved', label: 'Approved' },
  { key: 'fixing', label: 'Fixing' },
  { key: 'tested', label: 'Tested' },
  { key: 'deployed', label: 'Deployed' },
] as const;

function getStepIndex(status: IncidentStatus): number {
  switch (status) {
    case 'pending_approval':
      return 1; // reported, waiting for approval
    case 'approved':
      return 2;
    case 'fixing':
      return 3;
    case 'fixed':
      return 5; // all steps complete
    case 'failed':
      return -1; // special case
    default:
      return 0;
  }
}

function getFailedStep(status: IncidentStatus): number {
  // Only relevant for 'failed' status - show failure at the fixing step
  if (status === 'failed') return 3;
  return -1;
}

// ── Status badge config ──

const STATUS_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
  pending_approval: { bg: 'bg-amber-500/15', text: 'text-amber-300', label: 'Pending Approval' },
  approved: { bg: 'bg-blue-500/15', text: 'text-blue-300', label: 'Approved' },
  fixing: { bg: 'bg-purple-500/15', text: 'text-purple-300', label: 'Fixing' },
  fixed: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', label: 'Fixed' },
  failed: { bg: 'bg-red-500/15', text: 'text-red-300', label: 'Failed' },
};

// ── Pipeline Visualization ──

function Pipeline({ status }: { status: IncidentStatus }) {
  const currentStep = getStepIndex(status);
  const failedAt = getFailedStep(status);
  const isFailed = status === 'failed';

  return (
    <div className="flex items-center w-full py-4">
      {PIPELINE_STEPS.map((step, i) => {
        const isCompleted = !isFailed && i <= currentStep;
        const isCurrent = !isFailed && i === currentStep && status !== 'fixed';
        const isFailedStep = isFailed && i === failedAt;
        const isPastFailed = isFailed && i < failedAt;
        const isFutureStep = (!isFailed && i > currentStep) || (isFailed && i >= failedAt);

        let circleClass = '';
        let dotContent = null;

        if (isFailedStep) {
          circleClass = 'bg-red-500 border-red-500';
          dotContent = <XCircle size={14} className="text-white" />;
        } else if (isCompleted || isPastFailed) {
          circleClass = 'bg-emerald-500 border-emerald-500';
          dotContent = <CheckCircle size={14} className="text-white" />;
        } else if (isCurrent) {
          circleClass = 'border-blue-500 bg-blue-500/20 animate-pulse-ring';
          dotContent = <span className="w-2 h-2 rounded-full bg-blue-400" />;
        } else {
          circleClass = 'border-gray-600 bg-gray-800';
          dotContent = <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />;
        }

        // Connector line
        let lineClass = 'bg-gray-700';
        if ((isCompleted && i < currentStep) || (isPastFailed && i < failedAt - 1)) {
          lineClass = 'bg-emerald-500';
        } else if (isCurrent && i < currentStep) {
          lineClass = 'bg-blue-500';
        }

        return (
          <div key={step.key} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              <div
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center ${circleClass}`}
              >
                {dotContent}
              </div>
              <span
                className={`text-[10px] mt-1.5 text-center whitespace-nowrap ${
                  isCompleted || isCurrent || isPastFailed
                    ? isFailedStep
                      ? 'text-red-400 font-medium'
                      : isCurrent
                      ? 'text-blue-400 font-medium'
                      : 'text-gray-300'
                    : 'text-gray-600'
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < PIPELINE_STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1 mt-[-18px] ${lineClass} rounded`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Incident Card ──

function IncidentCard({ incident }: { incident: Incident }) {
  const statusCfg = STATUS_CONFIG[incident.status] || STATUS_CONFIG.pending_approval;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 card-hover animate-fade-in">
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-100 leading-snug pr-4">
          {incident.title}
        </h3>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${statusCfg.bg} ${statusCfg.text}`}>
          {statusCfg.label}
        </span>
      </div>

      <Pipeline status={incident.status} />

      <div className="space-y-3 mt-2">
        <div>
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
            Symptoms
          </h4>
          <p className="text-sm text-gray-400 leading-relaxed line-clamp-3">
            {incident.symptoms}
          </p>
        </div>

        <div>
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
            Proposed Fix
          </h4>
          <p className="text-sm text-gray-400 leading-relaxed line-clamp-3">
            {incident.proposedFix}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-800">
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Clock size={12} />
          <span>
            {new Date(incident.reportedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">
          {incident.group}
        </span>
        {incident.fixedAt && (
          <span className="text-xs text-emerald-500 ml-auto">
            Fixed {new Date(incident.fixedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Stats Banner ──

function StatsBanner({ stats }: { stats: Props['data']['stats'] }) {
  return (
    <div className="bg-gradient-to-r from-gray-900 to-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-purple-500/15 flex items-center justify-center">
          <Wrench size={20} className="text-purple-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Self-Heal Pipeline</h2>
          <p className="text-sm text-gray-500">Autonomous bug detection, diagnosis, and repair</p>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-100 tabular-nums">{stats.total}</div>
          <div className="text-xs text-gray-500 mt-0.5">Incidents Detected</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">{stats.autoFixed}</div>
          <div className="text-xs text-gray-500 mt-0.5">Auto-Fixed</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-100 tabular-nums">
            {stats.total > 0 ? `${(stats.successRate * 100).toFixed(0)}%` : '-'}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Success Rate</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-amber-400 tabular-nums">{stats.pending}</div>
          <div className="text-xs text-gray-500 mt-0.5">Pending</div>
        </div>
      </div>
    </div>
  );
}

// ── Empty State ──

function EmptyState() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-16 text-center animate-fade-in">
      <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
        <Shield size={32} className="text-emerald-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-200 mb-2">
        No incidents detected
      </h3>
      <p className="text-sm text-gray-500 max-w-md mx-auto">
        Your agent is running smoothly. When bugs are detected, they appear here
        with a full pipeline view from detection through automated fix and deploy.
      </p>
    </div>
  );
}

// ── Page ──

export function SelfHealPage({ data }: Props) {
  const hasIncidents = data.incidents.length > 0;

  return (
    <div className="animate-fade-in">
      <StatsBanner stats={data.stats} />

      {hasIncidents ? (
        <div className="space-y-4">
          {data.incidents.map((inc) => (
            <IncidentCard key={inc.id} incident={inc} />
          ))}
        </div>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}
