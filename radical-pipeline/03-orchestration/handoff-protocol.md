# 03-orchestration / handoff-protocol.md

**How work passes between agents without anything getting lost, duplicated, or silently dropped.** Every handoff is anchored to one universal key — the feature id — and recorded on disk in that feature's status file, so the protocol survives a cleared context and any number of parallel agents.

Two mechanisms make parallel handoff safe, and both are load-bearing here:

- the **git-worktree parallelism model** — each in-flight feature lives in its own isolated working directory, so handing a feature back and forth between builder and reviewer never disturbs any other feature's uncommitted code.
- the **claims registry** — a feature is owned by **exactly one** agent, recorded in the `owner` field of `05-tracking/status/<ID>.json`. Every handoff either *is* an ownership event (assign / release) or happens *within* a single owner's tenure (build → gate → fix). No feature is ever worked by two agents at once.

Companion files: `agent-roster.md` (the roles and the full worktree + claims spec), `quality-gates.md` (the gate each handoff crosses), `task-decomposition.md` (the S-cells a handoff flips), `04-git-strategy.md` (branch/merge mechanics).

---

## The universal join key: `<PREFIX>##`

Every feature has one id — `F##` (engine), `W##` (web), `X##` (cloud), `M##` (mobile) — and that **single id threads through every artifact**:

| Artifact | Form |
|---|---|
| Spec file | `02a-features-engine/<ID>.md` / `02b-features-platform/<ID>.md` |
| Status file | `05-tracking/status/<ID>.json` |
| Git worktree | `.claude/worktrees/<ID>-slug` |
| Feature branch | `feat/<ID>-slug` |
| PR title | `<ID>: <name>` |
| Commit trailer | `Feature: <ID>` |
| Tracker row | keyed by `<ID>` |

Because the id is the join key, any agent handed *any* one of these can find *all* the others: read `status/<ID>.json` for state, open the branch for code, read the spec for intent. A handoff is never "here is some work" — it is always "here is `<ID>`", and everything else is derivable from the id.

**Every gate result flips that feature's S-cell in the tracker.** A gate agent's verdict is written to `status/<ID>.json` via `update_status.mjs`; the Docs/Tracker regenerate turns the S0–S11 strip into the Progress heat-map. A rejected gate returns the feature to the named role with **written findings**, and the feature's `overall` status goes `Blocked` (red) until resolved.

---

## The handoff chain (one feature, start to finish)

Each arrow is a handoff. The **id** rides every arrow; the **owner/reviewer** fields record who holds it.

```
Orchestrator ──assign(owner=builder)──▶ Builder
   Builder ──build in worktree──▶ (self, S1..S8)
   Builder ──open PR──▶ Code-Reviewer      (reviewer set; reviewer != owner)
   Code-Reviewer ──verdict──▶ Builder | ▶ next gate
   [Architect / Design Lead / Security / QA / Live-Verify]  each: ▶ Builder (reject) | ▶ next gate (pass)
   Builder(all gates green) ──▶ Integration
   Integration ──merge, remove worktree, owner kept──▶ Done
   (wave) Integration+Deployment+Orchestrator ──▶ Promoted
```

### 1. Assign — Orchestrator → Builder *(ownership event)*
- Orchestrator selects an unblocked `<ID>` (per `dependency-dag-and-waves.md`), then **claims it**:
  `node 05-tracking/update_status.mjs <ID> --owner <builder-agent-id> --overall In-Prog`
  This write **is** the claim (see Claims registry below). The Orchestrator is the only role that writes `owner`, so the assign is single-writer and race-free.
- Orchestrator dispatches a **fresh** Builder subagent whose prompt contains only: the spec path `02a/02b-features/<ID>.md`, the ADR(s) it touches, and its Skills section (`context-bounded-workflow.md`). Not the whole plan.

### 2. Build — Builder → self *(within owner tenure, in an isolated worktree)*
- Builder re-reads `status/<ID>.json`, confirms `owner == self` (rejects a stale/duplicate dispatch), then creates its worktree:
  - Native: `EnterWorktree name:"<ID>-slug"` → `.claude/worktrees/<ID>-slug` on branch `feat/<ID>-slug` off `integration`.
  - Fallback: `git worktree add .claude/worktrees/<ID>-slug -b feat/<ID>-slug integration`.
