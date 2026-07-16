# F21 — NL→template one-shot

## 1. Summary

- **ID / Name:** F21 / "NL→template one-shot"
- **Pillar:** F (creative) · **Wave:** 5 (last — needs both hard deps fully merged)
- **Risk:** M · **Gates:** Ar only (no Se, no Lv — see §6)
- **Modules touched:** `index wrapper` only, per the catalog Modules column — this feature adds **zero new engine/storage/registry logic**. It is a thin orchestration module that composes F05's and F06's already-registered primitives behind one MCP tool, plus the one-line ADR-02 append to `src/index.ts`.

**What & why.** Today, turning a site into a usable community template requires an agent/dev to know which of two flows to invoke: F05's `renderPage`→write-script→dry-run→register (cheap, deterministic, static pages) or F06's computer-use crystallization (expensive, for sites that need login/clicks/pagination). F21 collapses that decision into a single request — literally **"make me an API for X"** — by wrapping both behind one tool that picks the cheap path first and falls back to computer-use only when the page/description demands it.

**Market angle (00-vision.md).** This is the friction-reducing capstone of the flywheel's first step: *"Agents/devs contribute templates ... instantly usable ... consumers run/monitor them."* Every target market in the vision (RPA replacement, financial/gov data, healthcare portals, competitive intel) starts with someone turning an un-APId screen into a template — F21 makes that onramp a single natural-language ask instead of a two-tool decision tree, directly realizing "a template is a portable, versioned, verified unit of programmatic access to a screen" with the lowest possible friction to mint one.

## 2. User/agent story

> As a calling agent (or a human directing one), I want to say *"make me an API for today's price and stock status on this product page"* and get back either a working, registered template I can immediately call via `execute_native_extraction`, or (if the site needs interaction) a guided hand-off into the computer-use flow that ends the same way — **without me having to know F05 and F06 exist as separate tools.**

## 3. Design

### 3.1 ADRs obeyed

- **ADR-02 (tool-module convention)** — directly depended on. New tool lives in its own module and is registered via `registerXxxTool(server, deps)`; `src/index.ts` gets exactly one appended call, nothing else.
- **ADR-01 (schema contract)**, indirectly via F05/F06 — F21 never computes or validates `outputSchema` itself; it only passes through whatever F05's/F06's own `registerTemplate` call already attaches to `ManifestEntry.outputSchema?`. If absent, no validation (back-compat), per ADR-01 as written.

### 3.2 Data shapes

`src/types.ts` (append — Zod lives centrally per the existing 4-module split: `types.ts` = Zod/interfaces):

```typescript
export const NlToTemplateInput = z.object({
  description: z.string().min(1).max(2000)
    .describe('What data/action you want, e.g. "get the price and stock status of this product"'),
  targetUrl: z.string().url(),
  templateId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional()
    .describe('Explicit id; omitted = slugified from description + domain'),
  mode: z.enum(['auto', 'render-first', 'computer-use']).default('auto'),
  cookieString: z.string().optional(),
  submitToRegistry: z.boolean().default(false),
  // present only on the second (resume) call:
  resumeToken: z.string().optional(),
  draftScript: z.string().optional(),          // render-first resume payload
  crystallizedRef: z.string().optional(),       // computer-use resume payload (F06 recording ref)
});
export type NlToTemplateInput = z.infer<typeof NlToTemplateInput>;

export interface NlToTemplateResult {
  phase: 'awaiting-script' | 'awaiting-computer-use' | 'done';
  templateId: string;
  domainPattern: string;
  pathTaken: 'render-first' | 'computer-use' | 'existing';
  registered: boolean;
  renderForensics?: unknown;      // F05's renderPage() output, phase 1 render-first only
  computerUseKickoff?: unknown;   // F06's kickoff pointer, phase 1 computer-use only
  outputSample?: unknown;
  outputSchema?: unknown;         // ADR-01 JSON Schema, passed through only, never computed here
  prUrl?: string;
  message: string;                // e.g. "Registered `acme-product-price`. Call execute_native_extraction({templateId:'acme-product-price', targetUrl:...})."
}
```

### 3.3 Module-by-module changes (exact paths)

