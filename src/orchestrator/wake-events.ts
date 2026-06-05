/**
 * Wake events.
 *
 * External services (monitoring, GitHub, Garmin, price tickers) push HTTP
 * events to /webhook/<group>/wake. Each event is identified by a
 * "<source>.<eventType>" tag (e.g. "garmin.hrv-anomaly"). A handler turns
 * the raw payload into a concrete prompt for the agent.
 *
 * Unknown tags fall back to a generic prompt so the agent at least gets
 * a chance to react. Add explicit handlers for common cases to make the
 * agent's job easier.
 */

export interface WakeEvent {
  source: string;       // 'garmin', 'github', 'crypto', ...
  eventType: string;    // 'hrv-anomaly', 'ci-failed', 'price-cross', ...
  payload: Record<string, unknown>;
  receivedAt: string;   // ISO timestamp
}

export type WakeHandler = (event: WakeEvent) => string;

const handlers: Record<string, WakeHandler> = {
  // ---------------- Garmin ----------------
  'garmin.hrv-anomaly': (e) => {
    const hrv = (e.payload.hrv as number | undefined) ?? '?';
    const baseline = (e.payload.baseline as number | undefined) ?? '?';
    const date = e.payload.date ?? new Date().toISOString().slice(0, 10);
    return `[WAKE-EVENT garmin.hrv-anomaly @ ${e.receivedAt}]
HRV сейчас ${hrv} (baseline ${baseline}, date ${date}).

Прочитай memory/topics/wellbeing.md и текущий календарь на сегодня.
Если есть важная встреча в первой половине дня — мягко предложи перенести.
Если это разовая аномалия (был стресс/тренировка) — просто запиши в memory/daily/ и не беспокой.
Не паникуй, не спамь. Один взвешенный ответ.`;
  },

  'garmin.poor-sleep': (e) => {
    const score = (e.payload.score as number | undefined) ?? '?';
    return `[WAKE-EVENT garmin.poor-sleep] Sleep score ${score}.
Запиши в memory/daily/. Если у тебя есть план дня - адаптируй (предложи лёгкий день).
Не отправляй если score >= 60 (не критично).`;
  },

  // ---------------- GitHub ----------------
  'github.ci-failed': (e) => {
    const repo = e.payload.repository ?? '?';
    const branch = e.payload.branch ?? '?';
    const url = e.payload.html_url ?? '';
    return `[WAKE-EVENT github.ci-failed] CI красный в ${repo} на ветке ${branch}.
URL: ${url}

Через WebFetch посмотри логи (если есть API access). Кратко скажи Жене:
- какой test/job упал
- предполагаемая причина (если понятна)
- 1-2 шага что попробовать
Если падает периодически - запиши skill.`;
  },

  'github.pr-review-requested': (e) => {
    const url = e.payload.html_url ?? '';
    const author = e.payload.author ?? '?';
    return `[WAKE-EVENT github.pr-review-requested] ${author} запросил ревью.
URL: ${url}

Скажи Жене кратко: автор + размер PR + 1-строчная цель. Если можешь — открой через WebFetch и резюмируй diff.`;
  },

  // ---------------- Crypto / markets ----------------
  'crypto.price-cross': (e) => {
    const symbol = e.payload.symbol ?? 'BTC';
    const price = e.payload.price ?? '?';
    const threshold = e.payload.threshold ?? '?';
    const direction = e.payload.direction ?? '?';
    return `[WAKE-EVENT crypto.price-cross] ${symbol} ${direction} $${threshold} → текущая $${price}.
Это срабатывание триггера который Женя сам поставил.
Скажи кратко: один-два факта (текущая цена, чем отличается от уровня), без советов "купить/продать".`;
  },

  // ---------------- Monitoring ----------------
  'monitoring.service-down': (e) => {
    const service = e.payload.service ?? '?';
    const since = e.payload.since ?? 'just now';
    return `[WAKE-EVENT monitoring.service-down] ${service} лежит с ${since}.
Если это ClaudeClaw — попробуй restart_service. Иначе скажи Жене и предложи действие.`;
  },

  'monitoring.cost-spike': (e) => {
    const window = e.payload.window ?? '1h';
    const spend = e.payload.spend ?? '?';
    return `[WAKE-EVENT monitoring.cost-spike] За ${window} ушло $${spend}.
Это аномально. Проверь agent_runs за последний час, найди что жрёт. Скажи Жене найденное.`;
  },
};

/**
 * Resolve a wake-event payload into an agent prompt.
 * Falls back to a generic template if no handler is registered.
 */
export function buildWakePrompt(event: WakeEvent): string {
  const tag = `${event.source}.${event.eventType}`;
  const handler = handlers[tag];
  if (handler) return handler(event);

  // Generic fallback — agent gets the raw payload.
  return `[WAKE-EVENT ${tag} @ ${event.receivedAt}]
External service emitted an event. Raw payload:
${JSON.stringify(event.payload, null, 2)}

Decide if this needs Женя's attention. If yes — short message in chat.
If no — log to memory/daily/ and stay silent (<internal>HEARTBEAT_OK wake</internal>).`;
}

export function registerWakeHandler(tag: string, handler: WakeHandler): void {
  handlers[tag] = handler;
}

export function listRegisteredWakeHandlers(): string[] {
  return Object.keys(handlers).sort();
}
