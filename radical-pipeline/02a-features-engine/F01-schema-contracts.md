# F01 — Schema contracts

## 1. Summary

- **ID / Name:** F01 — Schema contracts
- **Pillar:** A (reliability) · **Wave:** 1 · **Risk:** M · **Critical path:** ★ yes (ADRs → **F01→F02→F04**)
- **Gates:** Ar, Lv (no Se — F01 touches no secrets/untrusted input; it's pure validation logic)
- **Deps:** ADR-01 only (no feature-ID hard deps)

**What.** Every `ManifestEntry` (template) may declare an optional `outputSchema` (JSON Schema, stored inline). A new pure `validateOutput(value, schema)` checks each run's `data` against it. Absent schema = validation skipped, zero behavior change for every template registered before F01 exists.

**Why (tied to 00-vision's market angle).** 00-vision names "the moat = determinism vs computer-use" — a template that returns *some* JSON is not yet a deterministic API; a template whose output is checked against a declared shape every run is. Right now `ExtractionResult.data: unknown` (per ADR-01's Context) has zero machine-readable description of its own shape. That single gap blocks a whole column of downstream trust features: F02 has nothing to diff a live result against, F04 has nothing to re-verify a self-healed fix against, F11 has nothing to assert in a signed receipt, F25 has nothing to generate an OpenAPI response schema from, and Program 2's result views (W04/M04) have nothing to type or render against. F01 is the one primitive that makes "crystallize a site into a template" a *checkable* claim instead of an assertion — directly underwriting the compliance-grade-provenance and financial-data-aggregation target markets named in 00-vision, which need provable data shape, not "we scraped something."

## 2. User / agent story

- **As an agent authoring a template** (via F05 `synthesize_schema` or by hand), I declare the JSON Schema my extraction script's `data` will match, so every future run of my template is checked against that shape, and downstream consumers (F02 drift, F04 self-heal, F11 provenance, F25 export, W04/M04 views) can trust and type against it without re-deriving it.
- **As a template consumer** (human via web/mobile, or another agent via MCP), I call `execute_native_extraction` and see a `schemaValidation` result telling me whether this run's output still matches the template's declared contract — so I know if the target site silently changed shape, or the data is safe to render/pipe onward.

## 3. Design

**ADR obeyed:** ADR-01 (Schema contract), verbatim. Additive-optional-field precedent copied from `ManifestEntry`'s existing `waitStrategy`/`readySelector`/`source` fields. Contract rule enforced by G3 Arch: `validateOutput` must stay pure, total, no IO, never throw.

### Data shapes — `src/types.ts` (existing file, additive only)

```ts
export interface ManifestEntry {
  templateId: string;
  domainPattern: string;
  executableScript: string;
  fixedTargetUrl?: string;
  readySelector?: string;
  waitStrategy?: "domcontentloaded" | "load" | "networkidle";
  source?: string;
  // ...existing fields unchanged...
  outputSchema?: Record<string, unknown>; // NEW (F01) — JSON Schema object describing `data`'s shape.
                                           // Absent = validation skipped (ADR-01 back-compat). Persists
                                           // through the manifest like every other field, travels the
                                           // registry (ADR-06) for free.
}

export interface ExtractionResult {
  data: unknown;
  // ...existing fields unchanged...
  schemaValidation?: ValidationResult; // NEW (F01) — present only when the matched template has outputSchema.
}
```

### New pure module — `src/schema.ts` (new file, alongside `types.ts`)

```ts
import Ajv from "ajv";

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
// ponytail: recompiles the validator on every call, no compiled-schema cache.
// Upgrade to a Map<templateId, ValidateFunction> if verify-F01.mjs or F16's
// result-cache wiring ever shows ajv.compile() as measurably hot.

export function validateOutput(
  value: unknown,
  schema: Record<string, unknown> | undefined,
): ValidationResult {
  if (!schema) return { valid: true };
  try {
    const validate = ajv.compile(schema);
    if (validate(value)) return { valid: true };
    return {
      valid: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
      ),
    };
  } catch (err) {
    return { valid: false, errors: [`invalid outputSchema: ${(err as Error).message}`] };
  }
}
```

**Dependency choice (ADR-01 leaves this to F01):** `ajv` directly, not a json-schema→zod bridge. `outputSchema` is already stored as JSON Schema (the on-the-wire, cross-repo form ADR-06 needs); ajv validates that shape natively with zero lossy conversion and one small reputable dependency — exactly the alternative ADR-01 names. `npm install ajv` (new prod dep, no heavy sub-tree).

### Module-by-module changes (exact paths)

| Module | Change |
|---|---|
| `D:/MCP/src/types.ts` | Add `outputSchema?: Record<string, unknown>` to `ManifestEntry`; add `schemaValidation?: ValidationResult` to `ExtractionResult`; re-export `ValidationResult` from `./schema`. |
| `D:/MCP/src/schema.ts` | **New.** `validateOutput()` + `ValidationResult`, as above. Pure, no IO, no throw. |
| `D:/MCP/src/storage.ts` | **No code change.** `outputSchema` is just another `ManifestEntry` field; the existing `atomicWriteFile`-based manifest read/write already persists it generically. |
| `D:/MCP/src/engine.ts` | In `runExtraction` (the ADR-04 single instrumentation point), after `data` is produced and before the function returns: `const schemaValidation = entry.outputSchema ? validateOutput(data, entry.outputSchema) : undefined;` then include it on the returned `ExtractionResult`. One call site, hung off the existing instrumentation point — no parallel measurement path. |
| `D:/MCP/src/index.ts` | Thread the field through the two existing tool registrations (below). No new tool file — ADR-02's `registerXxxTool` convention already covers these two tools; F01 edits their zod schemas in place, does not add a new registration. |

### MCP tool signature deltas (ADR-02 convention — existing tools, no new tool)

`register_extraction_template` — input gains one optional field alongside the existing `templateId`, `domainPattern`, `executableScript`, `fixedTargetUrl`, `readySelector`, `waitStrategy`:

```ts
outputSchema: z.record(z.unknown()).optional() // NEW (F01) — JSON Schema for this template's `data`
```

`execute_native_extraction` — input (`templateId`, `targetUrl`, `cookieString`, `proxyUrl`) is **unchanged**; its resolved output gains one optional field:

```ts
schemaValidation?: { valid: boolean; errors?: string[] } // NEW (F01) — present iff the matched template has outputSchema
```

Back-compat: a template registered pre-F01 (no `outputSchema`) runs through `execute_native_extraction` with `schemaValidation` simply absent — identical wire shape to today.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `ManifestEntry.outputSchema?`, `ExtractionResult.schemaValidation?` in `types.ts`; `ValidationResult` in `schema.ts`. |
| S2 Storage | Applicable (no-op) | Zero new code — generic JSON manifest persistence in `storage.ts` already carries any new `ManifestEntry` field. |
| S3 Core | Applicable | `validateOutput()` in new `src/schema.ts`, backed by `ajv`. |
| S4 Module | Applicable | New pure module `src/schema.ts`; `npm install ajv`. |
| S5 Wiring | Applicable | `engine.ts` `runExtraction` call site; `index.ts` zod-schema edits on `register_extraction_template` (input) and `execute_native_extraction` (output). |
| S6 Unit | Applicable | `src/schema.test.ts` (new) + additions to `src/types.test.ts`. |
| S7 Verify | Applicable | `scripts/verify-F01.mjs` + fixture (engine/browser-touching). |
| S8 Docs | Applicable | README.md tool-param docs; `using-apimemcp` SKILL.md mention of `outputSchema`. |
| S9 Review | Applicable | G2 Code-Review. |
| S10 Live | Applicable | G6 Live-Verify (Gates = Ar **Lv**). |
| S11 Merge | Applicable | G7 Integration. |

## 5. Dependencies & sequencing

- **Hard deps:** ADR-01 only — must be locked in Phase 0 before this feature branch forks. No other feature ID blocks F01.
- **Unblocks:** F02 (drift detection diffs live shape vs this contract), F04 (self-heal re-verifies a fix against `outputSchema` before any registry PR), F11 (provenance receipt asserts "schema-valid"), F25 (OpenAPI + typed client generated from `outputSchema`), W04 (template detail page renders it as docs), M04 (mobile run/result views type and lay out from it).
- **Wave:** 1, alongside F05, F03, F14, F19 (after Wave 0 = F00 + ADRs). First link in the named critical path **F01→F02→F04**.

## 6. Quality gates

Applicable: G0 Spec, G1 Build, **G2 Code-Review**, **G3 Arch** (new module + `types.ts` shape change — boundary-sensitive), G5 QA, **G6 Live-Verify** (engine/Playwright-touching), G7 Integration, G8 Promote (wave-level). Skipped: G3b Design (no UI), G4 Security (F01 is not on the Security-Reviewer's explicit gate list — no secrets, no untrusted-input surface of its own).

**Definition of Done:**
- `ManifestEntry.outputSchema?` / `ExtractionResult.schemaValidation?` added additively; no existing test breaks; a template with no `outputSchema` behaves byte-identically to pre-F01.
- `validateOutput()` is pure, total, never throws (verified by a malformed-schema unit case), lives in `src/schema.ts`.
- `runExtraction` invokes it exactly once, only when `outputSchema` is present, and threads the result to `execute_native_extraction`'s output.
- `register_extraction_template` accepts the optional field; G3 Architect confirms the 4-module boundary is intact (no new cross-module coupling beyond the one `engine.ts → schema.ts` call).
- G6: `scripts/verify-F01.mjs` proves both a matching-schema pass (`valid: true`) and a mismatching-schema fail (`valid: false`, populated `errors`) against a real Playwright run.

## 7. Test plan

**`src/schema.test.ts` (new):**
- `validateOutput(anything, undefined)` → `{ valid: true }` (absent-schema back-compat).
- Value matching a simple object schema (`required`, `properties`, `type`) → `{ valid: true }`.
- Value missing a required property / wrong type → `{ valid: false, errors: [...] }` with a non-empty, human-readable `errors` array.
- Malformed schema itself (e.g. invalid `type` keyword) → never throws; returns `{ valid: false, errors: [...] }`.

**`src/types.test.ts` (existing file, add cases):**
- `ManifestEntry` round-trips `outputSchema` unchanged through whatever serialization/parse path the file already exercises for optional fields.
- `ExtractionResult` accepts an optional `schemaValidation` without breaking existing fixtures.

**`scripts/verify-F01.mjs` (new) + fixture:**
- Register a template (`register_extraction_template`) with a fixed `outputSchema` (e.g. `{type:"object", required:["title"], properties:{title:{type:"string"}}}`) against a local test fixture page (reuse the existing verify-fixture pattern under `scripts/`).
- Run `execute_native_extraction` → assert `schemaValidation.valid === true`.
- Re-run against a fixture variant whose script output violates the schema (e.g. `title` missing) → assert `schemaValidation.valid === false` and `errors.length > 0`.
- Run a template with no `outputSchema` at all → assert `schemaValidation` is `undefined` on the result (back-compat proof).

## 8. Acceptance criteria (live, observable proof)

- `npm run build` clean.
- `npx vitest run src/schema.test.ts src/types.test.ts` — all green.
- `node scripts/verify-F01.mjs` exits 0 and prints both the pass case (`valid: true`) and the fail case (`valid: false`, non-empty `errors`) to stdout.
- Live MCP call: `register_extraction_template` with an `outputSchema`, then `execute_native_extraction` against a real page whose output matches → response includes `schemaValidation: { valid: true }`. Point it at a page/script whose output no longer matches → `schemaValidation: { valid: false, errors: [...] }`.
- A template registered before F01 shipped (no `outputSchema` in its manifest entry) still runs via `execute_native_extraction` with no `schemaValidation` field in the response and no other observable change.

## 9. Reuse notes

- **`atomicWriteFile`** (storage.ts) — already the manifest write path; `outputSchema` rides through it for free, no new persistence code.
- **`registerTemplate` / `findTemplateByUrl`** (storage.ts/engine.ts) — unchanged; `outputSchema` is read through the existing `ManifestEntry` lookup, not a new lookup path.
- **The ADR-04 single instrumentation point in `runExtraction`** — F01 hangs its one validation call off that same point instead of adding a second measurement/hook path.
- **The `waitStrategy`/`readySelector`/`source` additive-optional-field precedent** on `ManifestEntry` — `outputSchema` copies that exact pattern; no new "is this field present" convention invented.
- Do **not** hand-roll JSON Schema validation or write a bespoke JSON-Schema→zod converter — one `ajv.compile()` + one `validate()` call, per ADR-01's named alternative.

## 10. Skills (setup + when-to-use)

- **`.agents/skills/test-driven-development`** (already installed, in-repo 24-skill library — no install step) — guides **S6**: write `schema.test.ts`'s valid/invalid/malformed/absent cases alongside `validateOutput`, not after.
- **`.agents/skills/spec-driven-development`** (already installed) — guides **S0/S4**: keep the new `src/schema.ts` module's boundary (pure, no IO) matched to this spec and ADR-01's contract rule before writing code.
- **`.agents/skills/code-simplification`** (already installed) — guides **S3/S9**: keep `validateOutput` to the minimal ajv-call shape above; resist adding caching, a schema registry, or a zod-bridge layer that nothing in F01's scope needs yet.
- **`context7-mcp`** — fallback for `ajv` itself: no ≥1K-install skills-marketplace skill exists for a narrowly-scoped validation library like ajv (same "no dedicated skill" bucket as the project's already-rejected Cloudflare/Playwright/serverless-Chromium candidates), so per the skill-quality bar, resolve-library-id `ajv` → query-docs "compile a JSON Schema and validate a value, collect all errors, strict mode off" before writing `src/schema.ts` — guides **S3**.
- **`using-apimemcp`** (already available per 08-skills-matrix) — guides **S7/S8**: keep `scripts/verify-F01.mjs` and the README/SKILL doc additions consistent with this repo's existing `verify-*.mjs` and tool-doc conventions rather than inventing a new format.