- **NEW `src/tools/nl-to-template.ts`** — the entire feature body:
  - `export function registerNlToTemplateTool(server: McpServer, deps: NlToTemplateDeps): void` — registers MCP tool **`nl_to_template`** (Zod input = `NlToTemplateInput` above), matching the `registerXxxTool(server, deps)` convention every other tool-adding feature uses.
  - `export interface NlToTemplateDeps { renderPage: <F05's engine.ts export>; dryRunExtraction: <the core fn behind execute_native_extraction>; registerTemplate: <storage.ts>; findTemplateByUrl: <storage.ts>; crystallizeComputerUse: <F06's engine.ts export>; submitRegistryPr?: <F06's registry-client.ts export> }` — every dependency is an **existing** export added by F05/F06; F21 imports, never re-implements.
  - `export function slugifyTemplateId(description: string, targetUrl: string, existingIds: string[]): string` — pure, unit-testable: domain + first 3–4 slug words of `description`, deduped against `existingIds` with a `-2`, `-3` suffix on collision.
  - `export function pickPath(input: NlToTemplateInput, renderForensics: unknown): 'render-first' | 'computer-use'` — pure decision function: forces the explicit `mode` when not `'auto'`; otherwise `'computer-use'` when the description matches an interaction-verb heuristic (`/\b(log ?in|sign ?in|click|add to cart|paginate|checkout|submit)\b/i`) or `renderForensics` signals an auth-wall/empty body; else `'render-first'`.
  - Handler logic (two-call protocol over the *existing* F05/F06 multi-turn contracts — F21 does not change how either works, it only decides which one to start and remembers the correlation across the two calls):
    1. **Call 1** (no `resumeToken`): if `findTemplateByUrl(targetUrl)` already exists → short-circuit, return `{phase:'done', pathTaken:'existing', registered:true, ...}` without touching `renderPage`/`crystallizeComputerUse` (reuse-first, avoids duplicate work). Else resolve `templateId` (input or `slugifyTemplateId`), call `deps.renderPage(targetUrl, {cookieString})`, run `pickPath`, and return phase `awaiting-script` (render-first) or `awaiting-computer-use` (computer-use) with `resumeToken = templateId` (ponytail: reuse the id you already minted as the correlation token instead of a separate session store — add a real ephemeral cache only if concurrent same-URL flows ever collide in practice).
    2. **Call 2** (`resumeToken` present): render-first → `deps.dryRunExtraction({templateId, targetUrl, executableScript: draftScript, cookieString})`; on success `deps.registerTemplate(...)`; **on failure, do NOT register — return a fresh `phase:'awaiting-computer-use'` suggestion** (this failure-triggered escalation is the one genuinely new piece of logic F21 contributes). computer-use → delegate wholesale to `deps.crystallizeComputerUse({templateId, crystallizedRef, ...})`, which already does its own dry-run+register per F06. If `submitToRegistry`, call `deps.submitRegistryPr?.(templateId)` and attach `prUrl`. Return `phase:'done'`.
- **EDIT `src/index.ts`** — one appended line per ADR-02: `registerNlToTemplateTool(server, { renderPage, executeExtraction, registerTemplate, findTemplateByUrl, crystallizeComputerUse, submitRegistryPr });` (wire the real imports F05/F06 already added). No other change to this file.
- **EDIT `src/types.ts`** — append `NlToTemplateInput`/`NlToTemplateResult` only. No change to any existing type.
- **NOT touched:** `engine.ts`, `storage.ts`, `registry-client.ts`, `dashboard.ts` — the catalog's Modules column says "index wrapper" precisely because every primitive F21 needs already exists by Wave 5 courtesy of F05/F06.
- **EDIT `README.md`** — one new row/section documenting the `nl_to_template` tool next to the other 8+ tools.
- **EDIT `skills/using-apimemcp/SKILL.md`** — one short "one-shot template creation" usage note pointing at `nl_to_template` as the recommended entry point over calling F05/F06 directly.

### 3.4 Tool signature registered (ADR-02)

