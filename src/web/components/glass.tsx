import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.js';

/**
 * Glass primitives (§28). All materials come from tokens.css — no component
 * hard-codes colors, blur, or shadows.
 *
 * Performance note (§42): only the large coherent surfaces (panes, top bar,
 * overlays, composer) use backdrop-filter. Nested cards (mat-2) and message
 * bubbles are translucent WITHOUT blur.
 */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* --------------------------------------------------------------------------
   Surfaces
   -------------------------------------------------------------------------- */

export function Glass({
  level = 1,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { level?: 1 | 2 | 3 }) {
  return (
    <div className={cn(`glass mat-${level}`, className)} {...rest}>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Buttons
   -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accept' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  icon?: IconName;
}) {
  return (
    <button className={cn('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  size = 16,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: IconName;
  size?: number;
}) {
  return (
    <button className={cn('iconbtn', className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/* --------------------------------------------------------------------------
   Pills, badges, misc
   -------------------------------------------------------------------------- */

export function Pill({ className, children, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn('pill', className)} {...rest}>
      {children}
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return <span className={cn('statusdot', className)} aria-hidden="true" />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Confidence indicator (§14): restrained dots, never a giant progress bar. */
export function ConfidenceDots({ value, label = 'confidence' }: { value: number; label?: string }) {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * 5);
  return (
    <span
      className="dots"
      role="img"
      aria-label={`${label}: ${Math.round(value * 100)} percent`}
      title={`${label} ${Math.round(value * 100)}%`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={cn('dot-unit', i < filled && 'filled')} />
      ))}
    </span>
  );
}

/* --------------------------------------------------------------------------
   Inputs
   -------------------------------------------------------------------------- */

export function TextInput({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('textinput', className)} {...rest} />;
}

/* --------------------------------------------------------------------------
   Overlays
   IMPORTANT: sheets/popovers are portal-rendered to document.body because
   backdrop-filter on an ancestor creates a containing block that would trap
   position:fixed descendants inside the pane.
   -------------------------------------------------------------------------- */

export function useClickOutside<T extends HTMLElement>(
  active: boolean,
  onClose: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [active, onClose]);
  return ref;
}

/** Traps Tab focus inside a dialog while active; restores focus on close. */
export function useFocusTrap(active: boolean): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    window.setTimeout(() => {
      (focusables()[0] ?? node)?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [active]);
  return ref;
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  variant?: 'center' | 'bottom';
  children: React.ReactNode;
  className?: string;
}

/** Floating glass sheet (§37): center panel on desktop, bottom sheet on mobile. */
export function Sheet({ open, onClose, title, variant = 'center', children, className }: SheetProps) {
  const trapRef = useFocusTrap(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className={cn('sheet-root', variant === 'bottom' && 'sheet-bottom')}>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('sheet glass mat-3', className)}
      >
        <div className="sheet-head">
          <span className="sheet-title">{title}</span>
          <IconButton label="Close" icon="close" onClick={onClose} />
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
