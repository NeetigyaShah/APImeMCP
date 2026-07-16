# F09 — Bidirectional flows

## 1. Summary

- **ID:** F09 · **Name:** Bidirectional flows · **Pillar:** C (fabric) · **Wave:** 4 · **Risk:** H
- **Gates:** Ar Se Lv (all three ⚫ required — the full gate set, see §6)
- **Deps:** F07 (template pipelines/DAG), F10 (transform/normalize layer) · **Modules touched:** `engine.ts`, `pipeline.ts` (+ incidental `storage.ts`/`types.ts` field additions, see §3)

**What.** Chains a *read* template's output through an ADR-03 transform into a *write* (form-fill + submit) action against a second template — "Read A → transform → form-fill write into B". Adds a `write` template kind and a `write` pipeline-step kind; does **not** add a new MCP tool or a new module.

**Why.** 00-vision's target-market list names RPA replacement (~$20B) as a core wedge — and the overwhelming majority of real RPA work is exactly this shape: read a row from one no-API system, reshape it, write it into another no-API system (portal → ERP, spreadsheet-export → vendor form, claim status → CRM). F01–F08/F10 make APImeMCP a excellent *read*-only universal API; F09 is the single feature that turns it into a full bidirectional automation fabric, closing the loop the vision calls out. It is deliberately the highest-risk feature in the catalog (H) because, unlike every read-only feature so far, its side effects are real and irreversible on systems the project doesn't own.

## 2. Story

An agent (or a human via a pipeline JSON) has a read template `leads-export` that extracts new rows `{name, email, company}` from a partner portal, and a write template `vendor-crm-intake` that fills and submits the vendor's "new contact" form. Today (post F07/F10) the agent can chain two *reads* in a pipeline and reshape output with a `TransformSpec`, but has no way to make the second step *submit* something. With F09, the agent defines a 2-step pipeline: step 1 reads `leads-export`, step 2 is a `write` step that transforms step 1's output (`rename company→organization`) and submits it into `vendor-crm-intake`, one write per row, with failures collected per-row instead of aborting the whole batch — and, critically, a `dryRun` flag so the agent can preview exactly what would be submitted before committing to real writes against a live third-party system.

## 3. Design

