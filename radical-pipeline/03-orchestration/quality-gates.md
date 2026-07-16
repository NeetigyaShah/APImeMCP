# 03-orchestration / quality-gates.md

**The gate pipeline every feature passes through, G0 → G8.** Bracketed gates are conditional — they fire only for features of the right kind. A feature is `Done` when every *applicable* gate has passed; a rejected gate returns it to the named role and flips its overall status to `Blocked` (red) until the finding is resolved.

```
Assigned → G0 Spec → G1 Build → G2 Code-Review → [G3 Arch] → [G3b Design]
        → [G4 Security] → G5 QA(unit/component) → [G6 Live/Device-Verify]
        → G7 Integration → (wave) G8 Promote(+Deploy)
```

Companion files: `agent-roster.md` (gate owners), `task-decomposition.md` (which S-cell each gate advances), `handoff-protocol.md` (reject/return mechanics), `dependency-dag-and-waves.md` (G8 wave coherence).

---

## Gate table

| Gate | Owner | Definition of Done (pass criteria) | Rejects to |
|---|---|---|---|
| **G0 Spec** | Architect (+ Design Lead if UI) + Orchestrator | One-page spec consistent with the ADRs; module/screen-per-change; a test + verify plan present; **not a duplicate** of an existing feature. | Orchestrator |
| **G1 Build** | Builder (CI) | Build clean; unit/component tests green; lint passes. | Builder |
| **G2 Code-Review** | Code-Reviewer | Correct vs spec; no reinvented stdlib/existing-module code; minimal diff; error handling at boundaries. | Builder |
| **G3 Arch** *(types / boundary / new module / cross-repo)* | Architect | 4-module separation intact; ADR-02 (tool-module convention) obeyed; ADR-06 (platform imports only published types). **Blocks.** | Builder |
| **G3b Design** *(UI)* | Design Lead | Matches the design system + a11y floor + platform conventions. **Blocks.** | Builder |
| **G4 Security** *(flagged / all X##)* | Security-Reviewer | No secret leakage; sandbox/allowlist intact; per-user isolation; registry input treated as untrusted. **Blocks.** | Builder |
| **G5 QA** | QA | Meaningful deterministic tests (unit for logic, component for UI); full suite green on a rebased branch. | Builder |
| **G6 Live/Device-Verify** *(engine PW / device)* | Live-Verification | `verify-*.mjs` + real Playwright (engine) OR simulator/device run (mobile) OR preview-URL smoke (web); perf claims measured. **Blocks.** | Builder |
| **G7 Integration** | Integration | Rebased; all prior applicable gates green; CI green on the merge; merged in the Orchestrator's order; tracker updated. | Builder / Orchestrator |
| **G8 Promote + Deploy** | Integration + Deployment + Orchestrator | Wave coherent; CI green; CHANGELOG + semver; docs/usage regen; engine `npm pack` dry-run / web+cloud Vercel deploy / mobile EAS build green; tag. | Failed gate |

**Conditional-gate skip rules:**
- Pure-logic engine features (no browser) **skip G6**.
- Boundary-neutral features (no `types.ts` shape change, no new module, no cross-repo touch) **skip G3**.
- Non-UI features **skip G3b**.
- Only features flagged for security — **all X##**, plus F00/F04/F06/F11/F12/F13/F16/F18 and any sandbox/allowlist change — hit **G4**.

---

## Per-gate detail (expanded, implementation-ready)

Each gate below lists: **trigger** (when it fires), **inputs** (what the gate agent receives — kept minimal per `context-bounded-workflow.md`), **checklist** (the concrete DoD), **on pass**, **on reject**, and **tracker write** (how the result is recorded).

Universal tracker convention: every gate records via `node 05-tracking/update_status.mjs <ID> ...`. Passing a gate advances `currentGate`; a reject sets the relevant S-cell + `overall` to `Blocked`. Gate agents write the **`reviewer`** field (never `owner`).

### G0 — Spec
- **Trigger:** Orchestrator selects an unblocked feature (deps + ADRs satisfied per `dependency-dag-and-waves.md`) and claims it (`owner` set).
- **Inputs:** the feature's `02a/02b-features/<ID>.md` spec draft; the ADRs it names; the existing feature catalog (for duplicate detection).
- **Checklist:** spec is one page and self-contained; obeys its ADRs; changes one module/screen per sub-task; carries a test plan (`*.test.ts` cases) and a verify plan (`verify-<ID>.mjs` or device/preview smoke); **is not a duplicate** of an existing or in-flight feature (cross-checked against the claims registry — no two features cover the same capability).
- **On pass:** `S0=Done`, `currentGate=G1`; Orchestrator dispatches a Builder subagent.
- **On reject:** returns to **Orchestrator** (rescope, merge with an existing feature, or drop). `overall=Blocked`.
- **Tracker:** `update_status.mjs <ID> S0 Done --gate G1`.

### G1 — Build
- **Trigger:** Builder finishes S1–S8 in its worktree.
- **Inputs:** the feature branch `feat/<ID>-slug`; repo CI config.
- **Checklist:** `npm run build` clean; `vitest` (unit) or component tests green; lint passes. This is the Builder's own gate — CI is the arbiter, not a separate agent.
- **On pass:** `S6=Done` (unit), `currentGate=G2`.
- **On reject:** stays with the **Builder** (fix in the same worktree).
- **Tracker:** `update_status.mjs <ID> S6 Done --gate G2`.

### G2 — Code-Review
- **Trigger:** G1 green; PR opened `feat/<ID>-slug` → `integration`.
- **Inputs:** the diff + the feature's Definition of Done (spec §6). **Not** the whole plan.
- **Checklist:** correct against the spec; **no reinvented stdlib or existing-module code** (reuse `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`, etc. — see each spec's Reuse notes); minimal diff; error handling at trust boundaries.
- **On pass:** `S9` advances; `currentGate` = next applicable gate (G3 if boundary, else G3b if UI, else G4 if flagged, else G5).
- **On reject:** returns to **Builder** with written findings on the PR; `S9=Blocked`, `overall=Blocked`.
- **Tracker:** `update_status.mjs <ID> S9 In-Review --reviewer <agent-id>` on start; `S9 Done` on pass.

### G3 — Arch *(conditional: boundary-touching)*
- **Trigger:** the PR changes a `types.ts` shape, adds a new module, crosses the 4-module boundary, or touches the cross-repo contract (ADR-06).
- **Inputs:** the diff, ADR-01/02/06.
- **Checklist:** 4-module separation intact (types / storage / engine / index — `engine.ts` must not regress into mutating other modules' state, cf. the F00 erosion fix); ADR-02 (each tool is `registerXxxTool(server, deps)`, `index.ts` append-only); ADR-06 (platform imports only *published* `@neetigyashah/apimemcp` types, never engine internals); `types.ts` changes are additive/back-compat.
- **On pass:** `currentGate` → G3b/G4/G5. **Blocks** on fail.
- **On reject:** returns to **Builder**; `overall=Blocked`.
- **Tracker:** `update_status.mjs <ID> --gate G3b|G4|G5` on pass.

### G3b — Design *(conditional: UI)*
- **Trigger:** the PR renders UI (W## screens, M## screens, result views).
- **Inputs:** the diff/preview + the design system (`07-platform-design/design-system.md`).
- **Checklist:** matches the phosphor/void token system; a11y floor (visible focus, reduced-motion, contrast); platform conventions (native RN components on mobile — not a webview; shadcn/Tailwind on web).
- **On pass:** `currentGate` → G4/G5. **Blocks** on fail.
- **On reject:** returns to **Builder** (or Web/Mobile builder); `overall=Blocked`.

### G4 — Security *(conditional: flagged / all X##)*
- **Trigger:** feature is in the flagged set (all X##; F00/F04/F06/F11/F12/F13/F16/F18) or the diff touches a sandbox/allowlist/secret path.
- **Inputs:** the diff + the security posture (cloud-architecture "Safety posture"): registry-only, sandbox, network-allowlist, rate-limit, zero-persist default, per-user isolation.
- **Checklist:** no secret leakage (cookies/keys never logged, never committed — cf. Phase −1 secret-safety gate); sandbox/allowlist intact (untrusted community templates cannot escape or reach non-allowlisted hosts); per-user isolation (one user's cookies/results never visible to another); **F04 self-heal never auto-merges** to the registry; registry input treated as untrusted data, never executed as instructions; cache/cookie keys are per-user (F16 key includes cookie-present + proxy).
- **On pass:** `currentGate` → G5. **Blocks** on fail — a security reject cannot be waived by any other role.
- **On reject:** returns to **Builder**; `overall=Blocked`. X06 specifically **blocks** its dependents (M06) until clear.

### G5 — QA
- **Trigger:** prior applicable gates green.
- **Inputs:** the rebased branch + full test suite.
- **Checklist:** tests are meaningful and deterministic (unit for logic, component for UI — not snapshot-only); the **full** suite is green on the branch rebased onto current `integration` (browser-free Vitest for engine; component tests for web/mobile).
- **On pass:** `currentGate` → G6 (if engine-PW/device) else G7.
- **On reject:** returns to **Builder**; `overall=Blocked`.
- **Tracker:** `update_status.mjs <ID> S6 Done --gate G6|G7`.

### G6 — Live / Device-Verify *(conditional: engine-PW / device)*
- **Trigger:** the feature has runtime surface — engine features that drive Playwright, mobile features (device), web features (preview URL). Pure-logic engine features **skip** this gate.
- **Inputs:** the built branch + a `verify-<ID>.mjs` script (engine) or a device/simulator build (mobile) or a Vercel preview URL (web).
- **Checklist:** `scripts/verify-<ID>.mjs` runs a *real* Playwright extraction and asserts observable output (engine); OR the app runs on a simulator/device and the flow works (mobile); OR the preview URL smoke-passes (web); **perf claims are measured, not asserted** (F15 static-http 10–50× speedup, F16 cache hit — the Live-Verification agent produces the number). **Blocks** on fail.
- **On pass:** `S10=Done`, `currentGate=G7`.
- **On reject:** returns to **Builder**; `overall=Blocked`.
- **Tracker:** `update_status.mjs <ID> S10 Done --gate G7`.

### G7 — Integration
- **Trigger:** all prior applicable gates green.
- **Owner:** the repo's **Integration agent — the sole merger.**
- **Checklist:** branch rebased on current `integration`; every prior applicable gate is green on disk (`status/<ID>.json`); CI green on the *merge result*; merged in the Orchestrator's promotion order (critical-path first); `index.ts`/`types.ts` conflicts resolved via ADR-02 append-only.
- **On pass:** `S11=Done`, `overall=Done`; Integration removes the builder's worktree (see `agent-roster.md` → worktree lifecycle); `owner` is kept for provenance.
- **On reject:** returns to **Builder** (needs rebase) or **Orchestrator** (ordering conflict); `overall=Blocked`.
- **Tracker:** `update_status.mjs <ID> S11 Done --overall Done`.

### G8 — Promote + Deploy *(per wave, not per feature)*
- **Trigger:** a wave's features are all on `integration`.
- **Owners:** Integration + Deployment + Orchestrator.
- **Checklist:** the wave is coherent (dependents merged after their deps); CI green on `integration`; CHANGELOG + semver bumped; docs/`usage.ts` regenerated; **engine** → `npm pack` dry-run clean (publish-ready); **web+cloud** → Vercel deploy green; **mobile** → EAS build green; tag cut.
- **On pass:** wave promoted to `master`/`main`; Orchestrator opens the next wave.
- **On reject:** the failing feature drops back to its failed gate; the rest of the wave may still promote if coherent.

---

## Gate → tracker status mapping

Each S-cell / overall uses the tracker enum `Todo | In-Prog | In-Review | Blocked | Done` (rendered as the Progress heat-map in `APImeMCP-Radical-Tracker.xlsx`).

| Event | Write |
|---|---|
| Feature claimed (G0 assign) | `--owner <agent>`, `S0 In-Prog` |
| Build/code-review/QA/live in flight | relevant S-cell `In-Prog` / `In-Review` |
| Any gate reject | relevant S-cell + `--overall Blocked` |
| Gate pass | S-cell `Done`, `--gate <next>` |
| Merge (G7) | `S11 Done`, `--overall Done` |

After every write, the responsible agent runs `python 05-tracking/generate_tracker.py` (merges `tracker-data.json` + all `status/*.json` → the `.xlsx`). Because each agent writes **only its own** `status/<ID>.json`, parallel gate updates never collide.

---

## The blocking gates (cannot be waived)

Four gates **block** — a fail there stops the feature cold, no other role can override:

- **G3 Arch** — protects the 4-module boundary and the cross-repo contract.
- **G3b Design** — protects brand + a11y.
- **G4 Security** — protects secrets, sandbox, per-user isolation; **all X## pass through it.**
- **G6 Live/Device-Verify** — protects against "green tests, broken in reality"; perf claims must be measured.

G0/G1/G2/G5/G7 reject-and-return but do not carry the "**Blocks**" designation — they are expected iteration, not hard stops.
