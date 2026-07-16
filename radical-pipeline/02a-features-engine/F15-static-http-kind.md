# F15 — `static-http` template kind

## 1. Summary

| Field | Value |
|---|---|
| ID | **F15** |
| Name | `static-http` template kind |
| Pillar | **E** — distribution + performance |
| Wave | **3** |
| Gates | **Ar, Lv** (no Se — not on the Security-Reviewer's flagged list) |
| Risk | **M** |
| Catalog Deps | **—** (none; standalone in Wave 3) |

**What.** A second extraction runtime alongside the existing Playwright path. A template registered with `kind:'static-http'` is served by a plain HTTP `fetch` + `cheerio` DOM parse instead of launching a browser — no Chromium process, no `page.goto`, no wait-for-selector. Same tools (`register_extraction_template`, `execute_native_extraction`), same `ExtractionResult` shape, same ADR-04 measure record — just a cheaper code path for pages whose target data is already present in the server-rendered HTML (no client-side JS needed to produce it).

**Why.** Per `00-vision.md`'s moat ("crystallize the path once, run deterministically forever") — F15 crystallizes to the *cheapest sufficient runtime*, not always a browser. Catalog claims 10–50× latency/cost reduction for no-JS pages. This is also the load-bearing dependency for **X02** (Program 2 catalog: `X02 Deps = F18, F15, item-5`) — the cloud "Safe registry-only runtime" can serve `static-http` templates from a bare Vercel Function with **zero** Sandbox/`@sparticuz/chromium` cost, which is exactly the "Light execution" row of the free-hosting matrix (`07-platform-design/cloud-architecture.md`). Cheaper cloud runs directly serve the "everyone, from a phone, free-tier-first" thesis.

**Out of scope.** Auto-classifying an arbitrary URL as "needs JS or not" is not F15's job — that heuristic lives with the authoring flows (F05 `synthesize_schema`, F06 computer-use crystallization), which choose `kind:'static-http'` when their own dry-run shows the target data present in the raw HTML response. F15 only builds the storage + execution support for a kind the author has already chosen.

## 2. User / agent story

- An authoring agent (via F05/F06, or a human contributor) determines a target page's data is fully present in the initial HTML (view-source has it, no XHR/hydration required). It calls `register_extraction_template` with `kind:"static-http"` and a cheerio-flavored `executableScript`.
- A consuming agent calls `execute_native_extraction({templateId, targetUrl})` exactly as it would for any other template — it does not know or care which kind ran. It gets back the same `ExtractionResult` shape, faster.
- Later (X02), a phone user taps "Run" on a `static-http` community template on the website/app; the cloud executes it in a bare Function in well under a second, with no microVM/Sandbox spin-up cost.

## 3. Design

### 3.1 Data shapes (`src/types.ts`)

```ts
// Extends the existing kind enum — ADR-04 already names this literal:
// "kind = extraction | action-sequence | static-http (matching ManifestEntry.kind)"
export const TemplateKind = z.enum(['extraction', 'action-sequence', 'static-http']);
export type TemplateKind = z.infer<typeof TemplateKind>;

// ManifestEntry: additive optional fields only, back-compat default applies
kind: TemplateKind.optional().default('extraction'),
requestHeaders: z.record(z.string()).optional(),   // static-http only: UA/Accept-Language/etc. overrides

// Zod-level guard: Playwright-only fields make no sense on a static-http entry
.superRefine((entry, ctx) => {
  if (entry.kind === 'static-http' && (entry.readySelector || entry.waitStrategy)) {
    ctx.addIssue({ code: 'custom', message: 'readySelector/waitStrategy are Playwright-only; omit them for kind:"static-http"' });
  }
});

export function isStaticHttpEntry(entry: ManifestEntry): boolean {
  return entry.kind === 'static-http';
}
```

`ExtractionMeta.kind` already exists as of F14's Wave-1 adoption of ADR-04 (the measure record `{templateId, kind, success, durationMs, timestamp, error?}` requires it) — F15 adds no new field there, only a third value flowing through it.

### 3.2 ADR compliance

- **ADR-04 (metrics measure-model) — the one this feature is most bound to.** ADR-04's own text names `static-http` as a first-class `kind` value and names `executeExtraction` as engine's single instrumentation point. F15 must **not** add a parallel metrics path: `executeStaticHttpExtraction`'s result flows through that same existing emission call with `kind:'static-http'` — zero new metrics code, per ADR-04's explicit contract rule ("a second metrics-writing path is rejected").
- **ADR-02 (tool-module convention) — depended-on-by table explicitly lists F15.** By Wave 3, the ADR-02 retrofit (chartered to F00, then F01) has already turned `register_extraction_template` and `execute_native_extraction` into standalone `registerXxxTool(server, deps)` modules. F15 edits those two modules' Zod shape/handler bodies directly — it adds **no new tool** and therefore **no new appended line** in `index.ts`; the wiring file is untouched. (If the retrofit's file layout differs slightly by the time F15 forks, apply the same diff wherever those two tools live post-retrofit — the module *name* is fixed by ADR-02, the exact path is not.)