### 3.1 ADRs obeyed
- **ADR-03 (transform interface):** the write step reuses `applyTransform(data, spec)` from `src/transform.ts` (F10) unchanged, in the reverse direction the ADR already anticipates — no hand-rolled reshaping.
- **ADR-02 (tool-module convention):** F09 adds **zero** new `registerXxxTool` calls and **zero** new lines to `index.ts`'s append-only list. It (a) extends the existing `register_extraction_template` tool's Zod input shape in place (that tool's module, created by F00/F01's ADR-02 retrofit in waves 0–1, long before F09's wave 4), and (b) extends F07's existing `run_pipeline` tool's internal step-kind union in `pipeline.ts`. This is why the catalog's Modules column for F09 reads `engine, pipeline` and omits `index` — a deliberate signal, not an oversight, and it's the reason S5/Wiring is N/A below.

### 3.2 Data shapes

```ts
// src/types.ts — new template-kind discriminant (back-compat: absent = 'read', today's only kind)
export interface WriteManifestEntry extends ManifestEntry {
  templateKind: 'write';
  writeScript: string;              // Playwright script body: fills fields from `input`, submits — same
                                     // script contract as existing extraction scripts (buildStandaloneScript-compatible)
  writeInputSchema?: JSONSchema7;    // ADR-01-style optional pre-submit shape check on the transformed payload
}
// existing entries gain: templateKind?: 'read' | 'write' (default 'read') — fully back-compat

// src/pipeline.ts — new step-kind variant appended to F07's existing step union
export interface WriteStep {
  kind: 'write';
  id: string;
  fromStepId: string;                         // upstream step whose output feeds this write (F07 DAG edge)
  targetTemplateId: string;
  transform: TransformSpec;                    // ADR-03
  perItem?: boolean;                           // default: true iff upstream output is an array
  onError?: 'stop' | 'continue' | 'collect';   // default 'collect'
  dryRun?: boolean;                            // default false — MUST be explicitly false to actually submit
}

// src/engine.ts
export interface WriteResult {
  templateId: string;
  input: unknown;             // the transformed payload that was (or would be) submitted
  success: boolean;
  dryRun: boolean;
  submittedAt: string;        // ISO timestamp
  durationMs: number;         // ADR-04 measure point
  error?: string;
  forensicsPath?: string;     // set via captureForensics when success=false
}
export async function executeWriteFlow(
  writeTemplate: WriteManifestEntry,
  input: unknown,
  opts: { cookieString?: string; proxyUrl?: string; dryRun?: boolean },
): Promise<WriteResult>;
```

### 3.3 Module-by-module changes

- **`D:/MCP/src/engine.ts`** — add `executeWriteFlow`. Runs the whole call under `withLock(writeTemplate.id)` (writes are non-idempotent — two concurrent runs against the same target must serialize, unlike reads). Reuses `launchPersistentContext` (F00) when an app-connection exists for the target domain, else a fresh context. On thrown error, calls `captureForensics` before building `{success:false, forensicsPath}`. When `dryRun`, executes the script up to (not including) the submit action and returns `{success:true, dryRun:true}` without mutating the target — this is the mechanism that makes acceptance criterion #2 (§8) true.
- **`D:/MCP/src/pipeline.ts`** (F07-owned) — add the `case 'write':` arm to the step-dispatch switch: resolve `targetTemplateId` via `findTemplateByUrl`/`loadTemplate`, fan out over `context.outputs[step.fromStepId]` (one item, or each array item when `perItem`), call `applyTransform` then (if `writeInputSchema` present) `validateOutput` (ADR-01 reuse) then `engine.executeWriteFlow`, aggregate into `context.outputs[step.id] = {results, succeeded, failed}`. `onError:'collect'` (default) lets sibling items keep running after one fails; `'stop'` aborts the fan-out; `'continue'` is like collect but doesn't count failures against pipeline-level success.
- **`D:/MCP/src/storage.ts`** (incidental) — persist the 3 new optional manifest fields (`templateKind`, `writeScript`, `writeInputSchema`) via the existing `atomicWriteFile`-based manifest writer; no new file, no new function.
- **`D:/MCP/src/types.ts`** (incidental) — the `WriteManifestEntry`/`WriteStep`/`WriteResult` shapes above, as zod schemas appended next to F07's/F10's existing pipeline/transform schemas (not a new file — these live inside the type slices F07/F10 already own).
- **Existing `register_extraction_template` tool** (its own module post-ADR-02 retrofit) — Zod input shape gains, with a refinement making `writeScript` required exactly when `templateKind==='write'`:
  ```ts
  z.object({ /* ...existing fields... */
    templateKind: z.enum(['read', 'write']).default('read'),
    writeScript: z.string().optional(),
    writeInputSchema: z.record(z.unknown()).optional(),
  }).refine(v => v.templateKind !== 'write' || !!v.writeScript,
    { message: 'writeScript required when templateKind is "write"' })
  ```
- **`run_pipeline` tool** (F07-owned) — signature unchanged; only the internal `PipelineStep` union it accepts grows by one variant (`WriteStep` above). No new tool, no new route, no app screen (Program 1 only).

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `WriteManifestEntry`, `WriteStep`, `WriteResult` zod schemas in `types.ts` |
| S2 Storage | Applicable | persist 3 new optional manifest fields via existing `atomicWriteFile` path in `storage.ts` |
| S3 Core | Applicable | `executeWriteFlow` in `engine.ts` (withLock, forensics, dry-run) |
| S4 Module | Applicable | `case 'write':` dispatch arm in `pipeline.ts` |
| S5 Wiring | **N/A** | no new `registerXxxTool`/no new `index.ts` line — extends 2 existing tools' Zod shapes in place (§3.1) |
| S6 Unit | Applicable | `pipeline.test.ts`, `engine.test.ts`, `types.test.ts` cases (§7) |
| S7 Verify | Applicable | `scripts/verify-F09.mjs` + local HTML fixture (§7) |
| S8 Docs | Applicable | README + `using-apimemcp` SKILL note: `templateKind:'write'`, write pipeline step, dry-run |
| S9 Review | Applicable | G2 |
| S10 Live | Applicable | G6, real Playwright submit against the fixture |
| S11 Merge | Applicable | G7 |

## 5. Dependencies & sequencing

- **Hard deps:** F07 (needs the pipeline DAG/step-dispatch/output-threading to exist before a step-kind can be appended to it) and F10 (needs `applyTransform`/`TransformSpec` to exist before the write step can reshape upstream output) — both merged well before wave 4 (F07 wave 3, F10 wave 2), so F09 starts wave 4 unblocked.
- **Soft/adjacent, not hard deps (per catalog — do not block on these):** F12 (policy engine — robots.txt/ToS + rate limits) is also wave 4 and highly relevant to writes' safety posture, but the catalog does not list it as an F09 dependency; treat as a parallel wave-4 sibling whose output F09 should consume opportunistically if it lands first, not wait on. F11 (signed provenance receipts, wave 3) is a natural future home for stamping `WriteResult` as a receipt, but is likewise not a listed dependency — do not add it as one.
- **What it unblocks:** nothing in F00–F25 or W/X/M lists F09 as a dependency — it is a leaf capability in the tracked DAG. Its consumers are pipeline authors (via `run_pipeline`) and, by product intent rather than tracked dependency, any future platform "automation" surface.
- **Wave:** 4, parallel-safe with F12/F13/F17/F20 (no ordering required against them).

## 6. Quality gates

Ar Se Lv means **every** gate in G0→G8 applies to F09 — none skipped (it touches type/module boundaries, it writes to live third-party systems, and it needs a real-browser verify):

- **G3 Arch:** 4-module separation intact (write logic in `engine.ts`, orchestration in `pipeline.ts`, zero new modules); ADR-02 respected (literally zero new `index.ts` lines — verify by diff); ADR-03 respected (`applyTransform` reused, not reimplemented).
- **G4 Security (blocks):** `dryRun` defaults false and must be explicitly overridden to submit; `withLock` demonstrably serializes concurrent writes to the same `targetTemplateId`; write execution honors the same app-connection/vault scoping as reads (ADR-05 — no cross-user credential reuse); `captureForensics` output contains no secrets/cookies; failures are always surfaced in `WriteResult`, never swallowed.
- **G6 Live-Verify (blocks):** `scripts/verify-F09.mjs` performs a real Playwright submit against a local fixture, end to end.
- **Definition of Done:** build clean; full Vitest suite green on rebased branch; `verify-F09.mjs` exits 0; Architect + Security-Reviewer + Live-Verification all sign off; CHANGELOG/semver bump noting `templateKind:'write'` and the `write` pipeline step; `index.ts` diff is empty.

## 7. Test plan

- **`src/types.test.ts`** (extend) — `WriteManifestEntry` parses with `writeScript` (+ optional `writeInputSchema`); rejects `templateKind:'write'` missing `writeScript`; an entry with no `templateKind` still parses as today's plain (read) entry — back-compat.
- **`src/engine.test.ts`** (extend) — `executeWriteFlow` success path (mocked page) → `WriteResult{success:true}`; thrown error path → `captureForensics` called, `success:false`+`forensicsPath` set; `dryRun:true` → submit action never invoked on the mock, `success:true,dryRun:true`; two concurrent calls with the same `templateId` are serialized by `withLock` (assert call 2 starts after call 1 releases).
- **`src/pipeline.test.ts`** (extend) — `kind:'write'` step reads `context.outputs[fromStepId]`, calls `applyTransform` before `engine.executeWriteFlow`; `perItem:true` over an array upstream output fans out one write per item; `onError:'collect'` (default) keeps running siblings after one failure and reports `failed>0` without throwing; `onError:'stop'` aborts remaining items on first failure.
- **`scripts/verify-F09.mjs`** + fixture `templates/fixtures/f09-write-target.html` (a minimal local `<form>` page that appends submissions to a local log file): registers a static read template A (`{name,email}`), a write template B pointed at the fixture with a `writeScript` that fills+submits, runs a 2-step pipeline (read→write, with a rename transform) under real Playwright, asserts the fixture's log now contains the transformed payload; exits non-zero on mismatch. Follows the existing `scripts/verify-*.mjs` + `.github/workflows/verify.yml` pattern.

## 8. Acceptance criteria (live, observable)

1. `node scripts/verify-F09.mjs` exits 0 and the fixture's submission log contains the exact transformed payload from template A's output.
2. A pipeline with `{kind:'write', dryRun:true}` run through `run_pipeline` returns `WriteResult{success:true,dryRun:true}` **and** the fixture's submission log is unchanged — proves dry-run genuinely no-ops.
3. Injecting a bad selector into the write script produces `WriteResult{success:false, forensicsPath}` where `forensicsPath` points to a real DOM+screenshot artifact on disk.
4. Two concurrent bidirectional runs against the same `targetTemplateId` are observably serialized (run 2's engine-side start timestamp ≥ run 1's end timestamp), proving `withLock` covers writes.

## 9. Reuse notes

Call, don't reimplement: `applyTransform`/`TransformSpec` (ADR-03, F10 — the reshape step) · `findTemplateByUrl` (resolve `targetTemplateId`) · `registerTemplate` (write templates register through the same path as read templates) · `withLock` (serialize concurrent writes per target — the one piece of infra reads never needed) · `captureForensics` (failure diagnostics, same as extraction failures) · `atomicWriteFile` (manifest field persistence in `storage.ts`) · `buildStandaloneScript` (write templates export as standalone scripts exactly like read templates) · `launchPersistentContext` (F00 — reuse an app-connection's session for the write target when one exists) · `validateOutput` (ADR-01 — optional pre-submit schema check against `writeInputSchema`).