- Builder runs S1–S8 entirely inside that worktree, flipping its **own** S-cells: `update_status.mjs <ID> S<#> Done` after each. Uncommitted state is invisible to every other worktree.

### 3–7. Gate handoffs — Builder → Gate agent → Builder|next *(within owner tenure)*
- Builder opens PR `feat/<ID>-slug` → `integration`. This hands the diff to the gate bench.
- Each gate agent is dispatched per-PR with **only the diff + the feature's Definition of Done**, records itself in `reviewer` (`update_status.mjs <ID> --reviewer <agent-id>`; enforced `reviewer != owner`), and returns a verdict:
  - **Pass:** flips the gate's S-cell to `Done`, advances `currentGate`, hands to the next applicable gate (order per `quality-gates.md`).
  - **Reject:** flips the S-cell + `overall` to `Blocked`, writes findings on the PR, and **returns the feature to the named role** — normally the same Builder (still the owner, worktree still live, so the fix is cheap). The Orchestrator re-dispatches the owner to address the findings; no re-claim is needed because ownership never left.

### 8. Merge — Builder → Integration *(ownership released to Done)*
- With all applicable gates green, the **Integration agent (sole merger)** rebases `feat/<ID>-slug` on `integration`, resolves any `index.ts`/`types.ts` conflict via ADR-02 append-only, merges, sets `S11=Done` + `overall=Done`, and **removes the builder's worktree** (`ExitWorktree action:"remove"` / `git worktree remove`).
- `owner` is **kept** (provenance — who built it). The feature is no longer "in flight"; a resumed Orchestrator reads `overall=Done` and skips it.

### 9. Promote — wave handoff *(Integration + Deployment + Orchestrator)*
- Once a wave's features are all on `integration`, G8 promotes them together (CHANGELOG/semver/tag; Vercel deploy / EAS build for Program 2). Handled as a set, not per feature.

---

## Git-worktree parallelism model (handoff view)

The worktree model is what makes the reject→fix→re-review loop cheap and collision-free across many concurrent features.

- **One worktree per in-flight feature**, named `.claude/worktrees/<ID>-slug`, on branch `feat/<ID>-slug`, based off `integration`.
- **The worktree persists across gate handoffs.** When a gate rejects and hands the feature back to its owner, the owner's worktree is still there with its full working state — the fix is a small edit, not a re-checkout. The worktree is created once (build start, G1) and removed once (merge, G7).
- **Isolation is per-feature, so handoffs never cross-contaminate.** Builder A's F02 fix-up and Builder B's F10 fix-up happen in separate working directories; neither can see or corrupt the other's uncommitted diff. The *only* place two features meet is the Integration agent's ordered merge — the single serialized handoff in the whole pipeline.
- **Gate agents use throwaway worktrees or the diff.** Code-Review/QA/Security read the PR diff directly. Live-Verify checks out the PR head in a detached throwaway worktree (`git worktree add --detach <path> <sha>`), runs `verify-<ID>.mjs` / device build, records the verdict, removes it — so a verification run never disturbs the builder's worktree.
- **Two isolation axes compose** (repeated here because handoffs rely on both): the **worktree** isolates the code working directory; the **`status/<ID>.json`** isolates the state record (only the owner writes it). Together they give lock-free handoff — the only serialized step is Integration's merges.

---

## Claims registry (handoff view) — one feature, one owner

Every handoff is legible through the `owner` field. The invariant: **a feature is claimed by exactly one agent**, and that agent's id is in `status/<ID>.json`'s `owner`.

**Ownership state machine:**
```
  (free: owner="")
        │  Orchestrator assigns  →  update_status.mjs <ID> --owner <builder>
        ▼
  (owned: owner=<builder>)  ── build ⇄ gate reject/fix loops all stay here ──┐
        │                                                                     │
        │  G7 merge  →  overall=Done, owner KEPT (provenance)                 │
        ▼                                                                     │
  (done: owner=<builder>, overall=Done)                                       │
                                                                              │
  (owned) ── abandonment/reassignment ──▶ Orchestrator clears owner ("") ─────┘  → back to (free)
```

