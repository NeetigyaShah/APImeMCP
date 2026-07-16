# 03-orchestration / context-bounded-workflow.md

**The whole build runs as a dispatched workflow, not one long-lived agent** — so no agent ever approaches its context limit, and the pipeline scales in *number of features* without scaling any single context window. Forty-eight features do not mean a 48-feature-sized context anywhere; they mean 48 small, isolated, discardable agent runs coordinated through files on disk.

This is the operational contract behind `agent-roster.md` (stateless gate agents), `handoff-protocol.md` (disk-anchored handoffs), and `dependency-dag-and-waves.md` (the Orchestrator's bounded view).

---

## The five principles

### 1. One feature per fresh subagent
The Orchestrator dispatches each `F##`/`W##`/`X##`/`M##` to a **new** Builder subagent whose prompt contains **only**:
- (a) the path to that feature's spec — `02a/02b-features/<ID>.md`,
- (b) the specific ADR(s) it touches,
- (c) its Skills list + install commands.

It never receives the whole plan, the other 47 specs, or any other feature's context. When the feature merges (G7), that subagent's context is **discarded** — its durable output is the merged code + the updated `status/<ID>.json`, nothing in a window. A 48-feature build is 48 short-lived contexts, peak-bounded at one feature each, not one context that grows with the project.

### 2. Disk is the shared brain
All specs, ADRs, and `tracker-data.json` live in the `radical-pipeline/` package on disk. Agents read **only their slice** and write status back to the tracker. Project state lives in **files, not any agent's window**:
- an agent needs intent → reads its one spec;
- it needs a contract → reads the named ADR;
- it needs to know what's done → reads `status/*.json`;
- it records progress → writes its own `status/<ID>.json`.

No agent holds "the state of the build" in memory, so no agent's memory is a bottleneck or a single point of failure. Apply the `.agents/context-engineering` skill: pull the minimum slice, never the whole corpus.

### 3. Skills = durable, reusable memory
A skill installed once (`-g`, global) is available to **every later agent** — this *is* what "use previous skills" means. Each agent, before coding:
```
npx skills check                      # reuse anything already installed (global, durable, shared)
npx skills add <pkg> -g -y            # install ONLY its missing feature skills
```
Setup is idempotent and per-task. A skill an early feature installed (e.g. `expo-react-native-typescript` for M01) is automatically present for every later mobile agent — the install cost is paid once for the whole fleet, and skills act as cross-agent long-term memory that survives every context discard.

### 4. Bounded fan-out harness
Drive the fleet with the **Workflow tool** (deterministic `pipeline()` / `parallel()` over the dependency DAG in `dependency-dag-and-waves.md`), so each feature runs as an isolated agent with its own context. The Orchestrator holds only the **wave plan + the merged tracker view** — never the sum of feature contexts. Reference `superpowers:subagent-driven-development`. The harness enforces the concurrency budget (≤3 Engine Builders; separate Program-2 pod) and the DAG edges, so "what runs now" is computed from disk, not remembered.

### 5. Gate agents are stateless too
Each Code-Review / QA / Security / Live-Verify agent is dispatched **per-PR** with only the diff + that feature's Definition of Done. It reviews one thing, records a verdict in the tracker (`--reviewer`, S-cell), and is discarded. No gate agent accumulates context across features; the reviewer of F02 and the reviewer of F10 share nothing but the skills library and the tracker on disk.

---

## Why this survives a cleared history (resumability)

Every coordination fact lives on disk, so a brand-new agent with **zero chat context** can resume the entire build:
- **What's the plan?** → `radical-pipeline/PLAN.md` + `START-HERE.md`.
- **What's done / blocked / free?** → `05-tracking/status/*.json` (`overall`, S-cells).
- **Who's building what?** → the `owner` field (claims registry, `agent-roster.md`).
- **What can start next?** → the next-unblocked algorithm in `dependency-dag-and-waves.md`, run against the status files.

The tracker **is** the resume point for progress; the claims registry **is** the resume point for in-flight work. Re-running the cold-start Orchestrator prompt (`START-HERE.md`) after clearing history reads these files and picks up exactly where the last run stopped — no chat memory required. This is the same property that makes parallelism safe: state that lives in files can be reconstructed by anyone, any time.

---

## Context flow of one feature (round-trip through disk)

```
Orchestrator (holds: wave plan + tracker view only)
   │  reads: dependency-dag-and-waves.md + status/*.json
   │  writes: status/<ID>.json  (owner = builder)         ← claim
   ▼
Builder subagent  (holds: ONE spec + its ADRs + its skills)
   │  reads: 02a/02b-features/<ID>.md, 01-adrs/<n>.md
   │  runs:  npx skills check / add;  builds in worktree <ID>-slug
   │  writes: code on feat/<ID>-slug + status/<ID>.json  (S-cells)
   ▼  (PR)
Gate subagents  (each holds: ONE diff + ONE Definition of Done)
   │  writes: status/<ID>.json  (reviewer, S-cell verdict)
   ▼
Integration  (holds: the merge + ADR-02 conflict rules)
   │  writes: merged code + status/<ID>.json (S11 Done, overall Done)
   ▼
context discarded — durable residue = merged code + status/<ID>.json + installed skills
```

At no step does any single agent's context exceed one feature (Builder), one diff (gate), or one merge (Integration). The Orchestrator's context is the wave plan plus a tracker summary — bounded regardless of how many features exist.

---

## Dispatch prompt templates (implementation-ready)

The Orchestrator uses these verbatim shapes. They are deliberately minimal — the point is what they **exclude** (the rest of the plan).

### Builder subagent
```
You are building feature <ID> for the APImeMCP Radical Pipeline. Assume no other context.

1. Read your spec:  D:\MCP\radical-pipeline\02a-features-engine\<ID>.md
                    (or 02b-features-platform\<ID>.md)
2. Read the ADR(s) it names:  D:\MCP\radical-pipeline\01-adrs\<...>.md
3. Confirm you own it:  read 05-tracking\status\<ID>.json — proceed only if owner == you.
4. Skills:  npx skills check ; then npx skills add <pkg> -g -y for any missing (spec §10).
5. Create your worktree:  feat/<ID>-slug off integration (EnterWorktree name:"<ID>-slug"
   or  git worktree add .claude\worktrees\<ID>-slug -b feat/<ID>-slug integration).
6. Build S1..S8 per the spec; after each sub-task:
      node D:\MCP\radical-pipeline\05-tracking\update_status.mjs <ID> S<#> Done
      python D:\MCP\radical-pipeline\05-tracking\generate_tracker.py
7. Open PR feat/<ID>-slug -> integration.  Follow the gates (quality-gates.md).
Do NOT read other features' specs. Do NOT merge your own PR.
```

### Gate subagent (Code-Review / QA / Security / Live-Verify)
```
You are the <GATE> reviewer for feature <ID>. Assume no other context.

1. Inputs: the PR diff for feat/<ID>-slug, and the Definition of Done in
   D:\MCP\radical-pipeline\02a/02b-features\<ID>.md §6 (+ the named ADR for G3, the
   design system for G3b, the security posture for G4).
2. Record yourself:  update_status.mjs <ID> --reviewer <you>   (you must NOT be the owner).
3. Apply your gate's checklist (quality-gates.md, gate <GATE>).
4. Verdict:
     PASS  -> update_status.mjs <ID> S<#> Done --gate <next>
     FAIL  -> post findings on the PR; update_status.mjs <ID> S<#> Blocked --overall Blocked
5. Regenerate the tracker. You are done — you will be discarded.
Review ONLY this one diff. Do not look at other features.
```

---

## The rule, in one line

**Fan out, never fatten.** Add features by adding short-lived agents that each read one slice of disk and write one status file back — not by growing any agent's context. The plan on disk is the memory; the agents are disposable.
