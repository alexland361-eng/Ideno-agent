# Ideno — Idea Development System

Ideno is not a chatbot with a sidebar. It is an **idea-development system** built around a
persistent, structured, evidence-aware **Idea State** that evolves as you develop your idea.
The conversation is only the interface; **the Idea State is the product**.

```
               ┌────────────────────┐
               │      HUMAN         │
               └─────────┬──────────┘
                         ▼
               ┌────────────────────┐
               │      IDENO UI      │  conversation + live state + versions
               └─────────┬──────────┘
                         ▼
               ┌────────────────────┐
               │   IDEA CASE        │  source of truth (validated, versioned)
               └─────────┬──────────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    Reasoning        Research*      Versioning
          └──────────────┼──────────────┘
                         ▼
                AI Runtime Layer     provider-agnostic, replaceable
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
      Local           Remote            Cloud
      (Ollama,        (self-hosted,     (OpenAI-compatible
       vLLM, …)        gateways)         APIs)
```

*Research: interface defined; no research provider implemented in v0.1 (it fails explicitly rather than faking).

## Quick start

```bash
npm install
npm run build
npm start          # → http://localhost:8787
```

A fresh install boots with the **scripted demo provider** (clearly labeled — it is *not* an
AI model) so you can walk the entire pipeline: describe an idea → review the proposed state
changes → accept → watch versions accumulate. To use a real model, configure it (below) and
restart.

### Configure a real model

```bash
cp config/ideno.config.example.json config/ideno.config.json
# edit providers + routing, e.g. point local-ollama at your Ollama instance
export OLLAMA_API_KEY=...   # only if your endpoint needs a key
npm start
```

Any OpenAI-compatible endpoint works: Ollama, vLLM, LM Studio, llama.cpp server, OpenAI
itself, NVIDIA NIM (`https://integrate.api.nvidia.com/v1`), gateways, or a remote server
you control. Provider configuration is fully externalized — no vendor is hard-coded, and
Ideno Core contains no provider-specific code.

Verify a provider before starting the app (health check, model listing, and a real
structured-output round trip using the production envelope schema):

```bash
export NVIDIA_API_KEY=nvapi-...        # or whatever api_key_env your provider uses
npm run provider:check nvidia-nim      # provider id from your config
```

## How it works

1. **You describe a rough idea.** The model returns a structured *proposal* (validated
   against a strict schema): goals, requirements, assumptions, constraints, unknowns,
   alternatives, … — each item classified epistemically (`USER_PROVIDED`, `ASSUMED`,
   `MODEL_SUGGESTED`, …).
2. **You review it.** Nothing touches the Idea State without explicit acceptance. The
   review card shows additions, modifications, invalidations, affected areas, conflicts,
   and the reasoning summary.
3. **Accepting creates a version.** Every state change is atomic, diffed, and recorded.
   Rejected alternatives and invalidated assumptions are preserved, never deleted.
4. **The idea evolves.** New constraints propagate: Ideno flags which areas are affected
   and invalidates assumptions that no longer hold. Decisions are recorded with their
   maker (you vs. the model) and basis. You can inspect any version's diff at any time.

## Capabilities

- **Deep analysis** — toggle "Deep" in the composer and Ideno runs a second,
  adversarial model pass over its own draft before showing it to you: issues,
  missing considerations, and questions to double-check, right on the review
  card. Advisory only — you still decide.
- **Research** — configure a research provider (Tavily, Brave, or a
  self-hosted SearXNG) and the Research view returns real, sourced results
  you can propose recording in the Idea State. Sources never come from the
  model (§17), and nothing enters the state without your acceptance (§27).
  Unconfigured, research says so instead of faking it.
- **Idea Constellation** — a 3D map of the whole Idea State: goals at the
  center, evidence orbiting the claims it supports (or contradicts, in red).
  Every edge is a real relation from the state. Orbit, zoom, click to
  inspect any node.

## The interface

The web client is a **Liquid Glass** design modeled on Apple's iOS materials:
luminous translucent panes with specular top-edge highlights and saturation
boost behind the blur, opaque nested cards, floating overlays, and a film-grain
environment — in light, dark, and system appearance. Color is meaning-only:
the glass itself is achromatic; blue marks interactive/active elements, green
accepted, orange uncertain, red conflicting. Its spatial model puts the **Idea State at the center** —
the conversation is on the left, the live state on the right, resizable and
persisted between sessions. Every state item opens an inspector sheet
(provenance, knowledge class, related evidence and decisions); every accepted
proposal pulses the exact items it touched. ⌘K opens a command palette that
searches state items, versions, and messages. On narrow screens the state
becomes a full-screen layer; on phones it gets its own tab.

The UI owns no business logic: it renders what the server validates and
versioned. Runtime status in Settings is the real `/api/health` response —
including the DEMO label when the scripted provider is active — never a
fabricated metric. When something is not implemented (research), the UI says
so instead of showing an empty simulation.

## Architecture

