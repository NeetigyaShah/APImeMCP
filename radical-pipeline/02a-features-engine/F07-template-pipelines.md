# F07 — Template Pipelines / DAG

## 1. Summary

| Field | Value |
|---|---|
| ID | **F07** |
| Name | Template pipelines / DAG |
| Pillar | C — fabric |
| Wave | 3 |
| Gates | Ar, Lv (no Se, no Design) |
| Risk | M |

**What.** Chain existing registered templates into a named, reusable **pipeline definition**: step *N*'s output can feed step *N+1*'s input via a declared field mapping. Adds one new module (`src/pipeline.ts`), a runner (`runPipeline`), and three MCP tools (`register_pipeline`, `run_pipeline`, `list_pipelines`) wired per **ADR-02**.

**Why (market angle, tied to 00-vision).** The vision's moat is "solve a site once, crystallize it, run it deterministically forever." A single template only covers one screen. Most real workflows span *multiple* screens/sites (list page → detail page; source portal → destination form). F07 is the "fabric" pillar's first primitive: it turns isolated deterministic templates into deterministic **multi-step capabilities** without asking an agent to re-plan the chain every run. It directly unblocks **F09** (bidirectional read→transform→write flows) and **F25** (OpenAPI/client export of a whole capability, not just one template), and is explicitly named in `06-creative-ideas.md` ("Shareable cross-site recipes — put F07 pipelines, not just single templates, in the registry and the app") as a flywheel amplifier: a pipeline is exactly the kind of higher-value, harder-to-copy unit that makes the community registry (and later X03 durable orchestration / mobile monitors) more valuable per contribution.

## 2. User / agent story

> An agent (or a human via the dashboard) already has two registered templates: `listing-search` (returns a list of item URLs for a query) and `listing-detail` (returns full details for one item URL). Today the agent must call `execute_native_extraction` twice and manually wire the URL between calls, in every conversation, forever. With F07, the agent calls `register_pipeline` once with a 2-step definition that maps `listing-search`'s first result URL into `listing-detail`'s `targetUrl`, then from then on calls `run_pipeline({pipelineId})` and gets back a single ordered result — deterministic, reusable, shareable in the registry like any template.

## 3. Design

### ADR(s) obeyed
- **ADR-02 (tool-module convention)** — F07 is explicitly listed in ADR-02's dependents table. All 3 tools are `registerXxxTool(server, deps)` functions living in `src/pipeline.ts`; `index.ts` gets exactly **3 appended lines**, no inline `server.tool()` bodies, no edits inside any other feature's block. `deps` is an explicit injected object (no hidden cross-boundary imports), matching ADR-02 point 2 — this makes `runPipeline` unit-testable with a fake `deps.runExtraction`.
- Not obeyed (deliberately, per catalog): **ADR-03 (transform interface)** is *not* a hard dependency of F07 — the catalog's `Deps` column for F07 is `exec` (the pre-existing execution primitive, i.e. `runExtraction` in `engine.ts`), not `ADR-03`/`F10`. F09 (Deps: `F07,F10`, Wave 4) is where a real `TransformSpec`/`applyTransform` step lands. F07's own field-mapping stays a deliberately dumber dot-path getter (see Reuse notes) so it ships in Wave 3 without waiting on richer transform semantics.

### Data shapes — `D:/MCP/src/types.ts` (append)

```ts
// Mirrors execute_native_extraction's existing param shape 1:1, plus inputMapping.
export const PipelineStepSchema = z.object({
  id: z.string().min(1),                              // unique within the pipeline; referenced by later steps
  templateId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  targetUrl: z.string().url().optional(),
  cookieString: z.string().optional(),                // forwarded as-is, same as execute_native_extraction today
  proxyUrl: z.string().url().optional(),
  inputMapping: z.record(z.string()).optional(),      // paramName -> "$init.<dotPath>" | "<stepId>.<dotPath>"
});
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

export const PipelineDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(PipelineStepSchema).min(1),
  createdAt: z.string().optional(),
});
export type PipelineDef = z.infer<typeof PipelineDefSchema>;

export interface PipelineStepResult {
  stepId: string;
  templateId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}
export interface PipelineRunResult {
  pipelineId: string;
  success: boolean;
  steps: PipelineStepResult[];
  failedStep?: string;
  totalDurationMs: number;
}
```

