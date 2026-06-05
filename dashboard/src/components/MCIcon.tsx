// Compact icon set for Mission Control sidebar/UI.
// One component, name-based lookup. Outline 1.75 stroke, neutral.

import type { ReactElement } from 'react';

interface Props {
  name: string;
  size?: number;
  className?: string;
}

const PATHS: Record<string, ReactElement> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </>
  ),
  check: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  message: (
    <>
      <path d="M21 12a8 8 0 0 1-8 8H6l-3 2v-10a8 8 0 0 1 18 0z" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      <path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    </>
  ),
  brain: (
    <>
      <path d="M12 3a3 3 0 0 0-3 3v0a3 3 0 0 0-3 3v3a3 3 0 0 0 3 3v3a3 3 0 0 0 6 0v-3a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3v0a3 3 0 0 0-3-3z" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </>
  ),
  activity: (
    <>
      <path d="M22 12h-4l-3 9-6-18-3 9H2" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  wallet: (
    <>
      <path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M3 7l3-3h12l3 3" />
      <circle cx="17" cy="14" r="1.5" />
    </>
  ),
  building: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  webhook: (
    <>
      <circle cx="6" cy="14" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M8.5 12l4-7M9 14h9M14 17l4-3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  github: (
    <>
      <path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5a3 3 0 0 0-.8-2.2c2.8-.3 5.8-1.4 5.8-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.5 11.5 0 0 0-6 0C7.8 2.6 6.8 2.9 6.8 2.9a4.3 4.3 0 0 0-.1 3.2 4.6 4.6 0 0 0-1.3 3.3c0 4.6 3 5.6 5.8 6a3 3 0 0 0-.8 2.2V21" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    </>
  ),
  usercog: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21v-1a7 7 0 0 1 11-5.7" />
      <circle cx="18" cy="17" r="3" />
      <path d="M18 13v1M18 20v1M22 17h-1M15 17h-1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </>
  ),
  plug: (
    <>
      <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 18v4" />
    </>
  ),
  bug: (
    <>
      <rect x="6" y="8" width="12" height="12" rx="6" />
      <path d="M8 8a4 4 0 0 1 8 0M2 12h4M2 16h4M18 12h4M18 16h4M12 4v4" />
    </>
  ),
  cog: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a2 2 0 0 0 .4 2.2l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-2.2-.4 2 2 0 0 0-1.2 1.8V21a2 2 0 1 1-4 0v-.1a2 2 0 0 0-1.3-1.8 2 2 0 0 0-2.2.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a2 2 0 0 0 .4-2.2 2 2 0 0 0-1.8-1.2H3a2 2 0 1 1 0-4h.1a2 2 0 0 0 1.8-1.3 2 2 0 0 0-.4-2.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a2 2 0 0 0 2.2.4h.1a2 2 0 0 0 1.2-1.8V3a2 2 0 1 1 4 0v.1a2 2 0 0 0 1.2 1.8 2 2 0 0 0 2.2-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a2 2 0 0 0-.4 2.2v.1a2 2 0 0 0 1.8 1.2H21a2 2 0 1 1 0 4h-.1a2 2 0 0 0-1.5 1.2z" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </>
  ),
  chevron: (
    <>
      <path d="M9 18l6-6-6-6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 2L2 22h20z" />
      <path d="M12 9v5M12 17.5v.5" />
    </>
  ),
  send: (
    <>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
};

export function MCIcon({ name, size = 18, className = '' }: Props) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {path}
    </svg>
  );
}
