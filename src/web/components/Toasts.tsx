import React from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.js';
import { cn } from './glass.js';

/**
 * Restrained transient notifications (§40): only real events, auto-dismiss,
 * never stacked spam.
 */

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

const TOAST_ICON: Record<Toast['kind'], IconName> = {
  ok: 'check',
  error: 'alert',
  info: 'info',
};

export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cn('toast glass mat-3', `toast-${t.kind}`)}>
          <Icon name={TOAST_ICON[t.kind]} size={14} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
