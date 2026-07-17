# Radical Pipeline Orchestration Log

## 2026-07-17 — Program 1 / Wave 0

- Baseline on `master`: `npm run build` and `npm test` passed (25 tests).
- Preserved the generated tracker workbook on `master` in `c962013`.
- Created `integration`; added `.claude/worktrees/` isolation in `4241b5e`; claimed F00 in `e8f5741`.
- F00 implementation is in `.claude/worktrees/F00` on `feat/F00-app-connections-hardening`.
- G1 passed: `npm run build` and `npm test` passed (32 tests).
- Local G2/G3/G4 review passed after stateless review agents repeatedly stalled without verdicts.
- G6 failed: `scripts/verify-F00.mjs` invokes `requestSubmit()` while its fixture's required username is blank, so the login handler does not run and the persistence assertion times out.
- F00 is marked `Blocked` at G6. A fresh builder owns the focused verifier repair.
- G6 repair worker `019f6e48-6903-7082-97f5-3169ed9193f1` disappeared without a handoff after the interrupted turn; replacement required.
- Replacement G6 builder repaired the fixture submission, passed `node scripts/verify-F00.mjs`, `npm run build`, and `npm test`, updated F00 to G7, and committed `ecb0abe`.
- G7 passed: F00 rebased as `cecf7b6`, merged to `integration`, and tracker finalization committed as `5aca9a2`. Merge-result validation passed `npm run build` and `npm test` (64 tests).
- Promotion policy: eligible Program 1 features run in isolated worktrees and merge only to `integration`; `master` is held until the complete engine build is green.

## 2026-07-17 - Program 1 / Wave 1

- F01 builder completed `00af630` with its local checks green. G2 rejected it: its module-level Ajv validator cache is unbounded for reloaded schema objects, and registry imports drop `outputSchema`. A fresh F01 repair builder is required.
- F05 builder completed `d0454cc` with its local checks green. G2 rejected it: dry runs write metrics, the verifier does not detect that write, and an empty inline script can fall back to a registered template. A fresh F05 repair builder is required.
- F03 builder completed `213c869` with build, test, verifier, and package-dry-run checks green; it awaits independent gates.
- F22 launch was rejected by the multi-agent runtime's thread cap. It remains queued; no source or tracker state was changed by the failed launch.
- After F22 started, an F03 stateless-review launch was also rejected by the runtime thread cap. F03 has independently passed build, 37 tests, and `verify-F03`; it remains queued for its reviewer verdict.
- F03 local G2 review rejected `213c869`: `scripts/verify-registry.mjs` calls `executeExtraction` and measures duration itself instead of using the required in-process `runExtraction` path. That bypasses ADR-04's extraction measurement/metric contract and violates the explicit no-reimplementation requirement. A fresh F03 repair builder is queued.
- F01 post-repair G3 rejected `3b15327`: schema validation remains wired into `src/index.ts` rather than the engine boundary, contrary to ADR-02's composition-only rule for the entrypoint. A fresh F01 architecture-repair builder is queued.
- F03 re-review reported `npm run lint` unavailable. The repository has no lint script at baseline; per the governing G1 definition (`npm run build` plus `npm test`), this is recorded as a tooling gap rather than an F03 regression. Its repaired runner wiring uses exported `runExtraction` and the agreed G1/G2/G5/G6 checks pass.
- F14 G2 rejected `d860680`: unknown-template failures return before `executeMeasured`, so no JSONL SLA measurement exists and the calculated success rate is biased. A fresh F14 repair builder is required.
- F01 final G3 rejected `b4decfe`: while schema validation is now at the engine boundary, `src/index.ts` still owns extraction orchestration and inline tool handlers. This exposes the uncompleted ADR-02 Wave 0 boundary; a fresh F01 architecture-repair builder is required.
- F22 G2 rejected `9109a2d`: its discovery registration passes an inline dependency object instead of appending dependencies to the single shared `deps` object, violating ADR-02. A fresh F22 repair builder is required.
- Sequencing note: F05 and F03 merged before blocked F01, despite the DAG's preferred Wave 1 foundation order. Neither declares a hard F01 dependency and both merge-result gates passed; F01 remains the next required Wave 1 foundation before F14/F19 integration. F22 is Wave 2 and remains unmerged pending F02.
- F22 re-review rejected `b5053ec`: it repaired the shared dependency object but rewrote three existing registrations. ADR-02 requires the discovery registration to be the only appended call. A fresh narrow repair is queued; F22 remains held for Wave 2.
- F14's first repair still omitted unmatched-domain and no-input measures because their empty template IDs were invalid under the measure schema. Its second repair uses schema-valid synthetic IDs and awaits its final integration gate.
- F19 G2 rejected `c81d721`: wildcard allowlists were not fail-closed, the lint workflow could no-op, the full suite had a malformed-test syntax error, and the nightly token was job-wide during untrusted template execution. A fresh security repair is in progress.
- F01 integrated at `7b3d19f` with build and all F01/F03/F05 verifiers passing. Its root `npm test` was polluted by an unmerged F19 worktree test. The test command now excludes `.claude/worktrees/**`, preserving isolation between parallel feature branches and integration gates.
- F14 integrated at `e2065bc` after its repaired pre-execution measurements passed independent review and root build/test/F01/F14 verification.
- F19 final review rejected `fe5f0a4`: its workflow lints the registry default branch rather than incoming PR inputs (and would fail against the current legacy manifest), while `verify-F19` bypasses the shipped registry driver and its own fixtures/CLI/lint path. A fresh focused repair is required.
- Tracker correction: F03, F05, and F19 were merged and verified but retained pre-merge overall states because their G7 update omitted `--overall Done`. Their statuses and generated workbook are corrected together after the Wave 1 merge checkpoint.

## 2026-07-17 - Program 1 / Wave 1 Checkpoint

- F00, F01, F03, F05, F14, and F19 are merged to `integration`; the combined root build, test suite, feature verifiers, and F19 package dry-run are green. `master` remains unchanged.
- `npm test` excludes `.claude/worktrees/**` so isolated, unmerged feature tests cannot contaminate the integration gate.
- Program 1 tracker completion is 6/26 (23.1%). F22 has passed its independent review but remains unmerged until Wave 2's F02 foundation is integrated.

## 2026-07-17 - Program 1 / Wave 2 In Progress

- Fresh isolated builders own F02 (`feat/F02-drift-detection`), F10 (`feat/F10-transform-layer`), F16 (`feat/F16-result-cache`), and F23 (`feat/F23-golden-snapshots`).

## Agent Failures

- Multiple builders and reviewers stalled during `npx skills check` or read-only review despite no required F00 skill installation. Their uncommitted work was retained or their agent was closed before replacement.
- Future agents receive explicit worktree ownership, narrowed deliverables, and time-bounded handoffs. Any failure is added here and reported in chat immediately.
- F01 and F05 are blocked by recorded G2 defects, not by infrastructure. Their original reviewer agents returned explicit rejection verdicts and will be replaced by fresh repair builders.
- F22 could not start because the agent-runtime concurrency cap was occupied. The orchestrator is reclaiming completed agents before retrying it.
