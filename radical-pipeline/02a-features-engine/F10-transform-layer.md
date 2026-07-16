# F10 — Transform / Normalize Layer

## 1. Summary

- **ID:** F10 · **Name:** Transform / normalize layer · **Pillar:** C (fabric) · **Wave:** 2 · **Risk:** L · **Gates:** Ar only (no Se, no Lv) · **Deps:** ADR-03 (no hard feature prereq) · **Critical path:** not marked ★ — off the F01→F02→F04 spine and the F05→F06→F21 secondary chain, but it is the shared plumbing three later features (F09, and per ADR-03's dependents table F25/W05/M04) build on.
- **What.** A small, serializable, jq-like reshaping layer: a `TransformSpec` (zod-validated JSON — `pick`/`rename`/`coerce`/`map`) plus one pure `applyTransform(data, spec)` in `src/transform.ts`. A template can declare a `transform` on its manifest entry so raw extraction output — messy field names, string-typed numbers, extra noise — comes back shaped like a real API response.
- **Why (tied to 00-vision).** The vision's inversion only works if a crystallized template's output looks like an API response, not like scraped HTML-in-JSON-clothing. Every downstream consumer of the registry — an agent chaining templates (F07/F09), the web run console's table/JSON views (W05), the mobile app's result cards (M04), the generated OpenAPI client (F25) — needs the *same* one normalized shape instead of each hand-rolling its own field-renaming glue. F10 is that one shared shaping step, owned once, reused everywhere (exactly ADR-03's rationale). It's also what makes the registry "ledger" UI (00-vision's structural device) presentable: a row's live-run preview reads as data, not as raw scrape noise.

## 2. User/agent story

> An agent registers a template against a product page. `execute_native_extraction` comes back with `{ "prod_name": "Widget", "raw_price": "19.99", "sku_internal_code": "X1", "_debug": "…" }` — accurate, but not something a phone app should render as a price. The agent calls `preview_transform` with that sample and a candidate spec, sees `{ "name": "Widget", "price": 19.99 }` come back, iterates once, then attaches the spec to the template via `register_extraction_template`'s `transform` field. Every future run of that template — from the CLI, from W05's run console, from M04's result screen — returns the normalized shape automatically, with no per-consumer glue code.

## 3. Design

### 3.1 Data shapes (`src/transform.ts`, NEW)

```ts
import { z } from "zod";

// jq-like ops — deliberately minimal (ADR-03 ceiling: grow only on a real F09/F25 need)
export const TransformOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pick"),   fields: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("rename"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("coerce"), field: z.string(), to: z.enum(["string", "number", "boolean", "date"]) }),
  // map: current value MUST be an array; `ops` (pick/rename/coerce only — no nested map)
  // is applied, in order, to every element. This is the one deliberate level of nesting;
  // it is how "map over an array" is expressed without a general recursive expression language.
  z.object({ op: z.literal("map"), ops: z.array(z.union([
    z.object({ op: z.literal("pick"),   fields: z.array(z.string()).min(1) }),
    z.object({ op: z.literal("rename"), from: z.string(), to: z.string() }),
    z.object({ op: z.literal("coerce"), field: z.string(), to: z.enum(["string", "number", "boolean", "date"]) }),
  ])) }),
]);
export type TransformOp = z.infer<typeof TransformOpSchema>;

export const TransformSpecSchema = z.object({
  version: z.literal(1),
  ops: z.array(TransformOpSchema), // applied in order; output of ops[i] feeds ops[i+1]
});
export type TransformSpec = z.infer<typeof TransformSpecSchema>;

export class TransformError extends Error {}

/** Pure, total (no IO / no hidden async), deterministic, never mutates `data`.
 *  "pick"/"rename"/"coerce" require the current value to be a plain object —
 *  throws TransformError otherwise (e.g. applied directly to an array without a wrapping `map`).
 *  "coerce ... to: 'date'" normalizes into an ISO-8601 string (not a native Date instance) —
 *  the transformed output must stay plain-JSON, same as the spec itself. */
export function applyTransform(data: unknown, spec: TransformSpec): unknown;
```

### 3.2 ADRs obeyed

- **ADR-03 (primary, owned by this feature).** F10 *is* the ADR-03 deliverable: `src/transform.ts`, the `TransformSpec` type, the op set, `applyTransform`. Keep the op set to exactly `pick`/`rename`/`coerce`/`map` — the ADR's consequences section explicitly flags a hand-rolled reshape elsewhere in the codebase as a G3-Arch rejection in favor of this shared applier.
- **ADR-02.** The new capability is exposed as a tool via `registerXxxTool(server, deps)` in its own module, appended (not inlined) in `index.ts`.
- **ADR-01 (pattern mirror, not a hard dep).** `ManifestEntry.transform?` follows the exact same back-compat rule ADR-01 set for `outputSchema?`: absent = pass-through, no behavior change for every template that predates this feature.

### 3.3 Module-by-module changes (exact paths)

| Path | Change |
|---|---|
| `D:/MCP/src/transform.ts` | **NEW.** `TransformOpSchema`, `TransformSpecSchema`, `TransformOp`, `TransformSpec`, `TransformError`, `applyTransform`. No imports from `engine.ts`/`storage.ts` — zero IO. |
| `D:/MCP/src/types.ts` | Import `TransformSpecSchema`/`TransformSpec` from `./transform.js`; add `transform: TransformSpecSchema.optional()` to the `ManifestEntry` zod shape (sibling to ADR-01's `outputSchema?`). |
| `D:/MCP/src/tools/transform-tool.ts` | **NEW.** `registerPreviewTransformTool(server, deps)` — see 3.4. `deps` is intentionally empty (`{}`) — the handler is pure — but the function still takes the parameter for consistency with the ADR-02 convention every other tool follows. |
| `D:/MCP/src/index.ts` | Three small, append-only touches: (a) one appended `registerPreviewTransformTool(server, {});` call; (b) `transform: TransformSpecSchema.optional()` added to `register_extraction_template`'s input shape (a shape addition, not a rewrite, of that tool's own block); (c) wherever that handler currently returns `execute_native_extraction`'s result, thread it through `applyTransform(result, manifestEntry.transform)` when `.transform` is present, catching `TransformError` and returning it as a normal tool error (`isError: true`) rather than throwing past the MCP boundary. |
| `D:/MCP/src/transform.test.ts` | **NEW.** Vitest unit tests — see Test plan. |

**Deliberately NOT touched: `src/engine.ts`.** The catalog's Modules column for F10 is `transform.ts (new), types, index` — no `engine`. Applying the transform is a *post-processing* step on the already-returned extraction result at the tool-response boundary (index.ts), not a change to the Playwright execution path itself. This keeps the diff genuinely low-risk (matches the catalog's Risk: L) and keeps engine.ts's ADR-04 instrumentation untouched. **Consequence to note, not paper over:** ADR-04's measure (`{templateId,kind,success,durationMs,timestamp,error?}`) is emitted inside `runExtraction` in engine.ts, *before* F10's post-processing step runs — a transform failure is therefore a distinct error surfaced at the tool-response layer and does not retroactively flip an already-emitted extraction measure. `preview_transform` (below) exists precisely to catch a bad spec before it's ever attached to a template, minimizing how often this edge case is hit live.

### 3.4 MCP tool signature (ADR-02 convention)

```ts
// src/tools/transform-tool.ts
export function registerPreviewTransformTool(server: McpServer, deps: Record<string, never>): void {
  server.tool(
    "preview_transform",
    { sampleData: z.unknown(), spec: TransformSpecSchema },
    async ({ sampleData, spec }) => {
      try {
        const result = applyTransform(sampleData, spec);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Transform error: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
```

`register_extraction_template`'s existing shape gains one optional field: `transform: TransformSpecSchema.optional()`. No new tool is needed for "apply on register" — it rides the existing tool.

### 3.5 Worked example (also the Acceptance-criteria #1 fixture)

```
input:  { "prod_name": "Widget", "raw_price": "19.99", "sku_internal_code": "X1", "_debug": "x" }
spec:   { version: 1, ops: [
           { op: "rename", from: "raw_price", to: "price" },
           { op: "coerce", field: "price", to: "number" },
           { op: "pick",   fields: ["prod_name", "price"] },
           { op: "rename", from: "prod_name", to: "name" },
         ] }
output: { "name": "Widget", "price": 19.99 }
```

Array case (the `map` op): `applyTransform([{prod_name:"A",raw_price:"1"}, {prod_name:"B",raw_price:"2"}], {version:1, ops:[{op:"map", ops:[{op:"rename",from:"raw_price",to:"price"},{op:"coerce",field:"price",to:"number"}]}]})` → `[{prod_name:"A",price:1},{prod_name:"B",price:2}]`.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document; conformance to ADR-01/02/03 checked at G0. |
| S1 Types | Applicable | `TransformOpSchema`/`TransformSpecSchema` in `transform.ts`; `ManifestEntry.transform?` in `types.ts`. |
| S2 Storage | **N/A** | No new storage function — the optional field rides through `storage.ts`'s existing `ManifestEntry` persistence unchanged (same path already used for `outputSchema?`). |
| S3 Core | Applicable | `applyTransform` + `pick`/`rename`/`coerce`/`map` handlers + `TransformError`, pure, in `transform.ts`. |
| S4 Module | Applicable | `src/tools/transform-tool.ts` (new), `registerPreviewTransformTool`. |
| S5 Wiring | Applicable | One appended call + `transform` field on `register_extraction_template`'s shape + a post-processing step on its result, all in `index.ts`. |
| S6 Unit | Applicable | `src/transform.test.ts` (see §7). |
| S7 Verify | **N/A as a gate** | F10 has no Lv/G6 gate (pure logic, no browser). See §7 for the optional non-gating smoke check. |
| S8 Docs | Applicable | README + `using-apimemcp` SKILL.md gain a "Transforms" section: op reference + the §3.5 worked example. |
| S9 Review | Applicable | G2 Code-Review + G3 Arch (Ar flag set). |
| S10 Live | **N/A** | No G6 for this feature — quality-gates.md: "Pure-logic engine features skip G6." |
| S11 Merge | Applicable | G7 Integration; ordinary append-only merge, conflict-free per ADR-02. |

## 5. Dependencies & sequencing

- **Hard deps:** ADR-03 (Accepted, Phase 0 — locked) for the type/op-set contract; ADR-02 for the tool-module shape. No F## feature is a hard prerequisite — the catalog's Deps column for F10 is `ADR-03` only.
- **Soft ordering:** land after F00 (wave 0 — establishes the `registerXxxTool` pattern this feature follows) and after F01 (wave 1 — `register_extraction_template`/`execute_native_extraction` are the first tools retrofitted to ADR-02 "as F00/F01 land," per ADR-02's own consequences; F10's small shape/post-processing addition to that same handler is cleanest once that retrofit has already happened). Wave 2 already sequences this correctly.
- **What it unblocks:** **F09** (wave 4, bidirectional flows) — hard dep (`F09`'s catalog row lists `F07,F10`) — reuses `applyTransform` unchanged to shape read-A output into B's write payload, per ADR-03's own text ("same applier... same spec, reverse direction"). Soft/design dependents per ADR-03's dependents table: **F25** (wave 5, OpenAPI+client export — describes the output mapping in the generated client), **W05** (web run console — applies/previews a transform on live results in-browser), **M04** (mobile run+result views — reshapes results for JSON/table/image views on device). These three consume the published `TransformSpec`/`applyTransform` shape (via ADR-06 published types for Program 2) rather than being catalog hard-Deps on F10.
- **Wave:** 2 (alongside F02, F16, F22, F23).

## 6. Quality gates

**Applicable:** G0 Spec → G1 Build → G2 Code-Review → **G3 Arch** (Ar flag: transform.ts stays pure/no-IO/total; op set stays exactly `pick`/`rename`/`coerce`/`map` — reject any PR that grows it speculatively per ADR-03's explicit ceiling comment; new tool follows ADR-02; `index.ts` touched only by append + the existing tool's own shape/return path, never another tool's block) → G5 QA (unit) → G7 Integration → G8 Promote.

**Skipped, with reason:** G3b Design (non-UI feature) · G4 Security (F10 is not in the flagged list — F00/F04/F06/F11/F12/F13/F16/F18/any-X — and touches no secrets/sandbox/network) · G6 Live/Device-Verify (Lv not set in F10's gate column; pure-logic engine feature, per quality-gates.md's explicit skip rule).

**Definition of Done:**
1. `src/transform.ts` exports the zod schemas/types + pure `applyTransform`; zero IO; unit-tested for all four ops plus error cases.
2. `ManifestEntry.transform?` wired in `types.ts`; every pre-existing template (no `transform` field) behaves exactly as before (back-compat, mirrors ADR-01).
3. `register_extraction_template` accepts an optional `transform`; a stored transform is applied to `execute_native_extraction`'s result before it's returned to the caller.
4. `preview_transform` registered via `registerPreviewTransformTool(server, {})` in its own module, appended in `index.ts` per ADR-02.
5. G3 Architect sign-off (purity, op-set ceiling, ADR-02 conformance); full Vitest suite green; `npm run build` clean.

## 7. Test plan

`src/transform.test.ts` (Vitest, browser-free):
1. `pick` keeps only the named fields, drops the rest.
2. `rename` renames a key, preserves the value, removes the old key.
3. `coerce` happy path for each target (`string`/`number`/`boolean`/`date`, the last producing an ISO-8601 string).
4. `coerce` on an uncoercible value (e.g. `"abc"` → `number`) throws `TransformError` with a descriptive message.
5. `map` over an array applies the nested ops to every element and returns a new array; the input array/objects are unchanged (immutability check via reference/deep-equal comparison).
6. `map` applied when the current value is *not* an array throws `TransformError`.
7. `pick`/`rename`/`coerce` applied directly to an array (no wrapping `map`) throws `TransformError`.
8. Full multi-op pipeline matches §3.5's worked example exactly, for both the object case and the array/`map` case.
9. `ops: []` is the identity function (unchanged `data`) — the "no transform declared" back-compat case.
10. Zod rejects a malformed spec (unknown `op`, missing required field per op, `version` other than `1`).

**`scripts/verify-F10.mjs`: N/A.** F10 has no G6/Lv gate — `applyTransform` is pure logic with no browser surface, so a Playwright verify script would add ceremony without adding signal. The one genuinely engine-adjacent bit (index.ts's post-processing step) is exercised as a plain Vitest case against a fake `ManifestEntry` + fake extraction result — no real browser needed. If the team later wants defense-in-depth, a thin script could register a real template with a `transform` attached, run `execute_native_extraction` against the repo's existing fixture target, and diff the shape — optional, not required for DoD.

## 8. Acceptance criteria (live, observable proof)

1. `applyTransform(...)` on the exact §3.5 input/spec returns exactly `{ "name": "Widget", "price": 19.99 }` — runnable as the first assertion in `transform.test.ts` or as a one-off `node`/`tsx` snippet.
2. Register a template with a `transform` block via `register_extraction_template`, run it via `execute_native_extraction` against fixture/live data — the returned result shows renamed/picked/coerced fields, not the raw shape; reading the template back (existing storage read path) round-trips the `transform` block unchanged.
3. Call `preview_transform` directly (MCP client or a quick stdio script) with arbitrary sample JSON + a spec — get the transformed JSON back with **no** template registered first, proving the dry-run/iterate-then-attach loop works standalone.
4. A deliberately bad spec (e.g. `coerce` a non-numeric field to `number`) surfaces a clear, catchable error — `isError: true` + message from `preview_transform`, and a normal tool error (not a crash, not silently-corrupted data) from `execute_native_extraction` when the bad spec is attached to a real template.

## 9. Reuse notes

- **Mirror, don't duplicate, ADR-01's `validateOutput` pattern.** Same discipline (pure, zod-backed, no IO, optional field with back-compat) — F10 is its sibling for reshaping instead of validating. Do not invent a second validation-error convention; follow whatever shape ADR-01/F01 already established for zod-parse failures on tool inputs.
- **`register_extraction_template`'s existing storage path** (already calls through to `storage.ts`'s persistence) is reused untouched — F10 only widens the input shape and lets the existing save path carry the new field. No new file-write/atomicity/locking code.
- **Explicitly NOT used, and why:** `captureForensics` (no DOM/browser surface here), `atomicWriteFile`/`withLock` (no new file writes — S2 is N/A), `findTemplateByUrl` (F10 doesn't look up templates, only reshapes their output), `buildStandaloneScript` (unrelated — that's the crystallization/export path, not reshaping). Listing these as explicitly out-of-scope is deliberate: don't go looking for a reason to wire them in.

## 10. Skills (setup + when-to-use)

- **`context7-mcp`** — fallback per the skill-quality bar (no ≥1K-install reputable skill exists for "author a zod discriminated-union schema"; this is exactly the documented context7-fallback case, same as Cloudflare/serverless-Chromium being rejected elsewhere in this plan). Pull live Zod docs for discriminated-union + `z.record`/`z.union` syntax before writing §3.1's schema (guides **S1 Types**).
- **`using-apimemcp`** (already available, no install) — read for the current tool-calling/registration conventions before extending `register_extraction_template`'s input shape and wiring the new tool (guides **S4 Module**, **S5 Wiring**).
- **`.agents/skills/` disciplines** (already available, no install): *test-driven-development* — write §7's cases before/alongside `applyTransform` (guides **S6 Unit**); *code-simplification* — actively resist growing the op set past `pick`/`rename`/`coerce`/`map` (guides **S3 Core**, enforced at **S9**/G3 per ADR-03's explicit ceiling); *spec-driven-development* — implement against this document + ADR-02/ADR-03 verbatim, no scope drift (guides **S0**, **S9**).
