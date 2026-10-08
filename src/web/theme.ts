import { useCallback, useEffect, useState } from 'react';

/**
 * Appearance management (§5 Light and Dark): light / dark / system.
 * The resolved theme is written to <html data-theme>; a pre-paint script in
 * index.html applies the stored value before React boots to avoid a flash.
 */

export type Appearance = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'ideno.appearance';

export function readStoredAppearance(): Appearance {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // storage unavailable — fall through
  }
  return 'system';
}

function resolve(appearance: Appearance): 'light' | 'dark' {
  if (appearance !== 'system') return appearance;
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyToDocument(appearance: Appearance): void {
  document.documentElement.setAttribute('data-theme', resolve(appearance));
}

export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [appearance, setAppearanceState] = useState<Appearance>(readStoredAppearance);

  useEffect(() => {
    applyToDocument(appearance);
    if (appearance !== 'system') return;
    // Follow OS changes while in system mode.
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia?.('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    if (!media) return;
    const onChange = () => applyToDocument('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance]);

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // persistence is best-effort; the in-memory theme still applies
    }
  }, []);

  return [appearance, setAppearance];
}

export function nextAppearance(current: Appearance): Appearance {
  if (current === 'light') return 'dark';
  if (current === 'dark') return 'system';
  return 'light';
}

/** Safe media query hook (happy-dom / older browsers may lack matchMedia). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia?.(query);
    } catch {
      return;
    }
    if (!media) return;
    const onChange = () => setMatches(media!.matches);
    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Persisted panel width (§33 Desktop Spatial Behavior). */
const WIDTH_KEY = 'ideno.stateWidth';

export function readStateWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return Math.min(620, Math.max(320, n));
  } catch {
    // ignore
  }
  return 420;
}

export function writeStateWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}

/**
 * Liquid Glass refraction support (progressive enhancement).
 * True refraction needs an SVG displacement filter inside backdrop-filter —
 * url() filters there are Chromium-only. Detect at runtime by setting the
 * value and reading the computed style back (unsupported browsers compute
 * 'none'), and only then let CSS apply the lens via html.refract.
 */
export function detectRefraction(): boolean {
  try {
    if (typeof document === 'undefined' || typeof CSS === 'undefined' || !CSS.supports) return false;
    const el = document.createElement('div');
    (el.style as CSSStyleDeclaration & { backdropFilter?: string }).backdropFilter = "url('#ideno-lens')";
    document.body.appendChild(el);
    const computed = getComputedStyle(el).backdropFilter ?? '';
    document.body.removeChild(el);
    return computed.includes('url');
  } catch {
    return false;
  }
}
