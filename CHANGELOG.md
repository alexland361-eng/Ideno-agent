# Changelog

## 2026-10-08 — v0.3.0

### Added

- **Research capability (§17, implemented)**: config-driven research
  providers — Tavily, Brave Search API, or a self-hosted SearXNG instance
  (no key, stays on your network). Secrets are env-var only and never reach
  the browser (the redacted config exposes only the origin and type). The
  Research view searches for real, sourced results (title, URL, date,
  excerpt) and can propose recording a research question in the Idea State —
  through the same human-review channel as model proposals (§27); sources
  are listed in the conversation for verification before acceptance.
  Without a configured provider the view still states honestly that
  research is unavailable.
- **Deep analysis (agent capability)**: a "Deep" toggle in the composer runs
  a second adversarial model pass over the drafted proposal before you see
  it. Findings (issues with severity, missing considerations, questions)
  appear on the review card in a dedicated section; they are advisory and
  never mutate the proposal. A failed critique pass degrades to a warning
  instead of losing the turn. Streaming gains a `critiquing` phase.
- **Idea Constellation (3D view)**: the Idea State as a spatial structure —
  goals at the center, decisions/constraints/unknowns/evidence on shells,
  with edges drawn ONLY from real relations (decisions → affected items,
  evidence → supported/contradicted claims, alternatives → related). Orbit
  by dragging, zoom with the wheel, full keyboard control (arrows, +/-),
  click a node to open its inspector sheet. Canvas 2D with hand-rolled 3D
  projection — zero new dependencies, deterministic layout (same state →
  same constellation), DPR-aware, pauses when hidden, respects
  prefers-reduced-motion, and degrades gracefully when 2D context is
  unavailable.

### Verification status

- Verified: 123/123 tests. Research providers tested against a REAL local
  HTTP round trip (a node http.Server standing in for the external service
  — request/response handling, source mapping, error classification,
  missing-key failure); the research→proposal→accept→version flow runs the
  full orchestrator + persistence stack. Deep analysis tested end-to-end
  over SSE (phase event, critique merge, warnings). Constellation math
  unit-tested (relation-only edges, determinism, settling, projection,
  picking) plus UI smoke tests. Typecheck clean, production build clean.
- NOT verified: live Tavily/Brave/SearXNG endpoints (sandbox network policy
  blocks them) and real-model critique quality (the demo provider's
  critique is a clearly-labeled deterministic template). The 3D view's
  visual quality needs a real browser — the math and lifecycle are tested,
  the aesthetics are not.

## 2026-10-08 — v0.2.0

### Added

- **Liquid Glass web interface** — full redesign of the client per the UI
  specification. The backend, domain logic, and API contracts are unchanged.
  - **Material system**: three real material levels — `mat-1` blurred panes
    (topbar, nav rail, state pane), `mat-2` opaque nested cards (no
    `backdrop-filter`, for composability and performance), `mat-3` floating
    overlays (sheets, palette, toasts). An `@supports` fallback degrades the
    blurred surfaces to solid tints where `backdrop-filter` is unavailable.
  - **Theming**: light / dark / system appearance with a pre-paint script
    (no flash), semantic accents (blue info, green accepted, orange uncertain,
    red conflict, purple AI exploration), and a full design-token stylesheet
    (`src/web/styles/tokens.css`) — dark is a designed palette, not an inversion.
  - **Spatial layout**: topbar + nav rail + conversation workspace + persistent
    Idea State pane. The pane is resizable (320–620px, persisted to
    `localStorage`), becomes an overlay ≤1180px, and the app recomposes to a
    tab bar with a full-screen state view ≤900px.
  - **Idea State as the centerpiece**: 13 collapsible collections with
    knowledge-class badges, inspector detail sheets for every item (provenance,
    related evidence/decisions), and highlight pulses linking conversation
    events to the state items they touched.
  - **Review cards**: proposals grouped as added / modified / invalidated,
    with impact analysis, conflicts, warnings, and the model's reasoning
    summary — accept / reject / inspect from the conversation.
  - **Command palette (⌘K)**: commands plus global search over state items,
    versions, and messages, with full keyboard navigation.
  - **History timeline**: semantic per-collection diffs (not Git-style hunks),
    lazily loaded per version.
  - **Settings**: appearance, provider health cards merged with live runtime
    status (real `/api/health` data — nothing fabricated), keyboard shortcuts,
    and a reset danger zone with confirmation.
  - **Honest surfaces**: the demo provider is labeled everywhere it appears
    (banner + DEMO tags); the research view states plainly that no research
    provider is configured rather than showing fake results.
  - Accessibility: focus trap in sheets/palette, `prefers-reduced-motion`
    support, aria labels on all icon-only controls.

### Changed