Also extend the existing ADR-04 `Measure.kind` union with a `'pipeline'` literal (one rollup measure per run, see below).

### Module — `D:/MCP/src/pipeline.ts` (NEW)

- **Storage** (mirrors the templates convention — one JSON file per entity, `atomicWriteFile` + `withLock`, no new persistence pattern invented): `D:/MCP/templates/pipelines/<pipelineId>.json`.
  - `registerPipeline(def: PipelineDef): Promise<void>` — Zod-validate, reject duplicate id, `withLock` + `atomicWriteFile`.
  - `findPipelineById(id: string): PipelineDef | null`.
  - `listPipelineDefs(): PipelineDef[]`.
- **Runner**:
  - `resolveInputMapping(mapping, initialInput, stepResults)` — dot-path getter only (`a.b.0.c`), no JSONPath lib. `"$init.X"` reads `initialInput`, `"<stepId>.X"` reads `stepResults[stepId].output`. Unknown `stepId` or unresolved path → throws a clear `PipelineMappingError`, caught by the runner as that step's failure (not a crash).
  - `async function runPipeline(pipelineId, initialInput, deps): Promise<PipelineRunResult>` — loads the def, iterates `steps` **in array order** (fail-fast, sequential; see ladder note below), for each step: resolves mapped fields, calls `deps.runExtraction({ templateId, targetUrl, cookieString, proxyUrl, ...resolved })`, records a `PipelineStepResult` keyed by `step.id`. On first failure: stop, return `success:false, failedStep`. On completion of all steps: `success:true`. Emits exactly one `{templateId: pipelineId, kind:'pipeline', success, durationMs, timestamp, error?}` measure through the existing ADR-04 metrics.ts aggregation path — per-step measures already fire automatically because each step goes through `runExtraction`, so nothing new is needed there.
  - `// ponytail: steps run strictly sequentially in declared array order — no topological sort / parallel branches. "DAG" in the catalog name is aspirational; a real DAG scheduler is deferred until a pipeline actually needs independent parallel branches (add a "needs: string[]" field + Kahn's-algorithm sort then).`
  - `// ponytail: no retry/backoff on step failure — fail-fast and surface the error. Retry policy is F17/observability or a future explicit feature, not F07's job.`

### Tools (ADR-02, in `src/pipeline.ts`)

```ts
export interface PipelineDeps {
  runExtraction: typeof runExtraction;         // reused from engine.ts, injected (ADR-02 pt.2)
  registerPipeline: typeof registerPipeline;
  findPipelineById: typeof findPipelineById;
  listPipelineDefs: typeof listPipelineDefs;
  recordMeasure?: (m: Measure) => void;        // ADR-04 aggregator, injectable for tests
}

export function registerRegisterPipelineTool(server: McpServer, deps: PipelineDeps): void
// tool "register_pipeline": { pipelineId, name, description?, steps: PipelineStep[] } -> { ok: true, pipelineId }

export function registerRunPipelineTool(server: McpServer, deps: PipelineDeps): void
// tool "run_pipeline": { pipelineId, initialInput?: Record<string, unknown> } -> PipelineRunResult

export function registerListPipelinesTool(server: McpServer, deps: PipelineDeps): void
// tool "list_pipelines": {} -> { pipelines: Array<{id, name, description?, stepCount}> }
```

Shapes deliberately mirror the *already-shipped* `register_extraction_template` / `execute_native_extraction` / `get_extraction_stats` tools (same `templateId`-style regex, same empty-object no-arg convention for the list tool) — no new conventions invented.

### `D:/MCP/src/index.ts` (append-only, 3 lines, ADR-02 pt.3)

```ts
registerRegisterPipelineTool(server, deps);
registerRunPipelineTool(server, deps);
registerListPipelinesTool(server, deps);
```

