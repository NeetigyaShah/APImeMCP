# 05-tracking — the Excel tracker

Static definitions and live status are split so many subagents can update the
tracker in parallel with zero write-contention (see `handoff-protocol.md` and
`context-bounded-workflow.md` in `03-orchestration/`).

| File | What | Who writes it |
|---|---|---|
| `tracker-data.json` | Static: all 48 features (F00-F25, W01-M07) with pillar/surface, deps, wave, gates, risk, modules, skills, `START_DATE`, per-wave duration estimates, and which S0-S11 sub-tasks apply to each feature. | Written once at package build; rarely changes. |
| `status/<ID>.json` | Live: one file per feature — `{ id, subtasks:{S0..S11}, overall, currentGate, blockedBy, owner, reviewer, updatedAt }`. | **Only the agent owning `<ID>`** — two agents never touch the same file. |
| `update_status.mjs` | Tiny, dependency-free Node script that atomically read-modify-writes ONE `status/<ID>.json` (temp file + rename). | Every builder/reviewer subagent, after finishing a sub-task or gate. |
| `generate_tracker.py` | openpyxl script: reads `tracker-data.json` + merges every `status/*.json` → writes the 3-sheet `.xlsx`. | Re-run any time; skips a malformed status file gracefully. |
| `APImeMCP-Radical-Tracker.xlsx` | The generated, styled tracker. Never hand-edited — it's fully derived. | Generated. |

## Setup

```
pip install openpyxl
```

(or `python -m pip install --user openpyxl` if a global install is blocked.)

## Updating your feature's status

```
node update_status.mjs <ID> <S#> <Todo|In-Prog|In-Review|Blocked|Done|N/A>
node update_status.mjs <ID> --overall <Not-started|In-Progress|Blocked|Done>
node update_status.mjs <ID> --gate <G0|G1|G2|G3|G3b|G4|G5|G6|G7|G8|null>
node update_status.mjs <ID> --blocked "<free text>"    # or --blocked null to clear
node update_status.mjs <ID> --owner <name>             # or --owner null to clear
node update_status.mjs <ID> --reviewer <name>
```

Flags combine in one call, e.g.:

```
node update_status.mjs F01 S6 Done --overall In-Progress --owner engine-builder-1
```

`<ID>` is the feature id (`F00`...`F25`, `W01`...`W08`, `X01`...`X07`,
`M01`...`M07`). `<S#>` is `S0`...`S11`. The script only ever touches
`status/<ID>.json` — safe for the whole fleet to call concurrently, one call
per feature at a time.

## Regenerating the spreadsheet

```
python generate_tracker.py
```

Run this after every sub-task/gate update (or periodically — the Docs/Tracker
role owns a periodic regenerate, but any agent may run it). It reads
`tracker-data.json` plus every file under `status/`, so it always reflects
whatever every feature-owning agent has written so far.

## The 3 sheets

1. **Feature Catalog** — one row per feature: ID/Name/Program/Surface/Pillar,
   description, value/why, tool-or-surface added, modules, skills, deps,
   wave, critical-path flag, the three gate flags, owner, risk. Colored by
   program/pillar/critical/risk/gate; frozen header + filter.
2. **Progress** — the heat-map: S0-S11 status cells colored by enum
   (grey=N/A, white=Todo, blue=In-Prog, amber=In-Review, red=Blocked,
   green=Done), a computed `% Complete` green data-bar (done non-N/A ÷ total
   non-N/A), current gate/blocked-by/owner/reviewer/overall, frozen header +
   frozen ID/Name/Program columns.
3. **Schedule-Deadlines** — wave bands, milestone dates relative to
   `START_DATE` (planned start through promote, derived from
   `waveDurationEstimatesDays`), a computed Status-vs-plan
   (Ahead/On-track/At-risk/Late) colored green/amber/red. While `START_DATE`
   is still the `"TBD-set-at-execution"` placeholder, dates read `TBD` and
   status defaults to `On-track`/`Late` from `overall` alone — set a real
   ISO date (`YYYY-MM-DD`) in `tracker-data.json`'s `START_DATE` once
   execution actually begins.

## Notes / known simplifications

- `subtasksApplicable` for S2 (storage/API-client) and S5 (wiring/route) was
  derived with a simple, documented rule (tied to whether the feature's
  listed modules include a persistence-ish module, and whether it adds a new
  tool/route) rather than hand-verified per the full 02a/02b spec prose.
  Hand-correct a feature's row in `tracker-data.json` if reality differs —
  it's a one-line edit, not a schema change.
- `generate_tracker.py` skips (with a stderr warning) any `status/*.json`
  that fails to parse, rendering that feature as if it were freshly seeded
  (all-Todo) rather than crashing the whole regenerate.