- **iOS-studied Liquid Glass materials (post-review revisions)**: the
  glass follows Apple's Liquid Glass principles — translucent luminous
  fills (never flat gray), specular top-edge highlights with a faint
  bottom bounce on every material, `saturate(180%)` behind the blur, and
  a subtle film grain over the environment. Primary controls are tinted
  liquid glass (translucent blue/green fills with their own blur and
  specular edge), not solid plastic. Surfaces, borders, shadows, inks,
  and the environment stay exactly achromatic; hue appears only on
  semantic elements (§4): interactive blue, accepted green, uncertainty
  orange, conflict red, AI-exploration purple. Verified by a channel
  scan of the built CSS: every non-semantic value is R=G=B in both
  themes. (Design studied from Apple's Liquid Glass announcement and
  HIG materials guidance, plus CSS reproduction write-ups.)
- **Liquid Glass behaviors (fourth revision, from the design language's
  published principles)**: chrome detaches into floating bubbles (pill nav
  items with accent-tinted active state, capsule buttons, 22px corners on
  all floating panels — "toolbars are no longer pinned to the bezels");
  **refraction** via an SVG displacement lens (feTurbulence +
  feDisplacementMap bending the backdrop before the blur) applied as a
  progressive enhancement in browsers that support url() filters in
  backdrop-filter (Chromium), with plain blur everywhere else; bevel rims
  (top light + darkened side edges, per the iOS 27 lighting adjustment);
  and a liquid focus morph on the composer. No new dependencies — inline
  SVG filter + runtime detection (~15 lines).
- `src/web/` restructured: `styles/` (tokens + app), `components/` (glass
  primitives, icons, conversation, state panel, palette, toasts, markdown),
  `views/` (history, research, settings). Old single-file UI removed.
- Dev dependencies: `@testing-library/react` and `happy-dom` for UI tests
  (in-memory DOM; the app itself has zero new runtime dependencies).
- `vitest.config.ts` defaults to a node environment; UI test files opt into
  happy-dom via `// @vitest-environment happy-dom`.

### Fixed

- Selecting a state item from the command palette on narrow screens now
  reveals the state pane before opening the inspector sheet (previously the
  sheet was hosted in the unmounted pane and never appeared).

### Verification status

- Verified: typecheck clean; full suite **105 tests passing** (93 server-side
  + 12 new UI tests covering navigation, message submission and streaming,
  state rendering, proposal accept/reject, history/diffs, palette search and
  keyboard use, appearance cycling, error surfacing, and the reset flow —
  all against an in-memory mock of the documented API contract, labeled as
  such in the test file). Production build succeeds (85 KB gzipped JS,
  7.9 KB gzipped CSS). End-to-end sanity pass against the real server over
  HTTP: chat → SSE stream → proposal → accept → version created with a
  semantic diff.
- NOT verified: real-browser rendering (no browser available in the build
  sandbox). Layout, materials, and animations should be eyeballed via
  `npm start` → http://localhost:8787.

## 2026-10-08 — v0.1.1

### Added

- `npm run provider:check [provider-id]` (`scripts/check-provider.ts`): provider
  self-test that runs the configuration check, health check (GET /models), model
  listing (with a warning when the configured model is absent from the catalog),
  and a REAL structured-output round trip using the production envelope schema —
  exercising routing, capability negotiation, validation, and the bounded repair
  pass exactly as a normal turn does. Secrets are read from the environment only.
- NVIDIA NIM example provider entry in `config/ideno.config.example.json`
  (`https://integrate.api.nvidia.com/v1`, OpenAI-compatible, `api_key_env:
  NVIDIA_API_KEY`) with guidance on `structured_output` fallbacks.

### Changed

- Config loader now tolerates `$`-prefixed annotation keys (`$note`, `$comment`)
  inside `providers` and `routing`. Both are Zod records, so an annotation key
  previously failed validation with a ConfigurationError — discovered when the
  example config itself tripped on it during schema validation. Regression test
  added.

### Verification status

- Verified: `npm run provider:check` executed against the scripted demo provider
  (plumbing verified — health, model listing, structured round trip all pass;
  the demo is not AI). Full suite: 93 tests passing, typecheck clean.
- NOT verified: NVIDIA NIM or any other real endpoint. The build sandbox's
  network policy blocks integrate.api.nvidia.com at connection setup (verified
  with a direct TLS probe — no key was used or stored). The NIM entry follows
  NVIDIA's documented OpenAI-compatible API shape; `structured_output` support
  varies by model and must be confirmed per endpoint via `provider:check`.

## 2026-10-08 — v0.1.0

First working implementation of the Ideno idea-development system: the complete
state-management vertical slice (§48 of the specification).

### Added

**Core state**
- Canonical Idea Case schema (`src/shared/schemas/ideaCase.ts`): 13 collections
  (goals, requirements, assumptions, constraints, unknowns, risks, dependencies,
  evidence, research_items, alternatives, decisions, rejected_approaches,
  open_questions), every item with stable server-assigned id, epistemic
  `knowledge_class`, lifecycle `status`, and provenance.
