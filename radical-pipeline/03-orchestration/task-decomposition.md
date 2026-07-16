# 03-orchestration / task-decomposition.md

**Every feature — engine, web, mobile, or cloud — decomposes into the same 12 sub-tasks, S0–S11.** A uniform grid means the tracker's Progress sheet is one comparable heat-map across all ~48 features, and any builder subagent knows the shape of its work before reading the spec. The *meaning* of each S# is reinterpreted per surface; sub-tasks that don't apply to a given feature are marked **N/A** and excluded from the percent-complete math.

Companion files: `quality-gates.md` (which gate each S-cell feeds), `handoff-protocol.md` (S-cell status as the join key), `05-tracking/tracker-data.json` (per-feature S-applicability, seeded at package build).

---

## The S0–S11 grid

Status enum per cell (matches the tracker): `Todo | In-Prog | In-Review | Blocked | Done | N/A`.

| # | Sub-task | Engine (F##) | Web (W##) / Mobile (M##) | Cloud (X##) | Feeds gate | N/A when |
|---|---|---|---|---|---|---|
| **S0** | Spec | One-page spec vs ADRs; test+verify plan | Same; + screen/interaction spec vs design system | Same; + route/contract spec | G0 | never (every feature is specced) |
| **S1** | Types | `types.ts` Zod/interface (or new pure `schema.ts`) | Shared TS types in `packages/shared` (result/request shapes) | Request/result DTOs in shared types (ADR-06 published types) | G3 | feature adds no type |
| **S2** | Storage / data | file IO via `storage.ts` (`atomicWriteFile`) | API client / data-fetch layer | Postgres/Redis/Blob access (`vercel-storage`) | G3/G5 | stateless feature |
| **S3** | Core | `engine.ts` extraction/logic | **screens / components** | Function/workflow handler logic | G2/G6 | rarely (this is the feature's substance) |
| **S4** | Module | new module (`drift.ts`, `transform.ts`, …) | feature module (hook/context/store) | function/route module | G3 | logic fits an existing module |
| **S5** | Wiring | `index.ts` tool registration (ADR-02 `registerXxxTool`) | route / navigation wiring (Expo Router / App Router) | route registration + middleware (auth/rate-limit) | G3 | no new entry point |
| **S6** | Unit / component tests | `*.test.ts` (Vitest, browser-free) | **component tests** (RTL / RN Testing Library) | handler unit tests | G1/G5 | never for non-trivial logic |
| **S7** | Verify | `scripts/verify-<ID>.mjs` (Playwright) + fixture | **e2e / device** test | integration test / preview-deploy smoke | G6 | pure-logic (no runtime surface) |
| **S8** | Docs | README + tool docs + `usage.ts` regen | screen docs / storybook / usage | route/API docs (OpenAPI-ish) | (feeds G8) | trivial change |
| **S9** | Review | G2 Code-Review pass | G2 (+ G3b Design for UI) | G2 (+ G4 Security — all X##) | G2 | never (all code is reviewed) |
| **S10** | Live | G6 `verify-*.mjs` + real Playwright | **device / preview verify** | sandbox run / preview-URL smoke | G6 | pure-logic (skips G6) |
| **S11** | Merge | G7 Integration merge | G7 merge (platform repo) | G7 merge (platform repo) | G7 | never (all work merges) |

**Reading the grid:** the natural build order is left-to-right — `S1 types → S2 storage → S3 core → S4 module → S5 wiring → S6 tests → S7 verify → S8 docs`, then the review/verify/merge tail `S9 → S10 → S11` runs through the gates. Engine features flow `types → storage → engine → module → index → *.test.ts → verify-mjs → docs`. Web/mobile features flow `shared types → data/API client → screens/components → feature module → route/nav → component tests → e2e/device → docs`.

---

## Per-sub-task detail

### S0 — Spec
The one-page spec (spec template §1–§9). Produced/refined at **G0**; `S0=Done` is the precondition for dispatching a Builder. UI features also spec the screen + interaction against the design system (Design Lead co-signs G0).

### S1 — Types
Engine: a Zod schema / TS interface in `types.ts`, or a new pure `src/schema.ts` (ADR-01). Web/mobile/cloud: shared TS types in `packages/shared` — the **only** cross-repo contract is these published types (ADR-06). Additive and back-compat; a breaking change is a semver major + a platform bump PR. **Feeds G3 Arch.**

### S2 — Storage / data
Engine: file IO through `storage.ts` using `atomicWriteFile` (temp+rename) — never hand-rolled writes. Web/mobile: the data-fetch/API-client layer calling X01. Cloud: Postgres (Neon) / Redis / Blob via `vercel-storage`. N/A for stateless transforms (e.g. F10).

### S3 — Core (the feature's substance)
Engine: the extraction/logic in `engine.ts` (reuse `captureForensics`, `renderPage`, `buildStandaloneScript`). Web/mobile: the **screens and components**. Cloud: the Function/Workflow handler. This is the one S# that is essentially never N/A. **Feeds G2 (correctness) and, if runtime, G6.** Optionally weighted 2× in percent-complete (see below).

### S4 — Module
A new module when the logic warrants one (`drift.ts` F02, `transform.ts` F10, `pipeline.ts` F07, `vault.ts` F13, `cel-eval.ts` F08, …). N/A when the logic belongs in an existing module — the Code-Reviewer (G2) and Architect (G3) reject a needless new module (no speculative abstractions). **Feeds G3.**

### S5 — Wiring
Engine: register the MCP tool in `index.ts` via ADR-02 (`registerXxxTool(server, deps)`) — an append-only line, which is what keeps 48 features from colliding on `index.ts`. Web/mobile: route + navigation wiring. Cloud: route registration + middleware (auth, rate-limit). N/A when the feature adds no new entry point (e.g. a pure internal refactor). **Feeds G3.**

### S6 — Unit / component tests
Engine: `*.test.ts`, Vitest, **browser-free** (the QA gate G5 runs these). Web/mobile: component tests (React Testing Library / RN Testing Library). Cloud: handler unit tests. **Never N/A for non-trivial logic** — a branch/loop/parser/money/security path leaves at least one runnable check. **Feeds G1 build + G5 QA.**

### S7 — Verify
Engine: `scripts/verify-<ID>.mjs` driving **real Playwright** against a fixture — the thing G6 runs. Web: preview-deploy smoke. Mobile: e2e/device test. Cloud: integration test / preview smoke. N/A only for pure-logic features with no runtime surface. **Feeds G6.**

### S8 — Docs
README/tool-docs/`usage.ts` regen (engine); screen/usage docs (web/mobile); route/API docs (cloud). Feeds the **G8** promote checklist (docs regen is a promote precondition). N/A for trivial changes.

### S9 — Review
The G2 Code-Review pass (correctness + simplification + minimal diff + reuse). UI features also carry **G3b Design**; all X## also carry **G4 Security** under this S-cell's umbrella. Never N/A — all code is reviewed by a non-author. Optionally weighted 2×. **Feeds G2 (+G3b/G4).**

### S10 — Live
The G6 result: `verify-*.mjs` + real Playwright (engine) / device run (mobile) / preview smoke (web) / sandbox run (cloud), with **measured** perf claims. N/A for pure-logic engine features (they skip G6). Optionally weighted 2×. **Feeds G6.**

### S11 — Merge
The G7 Integration merge (sole-merger). Never N/A — everything merges. **Feeds G7.**

---

## Percent-complete formula

```
% complete = (count of Done non-N/A sub-tasks) / (count of non-N/A sub-tasks)
```

- Equal weight by default; every applicable S-cell counts once.
- **Optional emphasis:** weight **S3 (core)**, **S9 (review)**, and **S10 (live-verify)** at **2×** — the substance, the correctness gate, and the reality gate matter more than docs/wiring. The weighting is a `tracker-data.json` flag; `generate_tracker.py` reads it. Default is equal weight.
- `N/A` cells are excluded from **both** numerator and denominator — a stateless feature isn't penalized for having no S2.
- `Blocked` counts as **not Done** (contributes to the denominator, not the numerator), so a blocked feature's percentage visibly stalls until unblocked.

`generate_tracker.py` computes this per feature and renders it as the green data-bar in the Progress sheet; the S0–S11 strip renders as the colored heat-map (grey=N/A, white=Todo, blue=In-Prog, amber=In-Review, red=Blocked, green=Done).

---

## How a builder uses this grid

1. Read the spec (`02a/02b-features/<ID>.md`) — §4 lists the S0–S11 sub-tasks with N/A marks for *this* feature.
2. Work left-to-right; after finishing each sub-task, update **only** your own status file:
   `node 05-tracking/update_status.mjs <ID> S<#> Done`
   then regenerate: `python 05-tracking/generate_tracker.py`.
3. The S9/S10/S11 tail is driven by the gate agents (Code-Review/Live-Verify/Integration), who set those cells on their verdicts — the Builder does not self-set S9/S10/S11.
4. N/A cells are set once at package build (in `tracker-data.json`); a builder never flips a cell to N/A mid-flight without Architect sign-off (changing applicability is a spec change).
