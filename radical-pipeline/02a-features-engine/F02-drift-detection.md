# F02 — Drift detection

## 1. Summary

- **ID / Name:** F02 — Drift detection
- **Pillar:** A (reliability)
- **Wave:** 2
- **Risk:** M
- **Gates:** Lv only (G3 Arch, G3b Design, G4 Security all N/A for this feature — see §6)
- **Deps:** F01 (ADR-01 schema contract)

**What.** Every extraction run whose template declares an `outputSchema` (ADR-01) gets its live result shape compared against that contract, automatically, at the existing single instrumentation point in `runExtraction`. The comparison is itemized — which field was added, removed, or changed type — not just a pass/fail bit. F02 also factors this comparison into a **generic, reusable structural-diff primitive** (`diffJson`) that is not schema-specific, because F20 (change-monitoring mesh) needs the exact same machinery to diff *two results over time* rather than a result against a schema.

**Why (tied to 00-vision).** The vision's stated moat is "agent solves a site once, crystallizes the path into a template that runs in ms deterministically forever, **self-healing when the site changes**." Without a drift signal, that last clause is a lie: a crystallized template just keeps returning wrong or empty data silently once the target site changes, which is exactly how RPA (the ~$20B market this displaces) fails today. F02 is the sensor underneath that promise — it is the thing F04 (self-healing) reacts to, and the exact same primitive is what F20 → X05 (mobile monitors, the "killer feature" / consumer wedge: price drops, restocks, new filings) is built on. One diff primitive, two consumers, no duplicate logic.

## 2. User / agent story

As an agent or developer who has crystallized a template and lets it run unattended, I call `execute_native_extraction` the same way I always have. If the target site's markup/response shape has changed since the template's `outputSchema` was declared, I don't have to notice the drift myself by eyeballing bad output — the next time I check `get_extraction_stats` (a tool I already call) or the dashboard (a resource I already read), I see that this template has drifted, plus exactly which fields were added/removed/type-changed. That itemized report is precise enough to hand to a self-healing pass (F04) or to a change-monitor (F20) without re-discovering the break from scratch.

## 3. Design

### ADRs obeyed

- **ADR-01 (schema contract):** F02 is a pure *consumer* — it reads `ManifestEntry.outputSchema` (already added by F01) and never redefines or duplicates it. It does not touch `validateOutput`; it complements it (boolean valid/invalid vs. itemized diff). Per ADR-01's back-compat rule, absent `outputSchema` ⇒ drift check is skipped entirely, zero behavior change for older templates.
- **ADR-04 (metrics measure-model):** the drift check is bolted onto the *existing* single instrumentation point inside `runExtraction` — no second instrumentation point is added (that would violate the ADR-04 contract rule). Two optional fields are appended to the measure object already built there.
- **ADR-02 (tool-module convention): explicitly N/A.** ADR-02's own "depended on by" table lists every tool-adding feature (F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25, …) and **F02 is not among them**. This matches the catalog's Gates column (`Lv` only, no `Ar`) and F02's Modules column (`drift.ts, engine, metrics, dashboard` — no `index`, no `types`). F02 registers **no new MCP tool** and does not touch `index.ts`. Drift is surfaced entirely through the two tools/resources that already exist: `get_extraction_stats` (metrics aggregate) and the dashboard resource. Do not add a `check_drift`-style tool — that would be scope creep beyond this row.

### Data shapes — `D:/MCP/src/drift.ts` (NEW)