- Strong epistemic classes (KNOWN / SUPPORTED_BY_EVIDENCE / CONTRADICTED_BY_EVIDENCE /
  USER_DECIDED / REJECTED) are assignable only by the system, never by model output —
  enforced at the schema level.
- Versioning: immutable version records with full snapshots, structured diffs, and
  parent links (linear chain in v0.1; snapshot-per-version enables branching later).
- Semantic validation: reference checks, double-modification detection, duplicate-add
  skipping with visible warnings, decision-authority rules, research-answer gating.
- Atomic proposal application (`stateManager.applyProposal`): pure function over a
  clone; server-side id generation, evidence-source overwrite, decision class
  assignment, auto-mirroring of rejected/superseded alternatives into
  rejected_approaches (never deleted).

**AI runtime**
- Provider-agnostic `AIProvider` interface; Ideno Core depends only on it. No Puter
  dependency (none existed to remove — the repository was empty; the architecture was
  built provider-neutral from the start).
- `openai_compatible` adapter: configurable endpoint, Bearer auth from env, non-streaming
  + SSE streaming, json_schema / json_object / prompt-only structured output modes,
  classified errors (auth/rate-limit/timeout/context-overflow/cancelled/provider),
  health checks, /models listing, in-memory usage counters.
- Capability negotiation, privacy-filtered task routing (LOCAL_ONLY / PREFERRED_LOCAL /
  CLOUD_ALLOWED / CLOUD_ONLY), bounded single repair pass for non-schema modes.
- Strict wire-schema derivation from the Zod envelope (all properties required, no
  `default` keywords, nullable optionals) for OpenAI strict-mode compatibility; nulls
  normalized before Zod validation.
- `demo` provider: a scripted, deterministic, clearly-labeled non-AI provider used as
  the safe default and for pipeline testing. Labeled in display name, UI badge, every
  reply, startup logs, and documentation.

**Product loop**
- Single orchestrator: context construction (system instructions + serialized state +
  recent conversation + user message), streaming reply preview via incremental partial-JSON
  extraction, envelope validation, semantic validation, pending proposals with explicit
  human accept/reject, version creation on acceptance, conversation logging.
- Rejected/invalid proposals leave state untouched; accepting a proposal re-validates it
  against current state (StateConflict on divergence).

**UI**
- Two-pane web app: conversation with streaming replies and proposal review cards
  (added/modified/invalidated, impact analysis, conflicts, questions, warnings,
  reasoning summary, inspect); live Idea State panel with per-item epistemic badges,
  lifecycle states, alternatives, decisions; version timeline with diffs.
- Provider status pill (health, model, DEMO badge), privacy mode chip, case reset.

**Infrastructure**
- Express 5 API: /api/health, /api/config (redacted), /api/case, /api/versions/:n,
  /api/chat (SSE), /api/proposals/:id/accept|reject, /api/case/reset; static UI with
  CSP and security headers; JSON body limits; single-flight generation guard.
- File persistence: atomic writes (temp+rename), version-first write order with
  roll-forward on crash, corrupted-file quarantine with restore from latest version
  snapshot, message-log corruption tolerance, reset archives everything (nothing deleted).
- Externalized configuration (config/ideno.config.json, auto-created safe default;
  env overrides for secrets and ops settings); secret redaction for anything sent to
  the browser.
- Research provider interface defined and wired to `POST /api/research`; no provider
  implementation — calls fail with a classified `RESEARCH_UNAVAILABLE` error (never
  faked, per §13 "fail explicitly").

### Tests (91, all passing at time of writing)

- schemas, wire-schema strictness, partial-JSON streaming extraction
- semantic validation and atomic state application
- persistence round-trip / corruption recovery / roll-forward / archival
- config loading, redaction, privacy routing
- OpenAI-compatible adapter protocol tests against an explicit in-process mock server
  (clearly labeled as a test double)
- end-to-end greenhouse workflow (§34) over real HTTP with the demo provider

### Verification status

- Verified: see "Verification status" in README.md — all automated tests above,
  executed in this environment.
- NOT verified: any real inference provider (no outbound access to inference APIs and
  no local models in the build environment). The `openai_compatible` adapter is
  protocol-tested against a mock only. Real-model behavior, vendor capability claims,
  and json_schema support of specific server versions are unverified.

### Known limitations

- Single case per data directory (one idea at a time; "New idea" archives and resets).
- One task type ('conversation') in routing; per-task model selection is a config
  table but only one task exists.
- No native (non-OpenAI-compatible) provider adapters yet — the abstraction permits
  them; none implemented.
- No research provider: external evidence is impossible by design in v0.1; model
  statements are labeled unverified rather than presented as research.
- Streaming preview extracts only the `reply` field; the rest of the envelope appears
  after validation completes (by design — the parsed envelope is authoritative).
- Conflict detection is model-assisted (via the proposal's conflicts field), not a
  deterministic engine.
- Rejected proposals do not create version records (no state change to record);
  they are recorded in the proposal store and conversation log.