```
src/
├── shared/                  # Zod schemas + contracts shared by server & web
│   ├── schemas/ideaCase.ts  #   canonical Idea Case + versions/diffs
│   ├── schemas/proposal.ts  #   model envelope + change proposals (the ONLY mutation channel)
│   ├── chat.ts              #   conversation + SSE event contract
│   ├── config.ts            #   provider/privacy/routing config schemas
│   └── errors.ts            #   error taxonomy
├── server/
│   ├── ai/
│   │   ├── types.ts         #   AIProvider interface (the only thing core depends on)
│   │   ├── runtime.ts       #   routing + negotiation + validation + bounded repair
│   │   ├── capabilities.ts  #   capability negotiation (§9)
│   │   ├── routing.ts       #   privacy-filtered task routing (§11, §12)
│   │   ├── wireSchema.ts    #   strict JSON-Schema derivation for structured outputs
│   │   ├── errors.ts        #   classified runtime errors (§26)
│   │   └── providers/       #   openaiCompatible (real) + demo (scripted, labeled)
│   ├── core/
│   │   ├── state/           #   semantic validation + atomic apply + diffs
│   │   └── orchestration/   #   single orchestrator, prompts, streaming
│   ├── persistence/         #   atomic file store with corruption recovery
│   ├── research/            #   research provider interface (explicitly unimplemented)
│   ├── api/                 #   express routes + SSE
│   └── config/              #   config load, env overrides, redaction
├── web/                     # Liquid Glass React UI
│   ├── styles/              #   design tokens + material system (light/dark)
│   ├── components/          #   glass primitives, conversation, state panel,
│   │                        #   command palette, toasts, icons
│   └── views/               #   history, research, settings
└── tests/                   # vitest suites incl. end-to-end workflow + UI
```

Key invariants:

- **The model never mutates state.** Its output is a proposal validated by Zod (structure)
  and semantic validation (references, invariants), then applied by a pure function only
  after human acceptance. Malformed output cannot corrupt the Idea State (§27).
- **The model cannot fabricate sources.** Evidence sources are overwritten server-side;
  `external` evidence requires a research provider (none in v0.1 — the schema itself
  rejects it from model output).
- **The model cannot claim your authority.** User-attributed decisions must cite the user
  message; the schema and semantic validation both enforce it, and the review card warns
  you to verify.
- **IDs, timestamps, provenance are server-assigned.** The model proposes content and
  references existing IDs; identity is never trusted from model output.
- **Privacy modes are enforced at the routing layer.** `LOCAL_ONLY` cannot route to a
  cloud provider, even as a fallback.
- **Secrets never reach the browser.** The client receives only a redacted config view
  (provider ids, models, URL origins).

## Deployment

**GitHub Pages (UI)**: a workflow (`.github/workflows/deploy-pages.yml`) builds the
web client and publishes it to GitHub Pages on every push to `main` (also
dispatchable manually). Pages is static hosting — the Ideno backend cannot run
there — so the hosted UI boots in one of two honest modes:

- **Connected** — Settings → Connection: enter the URL of any reachable Ideno
  instance (e.g. `http://192.168.1.20:8787` or a public deployment). The
  server must list the Pages origin in `server.allowed_origins`
  (default `["*"]`); CORS is preconfigured and supports the SSE chat stream.
- **Offline demo** — with no server, the UI runs the *real* core state
  machine (the same validation + versioning code the server uses, imported
  as pure modules) with a scripted provider that is labeled everywhere.
  Nothing is persisted, everything resets on reload, and research returns
  the same RESEARCH_UNAVAILABLE error rather than faking results.

When the backend serves the UI itself (`npm start`), it is detected
automatically and no configuration is needed.

## Development

```bash
npm run dev        # server (tsx watch) on :8787 + vite dev server on :5173 proxying /api
npm test           # full test suite (131 tests: server, e2e, research, deep, 3D math, browser UI)
npm run typecheck  # strict TypeScript across server + web
npm run build      # typecheck + web build + server bundle
```

## Verification status (honest, §45)

**Verified in this environment** (automated tests, `npm test`, 91 tests passing):

- Full pipeline end-to-end over real HTTP: idea → structuring → constraint with impact
  analysis and assumption invalidation → alternatives → user decision → versioned state
  (greenhouse scenario, §34) — using the scripted demo provider.
- `npm run provider:check` plumbing (health, models, structured round trip) executed
  against the demo provider.
- OpenAI-compatible adapter wire behavior against an explicit in-process mock server:
  request shape, `json_schema`/`json_object` response formats, SSE streaming, error
  classification (401/404/429/400-context/500/timeout/cancel), health checks.
- Schema + semantic validation, atomic apply, diff computation, version records.
- Persistence: atomic writes, corruption quarantine + restore from version snapshots,
  crash roll-forward, reset-archival.
- Config loading, env overrides, secret redaction, privacy routing.

**NOT verified in this environment:**

- Any real inference provider (OpenAI, Ollama, vLLM, NVIDIA NIM, …). The sandbox's
  network policy allows only github.com, npm and PyPI — a direct TLS probe to
  integrate.api.nvidia.com fails at connection setup, so real endpoints are unreachable
  from the build environment. Use `npm run provider:check <id>` on your own machine. The adapter implements the documented
  OpenAI-compatible protocol and passes protocol-level tests against a mock; configure a
  real endpoint to verify against your infrastructure.
- Real-model output quality, capability claims of specific vendors, or json_schema
  support of specific server versions. The `structured_output` config exists precisely
  because support varies — set it to `json_object` or `none` for servers without native
  structured outputs.

## v0.1 scope

Included: canonical versioned Idea Case, human-reviewed proposals, provider-agnostic
runtime with one real adapter class (OpenAI-compatible), privacy modes, capability
negotiation, classified errors, streaming, file persistence with recovery, web UI.

Deliberately excluded (§33): multi-agent orchestration, autonomous background agents,
vector databases, research providers, CAD/3D/simulation, plugin marketplace,
authentication. Interfaces are prepared where cheap (research provider interface,
renderer-independent state), not implemented speculatively.

See `CHANGELOG.md` for change history and `AGENT-EXPERIENCE.md` for engineering decisions.