```ts
export type DriftKind = "field_added" | "field_removed" | "type_changed";

export interface DriftEntry {
  path: string;        // dot + "[i]" index path, e.g. "price", "items[0].sku"
  kind: DriftKind;
  expected?: string;   // schema-declared type ("string"|"number"|"integer"|"boolean"|"object"|"array"|"null"), or "present"/"missing" for pure presence drift
  actual?: string;     // observed typeof-derived type of the live value
}

export interface DriftReport {
  templateId: string;
  timestamp: string;   // new Date().toISOString()
  hasDrift: boolean;   // entries.length > 0
  entries: DriftEntry[];
}

// THE reusable primitive. Pure, no IO, never throws. Generic structural diff
// between two JSON-like values — object keys deep-diffed by key; arrays
// diffed index-by-index up to min(length); extra elements on either side
// report as field_added/field_removed at "[i]".
// ponytail: naive index-based array diff — order-shifted arrays produce
// spurious entries. F20 wraps this for "value changed over time"; if it
// needs order-insensitive array comparison, that's F20's wrapper to add,
// not a change to this primitive.
export function diffJson(before: unknown, after: unknown, basePath?: string): DriftEntry[];

// F02-specific: diff a live sample's *shape* against a declared JSON Schema
// (ManifestEntry.outputSchema). Walks schema.properties/required/items vs
// the sample's own keys/types. Does not reuse diffJson's value-vs-value walk
// (a schema node describes a type, not a value) but returns the same
// DriftEntry shape so downstream consumers (dashboard, F04) don't branch.
export function diffAgainstSchema(schema: Record<string, any>, sample: unknown): DriftEntry[];

// Stamps templateId/timestamp/hasDrift around diffAgainstSchema's entries.
export function checkDrift(templateId: string, schema: Record<string, any>, sample: unknown): DriftReport;
```

Both `diffJson` and `diffAgainstSchema` are pure and total (never throw), mirroring the purity contract ADR-01 sets for `validateOutput` — this is what lets F04 call them in a hot self-heal loop and keeps them trivially unit-testable.

### Module-by-module changes (exact paths)

- **`D:/MCP/src/drift.ts` (NEW).** `DriftKind`, `DriftEntry`, `DriftReport`, `diffJson`, `diffAgainstSchema`, `checkDrift` — all as above. No IO, no lookups (takes `schema`/`sample` as plain args; caller resolves the manifest entry). No `registerXxxTool` export — see ADR-02 note above.
- **`D:/MCP/src/engine.ts`.** Inside `runExtraction`, immediately after the existing ADR-01 `validateOutput(result.data, manifestEntry.outputSchema)` call, at the *same* ADR-04 instrumentation point:
  ```ts
  const drift = manifestEntry.outputSchema
    ? checkDrift(manifestEntry.templateId, manifestEntry.outputSchema, result.data)
    : undefined;
  metrics.recordMeasure({
    templateId, kind, success, durationMs, timestamp, error,
    driftDetected: drift?.hasDrift,     // NEW optional field
    driftEntryCount: drift?.entries.length, // NEW optional field
  });
  ```
  No second instrumentation point; no change to `ExtractionResult`'s shape (that would require touching `types.ts`, which is not in F02's Modules column).
- **`D:/MCP/src/metrics.ts`.** Extend the per-template aggregate that F14 (Metrics 2.0, wave 1) already builds from the ADR-04 measure stream with two more rollup fields: `driftCount` (increment whenever `driftDetected === true`) and `lastDriftAt` (timestamp of the most recent `true`). Reuses F14's existing aggregation store — no new persistence format.
- **`D:/MCP/src/dashboard.ts`.** Extend the existing per-template render/summary (already iterating templates for success-rate/latency) with `driftCount` / `lastDriftAt` next to those stats.
- **`index.ts`, `types.ts`, `storage.ts` — untouched by F02.** No new tool, no new shared type, no new stored file.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable (scoped) | `DriftKind`/`DriftEntry`/`DriftReport` live entirely in `drift.ts`, not `types.ts`. |
| S2 Storage | **N/A** | No new storage schema/file; drift counters ride on F14's existing `metrics.ts` aggregate. |
| S3 Core | Applicable | `diffJson`, `diffAgainstSchema`, `checkDrift` pure logic in `drift.ts`. |
| S4 Module | Applicable | `drift.ts` is the new module. |
| S5 Wiring | Applicable (scoped) | `engine.ts` call-site + `metrics.ts` aggregate fields + `dashboard.ts` render fields. **No `index.ts` append, no new tool** (confirmed N/A — see §3 ADR-02 note). |
| S6 Unit | Applicable | `src/drift.test.ts`. |
| S7 Verify | Applicable | Engine-touching → `scripts/verify-F02.mjs` + fixture pair. |
| S8 Docs | Applicable | One-paragraph README/SKILL note: `get_extraction_stats`/dashboard now carry drift fields; no new tool to document. |
| S9 Review | Applicable | G2 code review. |
| S10 Live | Applicable | G6 (catalog marks `Lv`). |
| S11 Merge | Applicable | G7. |

