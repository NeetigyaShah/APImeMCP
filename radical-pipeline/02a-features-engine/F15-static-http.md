# F15 — Static-HTTP fast path

## 1. Summary

| Field | Value |
|---|---|
| **ID** | F15 |
| **Name** | Static-HTTP fast path |
| **Pillar** | E — distribution + performance |
| **Wave** | 3 |
| **Gates** | G0 Spec, G1 Build, G2 Code-Review, G3 Arch, G5 QA, G6 Live-Verify, G7 Integration, G8 Promote |
| **Risk** | Medium |
| **Catalog Deps** | None (standalone in Wave 3) |

**What.** Add a second extraction runtime alongside Playwright: templates registered with `kind: 'static-http'` run via HTTP `fetch` + `cheerio` DOM parsing instead of launching a browser. Same tools, same `ExtractionResult` shape, same ADR-04 measure record — just a cheaper code path for pages that serve data in the initial HTML (no client-side JS needed). Catalog claims 10–50× latency/cost reduction for static pages.

**Why.** Per 00-vision's moat ("crystallize once, run deterministically forever") — cheaper extraction directly enables the cloud "Safe registry-only runtime" (X02, Program 2) to serve community `static-http` templates from a bare Vercel Function with zero Chromium cost. Supports free-tier-first, everyone-can-use thesis.

**Out of scope.** Auto-classifying URLs as "needs JS or not" — that's the authoring flows (F05, F06). F15 only executes the kind the author has already chosen.

## 2. User / agent story

- An author (F05 synthesize, F06 computer-use, or human) determines target data is fully present in the initial HTML. Calls `register_extraction_template` with `kind: 'static-http'` and a cheerio-flavored `executableScript`.
- A consumer calls `execute_native_extraction({templateId, targetUrl})` as usual — does not know or care which kind ran. Gets back the same `ExtractionResult` shape, faster.
- (Future: X02) A phone user taps "Run" on a community `static-http` template; cloud executes it in a bare Function in under 1s, no microVM spin-up.

## 3. Design

### 3.1 Data shapes (`src/types.ts`)

**Add static-http kind to ManifestEntry:**
```ts
// Extend ManifestEntry.kind to include 'static-http'
kind?: 'extraction' | 'action-sequence' | 'static-http';

// Optional request headers for static-http (User-Agent overrides, etc.)
requestHeaders?: Record<string, string>;

// Zod-level guard: Playwright-only fields rejected on static-http entries
.superRefine((entry, ctx) => {
  if (entry.kind === 'static-http') {
    if (entry.readySelector || entry.waitStrategy) {
      ctx.addIssue({
        code: 'custom',
        message: 'readySelector/waitStrategy are Playwright-only; omit them for kind:"static-http"',
      });
    }
  }
});

export function isStaticHttpEntry(entry: ManifestEntry): entry is ManifestEntry & { kind: 'static-http' } {
  return entry.kind === 'static-http';
}
```

**RunKindSchema already supports 'static-http' (already in code).** `ExtractionMeta.kind` and `MeasureRecord.kind` already allow it via ADR-04.

### 3.2 ADR compliance

- **ADR-04 (single instrumentation point):** F15 routes through the existing `executeMeasured` + metrics flow with `kind: 'static-http'`. **No parallel metrics path.**
- **ADR-02 (tool-module convention):** Edits the two existing MCP tool modules' Zod shapes and handlers directly — **no new `index.ts` append** (the tools already exist).

### 3.3 Module-by-module changes

