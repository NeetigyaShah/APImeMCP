# Wave 3 close-out + Wave 4 push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get F04, F06, F11, F15 (Wave 3 remnants) and F09, F12, F13, F17, F20 (all of Wave 4) to an honest `Done`-and-merged or `Blocked`-with-finding state in `radical-pipeline/05-tracking/status/*.json` and `integration`, by 23:00 IST 2026-07-17.

**Architecture:** Reuse the existing G0-G7 gate pipeline (`radical-pipeline/03-orchestration/quality-gates.md`) exactly as documented. Two `Workflow` tool invocations dispatch subagents (Haiku 4.5 builders, default-model gate reviewers); the main session performs every actual git merge itself (build+test+verify before trusting any merge — no subagent self-declares "Done").

**Tech Stack:** `Workflow` tool (JS orchestration scripts), `Agent` tool patterns embedded in those scripts, existing repo tooling (`npm run build`, `npm test`, `scripts/verify-<ID>.mjs`, `node radical-pipeline/05-tracking/update_status.mjs`, `python radical-pipeline/05-tracking/generate_tracker.py`).

## Global Constraints

- Builder agents (write code): **Haiku 4.5** (`model: "claude-haiku-4-5-20251001"` is NOT a valid Workflow model string — Workflow's `opts.model` expects the same identifiers as the Agent tool; use `model: "haiku"`).
- Gate-reviewer agents (Code-Review G2, Architect G3, Security G4, QA G5, Live-Verify G6): **no model override** — inherit the session's default model.
- **≤3 concurrent fresh/repair builders at any moment** (documented Engine Builder cap). Enforced by chunking build dispatch into groups of 3 via `pipeline()`/`parallel()` calls, never passing more than 3 build-capable items to a single `parallel()`.
- **Every agent's prompt must end with this mandatory instruction, verbatim:**
  > "Before you finish, you MUST append one line to `radical-pipeline/05-tracking/orchestration-log.md` (a new bullet under a `## 2026-07-17 - <your feature ID> <what you did>` heading if one doesn't already exist for tonight's run) describing what you did or found, and update `radical-pipeline/05-tracking/status/<ID>.json` via `node radical-pipeline/05-tracking/update_status.mjs <ID> ...` (or direct edit if that script doesn't cover your field) with your actual S-cell/gate state — even if you are reporting a failure or a stall. Do this whether you pass or fail. This is the single most important requirement of your task; an agent that finishes without this write has not finished."
- Only the main session merges to `integration` (matches the "Integration / Merge — sole merger" rule in `agent-roster.md`).
- Security gate (G4) is mandatory and blocking for: **F04, F06, F11, F12, F13** (from `quality-gates.md`'s flagged set: all X##, plus F00/F04/F06/F11/F12/F13/F16/F18). Not required for F09, F15, F17, F20.
- Conditional G3 (Arch): fires only if the diff changes a `types.ts` shape, adds a new module, or crosses the 4-module boundary — the reviewer agent determines this from the diff itself, not hardcoded here.
- Conditional G6 (Live-Verify): fires only if the feature has runtime/Playwright surface. Per each feature's spec: F09 (bidirectional flows — has runtime surface, needs G6), F12 (policy engine — pure logic, skip G6), F13 (credential vault — pure logic + storage, skip G6 unless spec says otherwise), F17 (OTel — pure logic/instrumentation, skip G6), F20 (change-monitoring mesh — has runtime surface, needs G6). F04/F06/F11/F15 already have `scripts/verify-F04.mjs` etc. conventions from earlier waves — reuse if present, else the reviewer confirms G6 is/isn't applicable per spec.

---

### Task 1: Batch A — verify/repair Wave 3 remnants (F04, F06, F11)

**Files:**
- No new files created directly by this task; it dispatches agents that modify feature worktrees under `.claude/worktrees/{F04,F06,F11-retry}` and their branches.
- Read (context for every dispatched agent): `radical-pipeline/03-orchestration/quality-gates.md`, `radical-pipeline/03-orchestration/agent-roster.md`, the feature's own `radical-pipeline/02a-features-engine/<ID>*.md` spec.

**Interfaces:**
- Consumes: current worktree state (F04 commit `176e73c` already has a repaired, honestly-marked In-Review status; F06 at `f5dfff6`, mid G2; F11-retry at `d18bd3b`, self-reported Done but unverified).
- Produces: a structured verdict object per feature — `{id, finalGate: string, pass: boolean, commit: string, findings: string[]}` — consumed by Task 3 (merge sweep).

- [ ] **Step 1: Write the Workflow script for Batch A**

```js
export const meta = {
  name: 'wave3-remnants-verify',
  description: 'Verify/repair F04, F06, F11 through remaining gates',
  phases: [
    { title: 'Review' },
    { title: 'Repair' },
    { title: 'Re-review' },
  ],
}

const LOGGING_MANDATE = `Before you finish, you MUST append one line to radical-pipeline/05-tracking/orchestration-log.md (a new bullet under a "## 2026-07-17 - <your feature ID> <what you did>" heading if one doesn't already exist for tonight's run) describing what you did or found, and update radical-pipeline/05-tracking/status/<ID>.json via node radical-pipeline/05-tracking/update_status.mjs <ID> ... (or direct edit if that script doesn't cover your field) with your actual S-cell/gate state -- even if you are reporting a failure or a stall. Do this whether you pass or fail. This is the single most important requirement of your task; an agent that finishes without this write has not finished.`

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'string' } },
    gate: { type: 'string' },
  },
  required: ['pass', 'findings', 'gate'],
}

