# Wave 3 close-out + Wave 4 push — execution design

**Date:** 2026-07-17 19:10-23:00 IST
**Author:** Orchestration session (Claude Code), approved by NeetigyaShah

## Goal

Get as many of the 9 remaining Program-1 features in Waves 3-4 to `Done`/merged
into `integration` as possible by 23:00 IST, without weakening the existing
gate process (`03-orchestration/quality-gates.md`) or lying about status the
way a couple of tonight's self-declared "Done" markers did.

## Scope

- **Wave 3 remnants** (deps already satisfied, work already started):
  F04 (repair committed, unreviewed), F06 (mid-repair at G2), F11 (retry branch
  claims Done but reviewer field is not a named independent reviewer — needs
  real verification), F15 (worktree is quarantined line-ending noise — no real
  work exists, needs a fresh build).
- **Wave 4** (all blockers already merged, so all dispatchable now):
  F20, F17, F12, F09, F13.

Out of scope tonight: Wave 5 (F18/F21/F24/F25) and Program 2 (W/X/M).

## Priority order

1. F04, F06, F11 — finish/verify existing work (cheapest to land).
2. F20, F17, F12 — fresh Wave 4 builds, batch 1. F17 (OTel/observability) is
   prioritized per explicit user instruction that logging is the most
   important part of tonight's push.
3. F09, F13, F15 — batch 2. F13 is heaviest (vault ADR-05 + Security gate G4).

## Model assignment

- **Builders:** Haiku 4.5 — fast, cheap, high volume, and per the existing
  agent-roster design builders are the "many, disposable" role.
- **Gate reviewers** (Code-Review G2, Architect G3, Security G4, QA G5,
  Live-Verify G6) and the merge step: the session's default stronger model.
  Rationale: tonight's biggest time loss so far has been rejected gates
  triggering full rebuild loops, not slow builders — a bad gate verdict is
  far more expensive than a slow one.

## Concurrency

Respect the documented cap: ≤3 Engine Builders concurrent (burst 4 only in a
low-contention wave), because they share `types.ts`/`engine.ts`/`index.ts` and
wider parallelism moves the cost to a messier Integration merge, not less
total time.

## Mechanism

- One `Workflow` script per batch: pipeline of Build(Haiku) → Code-Review →
  [Arch/Security/QA/Live-Verify as applicable per `quality-gates.md`'s
  conditional rules].
- **Merges are done by the main session, not a subagent** — same pattern used
  tonight for F07/F08: real `npm run build` + `npm test` + `verify-<ID>.mjs`
  before trusting a merge, never a self-reported "Done."
- **Every dispatched agent's prompt mandates a one-line `orchestration-log.md`
  entry plus a `status/<ID>.json` write before it finishes, pass or fail.**
  This directly targets tonight's actual failure mode: agents stalling with
  no handoff and no record.
- Checkpoints at ~21:30 and ~22:30 IST: anything not converged gets frozen and
  marked `Blocked` with the real finding recorded, rather than silently
  consuming time past the 23:00 deadline.

## Non-goals / explicit descope

- Not attempting Wave 5 or Program 2 tonight — no branch/worktree exists for
  those and there isn't time to run them through G0-G7 from scratch on top of
  9 other features.
- Not trusting any tracker "Done" marker that lacks a real, named independent
  reviewer and a passing build+test run — this was the concrete failure mode
  caught earlier tonight (F04's uncommitted self-declared Done, F11-retry's
  vague reviewer field).

## Success criteria

By 23:00 IST: every one of the 9 features is in one of two honest states —
merged to `integration` with build+tests+verify passing, or `Blocked` with a
specific recorded finding and owner for the next session. No feature is left
in an ambiguous or silently-abandoned state.
