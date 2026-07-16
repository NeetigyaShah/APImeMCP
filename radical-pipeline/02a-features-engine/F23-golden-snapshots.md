# F23 — Golden-snapshot regression

## 1. Summary

- **ID / Name:** F23 · Golden-snapshot regression
- **Pillar:** F (creative) · **Wave:** 2 · **Risk:** L · **Gates:** Lv (only — no Ar, no Se, no Design)
- **What:** Give any registered template a per-template "known-good" reference output (a golden snapshot) that an agent or CI can record once and compare future runs against, flagging *value-level* regressions — not just shape drift.
- **Why (tied to 00-vision):** 00-vision names QA/E2E ("the Kriya origin") as one of the target markets, and frames the moat as "determinism vs computer-use" — a crystallized template is only trustworthy in CI/production if you can *prove* its output hasn't silently regressed between runs. F23 is that proof primitive: it turns "the template still passes" into an observable, storable fact instead of a one-off manual eyeball check.
- **Distinct from F02 (drift detection):** F02 diffs a live result's *shape* against the declared `outputSchema` (ADR-01) — a structural/type contract, pillar A, systemic. F23 diffs a live result's *values* against one specific previously-approved example — an opt-in snapshot test per template, pillar F. Both can flag the same broken page, but F23 also catches "the shape is still valid JSON but the values are now garbage" (e.g. every price field silently became `0`), which F02 cannot see. F23 does **not** depend on or reuse F02's `drift.ts` — F02 and F23 are both Wave 2 (parallel lanes, no ordering guarantee between them), so F23 ships its own minimal diff primitive (see §9).

## 2. Story

- **As an agent** that just crystallized or self-healed a template, I call `execute_native_extraction` with `snapshot: "record"` once I'm satisfied the output is correct, so there's now a durable "this is what good looks like" reference I (or another agent) can check against later without re-reading the whole output by eye.
- **As an agent (or the nightly job) re-running an existing template**, I call `execute_native_extraction` with `snapshot: "check"` and get back a `snapshotCheck` verdict (`match` / `regression` / `no-baseline`) with a path-level diff when something changed — so I can decide "still fine" vs "needs a human/self-heal look" without diffing raw JSON myself.
- **As a normal caller who never passes `snapshot`,** nothing changes — the tool behaves exactly as before F23 shipped.

## 3. Design