const FEATURES = [
  {
    id: 'F04',
    worktree: 'D:\\MCP\\.claude\\worktrees\\F04',
    spec: 'radical-pipeline/02a-features-engine/F04-self-healing.md',
    needsG4: true,
  },
  {
    id: 'F06',
    worktree: 'D:\\MCP\\.claude\\worktrees\\F06',
    spec: 'radical-pipeline/02a-features-engine/F06-crystallization.md',
    needsG4: true,
  },
  {
    id: 'F11',
    worktree: 'D:\\MCP\\.claude\\worktrees\\F11-retry',
    spec: 'radical-pipeline/02a-features-engine/F11-provenance.md',
    needsG4: true,
  },
]

async function reviewFeature(f) {
  const g2 = await agent(
    `Act as the Code-Reviewer gate (G2) from radical-pipeline/03-orchestration/quality-gates.md for feature ${f.id} in worktree ${f.worktree}. Read ${f.spec} for the Definition of Done. Run 'git log --oneline -5' and 'git diff integration...HEAD' in that worktree to see the real diff. Check: correct vs spec; no reinvented stdlib/existing-module code; minimal diff; error handling at boundaries. Run 'npm run build' and 'npm test' in the worktree and report their actual pass/fail. ${LOGGING_MANDATE}`,
    { label: `${f.id}:G2`, phase: 'Review', schema: VERDICT_SCHEMA }
  )
  if (!g2 || !g2.pass) {
    const repair = await agent(
      `Act as a repair Builder for feature ${f.id} in worktree ${f.worktree}. A Code-Reviewer (G2) rejected the current state with these findings: ${JSON.stringify(g2 ? g2.findings : ['reviewer produced no verdict'])}. Fix exactly these findings, minimal diff, do not refactor unrelated code. Run 'npm run build' and 'npm test' until both pass. Commit your fix with message "fix(${f.id}): repair G2 findings". ${LOGGING_MANDATE}`,
      { label: `${f.id}:repair`, phase: 'Repair', model: 'haiku', schema: VERDICT_SCHEMA }
    )
    const g2b = await agent(
      `Act as the Code-Reviewer gate (G2) again for feature ${f.id} in worktree ${f.worktree}, re-checking after a repair pass. Verify the specific findings from before are resolved: ${JSON.stringify(g2 ? g2.findings : [])}. Run 'npm run build' and 'npm test'. ${LOGGING_MANDATE}`,
      { label: `${f.id}:G2-recheck`, phase: 'Re-review', schema: VERDICT_SCHEMA }
    )
    if (!g2b || !g2b.pass) {
      return { id: f.id, finalGate: 'G2', pass: false, commit: null, findings: g2b ? g2b.findings : ['re-review produced no verdict'] }
    }
  }
  if (f.needsG4) {
    const g4 = await agent(
      `Act as the Security-Reviewer gate (G4) from radical-pipeline/03-orchestration/quality-gates.md for feature ${f.id} in worktree ${f.worktree}. Check: no secret leakage (cookies/keys never logged/committed); sandbox/allowlist intact; per-user isolation; registry input treated as untrusted; if this is F04, verify self-heal NEVER auto-merges to the registry. ${LOGGING_MANDATE}`,
      { label: `${f.id}:G4`, phase: 'Review', schema: VERDICT_SCHEMA }
    )
    if (!g4 || !g4.pass) {
      return { id: f.id, finalGate: 'G4', pass: false, commit: null, findings: g4 ? g4.findings : ['G4 produced no verdict'] }
    }
  }
  const g5 = await agent(
    `Act as the QA gate (G5) for feature ${f.id} in worktree ${f.worktree}. Run the full test suite ('npm test') and confirm it is meaningful and deterministic, not snapshot-only. Report the actual test count and pass/fail. ${LOGGING_MANDATE}`,
    { label: `${f.id}:G5`, phase: 'Review', schema: VERDICT_SCHEMA }
  )
  if (!g5 || !g5.pass) {
    return { id: f.id, finalGate: 'G5', pass: false, commit: null, findings: g5 ? g5.findings : ['G5 produced no verdict'] }
  }
  const headCommit = await agent(
    `In worktree ${f.worktree}, run 'git rev-parse HEAD' and return only the commit hash as plain text.`,
    { label: `${f.id}:head`, phase: 'Review' }
  )
  return { id: f.id, finalGate: 'G5', pass: true, commit: (headCommit || '').trim(), findings: [] }
}