## 5. Dependencies & sequencing

- **Hard dep:** F01 (wave 1) — must be merged to `integration` first; F02 reads `ManifestEntry.outputSchema` and never redefines it.
- **Practical ordering note (not a formal blocking dep):** F14 "Metrics 2.0" (wave 1) establishes the per-template aggregate F02 extends. Land after F14 if possible; if F14 hasn't merged yet, F02's `metrics.ts` change creates the minimal two-field aggregate itself and F14 later folds into it (still additive, no conflict).
- **Wave:** 2.
- **Unblocks:** F04 (self-healing, wave 3 — triggers on `DriftReport.hasDrift`, includes the report in its forensic bundle handed to the calling agent), F20 (change-monitoring mesh, wave 4 — imports `diffJson` directly to compare successive run results over time). Transitively unblocks X05 (monitors service, cloud — the mobile push-on-change "killer feature").
- **Conflict surface:** low. `engine.ts` change is a few additive lines right after the existing ADR-01 call; no `index.ts` touch at all (ADR-02 N/A), so F02 doesn't contend with sibling feature branches on the wiring file.

## 6. Quality gates

Required: **G0 Spec, G1 Build, G2 Code-Review, G5 QA, G6 Live-Verify, G7 Integration, G8 Promote** (at wave-2 promote).
Skipped: **G3 Arch** (no boundary/module-convention change — `drift.ts` is self-contained, ADR-02 confirms no tool added), **G3b Design** (no UI/screen), **G4 Security** (no untrusted input, no secrets, no sandbox/allowlist touched — operates on data already past extraction/validation).

**Definition of Done:**
1. `drift.ts` exports `diffJson`/`diffAgainstSchema`/`checkDrift`, 100% pure/total (no throw, no IO), fully unit-tested.
2. `engine.ts` computes drift exactly once per run, only when `outputSchema` is present, at the existing ADR-04 instrumentation point — zero behavior change for schema-less templates.
3. `metrics.ts` + `dashboard.ts` surface `driftCount`/`lastDriftAt` per template through the *existing* `get_extraction_stats` tool and dashboard resource — no new tool registered.
4. `scripts/verify-F02.mjs` passes live against a real fixture pair (matching + drifted).

## 7. Test plan

**`src/drift.test.ts` (Vitest, browser-free):**
1. `diffJson(a, a)` → `[]`.
2. `diffJson({x:1}, {x:1,y:2})` → one `field_added` entry at path `"y"`, `actual:"number"`.
3. `diffJson({x:1,y:2}, {x:1})` → one `field_removed` entry at path `"y"`, `expected:"number"`.
4. `diffJson({x:"a"}, {x:1})` → one `type_changed` entry at path `"x"`, `expected:"string"`, `actual:"number"`.
5. `diffJson` on `{items:[{sku:"a"}]}` vs `{items:[{sku:1}]}` → path `"items[0].sku"`, `type_changed`.
6. `diffAgainstSchema(schema, sample)` where sample matches exactly → `[]`.
7. `diffAgainstSchema` — sample has an extra top-level key not in `schema.properties` → `field_added`.
8. `diffAgainstSchema` — sample missing a `schema.required` key → `field_removed`.
9. `diffAgainstSchema` — sample field's `typeof` mismatches `schema.properties[k].type` → `type_changed`.
10. `checkDrift(id, schema, sample)` → stamps `templateId`/ISO `timestamp`, `hasDrift === entries.length > 0`, entries pass through unchanged.
11. `checkDrift` with a fully-matching sample → `hasDrift === false`.

