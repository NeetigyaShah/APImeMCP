# F08 — CEL Conditional Branching

## 1. Summary

- **ID/Name:** F08 — CEL conditional branching
- **Pillar:** C (fabric) · **Wave:** 3 · **Risk:** M · **Gates:** Ar, Lv (no Se — no new untrusted-input or auth surface; no Design — no UI)
- **What:** Port Kriya's CEL (Common Expression Language-style) evaluator into the engine so a template's action sequence can branch on **live page state** (extracted vars, response status, DOM presence) instead of being a single rigid script.
- **Why (tied to 00-vision):** the vision's core moat is "determinism vs computer-use" — a template is solved once and then runs deterministically forever. Real pages aren't static, though: stock/sold-out, logged-in/out, paginated/single-page, cookie-banner-present/absent. Today each variant needs either a second template or a fallback to slow/costly computer-use. F08 lets **one** deterministic template correctly branch on the state it actually observes, keeping it a single portable artifact — directly strengthening the template as "a portable, versioned, verified unit of programmatic access" and feeding the mobile-monitor wedge (X05/M05: "price dropped" vs "still in stock" is exactly a branch on live state).

## 2. User/agent story

As an agent that just crystallized a scraping script for a product page (via F05/F06), I want the *same* template to correctly report "in stock" vs "sold out" — or follow a "load more" link only when it exists — without authoring two templates or invoking computer-use for the different-looking cases, so the template stays one deterministic artifact the registry (F03), the pipeline runner (F07), and the mobile monitor (X05) can all rely on.

As the self-healing agent (F04), I want minor page variance (a cookie-consent banner that sometimes renders) to be a branch inside the existing script, not a drift false-positive, so F02's diff stays meaningful.

## 3. Design