No other line in `index.ts` changes.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Yes | This document. |
| S1 Types | Yes | `PipelineStepSchema`, `PipelineDefSchema`, `PipelineStepResult`, `PipelineRunResult`, `Measure.kind += 'pipeline'` in `types.ts`. |
| S2 Storage | Yes | `templates/pipelines/<id>.json`, one-file-per-entity, `atomicWriteFile`+`withLock`, in `pipeline.ts`. |
| S3 Core | Yes | `resolveInputMapping` + `runPipeline` fail-fast sequential runner. |
| S4 Module | Yes | `pipeline.ts` exports storage fns + runner + 3 `registerXxxTool` fns behind an explicit `PipelineDeps`. |
| S5 Wiring | Yes | 3 appended calls in `index.ts`, nothing else touched. |
| S6 Unit | Yes | `pipeline.test.ts` (see §7). |
| S7 Verify | Yes | `scripts/verify-F07.mjs` — engine/browser-touching (chains real templates via real Playwright). |
| S8 Docs | Yes | README + SKILL tool table gain 3 rows; no `dashboard.ts` change (not in F07's Modules column). |
| S9 Review | Yes | Standard G2 code-review. |
| S10 Live | Yes | G6 via `verify-F07.mjs`. |
| S11 Merge | Yes | Standard G7 integration, append-only `index.ts` diff makes this close to conflict-free. |

## 5. Dependencies & sequencing

- **Hard feature-ID deps:** none. Catalog `Deps` = `exec` — F07 only needs the pre-existing execution primitive (`runExtraction` in `engine.ts`), which already exists; it does not wait on any not-yet-built F0x feature.
- **Scheduling:** Wave 3, alongside F04, F06, F08, F11, F15 (contention-driven ordering, not a hard dependency chain).
- **Unblocks:** **F09** Bidirectional flows (Deps: `F07,F10`, Wave 4 — adds the write-back + real `TransformSpec` step on top of F07's chain primitive). **F25** OpenAPI + client export (Deps: `F01,F07`, Wave 5 — exports a whole pipeline, not just one template). Referenced by the unscheduled moonshot "Shareable cross-site recipes" (`06-creative-ideas.md`).

## 6. Quality gates

Applicable: **G0 Spec, G1 Build, G2 Code-Review, G3 Arch (Ar), G5 QA, G6 Live-Verify (Lv), G7 Integration, G8 Promote.** N/A: G3b Design (no UI), G4 Security (not flagged for F07 in the catalog — each chained template's own security posture is unchanged; F07 adds no new network surface or credential handling beyond what `execute_native_extraction` already accepts).

**Definition of Done:**
- `pipeline.ts` compiles; 4-module boundary intact — only imports `engine.ts`'s `runExtraction` + existing storage/lock helpers, no new cross-boundary leaks.
- 3 tools registered via `registerXxxTool` per ADR-02; `index.ts` diff is exactly 3 appended lines.
- `pipeline.test.ts` green: happy path, input-mapping resolution, fail-fast abort, unknown-pipeline error, bad-mapping-reference error.
- `scripts/verify-F07.mjs` green against 2 real chained templates with real Playwright.
- Exactly one `kind:'pipeline'` ADR-04 measure emitted per `runPipeline` call, in addition to the per-step measures `runExtraction` already emits.

## 7. Test plan

**`D:/MCP/src/pipeline.test.ts`** (Vitest, browser-free — fake `deps.runExtraction`):
1. `registerPipeline` persists and round-trips via `findPipelineById`; rejects a duplicate `pipelineId`; rejects a Zod-invalid step (bad `templateId` pattern).
2. `resolveInputMapping` resolves `"$init.query"` from `initialInput` and `"stepA.items.0.url"` from a prior step's `output`.
3. `runPipeline` happy path: 2-step pipeline, step B's `inputMapping` pulls a field out of step A's `output`; asserts both `PipelineStepResult`s are `success:true` and step B's resolved `targetUrl` equals the mapped value.
4. `runPipeline` fail-fast: step B's fake `runExtraction` rejects → result is `success:false`, `failedStep:"stepB"`, `steps` contains only step A (successful) and step B (`success:false`, `error` set) — no step C in a 3-step def is attempted.
5. `runPipeline` against an unknown `pipelineId` → clear thrown/returned error, not a crash.
6. `runPipeline` with an `inputMapping` referencing a step id not present earlier in `steps[]` → that step fails with a `PipelineMappingError`, pipeline aborts there (case of §3's fail-fast, not a new code path).
7. One `recordMeasure` call observed per `runPipeline` invocation with `kind:'pipeline'` and correct `success`/`durationMs`.

**`D:/MCP/scripts/verify-F07.mjs`** (real Playwright, matches the existing `verify-*.mjs` pattern): register a 2-step fixture pipeline chaining two already-verified lightweight fixture templates (reuse whichever minimal fixture template(s) the existing `verify-*.mjs` scripts already target, to avoid a new external network dependency), run it via `run_pipeline`, assert step 2 actually received the value step 1 produced (not a hardcoded fallback), print per-step PASS/FAIL, exit non-zero on any failure. Fixture def: `D:/MCP/templates/pipelines/verify-f07-fixture.json`.

## 8. Acceptance criteria (live, observable)

1. `register_pipeline` with a 2-step definition (step A: list-style template; step B: detail-style template with `inputMapping: {targetUrl: "stepA.items.0.url"}`) returns `{ok:true, pipelineId}`.
2. `run_pipeline({pipelineId})` returns a `PipelineRunResult` where `steps[1]`'s actual resolved `targetUrl` (visible in its `output`/logs) equals a URL that only existed in `steps[0].output` — proving live chaining, not two independent calls.
3. `list_pipelines` shows the registered pipeline with `stepCount: 2`.
4. `node D:/MCP/scripts/verify-F07.mjs` prints PASS for both steps and exits 0.
5. Break step B's `templateId` to a nonexistent template, re-run: `run_pipeline` returns `success:false, failedStep:"stepB"`, and `steps` contains exactly one entry (step A) that succeeded — proving fail-fast, not silent partial success.

## 9. Reuse notes

- **`runExtraction`** (`engine.ts`, the ADR-04 instrumentation point) — the runner's only call into the engine; per-step measures are already emitted automatically, F07 adds nothing there.
- **`atomicWriteFile` + `withLock`** — reused verbatim for `templates/pipelines/<id>.json`, same convention as template persistence; no new IO pattern.
- **`register_extraction_template` / `execute_native_extraction` / `get_extraction_stats` tool shapes** — the 3 new tools' Zod schemas and no-arg-list convention are copied, not reinvented.
- **ADR-04's metrics.ts aggregator** — the one new `kind:'pipeline'` measure is pushed through the existing aggregation path, not a parallel metrics system.
- **Explicitly NOT reused/needed for F07:** `captureForensics`, `buildStandaloneScript`, `findTemplateByUrl` (F02/F04/F05/F06 territory — drift, self-heal, computer-use crystallization, none of which F07 touches), `applyTransform`/`TransformSpec` (ADR-03 — F07's `inputMapping` is a deliberately dumber dot-path getter; F09 is where real transform semantics land on top of F07).

## 10. Skills (setup + when-to-use)

No skills.sh install needed — F07 is pure TS/Zod/Vitest engine work with no new vendor SDK, so per the skill-quality bar (reject <1K installs, no invented need) this stays on what's already available:

- **`.agents/skills/spec-driven-development`** (already installed, no install step) — guides S0.
- **`.agents/skills/incremental-implementation`** (already installed) — guides S3/S4 (storage → runner → module, in that order, not all at once).
- **`.agents/skills/test-driven-development`** (already installed) — guides S6 (write the fail-fast/mapping-error tests before the runner branches, per §7).
- **`using-apimemcp`** (already installed) — guides S3/S7: shows the existing engine usage patterns (`execute_native_extraction`/`register_extraction_template` call shapes) that `pipeline.ts` must mirror.
- **`context7-mcp`** — fallback only, for live Zod API specifics if a schema question comes up during S1; not a substitute for a missing feature-specific skill, because none is warranted here (no ≥1K-install "pipeline orchestration" skill exists, and this is plain TypeScript, not a new framework).

Setup: `npx skills check` first (reuse anything already global); nothing new to `npx skills add` for F07.
