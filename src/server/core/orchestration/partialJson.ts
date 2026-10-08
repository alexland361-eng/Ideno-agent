/**
 * Incremental extraction of a string field from a PARTIAL JSON document.
 *
 * Used to stream the model's `reply` field to the UI while the rest of the
 * structured envelope is still being generated. This is a *preview* only —
 * the authoritative reply always comes from the fully parsed and validated
 * envelope. A glitch here can at worst briefly garble the preview, never state.
 */

/**
 * Returns the decoded value-so-far of `field` in `buffer`, or null if the
 * field's value has not started yet. Handles JSON string escapes; stops at
 * the closing unescaped quote.
 */
export function extractPartialStringField(buffer: string, field: string): string | null {
  // Locate the key as an object member: { "field":  or  , "field":
  const keyPattern = new RegExp(`[{,]\\s*"${escapeRegex(field)}"\\s*:\\s*"`);
  const startMatch = keyPattern.exec(buffer);
  if (!startMatch) return null;
  let i = startMatch.index + startMatch[0].length;

  let out = '';
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === '\\') {
      const esc = buffer[i + 1];
      if (esc === undefined) return out; // escape cut off mid-stream
      switch (esc) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = buffer.slice(i + 2, i + 6);
          if (hex.length < 4) return out; // unicode escape cut off
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) return out; // invalid escape — bail
          out += String.fromCharCode(code);
          i += 4;
          break;
        }
        default:
          return out; // invalid escape — give up gracefully
      }
      i += 2;
      continue;
    }
    if (ch === '"') {
      return out; // value complete
    }
    out += ch;
    i += 1;
  }
  return out; // value still streaming
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
