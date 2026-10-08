# Changelog

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
