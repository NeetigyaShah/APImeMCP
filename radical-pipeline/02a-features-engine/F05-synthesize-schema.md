# F05 — synthesize_schema (agent-native)

## 1. Summary

- **ID** F05 · **Name** `synthesize_schema` (agent-native) · **Pillar** B (agent-native) · **Wave** 1 · **Risk** M · **Gates** Ar, Lv (no Se, no Design)
- **What.** A new MCP tool, `synthesize_schema`, that renders an unmapped page (`renderPage()` in `engine.ts`) and hands the raw forensics (HTML + screenshot) back to the **calling agent**. The agent — not the server — reads that content and writes an extraction script. The agent then dry-runs its draft script through an additively-extended `execute_native_extraction` (new optional `executableScript`/`outputSchema` fields, nothing persisted), and once satisfied, registers it via the existing `register_extraction_template` tool, unchanged.
- **Why (tied to 00-vision).** The vision's moat is "agent solves a site *once*, crystallizes the path into a template that runs deterministically forever" — F05 is the literal mechanism for the "solves it once" half for the simple, single-page case (F06 covers the harder multi-step/computer-use case). It is also the flywheel's first gear: "agents/devs contribute templates" only has a concrete tool surface once F05 exists. **Agent-native, not autonomous**: the server holds no LLM key and writes no script itself — it only gives the calling agent eyes (render) and a safe sandbox to test a hypothesis (dry-run). That is why F05 carries no Se gate: the trust boundary is identical to today's `execute_native_extraction` (agent-supplied URL/script/cookies), nothing new is persisted, and there is no auto-registration.

## 2. Story

*As the calling agent (e.g. Claude driving APImeMCP over MCP), when I hit a site with no matching template, I want to see what the page actually looks like, write my own extraction script against that real DOM, test the script safely before committing to anything, and then register it myself — without the server ever silently writing or auto-registering a template on my behalf.*

Concretely: call `synthesize_schema({ targetUrl })` → read back real HTML/screenshot → write a script body in my own reasoning → call `execute_native_extraction({ targetUrl, executableScript })` to dry-run it (no template exists yet, nothing is saved) → iterate until the extracted shape looks right → call the existing `register_extraction_template({ templateId, domainPattern, executableScript })` → the template now exists for every future call to `execute_native_extraction({ templateId })` or `({ targetUrl })` (via `findTemplateByUrl`).

## 3. Design

### 3.1 New engine primitive — reuse, don't reimplement forensics capture

`src/engine.ts` (additive exports only):

```ts
export interface PageForensics {          // shape owned by the existing captureForensics primitive (F04's row: "hand forensic DOM+old script to the calling agent") — reused as-is, not redefined
  html: string;
  screenshotPath?: string;
  url: string;
  capturedAt: string;                     // ISO timestamp
}

export async function renderPage(
  targetUrl: string,
  opts?: { cookieString?: string; proxyUrl?: string }
): Promise<PageForensics> {
  // Reuses the same page-launch path runExtraction already uses (context + cookieString + proxyUrl wiring),
  // navigates to targetUrl, then delegates capture to the EXISTING captureForensics(page) — no new
  // DOM/screenshot logic. renderPage is a thin "navigate, then reuse capture" wrapper.
}
```

`runExtraction` (the existing core runner named in ADR-04: *"One instrumentation point in `runExtraction` emits `{templateId,kind,success,durationMs,timestamp,error?}`"*) grows one additive field on its options bag — no new function, no duplicate execution path:

```ts
interface RunExtractionOpts {
  templateId?: string;          // existing
  targetUrl?: string;           // existing
  cookieString?: string;        // existing
  proxyUrl?: string;            // existing
  executableScript?: string;    // NEW — when set, SKIP findTemplateByUrl/manifest lookup entirely; run this script inline
  kind?: string;                 // ADR-04 measure tag; NEW value "synthesize-dry-run" alongside existing kinds
}
```

When `executableScript` is present, `runExtraction` never touches `storage.ts` / the manifest — it is a pure "navigate + eval script" call, tagged `kind: "synthesize-dry-run"` for the ADR-04 measure stream (so F14 metrics can distinguish real runs from dry-runs without any new plumbing).

