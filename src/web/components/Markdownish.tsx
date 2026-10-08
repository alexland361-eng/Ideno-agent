import React from 'react';

/**
 * Minimal inline text renderer: paragraphs, "- " bullets, **bold**.
 * Rendered as React nodes — never innerHTML — so model output cannot inject
 * markup. Styling comes from the design system (.md namespace).
 */
export function Markdownish({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const isList =
          lines.length > 0 && lines.every((l) => /^\s*[-*•]\s+/.test(l) || l.trim() === '');
        if (isList) {
          return (
            <ul className="md-list" key={i}>
              {lines
                .filter((l) => l.trim() !== '')
                .map((l, j) => (
                  <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
                ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) =>
              j === 0 ? inline(l) : <React.Fragment key={j}><br />{inline(l)}</React.Fragment>,
            )}
          </p>
        );
      })}
    </div>
  );
}

function inline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
