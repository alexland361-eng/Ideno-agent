/**
 * Short random id with a prefix, e.g. "prop_f3a9c2".
 *
 * Uses Web Crypto (globalThis.crypto), which exists in all browsers and in
 * Node >= 19 — keeping this module dependency-free lets the PURE core state
 * machine (stateManager, semanticValidation) be imported by the web bundle
 * for the offline demo mode.
 */
export function prefixedId(prefix: string): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${prefix}_${hex}`;
}
