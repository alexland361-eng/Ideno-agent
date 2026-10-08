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

## 2026-10-08 — provider verification tooling (v0.1.1)

### Findings

- **The build sandbox cannot reach any inference endpoint.** A direct TLS probe to
  `integrate.api.nvidia.com:443` fails at connection setup (network policy allows only
  github.com, npm registry, PyPI). Consequence: no real-provider verification is possible
  from this environment, with or without credentials. This is now stated in the README
  rather than papered over.
- **A user API key offered for testing was not used and not stored.** Decision: secrets
  volunteered in chat are never written to files, configs, commands, or commits; the
  correct flow is env-var + local `provider:check`. Users should rotate keys shared in
  chat regardless.
- **Sandbox persistence quirk:** `node_modules/`, `dist/`, and gitignored paths
  (`data/`, `config/ideno.config.json`) do not survive session boundaries — each new
  working session needs `npm install` + `npm run build`, and local runtime state starts
  fresh. Plan for this; never treat `data/` as durable across sessions here.
- **Example config bug caught by schema validation:** `$note` annotation keys inside
  `routing` (and `providers`) are fatal — both are Zod records that validate every
  value, unlike plain objects that strip unknown keys. Fixed two ways: removed the
  offending key from the example, AND made the loader strip `$`-prefixed keys inside
  those two records (annotation convention). Lesson: validate the *example* config
  against the real schema in a check, not just user configs at runtime — an example
  that fails when copied verbatim is a bug.

### Decisions

- `provider:check` reuses the production `AIRuntime.runStructured` path with the real
  envelope wire schema instead of a synthetic mini-schema: the check verifies exactly
  what a real turn exercises (routing, negotiation, Zod validation, repair pass), so a
  passing check means "this endpoint works with Ideno", not "this endpoint speaks HTTP".
- The check forces routing to the selected provider (empty fallbacks) so it tests what
  you pointed it at, while still respecting the configured privacy mode — a LOCAL_ONLY
  configuration refuses to check a cloud provider, which is correct behavior, and the
  error explains why.
- NVIDIA NIM defaults to `structured_output: "json_schema"` in the example, with an
  explicit note to fall back to `json_object`/`none` if the endpoint rejects it —
  per-model support varies and was NOT verifiable from here (do not claim capabilities
  you cannot test).

## 2026-10-08 — Liquid Glass UI (v0.2.0)

### Scope discipline

The redesign touched only `src/web/` plus dev tooling (vitest config, two dev
dependencies). Server, domain, and API contracts are byte-identical to v0.1.1 —
verified by the untouched 93-test server suite passing alongside the new UI
tests. The UI renders what the server validates; it owns no business logic.

### Key decisions and why

1. **Three material levels, not "blur everything".** `mat-1` panes use
   `backdrop-filter`; `mat-2` nested cards deliberately do NOT (solid tinted
   fills). Two reasons: an ancestor with `backdrop-filter` becomes a containing
   block that breaks `position: fixed` descendants, and stacking blurred
   surfaces on blurred surfaces is both a perf cost and visually muddy. All
   fixed/portal surfaces (sheets, palette, toasts) render to `document.body`.
2. **Dark theme is a designed palette, not `filter: invert()`.** Tokens live in
   `styles/tokens.css` as CSS custom properties keyed by `data-theme`; a
   pre-paint script in `index.html` applies the stored value before React
   boots, so there is no light-mode flash on reload.
3. **Zero new runtime dependencies.** React 19 + the existing stack only.
   Icons are hand-rolled 24×24 strokes (~30) in one file; markdown is rendered
   by a small React-node renderer, not `innerHTML`, to keep the XSS surface at
   zero. `@testing-library/react` and `happy-dom` are dev-only.
4. **UI tests double the network, explicitly.** `tests/web.ui.test.tsx` serves
   an in-memory mock of the documented API (including a hand-rolled SSE
   Response-like object with a ReadableStream reader). The file's header
   states this plainly: these tests verify UI behavior against the contract,
   not real backend integration — that is covered by the node e2e suite.

### Problems found and fixed

- **happy-dom's viewport is 1024px**, which trips the ≤1180px narrow-mode
  media query: the state pane is an overlay there and the first six test
  failures were all this one environmental fact. Tests now stub `matchMedia`
  to report the desktop layout (the suite exercises §33; the recomposition
  itself is component logic, not pixel rendering).
