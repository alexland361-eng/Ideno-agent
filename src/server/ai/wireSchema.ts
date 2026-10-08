import { z } from 'zod';
import { OrchestratorEnvelope } from '../../shared/schemas/proposal.js';

/**
 * Wire schema construction for structured outputs.
 *
 * Zod validates authoritatively; the JSON Schema sent to providers is derived
 * from the same Zod schema and then made compatible with OpenAI strict mode:
 *   - every object property is listed in `required`
 *   - formerly-optional properties become nullable (`type: [..., "null"]`)
 *   - `default` keywords are removed (strict mode rejects unknown annotations
 *     on some servers; defaults are applied by Zod after parsing)
 *
 * Model responses may therefore contain explicit `null`s for optional fields;
 * `normalizeNulls` strips them before Zod validation, where `.optional()` and
 * `.default()` take over.
 */

export function buildEnvelopeWireSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(OrchestratorEnvelope, {
    target: 'draft-2020-12',
    io: 'output',
  });
  return makeStrict(deepClone(derived)) as Record<string, unknown>;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Recursively transform a JSON Schema node for OpenAI strict compatibility.
 * `path` is used for error reporting only.
 */
export function makeStrict(node: unknown, path = '$'): unknown {
  if (Array.isArray(node)) {
    return node.map((n, i) => makeStrict(n, `${path}[${i}]`));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const obj: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  delete obj.default;

  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    const properties = obj.properties as Record<string, unknown>;
    const required = new Set<string>(
      Array.isArray(obj.required) ? (obj.required as string[]) : [],
    );
    for (const [key, child] of Object.entries(properties)) {
      const childStrict = makeStrict(child, `${path}.${key}`);
      properties[key] = childStrict;
      if (!required.has(key)) {
        properties[key] = makeNullable(childStrict as Record<string, unknown>);
        required.add(key);
      }
    }
    obj.required = [...required];
    obj.additionalProperties = false;
    return obj;
  }

  if (obj.type === 'array' && obj.items) {
    obj.items = makeStrict(obj.items, `${path}[]`);
    return obj;
  }

  // Enums, primitives, etc.
  return obj;
}

function makeNullable(node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.type === 'string') {
    return { ...node, type: [node.type, 'null'] };
  }
  if (Array.isArray(node.type)) {
    const types = new Set([...(node.type as string[]), 'null']);
    return { ...node, type: [...types] };
  }
  // enum-only or other shapes: wrap in anyOf with null.
  return { anyOf: [node, { type: 'null' }] };
}

/**
 * Recursively remove keys whose value is exactly null. This lets Zod's
 * `.optional()` / `.default()` handle absence uniformly regardless of whether
 * the provider emitted an explicit null (strict mode forces emission).
 */
export function normalizeNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeNulls(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[k] = normalizeNulls(v);
    }
    return out as unknown as T;
  }
  return value;
}