## 10. Skills (setup + when-to-use)

F09 is pure Program-1 engine work (no UI, no new external SDK) — the builder runs `npx skills check` first (idempotent, per 08-skills-matrix.md's protocol) and finds it needs nothing new; everything is already covered by the always-available `.agents/skills/` discipline library:

- **security-and-hardening** — mandatory given H risk + Se gate; guides S3/G4 (dry-run default, lock correctness, no secret leakage in forensics).
- **test-driven-development** — guides S6 (write the failure/dry-run/concurrency test cases in §7 before/alongside the code).
- **code-simplification** — guides S9/G2 (verify the diff really does reuse `applyTransform`/`withLock`/`captureForensics`/`buildStandaloneScript` rather than re-implementing any of them, and that `index.ts` has zero new lines per ADR-02).
- **browser-testing-with-devtools** — guides S7/S10/G6 (the real-Playwright fixture verify).
- **incremental-implementation** — guides build order S1→S2→S3→S4 (types before storage before engine before pipeline dispatch).
- **documentation-and-adrs** — guides S8.
- **using-apimemcp** (already available) — general engine usage patterns while wiring the write step into an existing template set.

**Fallback (no install needed):** `context7-mcp` for live Playwright form-fill/submit API specifics while writing `executeWriteFlow` and fixture write scripts — per the plan's own skill-quality bar, no ≥1K-install Playwright skill exists (community options top out at 63 installs and are explicitly rejected in 08-skills-matrix.md), so context7 + official Playwright docs is the correct source here, not a weak community skill.
