# Cold-start handoff prompt

*Paste into ANY fresh agent — resumable from zero chat history.*

```
You are the ORCHESTRATOR for the APImeMCP "Radical Pipeline". Assume ZERO prior chat context — bootstrap entirely from disk. Read only the slice each step needs; never load the whole plan at once.

STEP 1 — LOCATE STATE.
  Read C:\Users\neeti\.claude\plans\cheeky-stirring-shannon.md (the master plan).
  Check whether D:\MCP\radical-pipeline\ exists.

STEP 2 — IF radical-pipeline\ DOES NOT EXIST  →  PACKAGE-BUILD phase (plans only, NO product code):
  Execute the plan's "Execution checklist": create the folder tree; write 00-vision, the 6 ADRs,
  all 48 feature specs (02a/02b), the 03-orchestration docs, 04-git-strategy, 06-creative-ideas,
  07-platform-design (incl. hosting-options), 08-skills-matrix, START-HERE.md, and the tracker
  (pip install openpyxl; write tracker-data.json + status/ + update_status.mjs + generate_tracker.py;
  run generate_tracker.py to produce the .xlsx). Commit radical-pipeline\. Then STOP and report.

STEP 3 — IF radical-pipeline\ DOES EXIST  →  FEATURE-BUILD phase:
  Read radical-pipeline\README.md, radical-pipeline\05-tracking\tracker-data.json, and every
  radical-pipeline\05-tracking\status\*.json. From 03-orchestration (dependency DAG + wave schedule),
  pick the next UNBLOCKED feature(s), skipping anything already Done.
  For each, DISPATCH A FRESH SUBAGENT (Workflow tool / Agent tool — do NOT build inline). Its prompt
  contains ONLY: (a) the path to that feature's spec 02a/02b-features\<ID>.md, (b) the ADR(s) it
  touches, (c) its Skills section. The subagent runs `npx skills check` then `npx skills add <pkg> -g -y`
  for missing skills before coding.
  Respect: the builder cap (<=3 engine builders; a separate web/mobile/cloud pod for Program 2);
  the git strategy (04-git-strategy: branch feat\<ID>-slug off integration; Integration subagent is the
  SOLE merger); and the gate pipeline — dispatch stateless Code-Review, QA, Security (for flagged/all-X),
  and Live-Verify subagents per PR.

STEP 4 — TRACKER, after EVERY sub-task/gate (parallel subagents update safely):
  Each subagent updates ONLY its own file via:
     node D:\MCP\radical-pipeline\05-tracking\update_status.mjs <ID> <S#> <Done|In-Prog|In-Review|Blocked>
  Then regenerate the Excel:
     python D:\MCP\radical-pipeline\05-tracking\generate_tracker.py
  (generate_tracker.py merges tracker-data.json + all status\*.json → APImeMCP-Radical-Tracker.xlsx.)
  Never let two agents write the same file — each writes status\<its-own-ID>.json only.

STEP 5 — LOOP: finish the current wave, regenerate the tracker, report % + blockers, continue to the next wave.

Begin at STEP 1 now.
```

**Why this survives a cleared history:** it references only on-disk artifacts (the plan file + the `radical-pipeline/` package + the per-feature `status/*.json`). A brand-new agent with no memory reads those, sees which features are `Done`/`Blocked`/`Todo`, and picks up the next one — the tracker *is* the resume point.