### ADR(s) obeyed
- **ADR-01 (schema contract):** `saveSnapshot` optionally calls the existing pure `validateOutput(value, schema)` when the template has an `outputSchema`, and stamps the boolean result onto the golden record. F23 never *adds* a required schema — absent `outputSchema` just means the stamp is skipped, matching ADR-01's own "absent = skip" precedent.
- **ADR-02 (tool-module convention):** F23 adds **no new MCP tool** (confirmed: F23 is not in ADR-02's "which features depend on it" table). It extends the *existing* `execute_native_extraction` tool's own input shape and handler body — a change owned entirely inside that tool's `registerXxxTool` module, not a cross-wiring of an unrelated tool into someone else's block, so it doesn't trip ADR-02's "no feature adds tool wiring by editing another tool's block" rule. `index.ts` itself is untouched by F23 (no new append line, since there's no new tool).
- **ADR-04 (metrics measure-model):** untouched. F23 does not add a field to the `{templateId,kind,success,durationMs,timestamp,error?}` measure — snapshot results are reported back to the *caller* directly in the tool response, not through the metrics pipe, keeping ADR-04's shape stable.
- **Why not touch `types.ts`:** the catalog's own Gates column for F23 is `Lv` only — no `Ar` — so this spec deliberately keeps `ManifestEntry`/`ExtractionResult` in `src/types.ts` untouched. All new shapes live in the new module below. That's what keeps this feature out of the Architect boundary-review path.

### Data shapes — `src/snapshot.ts` (NEW module)

```ts
import { z } from "zod";

export const SnapshotModeSchema = z.enum(["off", "record", "check"]);
export type SnapshotMode = z.infer<typeof SnapshotModeSchema>; // default "off"

export interface GoldenSnapshot {
  templateId: string;
  capturedAt: string;        // ISO timestamp
  targetUrl?: string;
  outputHash: string;        // sha256 hex of stableStringify(data) — cheap identity fingerprint
  data: unknown;             // the recorded known-good ExtractionResult.data
  schemaValid?: boolean;     // ADR-01 validateOutput(data, outputSchema) at capture time, if outputSchema was present
}

export interface SnapshotDiffEntry {
  path: string;              // e.g. "items[3].price", or "$" for a whole-value/type mismatch at the root
  expected?: unknown;        // omitted (not undefined-valued) if the key/index didn't exist in the golden
  actual?: unknown;          // omitted if the key/index doesn't exist in the live output
}

export type SnapshotComparison =
  | { status: "no-baseline"; templateId: string }
  | { status: "match"; templateId: string }
  | { status: "regression"; templateId: string; diff: SnapshotDiffEntry[] };
```

Functions (all in `src/snapshot.ts`):
- `snapshotPath(templateId: string): string` → `path.join("templates", "snapshots", \`${templateId}.json\`)` — mirrors the existing local, gitignored `templates/saved-cookies.json` convention (instance-local state, not part of the shared registry).
- `stableStringify(value: unknown): string` — recursively sorts object keys (arrays keep index order, since order is semantically meaningful there) before `JSON.stringify`, so key-order nondeterminism from extraction never produces a false "regression".
- `diffValues(expected: unknown, actual: unknown, path = "$"): SnapshotDiffEntry[]` — **pure, total, never throws.** Recursive structural walk: primitives compared with `===` (NaN-safe); objects compared over the union of both sides' keys; arrays compared index-by-index over the longer length. Returns `[]` when equal.
- `saveSnapshot(templateId, data, opts?: { targetUrl?: string; outputSchema?: unknown }): Promise<GoldenSnapshot>` — builds the record (calls ADR-01's `validateOutput` iff `opts.outputSchema` given), writes it via `atomicWriteFile` (reuse, see §9) guarded by `withLock(snapshotPath(templateId), …)` (reuse, see §9) so two concurrent `record` calls for the same template can't corrupt the file.
- `loadSnapshot(templateId): Promise<GoldenSnapshot | null>` — reads the file; returns `null` (not a throw) on ENOENT — same "absent = skip, total, never throws" contract ADR-01 sets for `validateOutput`.
- `compareSnapshot(templateId, liveData): Promise<SnapshotComparison>` — `loadSnapshot`; `null` → `{status:"no-baseline"}`; else fast-path `stableStringify` equality → `{status:"match"}`; else `diffValues` → `{status:"regression", diff}`.

### Module-by-module changes (exact paths)

1. **`src/snapshot.ts`** (NEW) — everything above. No IO in `diffValues`/`stableStringify` (unit-testable with zero mocking); IO isolated to `saveSnapshot`/`loadSnapshot`.
2. **`src/engine.ts`** (EXISTING — the function ADR-04 names as the single instrumentation point, `runExtraction`) — after `data` is produced (and after any existing ADR-01 validation), add one opt-in branch keyed off a new optional param on the existing call, e.g. `runExtraction(entry, ctx, { snapshotMode })`:
   ```ts
   if (snapshotMode === "record") {
     result.snapshotRecorded = await saveSnapshot(entry.id, data, { targetUrl, outputSchema: entry.outputSchema });
   } else if (snapshotMode === "check") {
     result.snapshotCheck = await compareSnapshot(entry.id, data);
   }
   // snapshotMode undefined/"off" (default): zero-cost, zero behavior change
   ```
3. **`execute_native_extraction`'s tool module** — post-F00/F01 ADR-02 retrofit, this tool lives in its own `registerXxxTool` module (exact filename is F01's to land, e.g. `src/tools/execute-native-extraction-tool.ts` exporting `registerExecuteNativeExtractionTool(server, deps)` — confirm against whatever F01 actually names it). F23 adds one optional key to that tool's existing zod input shape:
   ```ts
   snapshot: SnapshotModeSchema.optional().default("off")
   ```
   and passes it through to `deps.engine.runExtraction(..., { snapshotMode: input.snapshot })`; the handler surfaces `result.snapshotRecorded` / `result.snapshotCheck` in the tool's returned content when present, and neither key when `snapshot` is omitted (default `"off"`) — full back-compat for every existing caller.
4. **`src/index.ts`** — **untouched by F23.** No new `registerXxxTool` append, because F23 registers no new tool (see ADR-02 note above).
5. **`.gitignore`** (EXISTING) — add `templates/snapshots/` alongside the existing `templates/saved-cookies.json` ignore, so recorded golden output (which may embed scraped, possibly session-specific page content) never lands in git, consistent with real cookies staying local today.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `SnapshotMode`, `GoldenSnapshot`, `SnapshotDiffEntry`, `SnapshotComparison` in `src/snapshot.ts` — deliberately **not** in `types.ts` (keeps out of G3 Arch scope). |
| S2 Storage | Applicable | `snapshotPath`, `saveSnapshot`, `loadSnapshot` — file IO under `templates/snapshots/`, atomic + locked writes. |
| S3 Core | Applicable | `stableStringify`, `diffValues`, `compareSnapshot` — pure, total, hand-rolled (no new dependency; see §9). |
| S4 Module | Applicable | Assemble `src/snapshot.ts` as one cohesive new module. |
| S5 Wiring | Applicable | `engine.ts` `runExtraction` opt-in branch; `execute_native_extraction`'s tool module gains the optional `snapshot` input key. `index.ts` gets no new line (no new tool). |
| S6 Unit tests | Applicable | `src/snapshot.test.ts` (Vitest, browser-free) — see §7. |
| S7 Verify script | Applicable | Gates include `Lv` → `scripts/verify-F23.mjs` + fixture, real Playwright. |
| S8 Docs | Applicable | One-paragraph mention in README's tool list + `SKILL.md` (the `snapshot` param on `execute_native_extraction`). |
| S9 Review (G2) | Applicable | Standard code-review; specifically check `diffValues` stays pure/total and no new dependency was smuggled in for what §9 says is a ~30-line function. |
| S10 Live-verify (G6) | Applicable | `scripts/verify-F23.mjs` against a real local fixture, real Playwright, real file writes. |
| S11 Merge (G7) | Applicable | Rebase onto `integration` **after F01 is merged** (hard dep, see §5). |

## 5. Dependencies & sequencing

- **Hard dep: F01 (schema contracts).** Two reasons: (a) `saveSnapshot` optionally calls ADR-01's `validateOutput`/reads `entry.outputSchema`, both of which F01 introduces; (b) F01 performs the ADR-02 retrofit that moves `execute_native_extraction` out of inline `index.ts` into its own `registerXxxTool` module — F23 needs that module to already exist before it can cleanly add the `snapshot` input key (editing raw inline `index.ts` instead would contradict ADR-02). F23's branch should fork **after** F00 and F01 are both merged to `integration`, avoiding a three-way conflict in `engine.ts` (F00 already touches `runExtraction`'s neighborhood fixing the engine↔app-connections erosion; F01 wires in schema validation; F23 adds the snapshot branch after both land).
- **What F23 unblocks:** nothing in the catalog lists F23 as a dependency — it's a leaf capability. It's a natural (optional, not required) complement to F04 (self-healing: could call `compareSnapshot` as an extra post-fix signal) and F03/F19 (nightly re-verification/CI lint: could pass `snapshot:"check"` for an extra regression signal on scheduled runs) — neither is wired by this spec; that's a future integration note, not a blocking dependency.
- **Wave:** 2, parallel with F02, F10, F16, F22. No intra-wave file collision expected: F23 is the only Wave-2 feature touching `execute_native_extraction`'s tool module per each feature's own Modules column.

## 6. Quality gates

- **G0 Spec / G1 Build / G2 Code-Review / G5 QA / G7 Integration:** all apply (baseline pipeline).
- **G3 Arch:** **not required** — catalog Gates = `Lv` only, no `Ar`; confirmed by design choice to leave `types.ts` untouched.
- **G3b Design, G4 Security:** N/A — no UI; no new attack surface (local file read/write under the existing `templates/` convention, single-operator self-host engine, no cross-user data).
- **G6 Live-Verify:** **required** (`Lv` flag) — `scripts/verify-F23.mjs` with real Playwright against a real fixture.
- **Definition of Done:**
  1. `src/snapshot.ts` lands with all functions in §3, unit-tested, `diffValues`/`stableStringify`/`compareSnapshot`'s `no-baseline` path pure/total/never-throw.
  2. `execute_native_extraction` gains the optional `snapshot` key (default `"off"`); omitting it is byte-identical to pre-F23 behavior.
  3. `scripts/verify-F23.mjs` passes end-to-end: record → match → mutate fixture → regression (with a correct diff path) → re-record → match again.
  4. No diff in `src/types.ts`'s `ManifestEntry`/`ExtractionResult` shapes.
  5. `templates/snapshots/` is gitignored.
  6. `npm run build && npm test` green; CI verify workflow green.

## 7. Test plan

`src/snapshot.test.ts` (Vitest, browser-free):
1. `saveSnapshot` → `loadSnapshot` round-trips a `GoldenSnapshot` with the expected shape and a stable `outputHash`.
2. `loadSnapshot` returns `null` (not a throw) for a `templateId` with no snapshot file yet.
3. `diffValues(x, x)` → `[]` for deep-equal objects/arrays regardless of key insertion order.
4. `diffValues` reports a single path-labeled entry for one changed leaf (e.g. `items[1].price`).
5. `diffValues` reports added/removed object keys and added/removed array elements, omitting the missing side's `expected`/`actual` key entirely (not `undefined`-valued).
6. `compareSnapshot` → `{status:"no-baseline"}` when nothing was ever recorded.
7. `compareSnapshot` → `{status:"match"}` when live data's `stableStringify` equals the stored snapshot (hash fast-path, no diff walk needed).
8. `compareSnapshot` → `{status:"regression", diff:[...]}` with a non-empty diff when values changed.
9. `execute_native_extraction` handler with `snapshot:"record"` calls `saveSnapshot` exactly once and returns `snapshotRecorded`; does not call `compareSnapshot`.
10. `execute_native_extraction` handler with `snapshot:"off"` (or omitted) calls neither function and returns neither `snapshotRecorded` nor `snapshotCheck` — proves zero back-compat regression.

`scripts/verify-F23.mjs` + fixture (engine/browser-touching → Lv gate):
- Fixture: `scripts/fixtures/f23-snapshot.html` (a small static local page) and a mutated variant `f23-snapshot-v2.html` (one visible field changed, e.g. a price), served locally so the run is deterministic and offline.
- Steps: register a template against the fixture → `execute_native_extraction({snapshot:"record"})` → assert `templates/snapshots/<id>.json` now exists with the expected shape → run again unchanged with `snapshot:"check"` → assert `status:"match"` → swap in the `-v2` fixture → run with `snapshot:"check"` → assert `status:"regression"` and the diff's `path` names the changed field → re-record → assert `status:"match"` again. Prints `PASS`/`FAIL` per step, exits non-zero on any failure (same convention as the other `verify-*.mjs` scripts).

## 8. Acceptance criteria (live, observable proof)

- `node scripts/verify-F23.mjs` exits `0` and prints a `PASS` line for each of: record, match, regression-detected (with a named diff path), re-record-match, and off-mode-no-op.
- After a `record` call, `templates/snapshots/<templateId>.json` is a real file on disk containing `{templateId, capturedAt, outputHash, data, ...}`.
- Calling `execute_native_extraction` with `snapshot` omitted produces a response with no `snapshotRecorded`/`snapshotCheck` key at all — identical to pre-F23 output for the same input.
- `npm run build` and `npm test` are green; the repo's `verify.yml` CI workflow is green on the feature branch.

## 9. Reuse notes

- **`atomicWriteFile`** (`src/storage.ts`) — reused as-is for writing the golden snapshot JSON; no new write-primitive invented.
- **`withLock`** (`src/lock.ts`, the existing in-proc mutex) — guards `saveSnapshot` against a concurrent `record` race on the same `templateId`.
- **`validateOutput`** (ADR-01, `src/types.ts`/`src/schema.ts` per F01) — called once at record time, only if `entry.outputSchema` is present; F23 never requires a schema to exist.
- **Deliberately NOT reused: F02's `drift.ts`.** F02 and F23 are both Wave 2, parallel lanes with no ordering guarantee — F23 cannot depend on a sibling feature that might not have merged yet. Its own `diffValues` is intentionally small and self-contained; if F02 lands first in practice, a later cleanup could unify the two diff primitives, but that's a follow-up, not a requirement here.
- **No new npm dependency.** A structural, path-reporting diff over plain JSON-shaped values (objects/arrays/primitives) is a ~30-line recursive function — smaller than the footprint of pulling in a diff library (e.g. `deep-diff`/`microdiff`) for something this narrow. Hashing uses Node's built-in `crypto` (stdlib), not a new package.
- **`templates/` local-storage convention** — `templates/snapshots/` sits next to the existing gitignored `templates/saved-cookies.json`, reusing the same "instance-local, not part of the shared registry" pattern rather than inventing a new top-level directory.
- Explicitly **not** the same concept as the `06-creative-ideas.md` "Time-travel snapshots" idea (persisting DOM history for offline replay) — F23 keeps exactly one current golden reference per template, not a timeline; that idea remains unscheduled/out of scope here.

## 10. Skills (setup + when-to-use)

- No new external library or SDK is introduced (Node `crypto` is stdlib; `zod` is already a project dependency) — there is no vendor API surface here to look up, so the `context7` fallback the skill-quality bar calls for isn't needed either; this feature's work is plain TypeScript algorithm/file-IO code.
- **Already-available, no install:** the `.agents/skills/` discipline skills, applied as:
  - `test-driven-development` — guides S6 (write `snapshot.test.ts` cases in §7 before/alongside `diffValues`/`compareSnapshot`).
  - `code-simplification` — guides S9/G2 review, specifically to push back on any temptation to pull in a diff/deep-equal dependency for what §9 establishes is a small hand-rolled function.
  - `spec-driven-development` — guides S0 (this document) and keeping the implementation inside its stated boundary (no `types.ts` edits).
  - `incremental-implementation` — guides S4/S5, landing `snapshot.ts` first (fully unit-tested in isolation) before wiring it into `engine.ts`/the tool module.
- **`using-apimemcp`** (already available) — reference for how `execute_native_extraction` is normally called, so the new `snapshot` param's UX matches existing tool-call conventions.