const results = await parallel(FEATURES.map(f => () => reviewFeature(f)))
return results.filter(Boolean)
```

- [ ] **Step 2: Run the workflow**

Invoke the `Workflow` tool with the script above (`script` param). Do not use `isolation: 'worktree'` — the features already have their own dedicated worktrees.

- [ ] **Step 3: Record raw results**

Read the workflow's returned array. For each feature, note `{id, finalGate, pass, commit, findings}` — this is the exact input Task 3 consumes. Do not act on these yet (no merges in this task).

---

### Task 2: Batch B — fresh Wave 4 builds, group 1 (F20, F17, F12)

**Files:**
- Creates worktrees `.claude/worktrees/{F20,F17,F12}` (branches `feat/F20-*`, `feat/F17-*`, `feat/F12-*`, based off `integration`).
- Read (context): `radical-pipeline/02a-features-engine/F20-*.md`, `F17-*.md`, `F12-*.md` (if these spec files don't exist yet under that exact name, the builder's first job is G0: write a one-page spec there per `quality-gates.md`'s G0 checklist, consistent with the feature's one-line description in `dependency-dag-and-waves.md`: F20 = change-monitoring mesh, F17 = OTel, F12 = policy engine).

**Interfaces:**
- Consumes: nothing from Task 1 (independent feature set); reads `integration` HEAD as the base for new worktrees.
- Produces: same `{id, finalGate, pass, commit, findings}` shape as Task 1, consumed by Task 3.

- [ ] **Step 1: Write and run the fresh-build Workflow script**

```js
export const meta = {
  name: 'wave4-fresh-build-batch1',
  description: 'Fresh-build F20, F17, F12 through G0-G6',
  phases: [
    { title: 'Build' },
    { title: 'Review' },
  ],
}

const LOGGING_MANDATE = `Before you finish, you MUST append one line to radical-pipeline/05-tracking/orchestration-log.md (a new bullet under a "## 2026-07-17 - <your feature ID> <what you did>" heading if one doesn't already exist for tonight's run) describing what you did or found, and update radical-pipeline/05-tracking/status/<ID>.json via node radical-pipeline/05-tracking/update_status.mjs <ID> ... (or direct edit if that script doesn't cover your field) with your actual S-cell/gate state -- even if you are reporting a failure or a stall. Do this whether you pass or fail. This is the single most important requirement of your task; an agent that finishes without this write has not finished.`

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    buildPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    testCount: { type: 'number' },
    commit: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['buildPassed', 'testsPassed', 'commit'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'string' } },
    gate: { type: 'string' },
  },
  required: ['pass', 'findings', 'gate'],
}

