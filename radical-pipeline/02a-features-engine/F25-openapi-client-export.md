# F25 — OpenAPI + client export

## 1. Summary

- **ID:** F25 · **Name:** OpenAPI + client export · **Pillar:** F (creative) · **Wave:** 5 (final wave, alongside F18/F21/F24, no ordering edge between siblings) · **Risk:** M
- **Deps:** F01 (schema contracts), F07 (template pipelines/DAG) · **Modules:** `exporter` (new) + existing `usage.ts` pattern · **Gates:** QA only (G0/G1/G2/G5/G7/G8 — no Ar/Se/Lv)

**What.** Generate an OpenAPI 3.1 document + a generated TypeScript client from a "bundle" — one or more registered templates, optionally chained as an F07 `PipelineDef` — so a crystallized template (or pipeline) becomes a portable, versioned API artifact: a spec file plus an importable typed function per step.

**Why (tied to 00-vision).** 00-vision's thesis is that APImeMCP inverts the API economy — a template is "programmatic access to a screen" that used to require a vendor. That inversion only pays off for MCP-native agents unless the artifact can also be consumed by the vast *non-agent* tooling ecosystem that only understands OpenAPI/REST: Postman, iPaaS/Zapier-style connectors, `openapi-generator` pipelines, internal API catalogs. F25 is that bridge — it makes a template indistinguishable, to any OpenAPI-consuming tool, from a normal vendor-published API. It directly serves the named target markets (RPA replacement, competitive intelligence, financial-data aggregation) where enterprise integration platforms require an OpenAPI contract as the price of entry, not an MCP tool call.

## 2. User/agent story

As a developer or agent that has already registered a template (via `register_extraction_template`) or a pipeline (F07), I want to run one tool call and get back (a) an `openapi.json` I can drop into Postman/Swagger UI/an iPaaS connector, and (b) a single-file typed TS client I can `import` in a normal project — with the response type already matching what F01's `outputSchema` (and, where a pipeline step applies one, ADR-03's `TransformSpec` output) promises — without hand-writing any HTTP glue or duplicating the schema.

## 3. Design

### Data shapes — `D:/MCP/src/exporter.ts` (new, pure — same no-IO/total discipline as ADR-01's `validateOutput` and ADR-03's `applyTransform`)

```ts
import { z } from "zod";

export const ExportBundleSpecSchema = z.object({
  bundleId: z.string().min(1),          // slug: output dir + package/file naming
  title: z.string().optional(),
  version: z.string().default("1.0.0"),
  templateIds: z.array(z.string()).min(1),   // ManifestEntry.id values
  pipelineId: z.string().optional(),          // if set: bundle = an F07 PipelineDef; templateIds = its steps in order
});
export type ExportBundleSpec = z.infer<typeof ExportBundleSpecSchema>;

export interface OpenApiExportResult {
  doc: Record<string, unknown>;   // OpenAPI 3.1 document, JSON-serializable
  clientSource: string;           // single-file generated TS client source
  clientFileName: string;         // "<bundleId>.client.ts"
  warnings: string[];             // e.g. "template X has no outputSchema — response typed unknown"
}

// pure — reads ManifestEntry[] (+ optional PipelineDef), never throws, never does IO
export function buildOpenApiDocument(
  entries: ManifestEntry[],
  pipeline: PipelineDef | undefined,
  spec: ExportBundleSpec,
): { doc: Record<string, unknown>; warnings: string[] };

// pure — consumes the doc built above, emits one exported client factory + one method per step
export function buildTypedClient(
  doc: Record<string, unknown>,
  spec: ExportBundleSpec,
): { source: string; fileName: string };

// pure — composes the two above; the only export tool code calls directly
export function exportBundle(
  entries: ManifestEntry[],
  pipeline: PipelineDef | undefined,
  spec: ExportBundleSpec,
): OpenApiExportResult;
```

Generated client shape (factory + method, not a class hierarchy — no auth/retry/interceptor scaffolding; add only when a real feature needs it):