### 3.3 Module-by-module changes (exact paths)

- **`D:/MCP/src/types.ts`** — add `TemplateKind`, extend `ManifestEntry` (`kind`, `requestHeaders`), add `isStaticHttpEntry`, the `superRefine` guard above.
- **`D:/MCP/src/storage.ts`** — no shape migration needed (additive optional JSON field; existing `atomicWriteFile`/read-modify-write round-trips it unchanged). Confirms via a new fixture-backed unit test only (S2/S6).
- **`D:/MCP/src/engine.ts`** — add `cheerio` import; new export:
  ```ts
  export async function executeStaticHttpExtraction(
    entry: ManifestEntry, targetUrl: string,
    opts: { cookieString?: string; proxyUrl?: string } = {}
  ): Promise<ExtractionResult> {
    const start = Date.now();
    const headers = { ...entry.requestHeaders, ...(opts.cookieString ? { cookie: opts.cookieString } : {}) };
    const dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined; // undici, already a Node18+ transitive dep
    try {
      const res = await fetch(targetUrl, { headers, dispatcher });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const $ = cheerio.load(await res.text());
      const run = compileSandboxedScript(entry.executableScript); // REUSE the existing item-5 sandbox, do not fork a second eval path
      const data = await run($, { url: targetUrl });
      return { data, meta: { templateId: entry.templateId, kind: 'static-http', durationMs: Date.now() - start, timestamp: new Date().toISOString(), success: true } };
    } catch (error) {
      return { data: null, meta: { templateId: entry.templateId, kind: 'static-http', durationMs: Date.now() - start, timestamp: new Date().toISOString(), success: false, error: String(error) } };
    }
  }
  ```
  and one branch in the existing router named by ADR-04 itself:
  ```ts
  export async function executeExtraction(entry, targetUrl, opts) {
    if (entry.kind === 'static-http') return executeStaticHttpExtraction(entry, targetUrl, opts);
    return executePlaywrightExtraction(entry, targetUrl, opts); // existing path, unchanged
  }
  ```
  `compileSandboxedScript` is a placeholder name for whatever the item-5 sandboxing commit (`94b6101`) already calls its script-execution wrapper — F15 must locate and reuse it, binding its first argument to a `CheerioAPI` ($) instead of a Playwright `Page`, never introducing a second unsandboxed execution path.