const FEATURES = [
  { id: 'F20', slug: 'change-monitoring-mesh', desc: 'change-monitoring mesh (F02 drift consumer, notifies on watched-template drift)', needsG4: false, needsG6: true },
  { id: 'F17', slug: 'otel-observability', desc: 'OpenTelemetry-style structured metrics/logging on top of the F14 metrics measure-model (ADR-04)', needsG4: false, needsG6: false },
  { id: 'F12', slug: 'policy-engine', desc: 'policy engine for extraction rules (no external deps listed)', needsG4: true, needsG6: false },
]

async function buildFeature(f) {
  const build = await agent(
    `You are the Engine Builder for feature ${f.id} (${f.desc}) in the apimemcp repo at D:\\MCP. First create your isolated worktree: 'git worktree add .claude/worktrees/${f.id}-slug -b feat/${f.id}-${f.slug} integration' run from D:\\MCP. Then, inside that worktree: (1) write a one-page spec at radical-pipeline/02a-features-engine/${f.id}-${f.slug}.md per the G0 checklist in radical-pipeline/03-orchestration/quality-gates.md (spec consistent with ADRs, one module/screen per sub-task, test + verify plan, not a duplicate of an existing feature -- check radical-pipeline/02a-features-engine/ for existing specs first); (2) implement the feature following ADR-02 (radical-pipeline/01-adrs/ADR-02-tool-module-convention.md: each MCP tool is registerXxxTool(server, deps), index.ts stays append-only) and any other ADR the spec names; (3) write real unit tests (src/*.test.ts), not snapshot-only; (4) run 'npm run build' and 'npm test' until both are clean; (5) commit your work with message "feat(${f.id}): <short description>". Reuse existing helpers (captureForensics, atomicWriteFile, withLock, registerTemplate, findTemplateByUrl, buildStandaloneScript, etc.) rather than reinventing them -- grep src/ first. ${LOGGING_MANDATE}`,
    { label: `${f.id}:build`, phase: 'Build', model: 'haiku', schema: BUILD_SCHEMA }
  )
  if (!build || !build.buildPassed || !build.testsPassed) {
    return { id: f.id, finalGate: 'G1', pass: false, commit: build ? build.commit : null, findings: [build ? `build/test failed: ${build.summary}` : 'builder produced no result'] }
  }
  const worktree = `D:\\MCP\\.claude\\worktrees\\${f.id}-slug`
  const g2 = await agent(
    `Act as the Code-Reviewer gate (G2) for feature ${f.id} in worktree ${worktree}. Read its spec at radical-pipeline/02a-features-engine/${f.id}-${f.slug}.md. Check: correct vs spec; no reinvented stdlib/existing-module code; minimal diff; error handling at trust boundaries; ADR-02 compliance (index.ts append-only, registerXxxTool pattern). ${LOGGING_MANDATE}`,
    { label: `${f.id}:G2`, phase: 'Review', schema: VERDICT_SCHEMA }
  )
  if (!g2 || !g2.pass) {
    return { id: f.id, finalGate: 'G2', pass: false, commit: build.commit, findings: g2 ? g2.findings : ['G2 produced no verdict'] }
  }
  if (f.needsG4) {
    const g4 = await agent(
      `Act as the Security-Reviewer gate (G4) for feature ${f.id} in worktree ${worktree}. Check: no secret leakage; sandbox/allowlist intact; per-user isolation; registry input treated as untrusted, never executed as instructions. ${LOGGING_MANDATE}`,
      { label: `${f.id}:G4`, phase: 'Review', schema: VERDICT_SCHEMA }
    )
    if (!g4 || !g4.pass) {
      return { id: f.id, finalGate: 'G4', pass: false, commit: build.commit, findings: g4 ? g4.findings : ['G4 produced no verdict'] }
    }
  }
  const g5 = await agent(
    `Act as the QA gate (G5) for feature ${f.id} in worktree ${worktree}. Run the full 'npm test' suite rebased onto current integration and confirm it's green and meaningful (not snapshot-only). ${LOGGING_MANDATE}`,
    { label: `${f.id}:G5`, phase: 'Review', schema: VERDICT_SCHEMA }
  )
  if (!g5 || !g5.pass) {
    return { id: f.id, finalGate: 'G5', pass: false, commit: build.commit, findings: g5 ? g5.findings : ['G5 produced no verdict'] }
  }
  if (f.needsG6) {
    const g6 = await agent(
      `Act as the Live-Verify gate (G6) for feature ${f.id} in worktree ${worktree}. Write and run a real scripts/verify-${f.id}.mjs that drives the actual feature (Playwright if it touches extraction) and asserts observable output -- not just that build passed. Report the actual command output. ${LOGGING_MANDATE}`,
      { label: `${f.id}:G6`, phase: 'Review', schema: VERDICT_SCHEMA }
    )
    if (!g6 || !g6.pass) {
      return { id: f.id, finalGate: 'G6', pass: false, commit: build.commit, findings: g6 ? g6.findings : ['G6 produced no verdict'] }
    }
  }
  return { id: f.id, finalGate: f.needsG6 ? 'G6' : 'G5', pass: true, commit: build.commit, findings: [] }
}