- **A real bug the tests caught**: selecting a state item from the command
  palette called `setDetail(...)` but the inspector sheet is hosted inside the
  state pane, which is unmounted in narrow mode — so on narrow screens the
  palette silently did nothing. Fixed by revealing the pane before opening the
  sheet. Worth remembering: hosting portal-ish surfaces inside a
  conditionally-mounted pane couples two concerns that only break on the
  small-screen path desktop development never exercises.
- **RTL text-matching discipline**: `getByText` fails on *multiple* matches,
  which is correct behavior. Version chips, item text, and knowledge badges
  legitimately appear in several places (topbar + state pane, card + state,
  pane + related-items in the sheet). The suite scopes assertions with
  `{ selector: ... }` instead of weakening to `queryAllByText(...).length > 0`
  where a specific surface is the point of the assertion.

### Verification status (do not overstate)

- Verified: 105/105 tests, strict typecheck, production build, and an HTTP-level
  end-to-end pass against the real server (chat → SSE → proposal → accept →
  version + semantic diff; served CSS contains the material/theme/reduced-motion
  blocks; index.html references the new hashed assets).
- NOT verified: actual browser rendering. No browser exists in the sandbox —
  layout, materials, animation feel, and responsive recomposition need human
  eyeballs on `npm start`.

### Post-review revision (same day): achromatic glass

First visual review of v0.2.0 read as *blue*: not because any single token
was blue, but because the environment base was blue-gray (#e7ebf2), the
atmospheric blobs were blue/teal, and every material border/shadow/fill used
blue-tinted neutrals (rgba(28,38,66,…), rgba(120,132,168,…)). All of it
composites — a white pane at 60% over a blue wash is blue glass.

Revision: the token file now enforces a hard rule — **hue exists only in the
semantic accent tokens** (§4), on small controls and signals. Surfaces,
borders, shadows, inks, environment: achromatic. Transparency raised at every
level (mat-1 0.60→0.42, mat-2 0.48→0.28, mat-3 0.80→0.68); the blur, not the
opacity, provides legibility. The neutral environment keeps *tonal* gradients
(dark/light gray blobs) so the backdrop-filter has something to soften —
flat white would make the glass read as plain opacity.

Verification note: a scan of the built CSS for blue-dominant rgba channels
(B − max(R,G) > 12) returns zero matches; remaining blues are the semantic
hex tokens (accent, focus ring) by design.

### Second post-review revision: fully monochrome

The first achromatic pass still read as blue. Three distinct sources, found
in order of visibility:

1. **The §4 semantic accent system was still hue.** The send button, primary
   and accept buttons, focus rings, text selection, links, selected palette
   rows, timeline nodes, and knowledge badges all used the blue accent (and
   green/orange/red/purple status hues). A "neutral glass + colored accents"
   split still reads as "blue all over" when the accents sit on every
   interactive element. Resolution: the whole UI is monochrome by user
   directive — the semantic tokens remain (names intact, 102 consumers) but
   now resolve to a neutral ink ramp (full ink for accent/ok/danger, mid
   gray for warn/explore/teal). Meaning is carried by tone, icons, and text.
   Tradeoff flagged to the user: hue-based semantics from §4 are retired.
2. **Three blue box-shadows** (`rgba(20, 28, 52, …)`) survived the first pass
   because the audit grep filtered out lines containing `var(--` — and those
   lines legitimately contained both a token AND a literal. Lesson: audit
   literals with NO other filter, and run the scanner on the BUILT css, not
   the source (the minifier also folds rgba→#rrggbbaa, which an rgba-only
   regex misses).
3. **The "neutral" grays weren't**: the ink ramp carried a +6…+9 blue-channel
   bias (#6b6b74 etc.) — invisible as a number, visible as a cast. Every
   value is now exactly R=G=B, enforced by a scanner that fails on any
   channel spread > 0 across hex, rgb()/rgba(), and hsl() in the built
   output, both themes (the @supports fallbacks included).

The scanner is the lasting artifact of this round: "looks neutral" is not a
verification state. Run the channel scan on dist, not on source.
