# Agent Experience Log

Engineering log for future contributors: problems encountered, decisions and their
justification, failed approaches, and tooling findings. Factual, not motivational.

## 2026-10-08 — v0.1 build

### Starting point

The repository contained only a stub README (`# Ideno-agent`). No stack existed to
preserve, no Puter coupling to remove, no tests to keep green. Stack choice was free;
we chose TypeScript end-to-end (Node 22 + Express 5 + Zod 4 server; React 19 + Vite 8
client) because the schema layer must be shared between server validation and web
rendering, and the local-model ecosystem (Ollama/vLLM/LM Studio) speaks
OpenAI-compatible HTTP from Node.

Runtime dependencies are deliberately just `express` and `zod`. React/Vite/esbuild/
vitest/tsx are dev dependencies (the client is bundled to static assets; the server is
bundled with esbuild `--packages=external`).

### Key decisions and why

1. **Zod as the single schema source; wire schema derived, not hand-written.**
   The model-facing JSON Schema is derived from the same Zod schema that validates the
   response (`z.toJSONSchema(OrchestratorEnvelope, { io: 'output' })`), then transformed
   for OpenAI strict-mode compatibility: strip `default` keywords, make every property
   required, wrap formerly-optional properties as nullable. This avoids a second
   hand-maintained schema drifting from the real one. Tests assert the strict-mode
   invariants (no `default` anywhere; required == all keys; additionalProperties false).
   Consequence: model responses may contain explicit `null`s, so `normalizeNulls`
   strips null-valued keys before Zod parsing (Zod optionals/defaults then apply).
   Nulls *inside* arrays are preserved — dropping them would be a silent mutation.

2. **`io: 'output'` makes default fields required in the wire schema.** Verified by
   experiment: with `io: 'input'`, `.default()` fields are not required; with
   `io: 'output'` they are (they always exist in parsed output). Requiring emission of
   everything is more deterministic for guided decoding; Zod tolerates omission anyway.

3. **Streaming preview via incremental partial-JSON extraction.** The whole turn is one
   structured-output call (envelope with `reply` first). To show text while the envelope
   is still generating, `extractPartialStringField` decodes the `reply` string value
   incrementally from the accumulated raw text, handling escapes and cut-off escapes.
   The preview is explicitly non-authoritative: the final `reply` event always replaces
   it with the parsed value. Key-name matching requires the key to be preceded by `{`
   or `,` so the field name appearing inside another string does not fool it (tested).

4. **Demo provider is a real, labeled component — not a hidden mock.** The spec forbids
   placeholder providers "presented as working". The scripted demo provider is presented
   as exactly what it is: display name `DEMO — scripted (not AI)`, a persistent banner
   in the UI, a prefix on every reply, startup-log warning, and documentation. It makes
   the state pipeline demonstrable and integration-testable without a model. The
   end-to-end test drives it through the real HTTP stack and verifies pipeline
   mechanics, not intelligence.

5. **Demo provider parses the serialized state from its own context.** To avoid
   extending the `AIProvider` interface with Ideno-specific state plumbing, the demo
   reads the same serialized state block the real models read (the format in
   `prompts.ts` is documented as shared and covered by the e2e test). This keeps the
   provider interface clean; the coupling is explicit and tested.

6. **Everything requires human acceptance in v0.1.** The spec allows auto-apply for
   "safe" changes, but defining materiality heuristics is a rabbit hole; a uniform
   review gate maximizes human authority and simplifies reasoning about integrity.
   Recorded as a known, intentional simplification.

7. **Rejections create no version.** A rejected proposal changes nothing; recording a
   no-op version would pollute the timeline. Rejections live in the proposal store and
   conversation log.

8. **Version-first write order.** `appendVersion` before `saveCase`: a crash between
   the two leaves case.json behind, and the loader rolls forward from the newest
   version snapshot. The reverse order could lose accepted changes silently.

### Problems encountered (and fixes)

- **Demo state parser bug (found by e2e test):** the collection variable was scoped
  per-line inside the parse loop, so items were never attached to their sections —
  invalidations silently never fired. Fixed by persisting the current section across
  lines. This is exactly why the §34 workflow is tested end-to-end rather than unit-only.
- **Duplicate detection false positive:** the duplicate-add check compared item "text"
  but decisions have `decision`, not `text` — two different decisions both normalized
  to `''` and the second was silently skipped. Fixed by extracting `decision` and by
  skipping duplicate detection entirely when no comparable text exists.
- **TS narrowing on heterogeneous change sets:** the 13 collections have different
  add/modify shapes; iterating them generically produces union types TS cannot narrow.
  Solved with narrow casts at the boundaries (shapes already validated by Zod) rather
  than duplicating per-collection logic.
- **Zod 4 `.default({})` on objects with inner defaults fails type-check** (default
  must match the full output type). Used `.prefault({})` (applies before parsing) for
   `server` and `context` blocks.
- **Vitest picked up `vite.config.ts` root (`src/web`)** and found no tests. Gave
  vitest its own `vitest.config.ts` with root `.`.
- **OpenAI strict mode constraints** (all properties required, `default` rejected on
  some servers, optional → nullable) drove the wire-schema transform; documented in
  `wireSchema.ts`. Could not verify against live OpenAI docs from the build sandbox
  (no outbound access to openai.com) — the transform targets the documented strict-mode
  subset and degrades gracefully (json_object/prompt-only modes exist for servers
  without json_schema support).

### Tooling findings

- Zod 4.6 `z.toJSONSchema` output is clean draft-2020-12 with
  `additionalProperties: false` on objects and no `$defs` for this schema size;
  refinements (`refine`) do not block JSON-schema export (used for the
  decision-authority rule).
- Node 22 `fetch` + `AsyncGenerator` return values (`gen.next().done → value`) work
  well for streaming with a typed final result — used to make the runtime's streaming
  API return the validated envelope after the partial events.
- esbuild `--packages=external --format=esm` bundles the server cleanly; `tsc --noEmit`
  with `moduleResolution: bundler` type-checks server + web + shared in one pass.

### Honest gaps to remember

- No real provider was ever contacted from this environment (network policy allows only
  npm/GitHub). The `openai_compatible` adapter is verified against a labeled mock only.
  First thing to do with real infrastructure: point it at Ollama and run one real turn.
- `include_usage_in_stream` defaults to false because some OpenAI-compatible servers
  reject `stream_options` — enable per endpoint when known to work.
- The single-flight chat guard returns 429 for concurrent turns rather than queueing;
  acceptable for a single-user local tool, worth revisiting for multi-user.
- Ideas for later (recorded, not implemented — §44): deterministic contradiction
  checker over structured constraint fields; per-task model routing (e.g. a cheap model
  for extraction, a strong model for critique); open-question aging; state export.
