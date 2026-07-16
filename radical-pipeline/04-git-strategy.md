# 04 — Git Strategy (three repos, worktree-parallel feature builds)

**Scope.** How the ~48-feature build runs across three repositories without two agents ever clobbering a shared file or building the same feature twice. Two ideas carry the whole strategy:

1. **Branch model** — `releasable ← integration ← feat/<id>-slug`, one Integration agent as the sole merger per repo.
2. **Worktree parallelism** — every parallel Builder gets its **own git worktree** under `.claude/worktrees/<ID>`, branched off `integration`, so builders that all edit `src/types.ts` / `src/engine.ts` / `src/index.ts` never stomp each other during the build.

This file expands the summary in `PLAN.md`. It cross-refs `01-adrs/ADR-02` (append-only tool registration), `ADR-06` (cross-repo contract), `03-orchestration/quality-gates.md` (G0–G8), `03-orchestration/agent-roster.md` (Integration = sole merger), and `05-tracking/status/<ID>.json` (the per-feature claim + status file).

---

## 1. The three repositories

| Repo | Program | Branch model | Worktree parallelism | Deploy |
|---|---|---|---|---|
| **`apimemcp`** (`D:\MCP`) | 1 — engine (MCP server) | `master` (releasable) ← `integration` ← `feat/F##-slug` | **Yes** — high-contention (`types.ts`/`engine.ts`/`index.ts` shared by every F##) | `npm publish` |
| **`apimemcp-platform`** (new Turborepo) | 2 — web + cloud + mobile | `main` (releasable) ← `integration` ← `feat/{W,X,M}##-slug` | **Yes** — per pod (`packages/shared` + monorepo configs are the shared surface) | web+cloud → Vercel, mobile → EAS |
| **`apimemcp-templates`** | shared — registry data | `main`; **PR-per-template** (gated by F03 verify + F19 lint) | **Optional** — templates are independent files; no shared-code contention | jsDelivr (auto from `main`) |

**Two long-lived branches per *code* repo** (`master`/`main` releasable ← `integration`) plus short-lived `feat/<id>-slug`. `apimemcp-templates` is a *data* repo, not a code repo: each template is a self-contained `<id>.json` + `<id>.mjs`, so it needs no `integration` branch and no worktree isolation — a template PR forks straight off `main`. (This expands the one-line "`main ← feat/…`" shorthand in `PLAN.md`: the platform repo, being shared code, gets the same `integration` tier the engine repo has.)

**Feature branch naming:** `feat/<ID>-<kebab-slug>` — the `<ID>` (F##/W##/X##/M##) is the universal join key across branch ⇄ worktree dir ⇄ PR ⇄ commit trailer ⇄ `status/<ID>.json` ⇄ tracker row (see `handoff-protocol.md`). **Split** a feature branch only when it is too big for one review — e.g. `feat/F04-drift-forensics` + `feat/F04-registry-pr`; each split gets its own worktree and its own S-cell handoff.

---

## 2. The worktree parallelism model (feature-build phase)

### 2.1 The problem it solves

Waves 1–4 run up to **3 Engine Builders in parallel** (`agent-roster.md`), and Program 2 runs a Web/Cloud/Mobile pod alongside them. In the engine repo *every* feature touches the same three files:

- `src/types.ts` — Zod schemas / shared interfaces
- `src/engine.ts` — Playwright core
- `src/index.ts` — the sole tool-wiring point

A single working directory can only have **one** branch checked out at a time. If three builders shared `D:\MCP` they would either serialize (`git switch` fighting over the checkout) or overwrite each other's edits to those three files. **Worktrees remove the contention**: each builder gets a *separate directory* with its *own* checked-out `feat/<ID>` branch, all backed by the one shared `.git` object store. Three builders can hold `feat/F01`, `feat/F05`, `feat/F03` checked out **simultaneously** in three sibling directories and build/test each independently.

### 2.2 Convention

- **One worktree per feature per builder**, at **`.claude/worktrees/<ID>`** inside the repo (e.g. `D:\MCP\.claude\worktrees\F01`). This is the same path the Claude Code harness's native `EnterWorktree`/`ExitWorktree` tools use, so a dispatched subagent can either call those tools or run raw `git worktree` (canonical below, because it is scriptable and identical across all three repos).
- The worktree branches **off `integration`**, never off `master`/`main` (dependents rebase onto `integration`, so that is the correct base).
- **`.claude/worktrees/` MUST be gitignored** in every repo. `.claude/` is a *tracked* directory (it holds `settings.json`), so without this line the nested checkouts show up as untracked/committable noise. This line does not exist yet in `apimemcp` — adding it is a Phase-0 prerequisite (§2.3).

### 2.3 Prerequisite (once per repo, Phase 0, by Integration/Orchestrator)

```bash
# 1. integration branch off the clean releasable branch (engine: after Phase -1 lands F00 on master)
git -C D:/MCP switch -c integration master        # platform: `-c integration main`
git -C D:/MCP push -u origin integration

# 2. ignore the worktree root so per-feature checkouts are never tracked/committed
printf '\n.claude/worktrees/\n' >> D:/MCP/.gitignore
git -C D:/MCP add .gitignore
git -C D:/MCP commit -m "chore: ignore .claude/worktrees (per-feature build isolation)"
git -C D:/MCP push
```

### 2.4 Full lifecycle (engine repo shown; identical shape in all three — see §2.7)

**① CREATE — off `integration`, in the builder's bootstrap.**
```bash
git -C D:/MCP fetch origin
git -C D:/MCP worktree add .claude/worktrees/F01 -b feat/F01-schema-contracts integration
cd D:/MCP/.claude/worktrees/F01
npm ci                       # worktrees share .git but NOT node_modules — install per worktree
# Playwright browsers live in a global cache (~/.cache/ms-playwright), shared across worktrees —
# only `npx playwright install` on first machine setup, not per worktree.
```

**② BUILD + RUN GATES — entirely inside the worktree.** The builder edits `types.ts`/`engine.ts`/`index.ts` on its private checkout and runs the compile + test + live gates there, isolated from every other builder's worktree:
```bash
# cwd = D:/MCP/.claude/worktrees/F01
npm run build                # G1 build
npm test                     # G5 Vitest (browser-free) — this feature's *.test.ts
node scripts/verify-F01.mjs  # G6 live — real Playwright against a fixture
```
Because the checkout is private, F05's and F03's builders can be doing the exact same thing to *their* copies of the same three files at the same moment with zero interference.

**③ HAND TO INTEGRATION — the builder never merges** (`agent-roster.md`: Integration is the sole merger). Handoff = **rebase onto the latest `integration` inside its own worktree** (this is the "rebased first" branch protection requires, done where the branch is actually checked out, so there is no cross-worktree conflict), then push, flip the status cell, signal the Orchestrator:
```bash
# cwd = the worktree; the branch is checked out HERE, so rebase HERE
git fetch origin
git rebase origin/integration          # ADR-02 append-only ⇒ conflict-free replay of the index.ts line
git add -A
git commit -m "feat: F01 schema contracts — outputSchema + validateOutput

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin feat/F01-schema-contracts   # --force-with-lease if the rebase rewrote already-pushed commits
node D:/MCP/radical-pipeline/05-tracking/update_status.mjs F01 S11 In-Review --gate G7
# builder's context ends here (context-bounded-workflow: one feature per fresh subagent)
```

**④ INTEGRATION MERGES — sole merger, in wave order.** With the feature already rebased onto `integration` (step ③), the Integration agent merges from `origin` with a **fast-forward** so history stays linear:
```bash
git -C D:/MCP fetch origin
# CI green on the rebased branch, all prior gates green, then:
git -C D:/MCP switch integration
git -C D:/MCP merge --ff-only origin/feat/F01-schema-contracts   # linear; no re-checkout of the feat branch
git -C D:/MCP push origin integration
```
**If `integration` advanced again after the builder's rebase** (a wave sibling landed in between), the fast-forward is refused. Because a branch is checked out in only one worktree at a time, Integration must **first free the branch — remove the builder's worktree (step ⑤); the commits are safe on `origin`** — then re-rebase it from a checkout it controls and fast-forward:
```bash
git -C D:/MCP worktree remove .claude/worktrees/F01     # free the branch (content is on origin)
git -C D:/MCP fetch origin
git -C D:/MCP switch -C feat/F01-schema-contracts origin/feat/F01-schema-contracts
git -C D:/MCP rebase origin/integration                 # replay the append-only edits onto the new tip
git -C D:/MCP switch integration && git -C D:/MCP merge --ff-only feat/F01-schema-contracts
git -C D:/MCP push origin integration
```

**⑤ REMOVE THE WORKTREE — after merge (or abandonment).**
```bash
git -C D:/MCP worktree remove .claude/worktrees/F01    # add --force if the tree is dirty/junked
git -C D:/MCP branch -d feat/F01-schema-contracts      # merged branch
git -C D:/MCP worktree prune                           # clear any stale registrations
node D:/MCP/radical-pipeline/05-tracking/update_status.mjs F01 S11 Done --overall Done
```
The worktree is the physical embodiment of "one feature per fresh subagent, discarded on merge" — build state lives on disk in the worktree, project state lives in `status/<ID>.json`, and neither leaks into another agent's context.

### 2.5 The no-duplicate-feature guarantee — three interlocking mechanisms

"No two agents ever build the same feature (no extra/duplicate feature)" is enforced at three independent layers, so a slip at any one is caught by the next:

1. **The tracker is the single source of *assignment*.** The Orchestrator reads `05-tracking/tracker-data.json` + every `status/*.json`, and from the dependency DAG / wave schedule dispatches **exactly one fresh subagent per `<ID>`**, skipping anything already `Done`. Duplicates cannot originate here because assignment is centralized.

2. **The `owner` field in `status/<ID>.json` is the atomic *claim* (the per-feature claims registry).** Before writing any code, a builder claims its feature:
   ```bash
   node 05-tracking/update_status.mjs F01 --owner engine-builder-2
   ```
   The tracking design gives **one status file per feature and lets only that feature's owner write it** — so the claim can't be corrupted by a racing writer, and any dispatch that finds `owner` already set on an `<ID>` stands down. This is the runtime lock against accidental double-dispatch.

3. **ADR-02 append-only tool registration makes any duplicate structurally *visible* and merge-*safe*.** Each feature adds its tool in its own `registerXxxTool(server, deps)` module and **appends one call line** to the `index.ts` registration list — it never edits another feature's registration. So two features can't produce overlapping edits, and if two agents ever *did* target the same tool, the result is two appended lines registering the **same tool name** — an obvious duplicate the Code-Reviewer and Integration agent catch at merge (and the MCP server itself rejects duplicate tool names at runtime).

**Net:** the tracker prevents duplicate *assignment*, the `owner` claim prevents duplicate *dispatch*, and ADR-02 prevents duplicate/overlapping *code* while surfacing any leak. No extra or duplicate feature survives to `integration`.

### 2.6 What worktrees do and do NOT do (the key distinction)

**Worktrees isolate the *build*; they do not by themselves prevent *merge* conflicts.** Two builders editing `types.ts` in separate worktrees still produce two divergent `types.ts` that must reconcile at merge time. The isolation and the clean merge come from **different** mechanisms working together:

| Concern | Mechanism |
|---|---|
| Concurrent, non-stomping build + test | **Worktrees** — each builder has a private, stable checkout to compile and run Playwright gates against |
| Conflict-free *merge* of shared files | **ADR-02 append-only** (`index.ts` gains an appended line, not a rewrite) + **one new module per feature** (logic lands in `drift.ts`/`transform.ts`/… not in a shared file) |
| Deterministic replay across a wave | **Rebase-before-merge** onto latest `integration` + **serial, wave-ordered promotion** by the single Integration agent |

That is why N engine builders all touching `types.ts`/`engine.ts`/`index.ts` neither block nor clobber one another: worktrees decouple their *builds*, ADR-02 + module-per-feature decouple their *diffs*, and rebase-then-ff-merge sequences their *landings*.

### 2.7 Cross-repo uniformity

| | `apimemcp` (engine) | `apimemcp-platform` (Turborepo) | `apimemcp-templates` |
|---|---|---|---|
| Worktree root | `D:\MCP\.claude\worktrees\<F##>` | `<platform>\.claude\worktrees\<W/X/M##>` | optional (`.claude/worktrees/<slug>`) |
| Branch off | `integration` | `integration` | `main` (no integration tier) |
| Dep install in fresh worktree | `npm ci` | `pnpm install` (shared store — fast across worktrees) | none needed |
| Build + gates inside worktree | `npm run build` · `npm test` · `node scripts/verify-F##.mjs` | `pnpm turbo build` · component tests · Vercel **preview** (web/cloud) / **EAS/simulator** (mobile) | F03 `verify-registry` + F19 lint on the PR |
| Shared-file contention | `types.ts`/`engine.ts`/`index.ts` | `packages/shared/*` + turbo/tsconfig/lockfile | none (independent template files) |
| Merger | Integration (engine) | Integration (platform) | Integration (templates), PR-per-template |

The lifecycle (§2.4 ① → ⑤) is byte-for-byte the same in the platform repo with `pnpm`/`turbo` substituted; in the templates repo, worktrees are a convenience for a builder juggling a template PR alongside engine work, not a contention fix.

### 2.8 Concurrency limits & hygiene

- **≤ 3 engine-builder worktrees live at once** (burst to 4 only in a low-contention wave, per `agent-roster.md`) — the cap exists because more parallel `types.ts` edits raise rebase churn faster than they add throughput. Program 2's pod runs its own worktrees in the platform repo and never contends with the engine repo.
- **A branch can be checked out in only one worktree.** `integration`, `master`, and `main` each live in exactly one checkout — builders branch `feat/*` off `integration` and never check `integration` out directly. The one place this bites is a **late rebase at merge** (§2.4 ④): a `feat/*` branch bound to the builder's worktree can't be rebased from Integration's checkout — free it first (`git worktree remove`; the commits are safe on `origin`), then rebase.
- **`git worktree prune`** after any manual deletion; **`git worktree list`** to audit live worktrees against live `owner` claims (they should match one-to-one).
- **Windows `MAX_PATH` (260).** `D:\MCP\.claude\worktrees\F01\node_modules\...` is deep. If a path-length error appears, enable `git config --global core.longpaths true` (and, if needed, the Windows long-paths policy) — the worktree root is already kept shallow to stay well under the limit. *(ponytail: global lock is `core.longpaths`; only revisit if a dep with pathological nesting appears.)*
- **Disk.** Each worktree is a full checkout + its own `node_modules`. Remove promptly on merge (§2.4 ⑤); don't leave abandoned worktrees for the OS to garbage-collect.

---

## 3. Promotion order within a wave

Merge the **critical-path / foundation** feature to `integration` **first** so its dependents rebase onto it rather than onto stale `integration`. Example (Wave 1): `F01` (schema contract) lands before `F05`/`F03`/`F14`, because F02→F04 and F11/F23/W04/M04 all build on F01's `outputSchema`. Any `index.ts` / `types.ts` reconciliation the Integration agent hits is resolved via **ADR-02 append-only** (keep both appended registration lines; union new type additions) — never by discarding a feature's edit.

---

## 4. Branch protection

- **`master` / `main` (releasable):** no direct push; green CI + **Integration sole-merger** + **Orchestrator sign-off** required; linear history; promoted only at the wave **G8** gate (`quality-gates.md`).
- **`integration`:** no self-merge (builder ≠ merger); all *applicable* gates green — Code-Review always, **+Security** if flagged / any `X##`, **+Arch** if it touches a boundary (`types.ts` shape / new module / 4-module separation / cross-repo contract), **+Design** if UI; CI green; feature **rebased onto latest `integration` first**.
- **`feat/<id>-slug`:** the builder's worktree branch; pushed for review, never self-merged, deleted after it lands.

---

## 5. Cross-repo contract (ADR-06)

`apimemcp-platform` consumes the **published `@neetigyashah/apimemcp` types** + the `apimemcp-templates` registry manifest — and **nothing else** from the engine repo (never engine internals, never a relative import across repos). A breaking engine type change is a **semver major** on the npm package **plus** a follow-up bump PR in the platform repo. This is why the platform repo can run its own worktree pod entirely in parallel with engine Waves 1–2: the only thing that crosses the repo boundary is a versioned npm artifact, not live source.

---

## 6. F00 reconciliation (explicit)

The in-flight **app-connections** work is Wave 0's `F00` and lands **first**, through the full gate pipeline (it has had zero prior review):

1. Phase −1 (see `PLAN.md`) commits app-connections straight to `master`; then `integration` is cut off that clean `master` (§2.3).
2. `F00`'s builder takes a worktree off `integration`, **retrofits its 3 tools** (`connect_app` / `confirm_app_connection` / `list_app_connections`) **to ADR-02** (`registerAppConnectionsTools` module + appended `index.ts` lines), and **fixes the `engine.ts ↔ app-connections.ts` erosion** (`engine.ts` currently imports/mutates app-connections state — F00 restores the boundary).
3. F00 merges to `integration` as the **very first merge**, clearing the biggest `index.ts` contention before any Wave-1 builder forks — so every later feature rebases onto an already-ADR-02-clean `index.ts`.
4. **Vault (F13) ≠ app-connections** (ADR-05): app-connections = login *profile/session dirs*; Vault = *encrypted secrets*. If F00 isn't green in time, **freeze its public surface via ADR-05** so F13/X06 can code against the frozen shape; land F00 before F13; rebase weekly.

---

## 7. Self-check (worked example — three engine builders, Wave 1)

```
integration @ F00 landed (ADR-02 clean index.ts)
│
├─ .claude/worktrees/F01  feat/F01-schema-contracts   owner=eng-1   → build+gates → push → (merged 1st, critical path)
├─ .claude/worktrees/F05  feat/F05-synthesize-schema  owner=eng-2   → build+gates → push → rebased onto F01 → merged
└─ .claude/worktrees/F03  feat/F03-nightly-verify      owner=eng-3   → build+gates → push → rebased → merged
```
All three edit `types.ts`/`engine.ts`/`index.ts` **at the same time** in **separate directories** (no stomp — worktrees). Each appends its own `registerXxxTool` line and adds its logic in a new module (`schema.ts` / `renderPage` in engine / `verify-registry.mjs`) (no merge conflict — ADR-02 + module-per-feature). Each has a distinct `owner` claim on a distinct `status/<ID>.json` (no duplicate feature — claims registry). Integration merges F01 → F05 → F03 in critical-path order, rebasing each onto the last (deterministic landings). Every worktree is removed on merge; `git worktree list` returns to just the base checkout.
