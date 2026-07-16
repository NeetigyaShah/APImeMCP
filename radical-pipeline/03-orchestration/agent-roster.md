# 03-orchestration / agent-roster.md

**The sub-agent org chart for both programs.** Quality-heavy by design: of the 14 roles, only 4 write feature code (the Builders). Everyone else specs, gates, merges, deploys, or tracks. No agent both builds a feature and approves it — separation of duties is structural, not a convention.

This file also defines the two mechanisms that let many agents run at once without stepping on each other:

- the **git-worktree parallelism model** — every agent that touches code gets its own isolated working directory, so N builders can edit the same logical files (`index.ts`, `types.ts`) concurrently with zero working-tree collisions; conflicts are resolved once, at merge, by the Integration agent.
- the **claims registry** — a feature is owned by **exactly one** agent at a time, recorded in the `owner` field of `05-tracking/status/<ID>.json`. The owner field *is* the claim. No second agent may build a feature that already has a live owner.

Read alongside: `quality-gates.md` (what each gate checks), `handoff-protocol.md` (how work passes between these roles), `dependency-dag-and-waves.md` (what runs when), `04-git-strategy.md` (branch/merge rules).

---

## Roster (14 roles)

| Role | Count | Merges? | Blocks? | Mission (skills) |
|---|---|---|---|---|
| **Orchestrator / Lead** | 1 | No | Yes (scope) | Owns the wave schedule + tracker + cross-lane conflicts; **the only role that instructs other agents** and the **only role that assigns feature ownership** (writes the `owner` field). (planning-and-task-breakdown, spec-driven-development, shipping-and-launch) |
| **Architect / Boundary-keeper** | 1 | No | **Yes** | Authors ADR-01..06 in Phase 0; gates any PR touching `types.ts` shapes / a new module / the 4-module boundary / the cross-repo contract. (spec-driven-development, documentation-and-adrs, code-simplification) |
| **Design Lead** *(Program 2)* | 1 | No | **Yes (brand)** | Owns the cross-surface design system (W02/M02); blocks UI PRs that break the phosphor/void identity or the a11y floor. (frontend-design, ui-ux-pro-max:design-system, dataviz) |
| **Engine Builder** | **3** (burst 4) | No | No | Program 1 (F##) features end-to-end in a lane. Cannot self-merge or self-approve. (test-driven-development, incremental-implementation + each feature's per-spec discipline) |
| **Web Builder** | 1–2 | No | No | W## features on the platform repo. (vercel:nextjs / shadcn / react-best-practices, frontend-design, ui-ux-pro-max) |
| **Mobile Builder** | 1–2 | No | No | M## features. (expo-react-native-typescript, expo-react-native-performance, expo push, frontend-design) |
| **Cloud/Infra Builder** | 1 | No | No | X## features. (vercel:vercel-functions / vercel-sandbox / workflow / vercel-storage, security-and-hardening) |
| **Code-Reviewer** | 1–2 | No | Yes | Correctness + simplification on every PR (never the builder of that PR); no reinvented stdlib / existing-module code; minimal diff; boundary error handling. (code-review-and-quality, code-simplification) |
| **Security-Reviewer** | 1 | No | **Yes** | Gates every security-sensitive PR — **all of X##**, plus F00/F04/F06/F11/F12/F13/F16/F18 and any sandbox/allowlist change. No secret leakage; sandbox intact; F04 never auto-merges; registry input treated as untrusted; cache/cookies never cross-user. (security-and-hardening) |
| **QA / Test-Verifier** | 1 | No | Yes | Vitest browser-free gate on every engine PR; component-test gate on web/mobile PRs. (test-driven-development, ci-cd-and-automation) |
| **Live-Verification Gatekeeper** | 1 | No | **Yes** | `scripts/verify-*.mjs` + real Playwright for the engine; **device/simulator** runs for mobile; preview-URL smoke for web; perf-claim measurement (F15/F16). (browser-testing-with-devtools, performance-optimization) |
| **Integration / Merge** | **1 per repo** | **Yes (sole merger)** | Yes | Owns each repo's `integration`/`main`; merges in the Orchestrator's order; resolves `index.ts`/`types.ts` conflicts via ADR-02; keeps the branch releasable; tags + changelog. (git-workflow-and-versioning, ci-cd-and-automation) |
| **Deployment Agent** *(Program 2)* | 1 | No | No | Vercel deploys (web + cloud) + EAS builds (mobile) at promote gates; env/secret hygiene. (vercel:deployments-cicd, vercel-cli, env-vars) |
| **Docs / Tracker** | 1 | No | No | Maintains the 3-sheet tracker (derives % from gate status), README / tool-docs / ADRs, `usage.ts` regen. (documentation-and-adrs, observability-and-instrumentation) |

**Head-count envelope.** Steady state ≈ 8–12 concurrent agents: 1 Orchestrator + 1 Architect + (Program 2: 1 Design Lead) + up to 3 Engine Builders + a Program-2 pod (1–2 Web, 1–2 Mobile, 1 Cloud) + a shared gate bench (1–2 Code-Review, 1 Security, 1 QA, 1 Live-Verify) + 1 Integration per active repo + (Program 2: 1 Deployment) + 1 Docs/Tracker. Gate agents are **stateless and per-PR** (see `context-bounded-workflow.md`) — the "1" is a concurrency budget, not a persistent process.

---

## Role details (expanded)

### Orchestrator / Lead — the single dispatcher
- **Only role that instructs other agents.** Every builder/gate/integration agent is spawned by the Orchestrator with a bounded prompt (spec path + ADRs + skills — never the whole plan).
- **Sole assigner of ownership.** Because the Orchestrator is the *only* writer of the `owner` field at claim time, two agents can never be dispatched onto the same feature — the claim is single-writer by construction (see **Claims registry** below).
- Holds only the wave plan + the merged tracker view in context — never the sum of feature contexts.
- Selects the next unblocked feature from `dependency-dag-and-waves.md`, respects the builder cap, dispatches, and advances waves.
- Blocks on **scope** only: rejects a spec that duplicates an existing feature or drifts from the plan (a G0 concern it shares with the Architect).
- Owns cross-lane conflict resolution: if two features need the same module in the same wave, the Orchestrator sequences them or splits the branch (per `04-git-strategy.md`).

### Architect / Boundary-keeper — Phase-0, then a blocking gate
- **Phase 0 (Wave 0):** authors ADR-01..06 *before any feature branch forks*. No builder starts until the ADRs it depends on are locked (see `dependency-dag-and-waves.md` → "ADR gate").
- **Blocking gate G3** on any PR that: changes a `types.ts` shape, adds a new module, crosses the 4-module boundary (types / storage / engine / index), or touches the cross-repo contract (ADR-06 — platform imports only *published* types, never engine internals).
- Enforces ADR-02: each MCP tool registered by its own `registerXxxTool(server, deps)`; `index.ts` stays an append-only list of calls.

### Design Lead *(Program 2 only)* — brand + a11y blocker
- Owns the one cross-surface token system (W02 web + M02 mobile), derived from the phosphor-amber `#ffb627` / void `#14100a` identity.
- **Blocking gate G3b** on every UI PR: matches the design system, clears the a11y floor (visible focus, reduced-motion, contrast), respects platform conventions (not a webview on mobile).
- Spins up in Program 2's **P0** alongside the Orchestrator and Architect.

### Builders (Engine / Web / Mobile / Cloud) — the only code authors
- **Own exactly one feature at a time** (recorded in that feature's `owner` field). Take a feature only when its status file shows `owner` empty and all its deps are `Done`.
- Work end-to-end in an isolated **git worktree** (see below): types → storage → core → module → wiring → tests → verify → docs, then drive their PR through the gates.
- **Cannot self-merge and cannot self-approve.** A builder is never the reviewer of its own feature (`reviewer != owner`, enforced at gate assignment).
- **Engine Builders cap at 3** (burst to 4 only in a low-contention wave) because they share `types.ts` / `engine.ts` / `index.ts`; the worktree model removes *working-tree* collisions but merge-order contention on those three files is the real limiter — 3 keeps the Integration agent's conflict queue tractable.
- **Program 2 builders run as a parallel pod** (Web + Mobile + Cloud) on the *separate* `apimemcp-platform` repo, so they never contend with Engine Builders on MCP-server files.

### Reviewer bench (Code-Review / Security / QA / Live-Verify) — stateless gatekeepers
- Dispatched **per PR** with only the diff + that feature's Definition of Done; record a verdict; are discarded (see `context-bounded-workflow.md`).
- Record themselves in the feature's **`reviewer`** field (distinct from `owner`) so review is auditable and never performed by the builder.
- Any of them can send a feature back: verdict = reject flips the relevant S-cell to `Blocked` and returns the feature to its owner with written findings (see `handoff-protocol.md`).
- Applicability is conditional (see `quality-gates.md`): pure-logic engine features skip Live-Verify (G6); boundary-neutral features skip Arch (G3); non-UI skip Design (G3b); only flagged / all-X features hit Security (G4).

### Integration / Merge — sole merger, one per repo
- The **only** role with merge rights. One instance per code repo: `apimemcp` (D:\MCP) and `apimemcp-platform`. (`apimemcp-templates` merges are gated by F03 verify + F19 lint, driven by the same agent for that repo.)
- Merges `feat/<ID>-slug` → `integration` in the Orchestrator's promotion order (critical-path first so dependents rebase onto it).
- Resolves the `index.ts` / `types.ts` conflicts via ADR-02 append-only convention — the one place feature branches collide after worktree isolation.
- On merge: removes the builder's worktree, sets `S11=Done`, tags + updates the changelog at promote (G8).

### Deployment Agent *(Program 2)* — promote-gate only
- Runs Vercel deploys (web + cloud) and EAS builds (mobile) at G8 promote gates; owns env/secret hygiene. Does not write feature code.

### Docs / Tracker — the tracker's steward
- Owns a periodic `generate_tracker.py` regenerate + a per-wave summary. **Every builder/reviewer still updates its own `status/<ID>.json`** — Docs/Tracker does not centralize writes (that would reintroduce write-contention); it curates prose docs, ADRs, tool docs, and `usage.ts` regen.

---

## Startup / spin-up sequence

1. **Phase 0 (Wave 0):** Orchestrator + Architect boot. For Program 2, the Design Lead boots too (needed for P0's design system). Architect authors ADR-01..06; nothing else forks until the ADRs are locked.
2. **First PR:** Code-Reviewer, QA, and Integration (for the active repo) spin up on demand when the first feature reaches its gate — they are not pre-warmed.
3. **On demand:** Security-Reviewer spins up the first time a flagged/all-X feature reaches G4; Live-Verification on the first engine/device feature at G6; Deployment at the first G8 promote.
4. **Program 2 pod** starts when Program 1 reaches Waves 1–2 (P0 = W01, W02, X07, X02-spike runs *in parallel* with engine Waves 1–2 — see `dependency-dag-and-waves.md`).

---

## Git-worktree parallelism model

**Problem it solves.** Multiple builders conceptually edit the same files (`index.ts` appends, `types.ts` shapes, `engine.ts` instrumentation). A single shared working directory would corrupt on concurrent edits. Long-lived feature *branches* alone don't help while agents share one checkout.

**The model: one worktree per in-flight feature.**

- Each code repo (`apimemcp` at `D:\MCP`, `apimemcp-platform`) hosts N parallel worktrees under `.claude/worktrees/`.
- When a Builder claims `<ID>`, it creates a worktree on branch `feat/<ID>-slug`, **based off `integration`** (the branch it will PR into) — not `master`/`main`:
  - Native: `EnterWorktree` with `name: "<ID>-slug"` (creates `.claude/worktrees/<ID>-slug` on a fresh branch).
  - Fallback (aligns with `superpowers:using-git-worktrees`): `git worktree add .claude/worktrees/<ID>-slug -b feat/<ID>-slug integration`.
- The Builder does **all** of S1–S10 inside that worktree. Its uncommitted state is invisible to every other worktree — 3 engine builders each hold their own `index.ts`/`types.ts` checkout simultaneously.
- **Contention moves to merge time, by design.** Isolated worktrees mean no live collisions; the *only* collision point is when two `feat/*` branches both appended to `index.ts` / changed `types.ts`. The Integration agent resolves those once, via ADR-02 (append-only tool list) and ADR-01/ADR-06 (types are additive, back-compat).
- **Lifecycle:** create at G1 (build start) → live through G2–G6 rejection loops (the same worktree persists so fix-ups are cheap) → Integration merges at G7 → Integration removes the worktree (`ExitWorktree action:"remove"` or `git worktree remove`). A rejected-and-abandoned feature's worktree is removed by the Orchestrator when it clears the claim.
- **Gate agents don't need long-lived worktrees.** Code-Review/QA/Security review the diff/PR directly; Live-Verify checks out the feature branch in a throwaway worktree (`git worktree add --detach` on the PR head), runs `verify-*.mjs` / device build, then removes it.
- **Integration agent** operates on a dedicated `integration` worktree (or the canonical checkout) — it is the one place branches are combined.

**Why worktrees + per-feature status files compose.** Two independent isolation axes:
- worktree isolates the **code working directory** (no uncommitted-state collisions),
- `status/<ID>.json` isolates the **state record** (no tracker write-contention — only the owner writes its own file).

Together they give lock-free parallelism across the whole fleet: the only serialized step is the Integration agent's ordered merges.

---

## Claims registry — one feature, one owner

**Invariant:** at any moment, a feature `<ID>` is being built by **exactly one** agent, named in `05-tracking/status/<ID>.json`'s **`owner`** field. The owner field is the claim; there is no separate lock.

**Status file shape (owner/reviewer are first-class fields):**
```json
{ "id": "F02", "subtasks": { "S0": "Done", "S1": "In-Prog", "...": "Todo" },
  "overall": "In-Prog", "currentGate": "G1", "blockedBy": [],
  "owner": "engine-builder-a17c",   // the claim — set by the Orchestrator at dispatch
  "reviewer": "",                    // set by whichever gate agent is reviewing; MUST != owner
  "updatedAt": "2026-07-17T09:00:00Z" }
```

**Claim protocol.**
1. **Assign (Orchestrator, single-writer).** The Orchestrator is the *only* role that assigns ownership. It picks an unblocked `<ID>` whose `owner` is empty, then writes the claim:
   `node 05-tracking/update_status.mjs <ID> --owner <agent-id>`
   Because one role does all assigning, the read-empty-then-write is never racy — there is no second assigner to race with.
2. **Verify before build (Builder).** The dispatched Builder re-reads `status/<ID>.json` and refuses to start unless `owner` equals its own agent id. This catches a stale/duplicate dispatch after a history clear.
3. **Hold.** While `owner` is set and the agent is live, no other agent may build `<ID>`. The Orchestrator will not dispatch an owned feature; a resumed Orchestrator (post history-clear) reads owner fields to see what is already claimed/in-flight versus free.
4. **Release.** On G7 merge, `owner` is **kept** (provenance: who built it) and `overall` → `Done`. On abandonment/reassignment, the Orchestrator explicitly clears `owner` (`--owner ""`) and removes the stale worktree, freeing the feature.

**Reviewer field ≠ owner.** Gate agents write the **`reviewer`** field, never `owner`. Gate assignment enforces `reviewer != owner`, which is exactly the "builder never reviews its own work" rule made durable on disk.

**Why this survives a cleared context/history.** Ownership lives in files, not any agent's memory. A brand-new Orchestrator with zero chat history reads every `status/*.json`, sees which features have a live `owner` (claimed), which are `Done`, and which are free — and resumes dispatching without ever double-building a feature. The claims registry is the resume point for parallelism, exactly as the tracker is the resume point for progress.

---

## Two hard rules (never relax)

1. **Only Builders write feature code; only Integration merges.** Every other role specs, gates, deploys, or tracks. A builder that approves or merges its own feature is a process failure.
2. **One live owner per feature.** If `status/<ID>.json` shows a live `owner` that isn't you, you do not touch `<ID>` — full stop. Duplication is prevented by the owner field, not by hoping two agents don't collide.