| Module | Changes |
|---|---|
| `src/types.ts` | Extend `ManifestEntry.kind` to include `'static-http'`; add optional `requestHeaders`; add `superRefine` guard; export `isStaticHttpEntry` helper. |
| `src/engine.ts` | New export `executeStaticHttpExtraction(entry, targetUrl, opts)` using `fetch` + `cheerio.load`. Route `entry.kind === 'static-http'` calls through it in the existing call site (the `runExtraction` flow). |
| `src/tools/register-extraction-template-tool.js` | Extend input Zod shape: add `kind` and `requestHeaders` optional fields. |
| `src/tools/execute-native-extraction-tool.js` | **No shape change** — `kind` lives on the stored entry; handler already routes based on `entry.kind`. |
| `package.json` | Add `cheerio` as the only new production dependency. Proxy support reuses Node 18+ `undici.ProxyAgent`. |

### 3.4 Core implementation (`executeStaticHttpExtraction`)

```ts
export async function executeStaticHttpExtraction(
  entry: ManifestEntry,
  targetUrl: string,
  opts: { cookieString?: string; proxyUrl?: string } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    ...(entry.requestHeaders || {}),
  };
  if (opts.cookieString) {
    headers['Cookie'] = opts.cookieString;
  }

  const dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
  const res = await fetch(targetUrl, { headers, dispatcher });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const $ = cheerio.load(await res.text());
  const run = compileSandboxedScript(entry.executableScript);
  return run($, { url: targetUrl });
}
```

Reuses the existing `compileSandboxedScript` sandbox (item-5) — only the bound argument differs (`$` instead of `page`). **No second unsandboxed eval path.**

### 3.5 Router in `runExtraction`

The extraction flow in `runExtraction` (created by `createExtractionRunner`) already receives the entry. It should route based on `entry.kind`:

```ts
if (isStaticHttpEntry(entry)) {
  // static-http path
  const data = await executeStaticHttpExtraction(entry, targetUrl, { cookieString, proxyUrl });
  return createSuccessfulExtractionResult(data, meta, entry.outputSchema);
} else {
  // existing Playwright path
  const data = await executeExtraction({ ... });
  return createSuccessfulExtractionResult(data, meta, entry.outputSchema);
}
```

This honors the existing `executeMeasured` wrapper in `runExtraction`, so `MeasureRecord` includes `kind: 'static-http'` automatically.

## 4. Sub-tasks (S0–S11)

| # | Sub-task | Note |
|---|---|---|
| S0 | Spec | This document. |
| S1 | Types | Extend `ManifestEntry.kind`/`requestHeaders`; add guard + `isStaticHttpEntry` helper. |
| S2 | Storage | No code change — existing `atomicWriteFile` round-trips new optional fields. Fixture test confirms. |
| S3 | Core | `executeStaticHttpExtraction` + sandbox reuse (item-5). |
| S4 | Module | Add `cheerio` + `undici` (ProxyAgent) to deps (ProxyAgent ships with Node 18+ fetch already). |
| S5 | Wiring | Extend register and execute tool Zod shapes; add routing branch in `runExtraction`. |
| S6 | Unit | `src/engine.test.ts` (new) + extend `src/types.test.ts`. |
| S7 | Verify | `scripts/verify-F15.mjs` + local fixture server; perf measurement ≥5×. |
| S8 | Docs | README + SKILL.md document `kind`, `requestHeaders`, authoring example. |
| S9 | Review | G2 confirms no parallel metrics/sandbox path (ADR-04/item-5 rules). |
| S10 | Live | G6 measures perf claim (≥5× vs Playwright), not asserts. |
| S11 | Merge | G7 Integration. |

## 5. Dependencies & sequencing

- **Catalog deps:** None. F15 is standalone in Wave 3.
- **Preconditions (Phase 0 locked):** ADR-02 retrofit (F00/F01), ADR-04 measure model (F14, Wave 1).
- **Unblocks:** X02 (Program 2, "Safe registry-only runtime") explicitly lists F15 in its deps.
- **Wave:** 3.

## 6. Quality gates

**Pipeline:** G0 → G1 → G2 → G3 → G5 → G6 → G7 → G8. No G3b (no UI), no G4 (not flagged security feature).

