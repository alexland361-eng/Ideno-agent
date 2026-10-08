import { randomBytes } from 'node:crypto';

/** Short random id with a prefix, e.g. "prop_f3a9c2". */
export function prefixedId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