**ADRs obeyed / not triggered (checked against the ADR table's "Depended on by" column — F08 appears in none of them):**
- **ADR-02 (tool-module convention): not triggered.** F08 registers **no new MCP tool** and does **not** touch `D:/MCP/src/index.ts` — confirmed by the catalog's own Modules column (`cel-eval.ts (new), engine, types` — no `index`). Branching is authored *inside* the existing `executableScript` string that `register_extraction_template` already accepts; the tool's Zod input shape (`templateId`, `domainPattern`, `executableScript`, `fixedTargetUrl?`, `readySelector?`, `waitStrategy?`) is **unchanged**.
- **ADR-01 (schema contract): not triggered.** F08 changes control flow *inside* a run, not the shape of `ManifestEntry.outputSchema?` or `validateOutput`. A branch's final extracted value still goes through whatever output-schema validation ADR-01 already applies once F01 lands — nothing here bypasses it.
- **ADR-04 (metrics measure-model): reused, not extended.** A thrown CEL parse/evaluation error propagates as the run's existing failure and lands in the single `runExtraction` measure's `error` field. F08 adds **no second instrumentation point**.
- **Structural precedent:** F08 mirrors the pattern ADR-03 establishes for F10 (`TransformSpec` + pure `applyTransform(data, spec)` in a new standalone `src/transform.ts`, hooked from one call site) — a new pure, dependency-free module plus a single hook in the module that already owns execution. F08 is the same shape: `src/cel-eval.ts` (pure) + one hook in `src/engine.ts`.

**Exact module-by-module changes:**

1. **`D:/MCP/src/cel-eval.ts` (new, pure — no IO, no Playwright import).**
   ```ts
   export interface CelContext {
     vars: Record<string, unknown>;              // values the script itself recorded via setVar()
     page: { url: string; status?: number; title?: string };
     lastResult?: unknown;                        // return value of the previous awaited script statement, if captured
   }

   /** Evaluate a CEL-subset boolean expression against ctx. Throws CelSyntaxError on malformed input. */
   export function evaluateCel(expression: string, ctx: CelContext): boolean
   export class CelSyntaxError extends Error {}
   ```
   Ported subset (deliberately smaller than full Google CEL — matches Kriya's original scope, not a general expression language):
   - Literals: numbers, `'single'`/`"double"` strings, `true`/`false`, `null`.
   - Dotted identifier paths resolved against `ctx`: `vars.count`, `page.status`, `lastResult.ok`.
   - Operators: `==  !=  <  <=  >  >=  &&  ||  !`, parens for grouping.
   - `in` membership (`"gold" in vars.tags`) and `has(path)` (path resolves to a non-`null`/non-`undefined` value).
   - No arithmetic, no ternary, no function calls beyond `has()`. `// ponytail: intentionally the Kriya subset, not full CEL — add arithmetic/ternary only if a real template needs it.`
   - Implementation: small hand-rolled tokenizer + recursive-descent parser + evaluator (~150-200 LOC), ported/adapted from Kriya's evaluator logic rather than re-derived from the CEL spec, and **no new npm dependency** (rung 5 of the reuse ladder: nothing already installed solves this, and the ask is explicitly a *port*, not "pick a library").

2. **`D:/MCP/src/types.ts` (modified).** Add and export the `CelContext` interface (plain interface, not Zod — it's an internal runtime shape assembled by `engine.ts` each call, never user input that needs parsing, consistent with ADR-01's "or new pure src/schema.ts" allowance for non-Zod internal shapes). No changes to any Zod-validated tool-input schema, no new `ManifestEntry` field — out of scope per the catalog's Modules column.

3. **`D:/MCP/src/engine.ts` (modified — one hook).** Locate the single place `executableScript` is invoked against the live Playwright `page` (there is exactly one call site — the 4-module separation holds, `engine.ts` is the sole Playwright module). Bind two additional helpers into that script's execution scope, alongside whatever `page`/existing helpers are already bound:
   ```ts
   // inside the existing script-sandbox invocation in engine.ts
   const vars: Record<string, unknown> = {};
   let lastResult: unknown;
   const cel = (expression: string): boolean =>
     evaluateCel(expression, { vars, page: { url: page.url(), status: lastStatus, title: /* live */ undefined }, lastResult });
   const setVar = (name: string, value: unknown): void => { vars[name] = value; };
   const getVar = (name: string): unknown => vars[name];
   ```
   `page.url()`/title are read live from Playwright at each `cel()` call (never cached), so a condition always reflects current state. A registered script can now do:
   ```js
   await page.goto(targetUrl);
   setVar('count', await page.locator('.item').count());
   if (cel('vars.count > 0')) {
     await page.click('.load-more');
   } else {
     return { empty: true };
   }
   ```
   No structural change to how scripts are stored or invoked — `executableScript` is still one JS string; `cel`/`setVar`/`getVar` are just three more names in its scope, exactly like any existing bound helper.

**No MCP tool / HTTP route / app screen is added or changed by F08** — this is the one explicit deliverable of the "not triggered" ADR-02 finding above; sibling engine features that *do* add a tool follow `registerXxxTool` in `src/index.ts`, F08 does not.

## 4. Sub-tasks (S0–S11)

| # | Task | Applicable? | Note |
|---|---|---|---|
| S0 Spec | This document | Applicable | — |
| S1 Types | `CelContext` interface in `types.ts` | Applicable | Interface only, no Zod, no `ManifestEntry` field |
| S2 Storage | — | **N/A** | No new persisted shape; nothing about a script's use of `cel()` needs to be stored |
| S3 Core | `cel-eval.ts` tokenizer/parser/evaluator | Applicable | The ported evaluator itself |
| S4 Module | `engine.ts` sandbox hook (`cel`/`setVar`/`getVar` binding + live `CelContext` assembly) | Applicable | Single call-site change |
| S5 Wiring | `index.ts` tool registration | **N/A** | No new tool; `index.ts` untouched |
| S6 Unit | `cel-eval.test.ts` operator-matrix cases | Applicable | Pure, no Playwright |
| S7 Verify | `scripts/verify-F08.mjs` + fixture | Applicable | Engine/browser-touching |
| S8 Docs | README/SKILL note: two injected helpers + one example | Applicable | Small |
| S9 Review | G2 code review | Applicable | Always-on |
| S10 Live | G6 live-verify run | Applicable | Matches Lv gate |
| S11 Merge | G7 integration | Applicable | Always-on |

**% complete = done ÷ 10 applicable** (S2, S5 excluded).

## 5. Dependencies & sequencing

- **Hard feature-ID deps: none.** The catalog lists F08's dep as `action-seq` (the pre-existing action-execution code path already inside `engine.ts`), not another `F##` — F08 is a leaf add-on to code that already exists today, not blocked on any other feature landing first.
- **Unblocks:** nothing is declared dependent on F08 in the catalog (checked every row's Deps column — none cite F08). It is informally composable with **F07** (template pipelines/DAG — a pipeline step could use `cel()` inside its script) and **F09** (bidirectional flows, wave 4) but neither has a hard dependency on it, so F08 does not gate their start.
- **Wave:** 3, alongside F04, F06, F07, F11, F15. No intra-wave ordering constraint — F08 can be picked up by any free Engine Builder lane independent of the other Wave-3 features' progress (unlike F04, which needs F02+F03+F05 first).

## 6. Quality gates

Pipeline: `G0 Spec → G1 Build → G2 Code-Review → G3 Arch → G5 QA → G6 Live-Verify → G7 Integration → G8 Promote`. (`G3b Design`, `G4 Security` skipped — no UI, no new untrusted-input/auth surface.)

- **G3 Arch (Ar):** confirm 4-module separation intact (`cel-eval.ts` is pure, no Playwright import); confirm `index.ts` genuinely untouched (the ADR-02 "not triggered" claim above); confirm no Zod tool-input schema changed.
- **G6 Live-Verify (Lv):** `scripts/verify-F08.mjs` against a real Playwright browser and local fixture proves a branch actually changes behavior based on live DOM state (not just that the evaluator unit-tests pass in isolation).

**Definition of Done:**
- `evaluateCel` covers the documented operator subset with a full unit matrix, including a thrown `CelSyntaxError` on malformed input.
- `engine.ts` binds `cel`/`setVar`/`getVar` at the one script-invocation site; `CelContext.page` is read live (not cached) on every call.
- Zero changes to `index.ts`, to any Zod tool-input schema, or to `ManifestEntry`.
- `scripts/verify-F08.mjs` demonstrates two different live states of the same fixture producing two different branch outcomes from one unchanged script.
- Pre-existing templates that never call `cel(...)` are byte-for-byte unaffected (regression-checked).

## 7. Test plan

**`D:/MCP/src/cel-eval.test.ts` (Vitest, pure/no-browser):**
| Case | Expression | Context | Expected |
|---|---|---|---|
| equality true/false | `vars.count == 3` | `{vars:{count:3}}` / `{vars:{count:2}}` | true / false |
| numeric compare | `vars.count > 0 && vars.count < 10` | `{vars:{count:5}}` | true |
| string literal | `page.title == 'Sold Out'` | matching / non-matching title | true / false |
| logical or/not | `!(vars.a == 1) \|\| vars.b == 2` | mixed | per truth table |
| `in` membership | `"gold" in vars.tags` | `{vars:{tags:['gold','silver']}}` | true |
| `has()` presence | `has(lastResult.ok)` | defined / `undefined` | true / false |
| nested path | `page.status == 200` | `{page:{url:'',status:200}}` | true |
| malformed expression | `vars.. ==` | any | throws `CelSyntaxError` |
| unknown identifier | `vars.missing == 1` | `{vars:{}}` | resolves to `undefined`, comparison false (no throw) |

**`D:/MCP/scripts/verify-F08.mjs` (real Playwright, engine-touching per repo convention):**
- Serves `D:/MCP/scripts/fixtures/f08-branching.html`, a static page whose "load more" button and stock badge are toggled by a query param (`?stock=1` vs `?stock=0`).
- Registers one template whose `executableScript` uses `setVar` + `cel(...)` to pick a branch.
- Runs `execute_native_extraction` twice — once per query-param state — asserts the two runs return **different** result shapes/values, proving the branch tracked live state rather than being hardcoded.
- Runs one **pre-F08-style** fixture template (no `cel()` call) through the same path and asserts output is identical to its pre-F08 baseline (non-regression).

## 8. Acceptance criteria

1. `npm run build` clean.
2. `npx vitest run src/cel-eval.test.ts` — all operator-matrix cases green, including the malformed-expression throw case.
3. `node scripts/verify-F08.mjs` — live run against the local fixture: state A (`?stock=1`) takes the "click load-more" branch, state B (`?stock=0`) takes the "return empty" branch, same template/script both times — printed proof of both branch outcomes.
4. Regression run of an existing non-CEL fixture template through `execute_native_extraction` returns output identical to its pre-F08 baseline.
5. `git diff` for the PR touches only `D:/MCP/src/cel-eval.ts` (new), `D:/MCP/src/cel-eval.test.ts` (new), `D:/MCP/src/engine.ts`, `D:/MCP/src/types.ts`, `D:/MCP/scripts/verify-F08.mjs` (new), `D:/MCP/scripts/fixtures/f08-branching.html` (new), and docs — **no** `index.ts` hunk.

## 9. Reuse notes

- **Reuse the existing `register_extraction_template` tool and its `executableScript` string field as-is** — the key reuse decision of this feature. No parallel "structured action-sequence" tool/type is introduced; branching is authored inline in the script agents already write via F05/F06.
- **`captureForensics`** (the screenshot+DOM-dump helper used by F02/F04's drift/self-heal flow) — reuse on `CelSyntaxError`/evaluation failure for debuggability rather than building a second error-capture path.
- **ADR-04's single `runExtraction` measure** — reuse its existing `error` field for CEL failures; do not add a second instrumentation point.
- **`atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`** — not needed by F08's own logic (no new persisted state), **except** `buildStandaloneScript`: if that helper serializes/wraps a script for standalone/offline export (e.g. for F18's hosted endpoint), it must also bind `cel`/`setVar`/`getVar` so exported scripts keep branching correctly outside the MCP server — call this out explicitly in the PR so the export path isn't silently left behind.

## 10. Skills (setup + when-to-use)

- **No ≥1K-install skill exists for "CEL" / "expression-language parsing"** — this is a from-scratch port task with no vendor doc surface to defer to (there is no official library being adopted; the reuse ladder already ruled out adding one). Per the skill-quality bar, the correct fallback here is not context7 either (nothing to look up) — it's the in-repo disciplines below.
- **`.agents/skills/incremental-implementation`** (already available, no install) — guides S3: land the tokenizer → parser → evaluator in small verifiable increments rather than one big-bang file.
- **`.agents/skills/test-driven-development`** (already available) — guides S6: write the operator-matrix table (section 7) before/alongside `cel-eval.ts`.
- **`.agents/skills/code-simplification`** (already available) — guides S3/S9: keep the ported subset exactly as small as Kriya's original (no speculative CEL features) and keep the `engine.ts` hook to the one call site.
- **`using-apimemcp`** (already available) — guides S4: understand the existing `register_extraction_template` / `execute_native_extraction` flow the new sandbox bindings must slot into without changing its signature.
- **`browser-testing-with-devtools`** (already available, `.agents/skills/`) — guides S7: building `scripts/verify-F08.mjs` and the toggle-state fixture against real Playwright.
