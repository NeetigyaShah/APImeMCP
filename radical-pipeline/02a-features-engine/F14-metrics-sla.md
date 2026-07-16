# F14 — Metrics 2.0 (SLA)

## 1. Summary

- **ID / Name:** F14 — Metrics 2.0 (SLA)
- **Pillar:** E (distribution + performance)
- **Wave:** 1 (parallel with F01, F03, F05, F19)
- **Risk:** L (low)
- **Gates:** QA only (no Ar / Se / Lv)

**What.** Turn the ADR-04 uniform measure record into a queryable SLA model — per-template success-rate, avg/p50/p95 latency, last-run-at, last-error — replacing today's narrow `{timestamp,templateId,url,imageCount}` CSV row and the two ad-hoc `logExtractionMetric` call sites in `src/index.ts` with the single ADR-04 instrumentation point.

**Why / market angle.** 00-vision's moat claim is "solve once, run deterministically forever, self-heal when it breaks" — that claim is only credible if someone can *see* success-rate and latency over time. F14 is the quantitative backbone under three later payoffs: the registry "ledger" verification badges (00-vision, consumed by W03), F24's contributor/template reputation scoring, and X05's cloud monitor "changed / healthy" decision. It is Wave 1 and "QA only" precisely because it adds no new external surface — pure aggregation over data already captured (`ExtractionMeta.durationMs`/`timestamp` exist today; they're just not stored in a queryable shape).

## 2. Story

- As a builder agent maintaining templates, I want a template's success-rate and latency trend surfaced via one tool call, so I can tell whether it needs F04 self-healing before a cloud monitor (X05) or a consumer run fails on it.
- As the registry/dashboard consumer (W03 badges, F24 reputation), I want `get_extraction_stats` to return real success-rate + p95 latency per template, so trust signals are computed from data, not vibes.

## 3. Design