### 3.2 New tool — `synthesize_schema` (render step)

Per ADR-02: own module, `registerXxxTool(server, deps)`, explicit `deps`.

`src/tools/synthesize-schema.ts`:

```ts
export interface SynthesizeSchemaDeps {
  renderPage: typeof renderPage;   // injected from engine.ts
}

export function registerSynthesizeSchemaTool(server: McpServer, deps: SynthesizeSchemaDeps) {
  server.tool(
    "synthesize_schema",
    {
      targetUrl: z.string().url(),
      cookieString: z.string().optional(),
      proxyUrl: z.string().url().optional(),
    },
    async ({ targetUrl, cookieString, proxyUrl }) => {
      const forensics = await deps.renderPage(targetUrl, { cookieString, proxyUrl });
      return {
        ...forensics,
        nextStep:
          "Write an extraction script body from this HTML, then call execute_native_extraction " +
          "with { targetUrl, executableScript } to dry-run it (nothing is saved). " +
          "When satisfied, call register_extraction_template to persist it.",
      };
    }
  );
}
```

`src/index.ts` — one appended line in the existing append-only list (ADR-02 already in force by Wave 1, retrofitted in F00):
```ts
registerSynthesizeSchemaTool(server, { renderPage });
```

### 3.3 Extended tool — `execute_native_extraction` (dry-run step, additive only)

