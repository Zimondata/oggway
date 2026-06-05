import { useState } from 'react';

type Step = 0 | 1 | 2;

const STEPS = ['Welcome', 'Interface', 'Credentials'];

export function OnboardingWizard({ onComplete, onSkip }: { onComplete: (mode: 'light' | 'full') => void; onSkip: () => void }) {
  const [step, setStep] = useState<Step>(0);
  const [mode, setMode] = useState<'light' | 'full'>('light');

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl bg-[#0d1220] border border-white/10 shadow-2xl">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 pt-6">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`flex items-center gap-2 ${i === step ? '' : 'opacity-40'}`}
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  i === step
                    ? 'bg-amber-400'
                    : i < step
                      ? 'bg-emerald-400'
                      : 'bg-gray-600'
                }`}
              />
            </div>
          ))}
        </div>
        <div className="text-center pt-2 text-[11px] tracking-widest text-gray-500 uppercase">
          {STEPS[step]}
        </div>

        <div className="p-8">
          {step === 0 && <WelcomeStep />}
          {step === 1 && <InterfaceStep mode={mode} onChange={setMode} />}
          {step === 2 && <CredentialsStep />}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-white/5">
          <button
            onClick={step === 0 ? onSkip : () => setStep((step - 1) as Step)}
            className="text-[12px] text-gray-500 hover:text-gray-300"
          >
            {step === 0 ? 'Пропустить настройку' : 'Назад'}
          </button>
          <button
            onClick={() => {
              if (step === 2) onComplete(mode);
              else setStep((step + 1) as Step);
            }}
            className="px-5 py-2 text-[12px] font-medium bg-amber-500 hover:bg-amber-400 text-black rounded-md"
          >
            {step === 2 ? 'Запустить всё равно' : step === 0 ? 'Начать' : 'Продолжить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-500 mb-4">
        <span className="text-white font-bold">CC</span>
      </div>
      <h2 className="text-[20px] font-bold text-gray-100 mb-2">
        Добро пожаловать в Mission Control
      </h2>
      <p className="text-[13px] text-gray-500 leading-relaxed">
        Ваша станция для AI-агентов. Когда агенты стыкуются здесь, они получают постоянную
        память, управление задачами, координированные рабочие процессы и полную
        наблюдаемость. Мы просканировали вашу конфигурацию вот что онлайн.
      </p>
      <div className="mt-6 space-y-2 text-left max-w-sm mx-auto">
        <RuntimeRow name="ClaudeClaw" version="0.1.0" status="authenticated" />
        <RuntimeRow name="Hermes Agent" status="not-installed" />
        <RuntimeRow name="Claude Code" version="2.1.128" status="authenticated" />
        <RuntimeRow name="Codex CLI" status="not-installed" />
        <RuntimeRow name="OpenCode" status="not-installed" />
      </div>
      <div className="mt-4 text-[11px] text-gray-600">2 of 5 runtimes ready</div>
    </div>
  );
}

function RuntimeRow({ name, version, status }: { name: string; version?: string; status: 'authenticated' | 'not-installed' }) {
  const ok = status === 'authenticated';
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className={ok ? 'text-emerald-400' : 'text-gray-700'}>●</span>
      <span className={ok ? 'text-gray-200' : 'text-gray-600'}>{name}</span>
      {version && <span className="text-gray-600 text-[10px]">{version}</span>}
      <span className={`ml-auto text-[10px] ${ok ? 'text-emerald-400' : 'text-gray-700'}`}>
        {ok ? 'Authenticated' : 'Not installed'}
      </span>
    </div>
  );
}

function InterfaceStep({ mode, onChange }: { mode: 'light' | 'full'; onChange: (m: 'light' | 'full') => void }) {
  return (
    <div>
      <h2 className="text-[18px] font-bold text-gray-100 mb-2">Выберите раскладку станции</h2>
      <p className="text-[12px] text-gray-500 mb-5 leading-relaxed">
        Базовый показывает основные панели, которые оператору нужны чаще всего. Полный
        открывает все системы станции - память, автоматизацию, аудит безопасности и многое
        другое. Вы можете переключиться в любое время.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <ModeCard
          selected={mode === 'light'}
          onClick={() => onChange('light')}
          label="Базовый"
          tag="Выбран"
          desc="Оптимизированное управление - панели для ежедневного использования: обзор флота, агенты, задачи, чат, лента активности, журналы, настройки."
          tone="amber"
        />
        <ModeCard
          selected={mode === 'full'}
          onClick={() => onChange('full')}
          label="Полный"
          desc="Полный доступ к станции - добавляет обозреватель памяти, планирование Cron, Webhooks, оповещения, аудит безопасности, учёт затрат и конфигурации шлюза."
          tone="cyan"
        />
      </div>
    </div>
  );
}

function ModeCard({
  selected,
  onClick,
  label,
  desc,
  tag,
  tone,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  desc: string;
  tag?: string;
  tone: 'amber' | 'cyan';
}) {
  const accent = tone === 'amber' ? 'text-amber-400 border-amber-500/40' : 'text-cyan-400 border-cyan-500/40';
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-colors ${
        selected ? accent + ' bg-white/[0.03]' : 'border-white/5 hover:border-white/10'
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <span className={`text-[14px] font-semibold ${selected ? '' : 'text-gray-300'}`}>{label}</span>
        {tag && selected && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">{tag}</span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">{desc}</p>
    </button>
  );
}

function CredentialsStep() {
  return (
    <div>
      <h2 className="text-[18px] font-bold text-gray-100 mb-2">Защитите свою станцию</h2>
      <p className="text-[12px] text-gray-500 mb-5 leading-relaxed">
        Пароль администратора защищает консоль вашей станции. API-ключ - это стыковочный
        пропуск - агенты предъявляют его при регистрации, чтобы только авторизованные агенты
        могли стыковаться.
      </p>
      <div className="space-y-2">
        <CredCard tone="error" tag="[x]" title="Пароль администратора" body="Используется стандартный или слабый пароль - измените AUTH_PASS в .env" />
        <CredCard tone="ok" tag="[+]" title="API-ключ" body="Настроен - агенты могут стыковаться с этим ключом." />
      </div>
      <button className="mt-3 text-[11px] text-cyan-400 hover:underline">Открыть настройки</button>
    </div>
  );
}

function CredCard({ tone, tag, title, body }: { tone: 'ok' | 'error'; tag: string; title: string; body: string }) {
  const styles =
    tone === 'ok'
      ? 'bg-emerald-950/30 border-emerald-500/30'
      : 'bg-red-950/30 border-red-500/30';
  const tagColor = tone === 'ok' ? 'text-emerald-400' : 'text-red-400';
  return (
    <div className={`rounded-lg border p-3 ${styles}`}>
      <div className="flex items-start gap-2">
        <span className={`font-mono text-[11px] ${tagColor}`}>{tag}</span>
        <div>
          <div className="text-[12px] font-medium text-gray-200">{title}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">{body}</div>
        </div>
      </div>
    </div>
  );
}