**ADRs obeyed.** ADR-04 (owns this feature — ADR-04 is Accepted, Phase 0). Respects ADR-01 (pure shapes live in `types.ts`, no IO) and ADR-02 (no new tool registration — the existing metrics tool's handler body changes, `index.ts` gets no new append).

**Data shapes — `src/types.ts` (new, pure, no IO):**

```ts
export type RunKind = "extraction" | "action-sequence" | "static-http";
// static-http is F15's future kind (Wave 3); ADR-04 names it explicitly so this
// union doesn't need a second edit when F15 lands — forward-declared now.

export interface MeasureRecord {
  templateId: string;
  kind: RunKind;
  success: boolean;
  durationMs: number;
  timestamp: string;   // ISO 8601
  error?: string;       // set iff success === false
}

export interface TemplateSla {
  templateId: string;
  runs: number;
  successCount: number;
  successRate: number;      // successCount / runs, 0..1
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  lastRunAt: string;
  lastError?: string;       // error of the most recent failing run
}
```

A `MeasureRecordSchema` zod mirror lives alongside for `metrics.ts` to validate before append (cheap, matches the ADR-01 validate-on-write pattern already used for schema contracts).

**Module-by-module changes (exact paths):**

- **`src/metrics.ts`** (modify, existing module) — Replace the current `logExtractionMetric({timestamp,templateId,url,imageCount})` CSV writer with:
  - `recordMeasure(record: MeasureRecord): void` — validates via `MeasureRecordSchema`, appends one JSON line to `templates/extraction_metrics.jsonl` (JSON Lines chosen over extending the CSV columns — trivial to aggregate, trivial to append, no header-migration problem).
  - `getTemplateSla(templateId: string): TemplateSla | undefined` and `getAllSla(): TemplateSla[]` — pure aggregation over the stored records; percentiles via a small local nearest-rank helper on a sorted copy of durations (no new dependency for two percentiles over small in-memory arrays).
  - `migrateLegacyCsvIfPresent(): void` — one-time best-effort import: old `templates/extraction_metrics.csv` rows become `MeasureRecord`s with `success: true, kind: "extraction"`, `durationMs` defaulted to `0` (documented: legacy rows never measured duration) and are written to the new jsonl; guarded so a second call is a no-op (check a sentinel or that the jsonl already has rows predating the CSV's last mtime). F14's explicit decision, per ADR-04's "F14 decides": **migrate, don't drop** — history is cheap to keep and F24 reputation wants it later.
- **`src/engine.ts`** (modify) — the single ADR-04 instrumentation point: wherever the extraction path assembles the result (the function that builds `ExtractionMeta`/`ExtractionResult`), call `recordMeasure({templateId, kind, success, durationMs, timestamp, error})` exactly once, on both the success return and the catch/failure path. This is the "replace two ad-hoc call sites with one" move ADR-04 mandates.
- **`src/index.ts`** (modify) — delete the two existing `logExtractionMetric(...)` call sites (one passing `imageCount: 0`, one the real count — both gone, superseded by the engine-side single point). The `get_extraction_stats` tool handler (already registered by an existing `registerMetricsTool`-style module per ADR-02 — **no new registration**) changes its body to call `getAllSla()` instead of the old imageCount-based stats reader.
- **`src/dashboard.ts`** (modify) — swap whatever currently reads the CSV/old stats shape for `getAllSla()`; add success-rate% and p95 latency columns per template row. No new screen/route.

**Tool signature — unchanged registration, changed body (ADR-02 compliant):**

```ts
// registration already exists (registerMetricsTool(server, deps)); F14 touches only the handler body
get_extraction_stats(): { templates: TemplateSla[] }
```

No new MCP tool, no HTTP route, no app screen — that's *why* the catalog gates F14 as "QA only".

## 4. Sub-tasks (S0–S11)

| # | Task | Status | Note |
|---|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `RunKind`/`MeasureRecord`/`TemplateSla` (+ zod mirror) in `src/types.ts`. |
| S2 Storage | Applicable | jsonl append + legacy-CSV one-time migration in `src/metrics.ts`. |
| S3 Core | Applicable | Aggregation (success-rate, avg/p50/p95) + percentile helper in `src/metrics.ts`. |
| S4 Module | Applicable | Extends existing `metrics.ts`/`dashboard.ts` — no new module file created. |
| S5 Wiring | Applicable | Single `recordMeasure` call in `engine.ts`; delete 2 old call sites + swap tool handler body in `index.ts`. |
| S6 Unit | Applicable | `src/metrics.test.ts` (new) — see §7. |
| S7 Verify | Applicable | `scripts/verify-F14.mjs` — engine-touching (instrumentation sits on the real extraction path); run for confidence though not gate-blocking (no G6 for this feature). |
| S8 Docs | Applicable | README/SKILL note: new `get_extraction_stats` shape, jsonl file, CSV migration. |
| S9 Review (G2) | Applicable | Code-Reviewer: no reinvented percentile lib, minimal diff, both success/failure paths call `recordMeasure`. |
| S10 Live (G6) | N/A | Catalog gate row = "QA only" — no Lv gate required; S7's verify script still runs, just isn't a merge blocker. |
| S11 Merge (G7) | Applicable | Integration merges after G1/G2/G5 green; rebase risk limited to `engine.ts`/`index.ts`/`types.ts` (shared with other Wave-1 features). |

## 5. Dependencies & sequencing

- **Hard deps:** ADR-04 only (Accepted, Phase 0 — no feature-ID prerequisite; F14's catalog `Deps` column is `ADR-04`).
- **Unblocks (catalog `Deps` naming F14 directly):** F16 short-TTL cache (`Deps: F14, ADR-04` — reads recency/hit signals from the measures), F17 OTel observability (`Deps: F14` — adapter exports the same measures, no new instrumentation), F24 marketplace reputation (`Deps: F03, F14` — derives reputation from success/failure records).
- **Informational (ADR-04's own "depended on by" list, not a catalog hard-dep):** F20/X05 change-monitors read run history conceptually but their catalog `Deps` is F02, not F14 — no merge-order requirement from F14 → F20.
- **Wave:** 1. Runs in parallel with F01 (schema contracts), F03 (nightly verify), F05 (synthesize_schema), F19 (CLI/lint gaps) — no cross-feature code dependency among them, only the usual shared-file (`engine.ts`/`index.ts`/`types.ts`) rebase discipline via ADR-02 append-only.
- Must land before F16 (Wave 2) and F17/F24 (Waves 4/5) merge, since those hard-depend on the measure model existing.

## 6. Quality gates

Per `quality-gates.md`, F14's path is: **G0 Spec → G1 Build → G2 Code-Review → G5 QA → G7 Integration → G8 Promote**. Skipped: G3 Arch (no new module/boundary — extends existing modules within ADR-04's already-locked shape), G3b Design (no UI), G4 Security (no secret/sandbox/user-data surface), G6 Live-Verify (catalog marks this feature QA-only; no Playwright-gated claim to verify).

**Definition of Done:**
- `RunKind`/`MeasureRecord`/`TemplateSla` land in `types.ts`, pure, zod-validated at the one write site.
- `engine.ts`'s result-assembly point calls `recordMeasure` exactly once per run (success and failure); the two ad-hoc `logExtractionMetric` sites in `index.ts` are deleted.
- `get_extraction_stats` returns `{ templates: TemplateSla[] }` computed from `getAllSla()`; `dashboard.ts` shows success-rate% and p95 latency per template.
- Legacy CSV rows are migrated into the jsonl store (no silent data loss) and migration is idempotent.
- `npm run build` clean; full Vitest suite green including `src/metrics.test.ts`; `node scripts/verify-F14.mjs` passes against a real template run.

## 7. Test plan

**`src/metrics.test.ts` (new, Vitest, browser-free — pure aggregation math):**
- `recordMeasure` appends a well-formed line; reading it back parses to an equal `MeasureRecord`.
- `getAllSla`/`getTemplateSla`: seed N synthetic records for `templateId: "t1"` with a fixed duration array (e.g. `[10,20,30,40,100]`) and a known success/failure mix; assert `successRate = successCount/N`, `avgDurationMs`, and `p50`/`p95` match hand-computed nearest-rank values for that exact array (documented in the test so the percentile method is unambiguous).
- `getTemplateSla` on an unknown `templateId` returns `undefined`.
- `lastError` reflects the most recent failing record's `error`, not an earlier one, when failures are interleaved with successes.
- `migrateLegacyCsvIfPresent`: given a fixture legacy CSV (`{timestamp,templateId,url,imageCount}` rows), asserts the produced records have `success: true, kind: "extraction", durationMs: 0`, and that calling it twice does not duplicate rows.

**`scripts/verify-F14.mjs` (new, engine-touching):**
- Runs one real extraction against an already-registered fixture template (reuse whatever fixture F00/F01's verify scripts already point at — no new HTML fixture needed for a metrics-only feature), then asserts a new line was appended to `templates/extraction_metrics.jsonl` and that `getAllSla()`/the `get_extraction_stats` tool path reports `runs >= 1`, `0 <= successRate <= 1`, and a recent `lastRunAt` for that template.

## 8. Acceptance criteria (live, observable proof)

- Run a registered template twice via `execute_native_extraction` — once to succeed, once forced to fail (bad `templateId` or unreachable URL) — and confirm `templates/extraction_metrics.jsonl` gains exactly two new lines with correct `success` booleans and positive `durationMs`.
- Call `get_extraction_stats` and confirm the response includes that template with `runs: 2, successCount: 1, successRate: 0.5`, `lastError` set to the failure's message, and `p95DurationMs > 0`.
- Confirm `templates/extraction_metrics.csv` stops growing after the change (the jsonl file is the only one gaining new rows on subsequent runs) — diff file sizes/mtimes before and after.
- Confirm `dashboard.ts`'s rendered output shows the success-rate/p95 columns for at least one template with `runs > 0`.

## 9. Reuse notes

- Reuse the file-append-under-lock convention already used by other file-backed stores (cookie-store, scheduler) for the new jsonl append — do not invent a new locking primitive.
- Reuse the `atomicWriteFile`-style temp+rename convention (used elsewhere in the codebase, e.g. the tracker's `update_status.mjs` pattern) only for full-file rewrites (the one-time CSV migration output); plain appends don't need it.
- `ExtractionMeta.durationMs`/`timestamp` are already computed in `engine.ts` — F14 must forward these existing values into `recordMeasure`, never recompute timing itself.
- Reuse the existing `get_extraction_stats` tool registration (module already exists per ADR-02) — change the handler body only; do not register a second stats tool.
- Reuse `dashboard.ts`'s existing per-template render loop — add columns, don't add a parallel view.
- Keep the percentile helper a small local pure function in `metrics.ts` (nearest-rank over a sorted copy) rather than pulling in a stats package for two numbers over small arrays.

## 10. Skills (setup + when-to-use)

F14 has zero new third-party API surface (no new npm dependency, pure TypeScript + the existing fs/append pattern), so it is fully covered by the project's own `.agents/skills/` library — no skills.sh install, no context7 fallback needed:

- **`test-driven-development`** (already installed, `.agents/skills/`) — guides S6: write the `metrics.test.ts` percentile/success-rate cases against the `MeasureRecord`/`TemplateSla` shapes before wiring the real aggregation.
- **`observability-and-instrumentation`** (already installed, `.agents/skills/`) — guides S3/S5: the single-instrumentation-point design (replace two ad-hoc call sites with one) and the success-rate/latency measure-model *is* this discipline's exact domain.

Setup: `npx skills check` to confirm both are already present from an earlier feature (they are global/durable per the skills matrix); skip `npx skills add` entirely — nothing is missing for this feature.