```ts
export function createClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  return {
    async runBernhardtProducts(input: RunBernhardtProductsInput): Promise<RunBernhardtProductsOutput> {
      const res = await fetchImpl(`${baseUrl}/run/bernhardt-products`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`export client: ${res.status}`);
      return res.json() as Promise<RunBernhardtProductsOutput>;
    },
  };
}
```

`baseUrl` is an explicit runtime parameter, never hardcoded — F25 depends only on F01+F07, **not** on F18 (hosted endpoint, same wave 5) or Program 2's X01 gateway, so the client must not assume either exists yet; it is deliberately pointable at a self-host server, a future F18 endpoint, or X01, whichever the caller stands up.

### ADRs obeyed

- **ADR-01 (schema contract).** Reads `ManifestEntry.outputSchema?` (optional JSON Schema) to build each path's response schema and the client's return type. Absent ⇒ response typed `unknown`/`{}` + a warning, never a thrown error (mirrors `validateOutput`'s total/no-throw contract). Reuses whichever JSON-Schema↔zod bridge F01 picked for schema→TS-type printing — does **not** add a second schema/codegen dependency.
- **ADR-02 (tool-module convention).** Tool registered by `registerExportBundleTool(server, deps)` in its own module; `index.ts` gets exactly one appended call, per the append-only rule that keeps 48 features from colliding on one file.
- **ADR-03 (transform interface).** When a pipeline step (F07) carries a `TransformSpec` (owned by F10, shipped wave 2 — already available by F25's wave 5), the exporter reflects the **already-applied** post-transform shape in that step's OpenAPI response schema and client return type. It reads the mapping, it never recomputes it — `applyTransform` stays the single source of truth.

### Module-by-module changes (exact paths)

| Path | Change |
|---|---|
| `D:/MCP/src/exporter.ts` | **New.** `ExportBundleSpecSchema`/`ExportBundleSpec`, `OpenApiExportResult`, `buildOpenApiDocument`, `buildTypedClient`, `exportBundle` — all pure, no IO. |
| `D:/MCP/src/storage.ts` | **Edit.** Add `writeExportedBundle(bundleId, result: OpenApiExportResult): Promise<{ dir: string; openapiPath: string; clientPath: string }>` — the only IO in this feature; uses the existing `atomicWriteFile` helper to write `output/exports/<bundleId>/openapi.json` and `output/exports/<bundleId>/<clientFileName>` (mirrors the existing gitignored `output/` convention). |
| `D:/MCP/src/tools/export-bundle.ts` | **New** (ADR-02 module). `registerExportBundleTool(server, deps)` — see tool signature below. |
| `D:/MCP/src/index.ts` | **Edit.** One appended line: `registerExportBundleTool(server, { storage, registry });` — no other edits. |
| `D:/MCP/src/usage.ts` | **Edit.** Regenerate the usage/tool-docs entry for `export_openapi_bundle` (existing regen pattern — no new module; this is what the catalog's "usage pattern" Modules entry means). |
| `D:/MCP/README.md` | **Edit.** Add the new tool to the tool table (S8 Docs). |
| Reads from (no changes needed) | `D:/MCP/src/types.ts` (`ManifestEntry.outputSchema`, ADR-01), `D:/MCP/src/pipeline.ts` (F07's `PipelineDef` store), `D:/MCP/src/transform.ts` (ADR-03's `TransformSpec`, F10). |

### MCP tool signature (ADR-02)

- **Tool:** `export_openapi_bundle`
- **Input (zod):** `{ bundleId: string, title?: string, version?: string, templateIds: string[] (min 1), pipelineId?: string }` — i.e. `ExportBundleSpecSchema` minus the defaulted `version`.
- **Behavior:** resolve `ManifestEntry` for each `templateIds` (+ `PipelineDef` if `pipelineId` given) via the existing manifest lookup, call pure `exportBundle(...)`, then `storage.writeExportedBundle(...)`.
- **Output:** `{ dir: string, openapiPath: string, clientPath: string, warnings: string[] }` — paths only, no inlined file bodies, consistent with other file-producing tools in the catalog.
- No HTTP route, no app screen — Program 1, engine-only; this is a leaf/terminal feature the catalog does not wire to any W##/X## screen or route.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document; G0 sign-off (Architect + Orchestrator; no Design Lead — no UI). |
| S1 Types | Applicable | `ExportBundleSpecSchema`/`ExportBundleSpec`, `OpenApiExportResult` in `src/exporter.ts`. |
| S2 Storage | Applicable | `writeExportedBundle()` in `src/storage.ts`, `atomicWriteFile`-based, under `output/exports/<bundleId>/`. |
| S3 Core | Applicable | Pure `buildOpenApiDocument`/`buildTypedClient`/`exportBundle` in `src/exporter.ts`. |
| S4 Module | Applicable | `src/tools/export-bundle.ts` (`registerExportBundleTool`, ADR-02). |
| S5 Wiring | Applicable | One appended call in `src/index.ts`. |
| S6 Unit | Applicable | `src/exporter.test.ts` + `src/tools/export-bundle.test.ts`. |
| S7 Verify | **N/A** | Pure-logic, no browser/engine execution — no `scripts/verify-F25.mjs`. Matches the catalog's "QA only" gate row. |
| S8 Docs | Applicable | README tool table + `usage.ts` regen entry. |
| S9 Review | Applicable | G2 Code-Review — correctness vs spec + no reinvented JSON-Schema→TS codegen (reuse F01's bridge). |
| S10 Live | **N/A** | No G6 Live-Verify required — pure/no-browser feature. |
| S11 Merge | Applicable | G7 Integration merge to `integration`, wave 5. |

## 5. Dependencies & sequencing

- **Hard deps:** F01 (needs `ManifestEntry.outputSchema` + `validateOutput` to exist — wave 1) and F07 (needs `PipelineDef`/pipeline store to exist for the multi-template "bundle" case — wave 3). Both land well before wave 5.
- **Consumed, not blocking:** ADR-03 + F10's `TransformSpec`/`applyTransform` (wave 2) — read only, already shipped by wave 5, no explicit sequencing edge required beyond obeying the ADR.
- **Unblocks:** nothing in Program 1 — F25 is a leaf/terminal feature (no other F## lists it as a dependency). Non-blocking integration point for Program 2: the exported OpenAPI doc is a natural artifact W04 (template detail) or X07 (registry mirror) could surface later, but no catalog edge requires it.
- **Wave:** 5, alongside F18/F21/F24 — no ordering requirement among same-wave siblings; explicitly does **not** depend on F18/X01 (see `baseUrl` design note above).

## 6. Quality gates

**Applicable:** G0 Spec, G1 Build, G2 Code-Review, G5 QA, G7 Integration, G8 Promote.
**Skipped:** G3 Arch (no `types.ts`/4-module-boundary change — `exporter.ts` is a self-contained new pure module), G3b Design (no UI), G4 Security (no untrusted input beyond local tool args; no cookies/vault/sandbox surface; writes only to local `output/`), G6 Live-Verify (pure-logic, no Playwright/browser — matches quality-gates.md's "pure-logic engine features skip G6" and the catalog's "QA only" row).

**Definition of Done:**
- `exportBundle` is pure/total (never throws, mirrors ADR-01/ADR-03 discipline) across: single template with `outputSchema`; single template without one (warning path); multi-template bundle; pipeline bundle with a `TransformSpec` step.
- `export_openapi_bundle` registered per ADR-02; returns paths, not bodies.
- Generated client type-checks (`tsc --noEmit`) against the schemas in the doc it was generated from.
- Vitest suite green; `usage.ts`/README regenerated; `npm run build` clean.

## 7. Test plan

`D:/MCP/src/exporter.test.ts`:
1. Single template with `outputSchema` → doc has 1 path, response schema matches the fixture schema, client has 1 exported method, 0 warnings.
2. Single template with **no** `outputSchema` → response schema is `{}`/unknown, exactly 1 warning, doc still OpenAPI-3.1-valid, client method return type is `unknown`.
3. Multi-template bundle (`templateIds.length === 2`, no `pipelineId`) → 2 paths, 2 client methods.
4. Pipeline bundle (`pipelineId` set, an F07 `PipelineDef` with one step carrying a `TransformSpec`) → that step's response schema reflects the **post-transform** shape, not the step's raw `outputSchema` (proves ADR-03 reflection, not re-derivation).
5. Purity/total: an unknown/malformed `templateId` → result carries a warning entry, function never throws.
6. Generated client source is syntactically valid — parse with the TypeScript compiler API (`ts.createSourceFile` / `ts.transpileModule`) and assert zero syntax diagnostics; keep this a fast parse check, not a full `tsc --noEmit` run, inside the unit test.

`D:/MCP/src/tools/export-bundle.test.ts`: tool registers under name `export_openapi_bundle` with the documented input schema; given a stubbed `storage.writeExportedBundle`, calling it with valid `templateIds` returns `{ dir, openapiPath, clientPath, warnings }`.

No `scripts/verify-F25.mjs` — N/A per S7/gate table (pure-logic, no browser).

## 8. Acceptance criteria (live, observable proof)

1. Register (or reuse) a real manifest entry that has an `outputSchema` (per F01). Call `export_openapi_bundle` with that single `templateId`. Open the written `output/exports/<bundleId>/openapi.json`: confirm `"openapi": "3.1.0"`, exactly one path, and the response schema matching the fixture's `outputSchema`. Run `npx tsc --noEmit` on the written `<clientFileName>` and confirm zero errors — paste the `tsc` output showing 0 errors as proof.
2. Register 2 templates plus an F07 `PipelineDef` chaining them with one `TransformSpec` step. Export that bundle. Confirm the OpenAPI doc has 2 paths, and the transformed step's response schema differs from its raw `outputSchema` (proves the ADR-03 reflection path, not a re-derivation bug).
3. Import the generated client's exported factory function in a scratch `.ts` file, call it, and confirm the return type shown by the TS language service/`tsc` matches the schema-derived type — not `any`.

## 9. Reuse notes

- `atomicWriteFile` (existing storage helper) — for `writeExportedBundle`, never hand-roll a write-then-rename.
- Existing manifest/template lookup (e.g. `findTemplateByUrl`-style resolution) — for turning `templateIds`/`pipelineId` into `ManifestEntry[]`/`PipelineDef`, not a second lookup path.
- The ADR-01 JSON-Schema↔zod bridge dependency — reuse F01's choice for schema→TS-type printing; do not add a second schema/codegen library.
- ADR-03's `applyTransform`/`TransformSpec` (F10, `src/transform.ts`) — read the already-applied mapping for pipeline steps; never recompute it inside the exporter.
- F07's `PipelineDef`/`src/pipeline.ts` step definitions — the only source of multi-step bundle structure.
- `registerXxxTool(server, deps)` convention (ADR-02) — exact pattern for `registerExportBundleTool`.
- `usage.ts` regeneration pattern — exact mechanism for S8 docs, no new docs module.

## 10. Skills (setup + when-to-use)

- Baseline (already installed, no setup): `.agents/skills/spec-driven-development` guides S0; `.agents/skills/code-simplification` + `.agents/skills/code-review-and-quality` guide S9; `.agents/skills/test-driven-development` guides S6.
- **No ≥1K-install reputable skill exists** for "OpenAPI 3.1 document authoring" or "JSON-Schema→TypeScript client codegen" specifically (per the 08-skills-matrix quality bar, which already rejects sub-150-install skills in adjacent areas like Cloudflare/serverless-Chromium) → fallback is `context7-mcp` + official docs, same pattern as those rejections:
  - Before writing `buildOpenApiDocument` (S3), `context7-mcp` → resolve-library-id + query-docs on the **OpenAPI 3.1 specification** itself (`paths`/`components.schemas`/`requestBody` shape) so the emitted doc is spec-correct, not remembered-from-training.
  - Before writing `buildTypedClient` (S3), `context7-mcp` → query-docs on the **TypeScript Compiler API** (whichever printer/AST-builder surface is used) to confirm current syntax for programmatic `.ts` source generation.
  - `npx skills check` first (per context-bounded-workflow.md) in case a higher-quality OpenAPI/codegen skill has appeared since this catalog was written; only install if it clears the ≥1K-install, reputable-source bar — otherwise stay on the context7 fallback.
