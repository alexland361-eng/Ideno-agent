import React from 'react';

/**
 * Icon system (§27): one coherent set of lightweight stroke icons.
 * 24×24 viewBox, 1.7 stroke, round caps — sized by the `size` prop.
 */

export type IconName =
  | 'logo'
  | 'workspace'
  | 'research'
  | 'history'
  | 'settings'
  | 'state'
  | 'search'
  | 'send'
  | 'stop'
  | 'plus'
  | 'check'
  | 'close'
  | 'chevron-down'
  | 'chevron-right'
  | 'user'
  | 'shield'
  | 'bolt'
  | 'layers'
  | 'alert'
  | 'info'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'refresh'
  | 'archive'
  | 'sparkle'
  | 'inspect'
  | 'minus'
  | 'trash'
  | 'compass'
  | 'orbit';

const PATHS: Record<IconName, React.ReactNode> = {
  orbit: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-24 12 12)" />
    </>
  ),
  logo: (
    <>
      <path d="M12 4.5 20 9l-8 4.5L4 9l8-4.5z" />
      <path d="M20 13.5 12 18l-8-4.5" />
    </>
  ),
  workspace: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
  research: (
    <>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.63.28 1.1.87 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  state: (
    <>
      <path d="M12 3 2.5 8 12 13l9.5-5L12 3z" />
      <path d="M2.5 13.5 12 18.5l9.5-5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      <path d="M21 21l-4.7-4.7" />
    </>
  ),
  send: <path d="M12 19V5m-7 7 7-7 7 7" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  layers: (
    <>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </>
  ),
  alert: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  monitor: (
    <>
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8.5 21h7M12 16.5V21" />
    </>
  ),
  refresh: (
    <>
      <path d="M23 4v6h-6" />
      <path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10" />
    </>
  ),
  archive: (
    <>
      <rect x="2.5" y="4" width="19" height="5" rx="1.5" />
      <path d="M4.5 9v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </>
  ),
  sparkle: <path d="M12 3.5l1.9 5.3 5.3 1.9-5.3 1.9L12 18l-1.9-5.4-5.3-1.9 5.3-1.9L12 3.5zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />,
  inspect: (
    <>
      <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  trash: (
    <>
      <path d="M3.5 6h17M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <path d="M5.5 6 6.7 20a2 2 0 0 0 2 1.9h6.6a2 2 0 0 0 2-1.9L18.5 6" />
      <path d="M10 10.5v7M14 10.5v7" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m15.5 8.5-2 5.2-5.2 2 2-5.2 5.2-2z" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
