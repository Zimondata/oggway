import type { NavSection } from './types';

export const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { id: 'overview', label: 'Обзор', icon: 'grid' },
      { id: 'agents', label: 'Агенты', icon: 'users' },
      { id: 'tasks', label: 'Задачи', icon: 'check' },
      { id: 'chat', label: 'Чат', icon: 'message' },
      { id: 'skills', label: 'Навыки', icon: 'sparkles' },
      { id: 'memory', label: 'Память', icon: 'brain' },
    ],
  },
  {
    label: 'МОНИТОРИНГ',
    items: [
      { id: 'activity', label: 'Активность', icon: 'activity' },
      { id: 'logs', label: 'Журналы', icon: 'file' },
      { id: 'costs', label: 'Учёт затрат', icon: 'wallet' },
      { id: 'office', label: 'Офис', icon: 'building' },
      { id: 'monitor', label: 'Monitor', icon: 'monitor' },
    ],
  },
  {
    label: 'АВТОМАТИЗАЦИЯ',
    items: [
      { id: 'cron', label: 'Cron', icon: 'clock' },
      { id: 'webhooks', label: 'Webhooks', icon: 'webhook' },
      { id: 'alerts', label: 'Оповещения', icon: 'bell' },
      { id: 'github', label: 'GitHub', icon: 'github' },
    ],
  },
  {
    label: 'АДМИН',
    items: [
      { id: 'security', label: 'Безопасность', icon: 'shield' },
      { id: 'users', label: 'Пользователи', icon: 'usercog' },
      { id: 'audit', label: 'Аудит', icon: 'search' },
      { id: 'integrations', label: 'Интеграции', icon: 'plug' },
      { id: 'debug', label: 'Отладка', icon: 'bug' },
      { id: 'settings', label: 'Настройки', icon: 'cog' },
    ],
  },
];

export const PAGE_TITLES: Record<string, { title: string; subtitle?: string }> = {
  overview: { title: 'Mission Control', subtitle: 'Complete each step to bring your station online' },
  agents: { title: 'Agent Squad', subtitle: 'Команда агентов и их состояние' },
  tasks: { title: 'Доска задач', subtitle: 'Канбан с очередями и прогрессом' },
  chat: { title: 'Agent Chat', subtitle: 'Прямой канал с агентом' },
  skills: { title: 'Навыки', subtitle: 'Установленные и доступные skill-плагины' },
  memory: { title: 'Память', subtitle: 'Дневники, темы, weekly summaries' },
  activity: { title: 'Активность', subtitle: 'Лента событий в реальном времени' },
  logs: { title: 'Просмотр логов', subtitle: 'Системные логи в реальном времени' },
  costs: { title: 'Отслеживание расходов', subtitle: 'Анализ токенов, расходов и затрат' },
  office: { title: 'Командный Мостик', subtitle: 'Мониторинг команды в реальном времени' },
  monitor: { title: 'System Monitor', subtitle: 'CPU, Memory, Disk, GPU, Network' },
  cron: { title: 'Управление cron', subtitle: 'Планирование повторяющихся заданий' },
  webhooks: { title: 'Вебхуки', subtitle: 'Локальные автоматизации вебхуков' },
  alerts: { title: 'Правила оповещений', subtitle: 'Автоматические оповещения для событий' },
  github: { title: 'GitHub', subtitle: 'Интеграция с репозиториями' },
  security: { title: 'Аудит Безопасности', subtitle: 'Состояние, события, оценки доверия' },
  users: { title: 'Пользователи', subtitle: 'Учётные записи и роли' },
  audit: { title: 'Журнал аудита', subtitle: 'Последовательность действий' },
  integrations: { title: 'Интеграции', subtitle: 'AI Providers, Search, Social, Dev Tools' },
  debug: { title: 'Отладка', subtitle: 'Статус шлюза, здоровье, модели, API' },
  settings: { title: 'Настройки', subtitle: 'Поведение Mission Control и хранилище' },
  selfheal: { title: 'Self-Heal', subtitle: 'Инциденты и автофиксы' },
};