```
nl_to_template(input: NlToTemplateInput) -> NlToTemplateResult
```
Registered by `registerNlToTemplateTool(server, deps)` in `src/tools/nl-to-template.ts`. No new HTTP route, no new app screen (Program 1, server-only).

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `NlToTemplateInput`/`Result` appended to `src/types.ts`. |
| S2 Storage | N/A | No new storage; reuses `registerTemplate`/`findTemplateByUrl` from `storage.ts` unchanged. |
| S3 Core | Applicable | `slugifyTemplateId`, `pickPath`, and the two-call handler in `src/tools/nl-to-template.ts` — the only new logic in this feature. |
| S4 Module | Applicable | New `src/tools/nl-to-template.ts` per ADR-02. |
| S5 Wiring | Applicable | One-line append to `src/index.ts`. |
| S6 Unit | Applicable | `src/tools/nl-to-template.test.ts` — see §7. |
| S7 Verify | Applicable (lightweight, non-gating) | `scripts/verify-F21.mjs` + static fixture — see §7. Not a G6 requirement (Gates = Ar only); written anyway as cheap end-to-end confidence per the ponytail "leave one runnable check" rule. |
| S8 Docs | Applicable | `README.md` tool entry + `skills/using-apimemcp/SKILL.md` usage note. |
| S9 Review | Applicable | G2 code-review always applies. |
| S10 Live | N/A | G6 skipped — pure-logic wrapper feature (Gates column has no "Lv"); the browser-touching paths it delegates to were already live-verified under F05's and F06's own G6. |
| S11 Merge | Applicable | G7 integration, after F05 and F06 are both in `integration`. |

## 5. Dependencies & sequencing

- **Hard deps (feature IDs):** F05 (Wave 1 — needs `renderPage` + the dry-run-then-register pattern) and F06 (Wave 3 — needs the computer-use crystallization primitive + optional auto-PR). Both must be merged to `integration` first.
- **ADR deps:** ADR-02 directly (tool-module convention); ADR-01 indirectly, passed through only.
- **Wave:** 5 — correctly last, since it requires both hard deps fully landed, not just started.
- **Unblocks:** nothing in the F00–F25 catalog lists F21 as a dependency — it is a leaf/capstone feature for pillar F. It is a plausible future entry point for Program 2's W06 (Contribute flow) or mobile onboarding, but that is **not** a scheduled dependency here — noted only, not built.

## 6. Quality gates

Applicable: **G0** Spec (this doc) · **G1** Build (clean build, lint) · **G2** Code-Review (verify zero reinvention of F05/F06 logic — this is the single biggest review risk on a wrapper feature) · **G3 Arch** (Architect confirms: new module lives under `src/tools/`, `index.ts` stays append-only, `types.ts` gains only the two new shapes, no boundary erosion) · **G5** QA (unit suite green) · **G7** Integration (rebased onto an `integration` that already contains F05+F06) · **G8** Promote (wave 5 coherence).

N/A: **G3b** Design (no UI) · **G4** Security (Gates column has no "Se" — F21 never touches untrusted execution, secrets, or the sandbox itself; that surface is entirely F05's/F06's own G4 responsibility) · **G6** Live-Verify (Gates column has no "Lv" — pure-logic wrapper per the "Pure-logic engine features skip G6" rule).

**Definition of Done:** `nl_to_template` registered per ADR-02; zero lines added to `engine.ts`/`storage.ts`/`registry-client.ts`; `slugifyTemplateId`/`pickPath` are pure and unit-tested; the render-first failure path escalates to computer-use instead of registering a broken template; `npm run build` and the full Vitest suite are green; README + SKILL.md updated; merged to `integration` only after F05 and F06 are present.

## 7. Test plan