**Definition of Done:**
1. `register_extraction_template` accepts `kind: 'static-http'` + `requestHeaders`; rejects Playwright-only fields on static-http.
2. `execute_native_extraction` transparently routes static-http entries via `executeStaticHttpExtraction` — zero Chromium spawned.
3. ADR-04 measure record emitted from same instrumentation point with `kind: 'static-http'` — no second metrics path.
4. Item-5 sandbox wraps cheerio scripts exactly as Playwright scripts — no second eval path.
5. `cheerio` only new dependency; proxy reuses `undici.ProxyAgent`.
6. `npm run build` clean; `vitest run` green; `node scripts/verify-F15.mjs` exits 0 with measured ≥5× speedup.
7. README + SKILL.md document the new params.

## 7. Test plan

**`src/types.test.ts` (extend):**
- `ManifestEntry` parses `kind: 'static-http'` + `requestHeaders`; defaults `kind` to `'extraction'` (back-compat).
- Rejects unknown `kind` values.
- `superRefine` rejects `kind: 'static-http'` + `readySelector` or `waitStrategy`.
- `isStaticHttpEntry` returns correctly per kind.

**`src/engine.test.ts` (new):**
- Mock `fetch` → fixed HTML → `executeStaticHttpExtraction` → cheerio script → expected fields. No throw.
- Non-2xx response → throws with HTTP status message.
- `opts.cookieString` → forwarded as `Cookie` header.
- `opts.proxyUrl` → `ProxyAgent` constructed + passed.
- Sandbox parity: disallowed globals (e.g., `process`, `require`) blocked same as Playwright path.

**`src/storage.test.ts` (extend):**
- Entry with `kind: 'static-http'` + `requestHeaders` round-trips unchanged via existing persist path.

**`scripts/verify-F15.mjs` (new) + fixture:**
- Fixture: `scripts/fixtures/f15-static-page.html` (static HTML with title, price, list).
- Start local `node:http` server on ephemeral port; register `static-http` template against it.
- `execute_native_extraction` → assert returned data matches fixture exactly.
- Record `durationMs`; register equivalent Playwright template against same server; assert static-http is ≥5× faster. Print ratio.

## 8. Acceptance criteria (live, observable proof)

1. `register_extraction_template({templateId, kind: 'static-http', executableScript, ...})` succeeds; manifest entry on disk shows `kind: 'static-http'`.
2. `execute_native_extraction({templateId, targetUrl})` returns data matching Playwright-kind run, with `meta.kind === 'static-http'`, in ≥5× less time.
3. No Chromium/Playwright process spawned during static-http run (verify-F15.mjs confirms).
4. `get_extraction_stats` distinguishes static-http runs by `kind` from Playwright runs (F14/ADR-04 measure record).
5. `npm run build` clean; `vitest run` green; `node scripts/verify-F15.mjs` exits 0 with measured ratio ≥5×.

## 9. Reuse notes

- **`compileSandboxedScript` (item-5)** — reused unchanged, only bound argument changes ($ instead of `page`). No second eval path.
- **`atomicWriteFile`, `findTemplateByUrl`, `findTemplateById`** — untouched; additive fields work with existing storage.
- **ADR-04 instrumentation (`executeMeasured`, `recordMeasure`)** — reused, not duplicated; F15 contributes `kind` value, not a code path.
- **`createSuccessfulExtractionResult`** — already handles optional `outputSchema` validation; reused unchanged.
- **Node 18+ `fetch` + `undici.ProxyAgent`** — avoids adding axios/node-fetch/https-proxy-agent for runtime-provided features.

## 10. Skills

- **test-driven-development** — guides S6 (write engine.test.ts first).
- **performance-optimization** — guides S7/S10 (perf measurement is the point).
- **code-simplification** — guides S9 (confirm no parallel paths).
- **context7-mcp** — live cheerio + undici docs (not in 08-skills-matrix, so defer to runtime reference).
