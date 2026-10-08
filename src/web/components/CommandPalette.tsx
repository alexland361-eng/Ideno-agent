import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.js';
import { Kbd, cn } from './glass.js';

/**
 * Command palette (§35, §48): ⌘K surface with commands and global search over
 * state items, versions, and conversation. Full keyboard navigation.
 */

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  run: () => void;
}

export interface PaletteResult {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  icon: IconName;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  searchIndex,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  searchIndex: PaletteResult[];
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return searchIndex
      .filter((r) => `${r.kind} ${r.title} ${r.subtitle ?? ''}`.toLowerCase().includes(q))
      .slice(0, 10);
  }, [searchIndex, query]);

  const entries = useMemo(
    () => [
      ...filteredCommands.map((c) => ({ type: 'command' as const, entry: c })),
      ...results.map((r) => ({ type: 'result' as const, entry: r })),
    ],
    [filteredCommands, results],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    list?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const execute = (index: number) => {
    const item = entries[index];
    if (!item) return;
    onClose();
    item.entry.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(entries.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(active);
    }
  };

  let index = 0;

  return createPortal(
    <div className="palette-root">
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="palette glass mat-3"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="palette-input-row">
          <Icon name="search" size={15} className="muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search state, versions, conversation — or run a command…"
            aria-label="Command palette input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {entries.length === 0 && (
            <div className="palette-empty muted">No matches for “{query}”.</div>
          )}
          {filteredCommands.length > 0 && (
            <>
              <div className="palette-group-label">Commands</div>
              {filteredCommands.map((c) => {
                const i = index++;
                return (
                  <button
                    key={c.id}
                    role="option"
                    aria-selected={active === i}
                    data-index={i}
                    className={cn('palette-item', active === i && 'active')}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => execute(i)}
                  >
                    <Icon name={c.icon} size={14} />
                    <span className="palette-item-label">{c.label}</span>
                    {c.hint && <span className="palette-item-hint">{c.hint}</span>}
                  </button>
                );
              })}
            </>
          )}
          {results.length > 0 && (
            <>
              <div className="palette-group-label">Results</div>
              {results.map((r) => {
                const i = index++;
                return (
                  <button
                    key={r.id}
                    role="option"
                    aria-selected={active === i}
                    data-index={i}
                    className={cn('palette-item', active === i && 'active')}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => execute(i)}
                  >
                    <Icon name={r.icon} size={14} />
                    <span className="palette-item-label">{r.title}</span>
                    <span className="palette-item-kind">{r.kind}</span>
                    {r.subtitle && <span className="palette-item-hint">{r.subtitle}</span>}
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="palette-foot muted">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span>
          <span><Kbd>↵</Kbd> select</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