// Cap: exactly 3 builders in this group, run concurrently (== the documented cap, not over it).
const results = await parallel(FEATURES.map(f => () => buildFeature(f)))
return results.filter(Boolean)
```

- [ ] **Step 2: Run the workflow, record raw results** (same as Task 1 Step 3).

---

### Task 3: Merge sweep after Batch A + Batch B

**Files:**
- Modifies: `integration` branch directly (main session's checkout at `D:\MCP`), `radical-pipeline/05-tracking/status/*.json`, `radical-pipeline/05-tracking/APImeMCP-Radical-Tracker.xlsx`, `radical-pipeline/05-tracking/orchestration-log.md`.

**Interfaces:**
- Consumes: the two result arrays from Task 1 and Task 2 (`{id, finalGate, pass, commit, findings}[]`).
- Produces: updated `integration` HEAD; a written checkpoint note in `orchestration-log.md`.

- [ ] **Step 1: For each `pass: true` result, verify independently before merging**

For each feature in critical-path-first order (F12 before F17/F20 if it unblocks anything — check `dependency-dag-and-waves.md`'s reverse-DAG table; otherwise merge order doesn't matter for this batch since none of F04/F06/F11/F12/F17/F20 unblock each other directly), run in the main session:

```bash
cd D:/mcp && git merge --no-ff feat/<slug> -m "merge: integrate <ID> (gate-passed)"
```

If the xlsx binary conflicts (expected, seen with F07), resolve with:
```bash
git checkout --theirs radical-pipeline/05-tracking/APImeMCP-Radical-Tracker.xlsx
git add radical-pipeline/05-tracking/APImeMCP-Radical-Tracker.xlsx
git commit -m "merge: integrate <ID> (gate-passed)"
```

Then:
```bash
npm run build
npm test
node scripts/verify-<ID>.mjs   # if the feature has one
```

If any of these fail post-merge (integration conflict the agents' isolated worktrees couldn't see), **do not leave the merge in place** — `git merge --abort` if mid-merge, or `git revert` if already committed, and record the feature as `Blocked` with the integration-conflict finding instead.

- [ ] **Step 2: For each `pass: false` result, write the Blocked state**

```bash
cd D:/mcp/radical-pipeline/05-tracking
node update_status.mjs <ID> --overall Blocked --gate <finalGate>
```

(If `update_status.mjs` doesn't support the exact fields needed, edit `status/<ID>.json` directly, matching the existing shape.)

- [ ] **Step 3: Regenerate tracker and commit**

```bash
cd D:/mcp/radical-pipeline/05-tracking && python generate_tracker.py
cd D:/mcp && git add radical-pipeline/05-tracking/APImeMCP-Radical-Tracker.xlsx radical-pipeline/05-tracking/status/*.json
git commit -m "chore: tracker sweep after Batch A/B (Wave 3 remnants + Wave 4 group 1)"
```

- [ ] **Step 4: Append a checkpoint entry to orchestration-log.md**

Add a `## 2026-07-17 HH:MM IST - Batch A/B checkpoint` section listing exactly which of the 6 features merged, which are Blocked and why, matching the style of existing entries (see lines 60+ for the format).

```bash
git add radical-pipeline/05-tracking/orchestration-log.md
git commit -m "chore: log Batch A/B checkpoint"
```

- [ ] **Step 5: Time check against 21:30 IST checkpoint**

If it's past ~21:30 IST when this task completes, skip straight to Task 5 (final wrap) instead of starting Task 4 — better to land a clean report on 6 features than rush 3 more and blow the 23:00 deadline with nothing landed.

---

### Task 4: Batch C — remaining fresh builds (F09, F13, F15)

**Files:**
- Creates worktrees `.claude/worktrees/{F09,F13,F15}` (F15's existing quarantined worktree at `.claude/worktrees/F15` must be removed first: `git worktree remove .claude/worktrees/F15 --force` from `D:\MCP`, then recreated fresh).

**Interfaces:**
- Consumes: `integration` HEAD after Task 3's merges (F09 needs F07 — already merged tonight — and F10 — already merged in Wave 2).
- Produces: same `{id, finalGate, pass, commit, findings}` shape, consumed by a second run of Task 3's merge sweep.

- [ ] **Step 1: Remove F15's stale quarantined worktree**

```bash
cd D:/mcp && git worktree remove .claude/worktrees/F15 --force
```

(Confirm no uncommitted work worth keeping first: `cd .claude/worktrees/F15 && git status --short` — per tonight's investigation this worktree only has line-ending/skill-sync noise, safe to discard.)

- [ ] **Step 2: Write and run the Batch C Workflow script**

Same structure as Task 2's script, with `FEATURES` replaced by:

```js
const FEATURES = [
  { id: 'F09', slug: 'bidirectional-flows', desc: 'bidirectional flows (depends on F07 pipelines + F10 transform layer, both merged)', needsG4: false, needsG6: true },
  { id: 'F13', slug: 'credential-vault', desc: 'credential vault (ADR-05 vault vs app-connections; depends on F00, merged)', needsG4: true, needsG6: false },
  { id: 'F15', slug: 'static-http', desc: 'static-http fast path (10-50x speedup claim -- must be measured, not asserted, at G6)', needsG4: false, needsG6: true },
]
```

Keep the `LOGGING_MANDATE`, `BUILD_SCHEMA`, `VERDICT_SCHEMA`, and `buildFeature()` function identical to Task 2's script.

- [ ] **Step 3: Record raw results** (same pattern as before).

---

### Task 5: Final merge sweep and wrap-up report

**Files:**
- Same as Task 3, plus a final summary appended to `orchestration-log.md`.

- [ ] **Step 1: Repeat Task 3 Steps 1-4** for Batch C's results (or for whatever batches actually completed, if the 21:30 checkpoint skipped Task 4).

- [ ] **Step 2: Write the final status table**

Read every `radical-pipeline/05-tracking/status/{F04,F06,F09,F11,F12,F13,F15,F17,F20}.json` and produce a table: feature, final gate, pass/blocked, commit hash (if merged), one-line finding (if blocked). This is the actual deliverable the user sees — report it directly in chat, don't just say "done."

- [ ] **Step 3: Final tracker regen + commit**

```bash
cd D:/mcp/radical-pipeline/05-tracking && python generate_tracker.py
cd D:/mcp && git add -A radical-pipeline/05-tracking
git commit -m "chore: final tracker regen, Wave 3/4 push wrap-up"
```

- [ ] **Step 4: Report to user**

State clearly: how many of the 9 landed merged vs blocked, with the one-line finding for each blocked one, and total time remaining vs 23:00.