Module: `src/tools/execute-native-extraction.ts` (its ADR-02 home post-F00 retrofit — if F00 has not yet moved it out of `index.ts`, apply the identical additive diff to that tool's existing inline block instead; do not restructure it as part of F05).

Additive Zod fields:
```ts
executableScript: z.string().optional(),        // NEW — inline dry-run script; bypasses template lookup when present
outputSchema: z.record(z.unknown()).optional(), // NEW — draft JSON Schema (ADR-01 shape) to validate the dry-run output against
```

Handler, additive branch at the top (existing `templateId`/`findTemplateByUrl` path is untouched below it):
```ts
if (input.executableScript) {
  const result = await runExtraction({
    targetUrl: input.targetUrl,
    executableScript: input.executableScript,
    cookieString: input.cookieString,
    proxyUrl: input.proxyUrl,
    kind: "synthesize-dry-run",
  });
  const schemaValidation =
    input.outputSchema && deps.validateOutput
      ? deps.validateOutput(result.data, input.outputSchema)   // ADR-01, pure, never throws
      : undefined;
  return { ...result, dryRun: true, schemaValidation };
}
// ...unchanged templateId / findTemplateByUrl path
```

`deps.validateOutput` is an **optional** dependency injection: F01 (same wave) owns the real implementation. If F01's PR hasn't landed yet when F05 merges, `deps.validateOutput` is simply `undefined` and `schemaValidation` is omitted — no hard coupling, no blocked merge.

### 3.4 Registration step — zero new code

The agent calls the **existing, unmodified** `register_extraction_template` tool (`registerTemplate` in `storage.ts`) directly. F05 does not touch it, does not wrap it, does not add a "confirm" step — that would duplicate a tool that already exists and already does exactly this.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | N/A | no new field on `ManifestEntry`/`types.ts` — `outputSchema`/`validateOutput` are owned and added by F01 (ADR-01); F05 only optionally *consumes* `validateOutput` via injected `deps` |
| S2 Storage | N/A | dry-run never persists; render never persists; registration reuses `storage.ts`'s existing `registerTemplate` path unchanged |
| S3 Core (engine) | Applicable | `renderPage()` + `runExtraction`'s additive `executableScript`/`kind` branch in `src/engine.ts` |
| S4 Module | Applicable | `src/tools/synthesize-schema.ts` (new); `src/tools/execute-native-extraction.ts` (additive edit) |
| S5 Wiring | Applicable | one appended `registerSynthesizeSchemaTool(server, deps)` call in `src/index.ts` |
| S6 Unit tests | Applicable | `synthesize-schema.test.ts` (new) + additive cases in `engine.test.ts` |
| S7 Verify | Applicable | `scripts/verify-F05.mjs` + fixture (engine/browser-touching) |
| S8 Docs | Applicable | README tool list + `using-apimemcp` SKILL.md gain a `synthesize_schema` entry; note the additive `execute_native_extraction` fields |
| S9 Review (G2) | Applicable | confirm no reinvented forensics/execution logic; diff stays to the two-touch-point design above |
| S10 Live-verify (G6) | Applicable | real Playwright run, not mockable — browser-touching feature |
| S11 Merge (G7) | Applicable | standard |

## 5. Dependencies & sequencing

- **Hard dep:** ADR-01 (schema contract shape — stable enough to code the optional `outputSchema`/`validateOutput` call against even before F01 physically merges).
- **Ordering dep (wave-implicit):** F00 (Wave 0) must land first — F05's tool wiring assumes ADR-02's `registerXxxTool`/append-only `index.ts` convention already applies, and its `execute_native_extraction` edit assumes that tool has already been retrofitted into its own module.
- **Soft/parallel dep:** F01 (same Wave 1) owns the real `validateOutput` implementation. F05 codes against it via optional dependency injection so the two can build in parallel; if F01 lags, F05 ships with `schemaValidation` simply omitted, and starts returning it the moment F01 merges — no re-open needed.
- **What F05 unblocks:** F06 (Computer-use crystallization, Wave 3) reuses `renderPage`/the dry-run path for the harder interactive/multi-step case. F21 (NL→template one-shot, Wave 5) wraps F05+F06 behind a single "make me an API for X" tool.
- **Wave:** 1.

## 6. Quality gates

Pipeline: `G0 Spec → G1 Build → G2 Code-Review → G3 Arch → G5 QA → G6 Live-Verify → G7 Integration → G8 Promote`. **G3b Design and G4 Security do not apply** — no UI surface, and no new trust boundary (same agent-supplied URL/script/cookie model as today's `execute_native_extraction`; nothing new persisted; no auto-registration).

**Definition of Done:**
- `renderPage()` returns real `PageForensics` (non-empty HTML) for a live URL, built entirely on the existing capture primitive (no duplicated DOM/screenshot logic).
- `execute_native_extraction` dry-run path (`executableScript` set) never writes to `storage.ts`/the manifest, and is tagged `kind: "synthesize-dry-run"` in the ADR-04 measure stream.
- `synthesize_schema` tool registered via `registerSynthesizeSchemaTool` per ADR-02, with explicit injected `deps`, appended as one line in `index.ts`.
- Full loop proven live: render → hand-written dry-run script → matching real registration → `execute_native_extraction({templateId})` reproduces the dry-run's output exactly.
- G3 Arch signs off: 4-module boundary intact, ADR-02 followed, no hidden cross-module imports in the new tool's handler.

## 7. Test plan

**`src/tools/synthesize-schema.test.ts`** (Vitest, browser-free, fake `deps` per ADR-02):
- No script drafted yet → calls `deps.renderPage(targetUrl, {...})`, returns the forensics bundle plus the literal `nextStep` hint.
- Propagates `cookieString`/`proxyUrl` through to `deps.renderPage` unchanged.
- Rejects a missing/malformed `targetUrl` (Zod validation) without invoking `deps.renderPage`.

**Additive cases in `src/engine.test.ts`:**
- `renderPage` delegates to `captureForensics` on the navigated page and returns its bundle plus `{ url }`; no new capture logic duplicated.
- `runExtraction({ executableScript, targetUrl })` executes the given script and **does not** call `findTemplateByUrl` / read the manifest.
- `runExtraction({ executableScript })` emits an ADR-04 measure with `kind: "synthesize-dry-run"`, `templateId: undefined`.

**Additive cases for `execute_native_extraction`'s handler test:**
- `executableScript` present + `outputSchema` present + `deps.validateOutput` injected → response includes `schemaValidation`.
- `executableScript` present + `outputSchema` present + `deps.validateOutput` **undefined** (pre-F01) → response omits `schemaValidation`, does not throw.
- `executableScript` present → response includes `dryRun: true`; storage mock receives zero write calls.

**`scripts/verify-F05.mjs`** (real Playwright, mirrors the existing `scripts/verify-*.mjs` convention) + a small static fixture page:
1. Call `synthesize_schema({ targetUrl: fixture })` over the live MCP server → assert non-empty `html`/`screenshotPath`.
2. Hand-write a trivial script (e.g. `return { title: document.title }`) and call `execute_native_extraction({ targetUrl: fixture, executableScript })` → assert the extracted value matches the fixture's known title; assert the manifest file's mtime is unchanged (nothing persisted).
3. Call `register_extraction_template` with that same script/id, then `execute_native_extraction({ templateId })` → assert output is byte-identical to step 2's dry-run result (proves dry-run/real-run parity — the core trust claim of this feature).

## 8. Acceptance criteria

Live, observable, against a running `node dist/index.js`:
1. `synthesize_schema({ targetUrl })` returns real, non-empty HTML and a screenshot path for a live page — not a stub.
2. `execute_native_extraction({ targetUrl, executableScript })` (no `templateId`) returns extracted data matching manual inspection of the page, **and** `templates/manifest`'s on-disk mtime is unchanged before/after the call.
3. Following up with `register_extraction_template` + `execute_native_extraction({ templateId })` reproduces the exact same output the dry-run predicted.
4. `outputSchema` passed alongside `executableScript` yields a `schemaValidation` field once F01 has merged `validateOutput` — absent (not erroring) if it hasn't.

## 9. Reuse notes

| Reused as-is | From | Why not reimplement |
|---|---|---|
| `captureForensics` | `src/engine.ts` (existing, used by F04's forensic hand-off) | `renderPage` is a thin navigate-then-capture wrapper around it — building a second DOM/screenshot capture path would duplicate exactly what F04 already needs. |
| `runExtraction` | `src/engine.ts` (existing core runner behind `execute_native_extraction`, per ADR-04) | Extended with one optional field (`executableScript`) rather than forked into a second "dry-run engine" — keeps ADR-04's single instrumentation point single. |
| `register_extraction_template` / `registerTemplate` | existing tool / `src/storage.ts` | The "register" arrow in F05's own catalog row is this exact existing tool — zero new code for this step. |
| `findTemplateByUrl` | existing (`storage.ts`) | Explicitly **bypassed**, not called, when `executableScript` is present — a dry-run must never accidentally match an unrelated registered template by domain pattern. |
| `validateOutput` | ADR-01 / F01 (`types.ts` or `schema.ts`) | Injected as an optional dependency rather than re-implemented, per ADR-01's "one pure validator" contract rule. |
| `atomicWriteFile`, `withLock` | existing (`storage.ts`) | **Not needed** — F05 introduces zero persistence; noted explicitly to head off adding locking machinery this feature has no use for. |

## 10. Skills (setup + when-to-use)

- **`.agents/skills` (already installed, 24-skill local library — `npx skills check` to confirm, no install needed):** `spec-driven-development` guided S0 (this spec); `incremental-implementation` + `test-driven-development` for S3/S4/S6 (write the `renderPage`/`runExtraction` extension and the new tool module test-first, in the smallest additive diff); `code-simplification` for S9 (the G2 reviewer's job is specifically to reject any temptation to add a third tool or a duplicate execution path — this spec's two-touch-point design is the target diff size).
- **`using-apimemcp` (already available locally):** guides S0/S3 — read how `register_extraction_template` and `execute_native_extraction` are actually driven end-to-end today so the new tool's contract (and the additive fields) match real agent usage rather than a guessed shape.
- **`context7-mcp` (already available locally):** for S3's `renderPage` implementation, pull live Playwright docs (page/context navigation, `page.content()`/screenshot APIs) — per the skills-matrix's own verified quality bar, community Playwright skills top out at 63 installs and are rejected, so this feature uses `context7` + official Playwright docs instead of an installed skill. One scoped query per concept (navigation vs. capture), not a combined query.
- **No new skills.sh package installed for F05.** Everything it touches (TS/Zod tool wiring, Playwright navigation, pure schema validation) is covered by the three always-available sources above; the skills-matrix's own bar (reject <100 installs, prefer ≥1K) has no reputable engine-specific candidate for this feature, so none is added.