**`scripts/verify-F02.mjs` + fixtures** (engine-touching, real Playwright, mirrors the repo's existing `verify-*.mjs` + fixture convention):
- Fixtures: `scripts/fixtures/f02-drift/page-v1.html` (matches a registered `outputSchema`) and `scripts/fixtures/f02-drift/page-v2.html` (one field renamed + one field's type changed — a realistic "site redesign").
- Run `execute_native_extraction` against `page-v1.html` → assert `get_extraction_stats` shows `driftCount` unchanged.
- Run `execute_native_extraction` against `page-v2.html` (same template, mutated fixture) → assert `get_extraction_stats.driftCount >= 1` and `lastDriftAt` set; assert the dashboard resource's rendered output includes the drift indicator for that template.
- Run against a template registered with **no** `outputSchema` → assert it completes unchanged, no drift fields populated (back-compat).

## 8. Acceptance criteria

1. `npm run build` clean; `npx vitest run src/drift.test.ts` — all green.
2. `node scripts/verify-F02.mjs` exits 0, printing a clear PASS line for: (a) matching fixture → no drift, (b) drifted fixture → itemized entries with correct `kind`/`path`, (c) schema-less template → unaffected.
3. After the drifted fixture run, the **existing, unmodified** `get_extraction_stats` tool call for that `templateId` returns `driftCount >= 1` and a `lastDriftAt` ISO timestamp.
4. The existing dashboard resource visibly renders the drift indicator for that template.
5. `listTools()` shows **no new tool** — proof F02 stayed inside its Modules-column scope (no ADR-02 surface added).

## 9. Reuse notes

- **`validateOutput`** (ADR-01/F01) — reused unchanged for the boolean valid/invalid gate; `checkDrift` is a complementary, more detailed sibling, not a replacement or a duplicate schema walk.
- **F14's existing `metrics.ts` per-template aggregate** — extended with two fields, not rebuilt; no parallel metrics store.
- **ADR-04's single instrumentation point** in `runExtraction` — drift check is bolted onto that exact point; adding a second one is the specific failure mode this reuse note exists to prevent.
- **`findTemplateByUrl` / manifest lookup** (existing, `storage.ts`) — engine.ts uses it unchanged to obtain `manifestEntry.outputSchema`; `drift.ts` itself does no lookup/IO (kept pure, mirrors ADR-01's purity contract).
- **Explicitly NOT touched:** `atomicWriteFile`, `withLock` (no new storage file — S2 is N/A), `registerTemplate` (no new registration flow), `buildStandaloneScript` (F05/F06/F25 territory, out of scope here), `captureForensics` (F04's job — F02 only needs to emit a plain-JSON `DriftReport` that F04 can attach to its own forensic bundle later; F02 does not call `captureForensics` itself).

## 10. Skills (setup + when-to-use)

No external skill install needed — F02 is pure logic + additive wiring, fully covered by what's already available per `08-skills-matrix.md`:

- **`.agents/skills/test-driven-development`** (already available, no install) — guides S3/S6: write the `drift.test.ts` cases in §7 alongside `diffJson`/`diffAgainstSchema`, not after.
- **`.agents/skills/code-simplification`** (already available) — guides S9 review: keep the diff kinds to exactly `field_added`/`field_removed`/`type_changed`; resist adding speculative kinds (e.g. "value_changed" at the schema level) that F02's row doesn't ask for — F20 owns value-level diffing via `diffJson` directly.
- **`.agents/skills/browser-testing-with-devtools`** (already available) — guides S7: driving `scripts/verify-F02.mjs`'s live Playwright fixture run.
- **`context7-mcp` fallback** — no ≥1K-install reputable "JSON-Schema diff" skill exists in the matrix (only Cloudflare/serverless-Chromium/Playwright community skills were checked and rejected for other features on installs alone); pull current JSON Schema (`type`/`properties`/`required`/`items` — whichever draft F01 picked) and Zod docs live via `context7-mcp` while implementing `diffAgainstSchema`, rather than hand-rolling from stale recollection. Guides S1/S3.