`src/tools/nl-to-template.test.ts` (Vitest, browser-free, all deps mocked/spied):
1. `slugifyTemplateId()` — valid `^[a-z0-9]+(-[a-z0-9]+)*$` output across varied inputs; collision → `-2` suffix.
2. `pickPath()` — plain description + healthy forensics → `'render-first'`; description with an interaction verb ("add to cart", "log in") → `'computer-use'`; auth-walled/empty forensics → `'computer-use'` even for a plain description; explicit `mode` always wins.
3. Handler short-circuits via `findTemplateByUrl` (mode `'auto'`) — asserts `renderPage`/`crystallizeComputerUse` are **never called**.
4. Phase-1 render-first — asserts `renderPage` called once, returns `phase:'awaiting-script'`, `resumeToken===templateId`, `registerTemplate` **not yet called**.
5. Phase-2 render-first success — `dryRunExtraction` then `registerTemplate` called once each; result `registered:true, pathTaken:'render-first'`.
6. Phase-2 render-first **failure** — `dryRunExtraction` rejects → `registerTemplate` **never called**; result re-offers `phase:'awaiting-computer-use'` (the core one-shot fallback behavior).
7. Phase-1 forced computer-use (`mode:'computer-use'`) — `renderPage` **never called**; `crystallizeComputerUse` kickoff invoked.
8. `submitToRegistry:true` — `submitRegistryPr` called once post-registration, `prUrl` attached; `false` (default) — never called.
9. Zod rejects malformed `targetUrl`/`templateId`; defaults (`mode:'auto'`, `submitToRegistry:false`) fill correctly.

`scripts/verify-F21.mjs` + `scripts/fixtures/f21-static-page.html` (lightweight, non-gating per §6): a trivial static single-product fixture with no auth/interaction, run end-to-end forcing `mode:'render-first'` — call 1 returns forensics + `awaiting-script`; a hand-authored 5-line extraction script is submitted as call 2's `draftScript`; asserts `registered:true` and that `execute_native_extraction({templateId, targetUrl})` immediately returns the expected sample value. Proves the wiring end-to-end without requiring a real network site or a real computer-use session.

## 8. Acceptance criteria

1. `nl_to_template({description:"get the current price and stock status", targetUrl:"https://example.com/product/123"})` returns, in one call, a `phase` + forensics/kickoff and a stable `templateId` matching `^[a-z0-9]+(-[a-z0-9]+)*$`.
2. Completing the resume call registers a template such that `execute_native_extraction({templateId, targetUrl})` — the real, existing tool — returns a value matching the description, with **no manual `register_extraction_template` call ever required**.
3. Re-invoking `nl_to_template` on the same `targetUrl` short-circuits to the existing template (`pathTaken:'existing'`); `renderPage`/`crystallizeComputerUse` are not re-invoked (call-count assertion).
4. A description implying interaction ("add this item to my cart and confirm the total") drives the computer-use path only — `renderPage` is never called for that input.
5. `npm run build` is clean and `git log` shows F21 merged only after F05 and F06 are present in `integration`.

## 9. Reuse notes

Everything F21 needs already exists by Wave 5 — this feature is composition, not invention:
- `renderPage` (F05, `engine.ts`) — phase-1 render-first forensics.
- `executeExtraction` / the core behind `execute_native_extraction` — phase-2 dry-run.
- `registerTemplate`, `findTemplateByUrl` (`storage.ts`) — registration + short-circuit reuse-check.
- `crystallizeComputerUse`, `buildStandaloneScript` (F06, `engine.ts`) — phase-1 kickoff + phase-2 finish for the interactive path.
- `submitRegistryPr` (F06, `registry-client.ts`) — optional auto-PR, only if `submitToRegistry`.
- `captureForensics`, `atomicWriteFile`, `withLock`, `validateOutput` (ADR-01) — reused **transitively** through the F05/F06 calls above; F21 never calls any of these directly.

## 10. Skills (setup + when-to-use)

This feature is 100% internal composition (no new external library, no browser/cloud vendor surface), so no external skill install applies — the ≥1K-install bar and the context7 fallback are both moot here. Setup is entirely the **already-available, no-install** disciplines from `08-skills-matrix.md`:
- `.agents/skills/spec-driven-development` + `documentation-and-adrs` — guides S0 (this spec must cite ADR-02 exactly, no scope drift beyond F21's catalog row).
- `.agents/skills/code-simplification` — guides S3/S9: the single biggest failure mode on a wrapper feature is silently re-implementing a slice of F05's or F06's logic instead of importing it; this skill is what the Code-Reviewer runs against the diff at G2.
- `.agents/skills/test-driven-development` — guides S6: write the `pickPath`/`slugifyTemplateId` pure-function tests first, since those are the only genuinely new logic.
- `using-apimemcp` (already available) — guides S8/S3: grounds the handler's two-call protocol in the real existing tool conventions (`execute_native_extraction`, `register_extraction_template` shapes) so `nl_to_template`'s contract feels native, not bolted-on.