- **`D:/MCP/src/tools/register-extraction-template.ts`** (post-ADR-02 retrofit location of the existing `register_extraction_template` tool) — extend its Zod input shape with `kind` (optional, default `'extraction'`) and `requestHeaders` (optional record), passed straight through to `storage.ts`'s existing write.
- **`D:/MCP/src/tools/execute-native-extraction.ts`** (post-ADR-02 retrofit location of `execute_native_extraction`) — **no shape change**: `kind` lives on the stored entry, not the call args; the handler already calls `engine.executeExtraction(entry, targetUrl, {cookieString, proxyUrl})`, which now internally routes.
- **`package.json`** — add `cheerio` as the **only new production dependency**. Proxy support reuses `undici`'s `ProxyAgent` (ships with Node ≥18's global `fetch`) rather than adding `node-fetch`/`https-proxy-agent`/`axios`.
- **`src/registry-client.ts` / `buildStandaloneScript`** (wherever the `.mjs` standalone-script generator lives, per W04's "`.mjs` download") — gains a `static-http` branch emitting `fetch` + `cheerio.load` boilerplate instead of a Playwright-launch boilerplate, mirroring the existing kind-aware codegen pattern rather than a parallel generator function.

## 4. Sub-tasks (S0–S11)

| # | Sub-task | Applicable? | Note |
|---|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `TemplateKind`, `ManifestEntry.kind`/`requestHeaders`, `superRefine` guard, `isStaticHttpEntry` in `types.ts`. |
| S2 Storage | Applicable (thin) | No shape migration; add a fixture round-trip test confirming `kind`/`requestHeaders` persist via existing `atomicWriteFile` path. |
| S3 Core | Applicable | `executeStaticHttpExtraction` + router branch in `engine.ts`; reuse item-5 sandbox. |
| S4 Module | Applicable | Add `cheerio` dep; extend `buildStandaloneScript` codegen branch. |
| S5 Wiring | Applicable | Edit the two existing ADR-02 tool modules' Zod shapes — **no new `index.ts` append**. |
| S6 Unit | Applicable | New `src/engine.test.ts` (does not exist yet — `ls src/` confirms only `types.test.ts`, `storage.test.ts`, `app-connections.test.ts` today) + extend `types.test.ts`. |
| S7 Verify | Applicable | `scripts/verify-F15.mjs` + local fixture server (engine-touching, real HTTP + real cheerio, no mocks). |
| S8 Docs | Applicable | README + `using-apimemcp` SKILL.md: document `kind`/`requestHeaders` param and an authoring example. |
| S9 Review | Applicable | G2 Code-Review — confirm no parallel metrics/sandbox path was introduced (ADR-04/item-5 contract rules). |
| S10 Live | Applicable | G6 Live-Verify — perf claim measured, not asserted; see §8. |
| S11 Merge | Applicable | G7 Integration into `integration`, ordered after any in-flight ADR-02 retrofit work on the same two tool modules. |

## 5. Dependencies & sequencing

- **Catalog hard deps: none.** F15 is standalone in Wave 3.
- **Cross-cutting preconditions (not new feature deps, already Phase-0-locked):** ADR-02 must have retrofitted `register_extraction_template`/`execute_native_extraction` into standalone modules (owned by F00 then F01) before F15 edits them — true by Wave 3 given F00/F01 land Waves 0–1. ADR-04's measure model (owned by F14, Wave 1) must already be the live instrumentation point before F15 adds its `kind` value — also true by Wave 3.
- **What F15 unblocks:** **X02** (Program 2, "Safe registry-only runtime") lists `F15` directly in its Deps (`F18, F15, item-5`) — the cloud fast path for community `static-http` templates needs this to skip Sandbox/`@sparticuz/chromium` entirely.
- **Wave:** 3 (with F04, F06, F07, F08, F11).

## 6. Quality gates

Pipeline: `G0 Spec → G1 Build → G2 Code-Review → G3 Arch → G5 QA → G6 Live-Verify → G7 Integration → G8 Promote`. No G3b (no UI). No G4 Security (F15 is not on the Security-Reviewer's flagged list: F00/F04/F06/F11/F12/F13/F16/F18 + all X##).

**Definition of Done:**
1. `register_extraction_template` accepts `kind:"static-http"` + `requestHeaders`; rejects Playwright-only fields on a static-http entry.
2. `execute_native_extraction` transparently routes static-http entries through `executeStaticHttpExtraction` — zero browser/Chromium process spawned.
3. The ADR-04 measure record is emitted from the **same single instrumentation point** with `kind:'static-http'` — no second metrics path (G3 Arch enforces).
4. The item-5 sandbox wraps cheerio-script execution exactly as it wraps Playwright scripts — no second unsandboxed eval path (G2/G3 enforce).
5. `cheerio` is the only new dependency; proxy support reuses `undici.ProxyAgent`.
6. `vitest run` green (new `engine.test.ts` + extended `types.test.ts`); `node scripts/verify-F15.mjs` exits 0 with a measured (not asserted) speed multiplier documented in its output.
7. README + SKILL.md document the new param.

## 7. Test plan

**`src/types.test.ts` (extend):**
- `ManifestEntry` parses `kind:'static-http'` + `requestHeaders`; defaults `kind` to `'extraction'` when omitted (back-compat with every existing template on disk).
- Rejects an unknown `kind` value.
- `superRefine` rejects `kind:'static-http'` combined with `readySelector`/`waitStrategy`.
- `isStaticHttpEntry` returns correctly for each kind.

**`src/engine.test.ts` (new file — none exists today):**
- Happy path: mock global `fetch` → fixed HTML → `executeStaticHttpExtraction` → cheerio script extracts expected fields → `meta.kind === 'static-http'`, `meta.success === true`.
- Non-2xx response → `meta.success === false`, `meta.error` populated, no throw escapes.
- `opts.cookieString` forwarded as a `Cookie` header.
- `opts.proxyUrl` set → `ProxyAgent` constructed and passed as `dispatcher`.
- Router (`executeExtraction`) dispatches to `executeStaticHttpExtraction` only when `entry.kind === 'static-http'`, else the existing Playwright path (spy/mock both branches).
- Sandbox parity: a static-http script attempting a disallowed global (e.g. `process`, `require`) is blocked the same way the existing Playwright-script sandbox test (if any) blocks it — same sandbox, same guarantee.

**`src/storage.test.ts` (extend):** a `ManifestEntry` with `kind:'static-http'` + `requestHeaders` round-trips through the existing write/read fixture unchanged.

**`scripts/verify-F15.mjs` + fixture (engine-touching, per template):**
- Fixture: `scripts/fixtures/f15-static-page.html` — a small static page with known, hand-authored content (title, a price, a list).
- Script: starts a local `node:http` server on an ephemeral port serving the fixture (no external network dependency, deterministic); registers a `static-http` template against it; calls `execute_native_extraction`; asserts returned data matches expected fixture values exactly; records `durationMs`.
- Perf-claim measurement (ties to G6 / agent-roster's "perf-claim measurement (F15/F16)" duty): also registers an equivalent Playwright (`extraction`-kind) template against the same fixture server, runs it, and asserts the static-http run's `durationMs` is at least **5×** faster (a conservative floor under the catalog's "10–50×" claim — verified, not optimistically asserted). Prints the measured ratio.

## 8. Acceptance criteria (live, observable proof)

1. `register_extraction_template({templateId:'f15-fixture', domainPattern:'127.0.0.1', kind:'static-http', executableScript:'...'})` succeeds; the on-disk manifest entry (existing `storage.ts` store, unchanged file) shows `kind:'static-http'`.
2. `execute_native_extraction({templateId:'f15-fixture', targetUrl:'http://127.0.0.1:<port>/'})` returns data equal to a browser-kind run of the same fixture page, with `meta.kind === 'static-http'`.
3. No Chromium/Playwright process is observed during that run (process-count check in `verify-F15.mjs`, or absence of any `page.goto` call path executed).
4. `get_extraction_stats` (F14/ADR-04 consumer) shows the static-http run's measure distinguishable by `kind` from `extraction`-kind runs.
5. `npm run build` clean; `vitest run` green; `node scripts/verify-F15.mjs` exits 0 and prints a measured speed-multiplier ≥5×.

## 9. Reuse notes

- **Sandboxed script execution (item-5, shipped in `94b6101`)** — reused unchanged for the cheerio path; only the bound argument changes ($ instead of `page`). Do not write a second `eval`/`new Function`/`vm` path.
- **`atomicWriteFile` (storage.ts)** — untouched; already handles additive JSON fields.
- **ADR-04's single instrumentation point in `executeExtraction`** — reused, not duplicated; F15 contributes a `kind` value, not a code path.
- **`findTemplateByUrl`** — untouched; static-http entries participate in the same domain-pattern lookup as every other kind.
- **`buildStandaloneScript`** — extended with one branch, not forked into a second generator.
- **`registerTemplate` / `captureForensics`** — success path needs neither; on failure, `executeStaticHttpExtraction` captures the HTTP status + a response-body snippet (cheaper than a DOM forensics dump) into the same `error` field ADR-04 already defines — no parallel error-reporting shape.
- **Node 18+ global `fetch` + `undici.ProxyAgent`** — avoids adding `axios`/`node-fetch`/`https-proxy-agent` for what the runtime already provides (ladder rung 5).

## 10. Skills (setup + when-to-use)

- **`.agents/skills/` (already installed, no setup)** — `test-driven-development` guides S6 (write the fetch-mocked `engine.test.ts` first); `performance-optimization` guides S7/S10 (the 5× perf-claim measurement is the whole point of this feature's Lv gate); `code-simplification` guides S9 (confirm no parallel metrics/sandbox path snuck in).
- **cheerio / undici (`ProxyAgent`) API docs** — not one of `08-skills-matrix.md`'s vetted ≥1K-install picks (the matrix doesn't evaluate cheerio at all, unlike Cloudflare/serverless-Chromium which were explicitly checked and rejected at 142/75 installs). Applying the same quality bar: fall back to **`context7-mcp`** (already "available in this environment — no install" per the matrix) for live `cheerio` and `undici` API docs rather than trusting training-data recall of exact method signatures (`.load`, `.text()`, `ProxyAgent` constructor options). Guides S1 (types/shape) and S3 (Core implementation).
- No new skill install required for this feature.
