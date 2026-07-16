# F06 — Computer-Use Crystallization

## 1. Summary

| Field | Value |
|---|---|
| ID | **F06** |
| Name | Computer-use crystallization |
| Pillar | B — agent-native |
| Wave | 3 (parallel with F04, F07, F08, F11, F15) |
| Risk | **H** |
| Gates | Ar · Se · Lv (all three — the widest gate set of any Wave-3 feature) |
| Deps | F05 (synthesize_schema / renderPage / dry-run-via-executeExtraction pipeline) |
| Modules touched | `engine.ts`, `storage.ts`, `registry-client.ts` (+ `types.ts` for shared shapes; F05's tool module extended, not replaced) |

**What.** An agent solves a previously-unmapped site the slow way — computer-use (vision + action loop, driving a real browser step by step) — exactly once. F06 turns that one solved run into a **recording** (a structured action trace), **crystallizes** it into a deterministic Playwright template (reusing F05's dry-run→register pipeline), and optionally opens a registry PR so every other agent/user benefits — but never auto-merges.

**Why (market angle, 00-vision).** This *is* the project's stated moat: "LLM computer-use is slow/costly/nondeterministic every run; APImeMCP is the complement — agent solves a site once, crystallizes the path into a template that then runs in ms deterministically forever, self-healing when the site changes." F06 is the literal mechanism behind that sentence, and it feeds the flywheel ("agents/devs contribute templates → instantly usable in web + app → usage signals which matter → coverage grows itself"). Without F06, "solve once, run forever" is a slogan; with it, computer-use sessions stop being throwaway cost and become permanent, versioned, free capacity.

## 2. User / agent story

> An agent is asked to fetch a value from `partsupplier.example.com/catalog` — no template exists (`findTemplateByUrl` returns nothing). The agent falls back to its own computer-use loop: screenshot, reason, click "Search", type a part number, screenshot, read the price off the rendered page. It succeeds, but it took 12 vision round-trips and would cost the same again next time.
>
> The agent then calls the (F05-registered, F06-extended) `synthesize_schema` tool with a `recording` — the sequence of steps it just took (`goto` → `fill` → `click` → `waitFor` → `extract`) — instead of a hand-authored `script`. F06 converts the trace into a standalone Playwright script, dry-runs it against the *same* live page via the existing `executeExtraction` path, confirms it reproduces the same price with zero vision calls, and registers it as `partsupplier-catalog-lookup`. The agent (or a human owner) can pass `autoPr: true` to propose it to the public registry. Every later call — by this agent or any other — runs in milliseconds, deterministically, with no computer-use step at all.

## 3. Design

### 3.1 Data shapes (`src/types.ts` additions)

```ts
// A single computer-use-loop step, generalized enough to cover the common
// primitives a vision+action agent performs (nav / type / click / wait / read).
export const ActionStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"),    url: z.string() }),
  z.object({ kind: z.literal("click"),   selector: z.string(), label: z.string().optional() }),
  z.object({ kind: z.literal("fill"),    selector: z.string(), value: z.string(), label: z.string().optional() }),
  z.object({ kind: z.literal("waitFor"), selector: z.string() }),
  z.object({ kind: z.literal("extract"), selector: z.string(), field: z.string(),
             attr: z.enum(["text", "href", "src"]).default("text") }),
]);
export type ActionStep = z.infer<typeof ActionStepSchema>;

export const ActionTraceSchema = z.object({
  targetUrl: z.string(),
  steps: z.array(ActionStepSchema).min(1),
  outputSchema: z.record(z.any()).optional(), // ADR-01 passthrough, optional, back-compat
});
export type ActionTrace = z.infer<typeof ActionTraceSchema>;

// Persisted audit record — distinct from a registered template; kept even if
// crystallization is abandoned, for forensics / re-attempt / dedupe.
export interface Recording {
  id: string;                      // uuid
  trace: ActionTrace;
  createdAt: string;                // ISO
  crystallizedTemplateId?: string;
  prUrl?: string;
}
```

### 3.2 ADRs obeyed / stayed compatible with

- **ADR-02 (tool-module convention) — obeyed by *not* adding a tool.** ADR-02's own per-feature dependency list (`F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25`) does **not** include F06, matching the catalog row's Modules column (no `index`). F06 therefore does **not** register a new `registerXxxTool`; it extends F05's already-ADR-02-compliant `synthesize_schema` tool module in place. `index.ts` only gains 3 new fields on the *existing* assembled `deps` object (see 3.3) — not a new append, so it carries near-zero merge-contention cost.
- **ADR-01 (schema contract)** — `ActionTrace.outputSchema` is optional and passed straight through to the same `ManifestEntry.outputSchema?` field F05 already writes; F06 adds no new validation logic.
- **ADR-06 (registry = cross-repo contract)** — `submitTemplatePR` (3.3) only ever proposes a standard `ManifestEntry`-shaped diff, the same shape ADR-06 already treats as the sole cross-repo contract; F06 doesn't widen or bypass it.

### 3.3 Module-by-module changes (exact paths)

- **`src/types.ts`** — add `ActionStepSchema`, `ActionTraceSchema`, `Recording` (3.1). Pure types/schemas only.
- **`src/engine.ts`** — add:
  - `crystallizeRecording(trace: ActionTrace): string` — pure-ish function; walks `trace.steps` and emits a standalone Playwright script body via the existing `buildStandaloneScript` helper (goto/click/fill/waitFor/extract → the same statements a hand-authored F05 script would contain). No new browser launch logic — the dry-run itself reuses F05's existing `executeExtraction(script, targetUrl)` call, unchanged.
  - If the target requires an authenticated profile, the dry-run may pass through F00's `launchPersistentContext` exactly as any other template run would — F06 adds no new auth path.
- **`src/storage.ts`** — add `saveRecording(rec: Recording): Promise<void>`, `loadRecording(id: string): Promise<Recording | null>`, `listRecordings(): Promise<Recording[]>`. Persist under `templates/recordings/<id>.json` via the existing `atomicWriteFile` primitive, serialized through the existing `withLock` mutex (same pattern as template registration) so concurrent crystallizations never corrupt the recordings index.
- **`src/registry-client.ts`** — add:
  ```ts
  export interface SubmitPrOptions { githubToken: string; branch?: string }
  export async function submitTemplatePR(entry: ManifestEntry, opts: SubmitPrOptions): Promise<{ prUrl: string }>
  ```
  Opens a branch + PR against `apimemcp-templates` (never pushes to `main`, never calls a merge endpoint). **Coordinate with F04** ("registry PR helper" in the same Wave 3): whichever of F04/F06 forks first implements this helper in `registry-client.ts`; the other imports it — do not let both hand-roll a GitHub-PR client.
- **F05's tool module** (extended, not created — exact path TBD at F05 merge time; this spec assumes `src/tools/synthesize-schema.ts` per ADR-02's `src/tools/` option) — extend the existing input shape additively:
  ```ts
  // F05 (existing, inferred from its catalog row):
  const SynthesizeSchemaInput = z.object({
    targetUrl: z.string().url(),
    script: z.string(),                          // agent-hand-authored
    outputSchema: z.record(z.any()).optional(),
    register: z.boolean().default(true),
  });

  // F06 (this feature) — additive, optional fields only:
  const SynthesizeSchemaInputV2 = SynthesizeSchemaInput.extend({
    recording: ActionTraceSchema.optional(),      // alternative to `script`
    autoPr: z.boolean().default(false),           // opt-in, never auto-merge
  }).refine(v => !!v.script || !!v.recording, { message: "one of script|recording required" });
  ```
  Handler: if `recording` present, call `crystallizeRecording(recording)` to produce the script, then fall into F05's existing dry-run → `registerTemplate` path unchanged; if `autoPr`, call `submitTemplatePR` after a successful local register.
- **`src/index.ts`** — **no new `registerXxxTool` append.** The one assembled `deps` object gains 3 fields (`crystallizeRecording`, `saveRecording`/`loadRecording`, `submitTemplatePR`); the existing `registerSynthesizeSchemaTool(server, deps)` call is untouched.

## 4. Sub-tasks (S0–S11)

| # | Sub-task | Applicable? | Note |
|---|---|---|---|
| S0 Spec | Yes | This document. |
| S1 Types | Yes | `ActionStep`/`ActionTrace`/`Recording` in `src/types.ts`. |
| S2 Storage | Yes | `saveRecording`/`loadRecording`/`listRecordings` in `src/storage.ts`. |
| S3 Core (engine) | Yes | `crystallizeRecording` in `src/engine.ts`; dry-run reuses F05's `executeExtraction` call as-is. |
| S4 Module (tool wrapper) | Yes | Extend F05's `synthesize_schema` tool module in place — no new tool file. |
| S5 Wiring (index.ts) | Yes, minimal | 3 new fields on the existing `deps` object only; no new append (ADR-02 — F06 not in its per-feature list). |
| S6 Unit (`*.test.ts`) | Yes | See §7. |
| S7 Verify (`verify-*.mjs`) | Yes | `scripts/verify-F06.mjs` + fixture — engine/browser-touching, Lv gate applies. |
| S8 Docs | Yes | README tool-docs update for the extended `synthesize_schema` shape; `using-apimemcp` SKILL.md gets a "computer-use crystallization" usage note. |
| S9 Review (G2) | Yes | Always. |
| S10 Live (G6) | Yes | Real Playwright fixture run — matches Lv gate. |
| S11 Merge (G7) | Yes | Always. |

## 5. Dependencies & sequencing

- **Hard dep:** F05 must be on `integration` first — F06 extends F05's tool module and reuses its `renderPage`/dry-run-via-`executeExtraction` pipeline verbatim.
- **Unblocks:** F21 (NL→template one-shot) explicitly wraps "F05+F06" per the catalog.
- **Wave 3 coordination:** shares `engine.ts`/`registry-client.ts` with F04. Land order: F05 → (F04 or F06, whichever forks first builds the shared `submitTemplatePR`/registry-PR helper) → the other reuses it. Any `index.ts` deps-object conflict with a sibling Wave-3 feature resolves by re-ordering the object's fields, never by merging handler bodies (ADR-02 §3).

## 6. Quality gates

- **G0 Spec** — Architect confirms this doc doesn't duplicate F05 and that `ActionTrace` doesn't collide with any future F01 schema work.
- **G1 Build** — clean build, lint.
- **G2 Code-Review** — confirms reuse of `buildStandaloneScript`/`registerTemplate`/`executeExtraction`/`findTemplateByUrl`; confirms no duplicate GitHub-PR client vs F04's registry-PR helper.
- **G3 Arch (required — Ar)** — new shared types in `types.ts`; `deps`-object shape change in `index.ts`; sign-off that `registry-client.ts` becoming write-capable (first such change) still satisfies ADR-06 (only ever emits a standard `ManifestEntry` diff).
- **G4 Security (required — Se)** — computer-use-sourced actions execute agent-directed steps against a live third-party site (same blast radius as any authenticated Playwright session, incl. F00's persistent contexts); `autoPr` **must default `false`**, must **never auto-merge**, and the generated script + PR diff must be scanned to ensure no cookie/secret value from the recording is baked in literally (credentials must resolve via app-connections/vault indirection, never inline — spirit of ADR-05).
- **G5 QA** — full Vitest suite green, incl. new cases from §7.
- **G6 Live-Verify (required — Lv)** — `scripts/verify-F06.mjs` real-Playwright run, perf sanity-checked.
- **G7 Integration** — rebase after F05 merges; resolve `deps`-object / `registry-client.ts` ordering with F04.

**Definition of Done:** a hand-built `ActionTrace` against a real fixture page crystallizes into a registered template, dry-run matches the fixture's known values, a second `execute_native_extraction` call on the same template completes without any crystallization/vision step, `autoPr:false` is the default and verified, and a mocked-GitHub unit test proves a PR would be opened (never merged) with no leaked secrets in its body.

## 7. Test plan

- **`src/engine.test.ts`** — `crystallizeRecording`: happy-path multi-step trace emits goto/fill/click/waitFor/extract in source order; empty `steps` rejected at the schema level; unknown `kind` rejected (discriminated union); two `extract` steps with the same `field` name are deduped (last wins) with a logged warning.
- **`src/storage.test.ts`** — `saveRecording`/`loadRecording` round-trip; a simulated crash mid-write leaves no partial file (atomicWriteFile guarantee); concurrent `saveRecording` calls serialize via `withLock` without corrupting the recordings directory listing.
- **`src/registry-client.test.ts`** — `submitTemplatePR` against a mocked fetch/Octokit: asserts a branch + PR are created (never `main`, never a merge call), PR body contains the `ManifestEntry` JSON plus a "auto-generated via computer-use crystallization — review required" note; missing `githubToken` rejects before any network call.
- **Tool-level test** (alongside F05's own tool tests) — input validation: `recording` XOR `script` (both/neither rejected); `autoPr` defaults `false`; F05's pre-existing `script`-only path is unchanged (regression guard).
- **`scripts/verify-F06.mjs` + fixture** (Lv gate, real Playwright) — new fixture `templates/fixtures/f06-unmapped-page.html` (static page with a name/price/stock block, no pre-existing template) served locally per the existing `verify-*.mjs` fixture pattern. Steps: (1) build a hand-authored `ActionTrace` mimicking a solved computer-use path; (2) `crystallizeRecording` it; (3) dry-run the generated script via real Playwright; (4) assert extracted fields match the fixture's known values; (5) register the template; (6) call `execute_native_extraction` on the *same* `templateId` again and assert it completes in well under a second with zero crystallization/vision calls (the "runs in ms deterministically forever" claim, checked live); (7) non-zero exit on any mismatch. `autoPr`/`submitTemplatePR` is **not** live-verified against real GitHub (avoids spamming the real templates repo from CI) — it stays unit-tested with a mock, per G4.

## 8. Acceptance criteria

1. `node scripts/verify-F06.mjs` exits 0 and prints the crystallized `templateId` plus extracted values equal to the fixture's known-good values.
2. The crystallized template file is readable from `storage` afterward and a second, independent `execute_native_extraction` call against it reproduces the same result deterministically — no LLM/computer-use step on the second run.
3. Calling `synthesize_schema` with a `targetUrl` that `findTemplateByUrl` already resolves short-circuits with a "template exists — consider F04 self-heal" message instead of registering a duplicate.
4. A `recording` whose generated script fails the dry-run captures forensics (via `captureForensics`) and returns them to the calling agent instead of silently registering a broken template.
5. With `autoPr:true` and a mocked GitHub API, a PR object is created containing the manifest-entry diff and is never merged — asserted by unit test.

## 9. Reuse notes

Call, don't reimplement: **`buildStandaloneScript`** (trace → script text), **`executeExtraction`** (the dry-run, identical to F05's), **`registerTemplate`** (final registration), **`findTemplateByUrl`** (dedupe check before crystallizing), **`atomicWriteFile`** + **`withLock`** (recording persistence, same pattern as template registration), **`captureForensics`** (on dry-run failure — same primitive F04 uses on drift), **`renderPage`** (F05 — optional fresh-DOM sanity check before crystallizing), **`launchPersistentContext`** (F00 — reused as-is if the target needs an authenticated profile during dry-run). No new browser-launch, script-templating, or file-locking code should be written for F06 — everything above already exists.

## 10. Skills (setup + when-to-use)

- **`.agents/skills/security-and-hardening`** (already installed, no `npx skills add` needed — `npx skills check` to confirm) — guides G4/S9: scrubbing secrets from generated scripts/PR bodies, `autoPr` default-off reasoning.
- **`.agents/skills/test-driven-development`** (already installed) — guides S6 (write the `crystallizeRecording`/storage/registry-client test cases in §7 before wiring).
- **`.agents/skills/incremental-implementation`** (already installed) — guides S3/S4: land `crystallizeRecording` + storage + the tool-shape extension as small reviewable increments rather than one large diff.
- **`using-apimemcp`** (already installed) — engine usage/reuse conventions; confirms which helpers (§9) already exist before writing new ones.
- **Fallback: `context7-mcp`**, per the skills-matrix quality bar — no ≥1K-install skill exists for either Playwright scripting (the project's own audit found the top community Playwright skill at only 63 installs → rejected) or GitHub REST/Octokit PR automation. Before writing `crystallizeRecording`'s script-emission or `submitTemplatePR`'s Octokit calls, run `resolve-library-id` for "Playwright" and for "GitHub REST API / Octokit" and `query-docs` the specific call shapes needed, instead of relying on training-data recall.
- Builder still runs `npx skills find playwright automation` / `npx skills find github pr automation` once per the matrix's re-check rule, in case a ≥1K-install reputable skill has since appeared; if not, the context7 fallback above stands.