**Rules that keep handoff unambiguous:**
1. **Only the Orchestrator writes `owner`.** Assign and release are single-writer, so no two agents can both believe they own `<ID>`.
2. **A handoff back to the owner is not a re-claim.** Gate rejects return the feature to its existing owner; `owner` is unchanged. Only a full reassignment (owner leaves/dies) clears and re-sets `owner`.
3. **Gate agents write `reviewer`, never `owner`.** Review responsibility is tracked separately and enforced `reviewer != owner` — the builder never reviews its own feature.
4. **No agent touches a feature it doesn't own.** Before doing any build work on `<ID>`, an agent reads `status/<ID>.json` and refuses unless `owner == self`. This is the anti-duplication guarantee: a stale dispatch after a history clear is caught here, not after two agents have both built the feature.
5. **Resumability.** A fresh Orchestrator (zero chat history) reconstructs every handoff's state from disk: `owner` set + `overall != Done` = in-flight (do not re-dispatch); `owner` empty = free; `overall=Done` = finished. The claims registry is the resume point for *who is doing what*, exactly as the tracker is the resume point for *how far along*.

---

## Rejected-gate handoff (the return path, precisely)

When any gate rejects `<ID>`:
1. The gate agent writes findings **on the PR** (durable, tied to the diff) and flips the S-cell + `overall`:
   `node 05-tracking/update_status.mjs <ID> S9 Blocked --overall Blocked` (S9 for review gates, S10 for live gates, etc.)
2. `python 05-tracking/generate_tracker.py` → the Progress row turns red; the Schedule sheet flags at-risk if past target.
3. The Orchestrator sees the red row, re-dispatches the **owner** (unchanged) to fix in the still-live worktree. No re-claim.
4. Owner fixes, pushes, flips the S-cell back to `In-Review`; the same gate re-runs. Loop until pass.
5. `blockedBy` records the *reason* class if the block is a dependency (e.g. `["F02"]`) rather than a review finding — so the Orchestrator can distinguish "waiting on another feature" from "failed review".

---

## Worked example — F02 (drift detection) end to end

1. **Assign.** Orchestrator confirms deps (`F01 Done`, `ADR-01` locked) via `dependency-dag-and-waves.md`, claims: `update_status.mjs F02 --owner engine-builder-7a --overall In-Prog`. Dispatches a fresh Engine Builder with only: `02a-features-engine/F02.md`, ADR-01, and F02's Skills.
2. **Worktree.** Builder confirms `owner==self`, creates `.claude/worktrees/F02-drift-detection` on `feat/F02-drift-detection` off `integration`.
3. **Build.** S1 (diff type in `types.ts`) → S2 (n/a, stateless) → S3 (drift logic in `engine.ts`, reusing F02's diff primitive) → S4 (`drift.ts`) → S5 (wire the diff into metrics/dashboard) → S6 (`drift.test.ts`, Vitest) → S8 (docs). Each: `update_status.mjs F02 S<#> Done`.
4. **G1/G2.** CI green (S6 Done). PR `feat/F02-drift-detection → integration`. Code-Reviewer (`reviewer=code-rev-3`, ≠ owner) checks reuse of the diff primitive, minimal diff → pass, `S9 Done`.
5. **G3.** F02 adds `drift.ts` (new module) + a `types.ts` shape → Architect reviews ADR-01/02 boundary → pass.
6. **G5/G6.** QA runs the full Vitest suite → pass. F02 touches Playwright output shape → Live-Verify runs `verify-F02.mjs` against a fixture, asserts a real drift is flagged → `S10 Done`.
7. **G7.** Integration rebases on `integration`, merges (no `index.ts` conflict — F02 added no tool), removes the worktree, sets `S11 Done` + `overall Done`. `owner=engine-builder-7a` kept.
8. **Fan-out.** The reverse-DAG (`dependency-dag-and-waves.md`) shows F02 unblocks **F04** and **F20** → Orchestrator re-runs the next-unblocked scan and may now dispatch them.

Throughout, `F02` is the only string an agent needed to find the spec, the branch, the worktree, the PR, and the tracker row — and at no point were two agents building it.
