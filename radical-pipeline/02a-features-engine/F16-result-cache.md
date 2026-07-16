# F16 — Short-TTL Result Cache

## 1. Summary

- **ID / Name:** F16 — Short-TTL result cache
- **Pillar:** E (dist+perf) · **Wave:** 2 · **Risk:** L · **Gates:** Se (blocking; only gate this feature carries)
- **Modules:** `result-cache.ts` (new) + `index.ts` (wiring only, no new module boundary)
- **Deps:** F14 (Metrics 2.0), ADR-04 (Metrics measure-model)

**What.** An in-process `Map`-backed, short-TTL cache in front of template execution. Key = `templateId + targetUrl + cookie-identity + proxy` (per the F00-F25 catalog row). A second call with the same key inside the TTL window returns the prior result without re-running Playwright/cheerio; a different cookie, proxy, URL, or template always misses.

**Why (00-vision tie-in).** The vision's moat is "solve once, replay in ms deterministically" — computer-use is slow/costly *every* run, APImeMCP's edge is that a crystallized template is supposed to be cheap to re-run. Without F16, an agent that polls the same page twice in a retry/pagination burst pays a full browser-launch round-trip twice for data that provably hasn't changed, and hammers the target site (RPA-replacement and financial-aggregation targets are exactly the sites that rate-limit/ban tight polling loops). F16 is also load-bearing for Program 2: X02's "safe registry-only runtime" must return a **sync result inside a serverless function timeout** — a millisecond cache hit is the cheapest way to keep bursty agent/monitor traffic inside that budget before X03's durable-job fallback is needed.

## 2. Story

As an agent (or a Program-2 monitor/X05 cron) calling `execute_native_extraction` repeatedly for the same template + target — paginating, retrying after a transient blip, or re-checking a value seconds apart — I want the second call back in low-single-digit milliseconds with byte-identical output, as long as my request context (same cookies, same proxy) matches the call that produced it. If my cookies or proxy differ from whoever populated the cache, I must **never** see their result — that cross-tenant leak is the one thing this feature is not allowed to get wrong, which is why it carries a blocking Se gate despite being risk L otherwise.

## 3. Design

### 3.1 ADR obeyed
**ADR-04 (Metrics measure-model)** governs this feature directly: "F16 … Reads recency/hit signals from the measures to inform cache decisions" and "a second metrics-writing path is rejected." Concretely: `result-cache.ts` **never emits** a `{templateId,kind,success,durationMs,timestamp,error?}` record itself — that stays the single instrumentation point inside `executeExtraction`/its `index.ts` wrapper (F14's domain). F16 only *consumes* the existing `success` semantics implicitly: a cache **miss** falls through to the real, already-instrumented call, which emits its own measure exactly as before; a cache **hit** performs no extraction at all, so it correctly emits nothing (a hit is not a new "run" and must not inflate F14's success-rate denominator). The only thing F16 caches is a **resolved (successful) promise** — a thrown/rejected call is never written to the store, so failures always pass through live and the measure store's `error` field stays meaningful.

### 3.2 Data shapes (`src/result-cache.ts`, new — plain TS, no Zod: no external input boundary is introduced, ADR-01 only requires schemas at template-output boundaries)
```ts
export interface CacheKeyParams {
  templateId: string;   // must be the RESOLVED id (see 3.4), never the raw optional input field
  targetUrl: string;
  cookieString?: string;
  proxyUrl?: string;
}

interface CacheEntry {
  value: unknown;
  cachedAt: number; // Date.now()
}

const TTL_MS        = Number(process.env.APIMEMCP_CACHE_TTL_MS)        || 60_000; // "short" TTL
const MAX_ENTRIES    = Number(process.env.APIMEMCP_CACHE_MAX_ENTRIES)   || 500;   // bounded memory
const store = new Map<string, CacheEntry>(); // insertion-ordered → oldest-first eviction, no lib needed

export function buildCacheKey(p: CacheKeyParams): string;      // see 3.3 for the hash
export function getCached<T>(key: string): T | undefined;      // lazy expiry, deletes on read if stale
export function setCached<T>(key: string, value: T): void;     // evicts oldest if over MAX_ENTRIES
export async function withResultCache<T>(params: CacheKeyParams, run: () => Promise<T>): Promise<T>;
export function clearResultCache(): void;                      // test-only reset
export function getResultCacheStats(): { size: number; ttlMs: number; maxEntries: number };
```

### 3.3 The security-critical refinement to the catalog key
The catalog literally says the key includes "cookie-present" — a bare boolean. Implemented literally, two callers with **different** real cookies for the same `templateId+targetUrl` (Alice's session vs. Bob's) both collapse to the same `cookie-present=true` slot and Bob would receive Alice's cached, cookie-scoped result. That is the exact cross-tenant leak the Se gate exists to catch, so the key's cookie dimension is a **one-way hash of the cookie string**, not a boolean — this is a stricter reading of "cookie-present," not a scope change: presence *and* identity, computed with stdlib `node:crypto` (`createHash('sha256').update(cookieString).digest('hex').slice(0,16)`), so the raw cookie value is never stored, logged, or reversible from the key. Absent cookies/proxy collapse to sentinel strings `"no-cookie"` / `"no-proxy"`. Proxy uses the **exact** `proxyUrl` string (not presence) since different proxies can legitimately return different geo-scoped content — the catalog's "+proxy" already reads as exact-match, no refinement needed there.

### 3.4 Wiring (`src/index.ts`, modified — no new `registerXxxTool` call)
Per ADR-02, `execute_native_extraction` is registered by its own `registerXxxTool(server, deps)` module; F16 does not add a tool, route, or screen — it changes what that handler does internally, so `index.ts`'s append-only tool-registration list gains zero lines. Two required precisions in the handler body:
1. **Resolve before keying.** `templateId` is an optional input on `execute_native_extraction` (auto-resolved via the existing template-URL lookup when omitted); `buildCacheKey` must receive the **post-resolution** id, never the raw optional field, or two unresolved calls to the same URL silently miss each other.
2. **Never cache `action-sequence`.** `ManifestEntry.kind` (ADR-04) is `extraction | action-sequence | static-http`. Only `extraction` and `static-http` (F15) are read-only/idempotent by construction. `action-sequence` templates may click/submit/fill (F08/F09 territory) — replaying a cached "success" for what looks like the same call could mask that a form-submit / add-to-cart / one-time-code step never actually re-ran. The handler gates the wrap: `template.kind === 'action-sequence' ? runDirect() : withResultCache(keyParams, runDirect)`.

Shape of the call site:
```ts
const result = template.kind === 'action-sequence'
  ? await engine.executeExtraction(template, { targetUrl, cookieString, proxyUrl })
  : await withResultCache(
      { templateId: template.id, targetUrl, cookieString, proxyUrl },
      () => engine.executeExtraction(template, { targetUrl, cookieString, proxyUrl })
    );
```

### 3.5 Concurrency — reuse the existing in-proc lock, don't reinvent one
Two agents calling the identical key simultaneously before either finishes would both miss and both pay for a duplicate Playwright run (wasteful, not unsafe, but avoidable). `withResultCache`'s miss path wraps the run in the **existing `lock.ts` in-proc mutex** (`withLock(key, fn)`, already used elsewhere in the codebase) with a double-checked-read: check the cache, if still empty acquire `withLock(key, …)`, re-check inside the lock (in case a racing caller just finished), then run and store. This reuses `withLock` exactly as the per-feature template's reuse-note list names it — no new coalescing/dedup primitive.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | ✅ | This document. |
| S1 Types | ✅ | `CacheKeyParams`/`CacheEntry` local to `result-cache.ts` — deliberately **not** hoisted into `types.ts`; nothing outside this module needs the shape (ladder: don't widen a shared boundary for a private implementation detail). |
| S2 Storage | **N/A** | In-memory only, by design — the whole point is TTL-bounded ephemerality; process restart clearing the cache is correct behavior, not a gap. |
| S3 Core | ✅ | `buildCacheKey` / `getCached` / `setCached` / eviction in `result-cache.ts`. |
| S4 Module | ✅ | `withResultCache` wrapper (cache-check → lock → run → store) + `kind==='action-sequence'` bypass. |
| S5 Wiring | ✅ | `index.ts`: import `withResultCache`, wrap the `execute_native_extraction` handler's call per 3.4 (no new tool registration). |
| S6 Unit | ✅ | `src/result-cache.test.ts` (Vitest, browser-free) — see §7. |
| S7 Verify | ✅ | `scripts/verify-F16.mjs` against a real registered template — live timing + isolation proof, see §7. Runs even though **Lv is not a required gate** for this feature (see §6), as the cheapest live falsifier of the perf/isolation claims. |
| S8 Docs | ✅ | README "Configuration" section: `APIMEMCP_CACHE_TTL_MS` / `APIMEMCP_CACHE_MAX_ENTRIES`; `using-apimemcp` SKILL note that caching is transparent (no agent-facing API change) and never applies to `action-sequence`. |
| S9 Review | ✅ | G2 Code-Review (always required). |
| S10 Live | **N/A** | No `Lv` in this feature's Gates column, and per `quality-gates.md` "pure-logic engine features skip G6" — no new browser/device surface is introduced (it wraps an already-verified extraction path). S7's script still runs in CI as a build-time check; it just doesn't gate promotion the way an `Lv`-flagged feature's does. |
| S11 Merge | ✅ | G7 Integration (always required). |

## 5. Dependencies & sequencing

- **Hard deps:** ADR-04 (locked Phase 0 — the measure shape/contract this feature must not duplicate) and **F14** (Metrics 2.0 owns `metrics.ts` aggregation; F14 must land first — Wave 1 — so the measure store exists in its ADR-04 shape before F16 forks in Wave 2, per the catalog's own wave placement).
- **What F16 unblocks:** nothing in the F00–F25 catalog declares F16 as a dependency — it is a leaf perf feature. It is, however, load-bearing (non-blocking) context for Program 2: X02's inline-execution latency budget and X05's monitor-poll cadence both benefit from cache hits, but neither lists F16 as a hard `Deps` entry, so F16 does not gate their start.
- **Wave:** 2 (alongside F02, F10, F22, F23).
- **Sequencing note:** because F16 only *reads* the ADR-04 contract and never writes a second measure path, it can be built in parallel with F02/F10/F22/F23 in the same wave with zero file-contention risk beyond the shared `index.ts` append point (resolved via ADR-02's append-only convention).

## 6. Quality gates

Applicable: **G0 Spec, G1 Build, G2 Code-Review, G4 Security (blocking), G5 QA, G7 Integration, G8 Promote.**
N/A: **G3 Arch** (not boundary/cross-repo — new module is self-contained, no `types.ts`/4-module-boundary change), **G3b Design** (no UI), **G6 Live/Device-Verify** (not in Gates column; pure-logic feature per `quality-gates.md`'s explicit skip rule).

**Definition of Done:**
1. `result-cache.ts` implements the key/TTL/eviction primitives in §3.2–3.3; cookie dimension is a hash, never a boolean or raw value.
2. `execute_native_extraction`'s handler wraps only `kind !== 'action-sequence'` calls; a thrown/rejected run is never stored.
3. No second ADR-04 emission point is added anywhere in `result-cache.ts` (Security- and Architect-reviewable via `grep -r "logExtractionMetric\|emitMeasure"` returning zero hits inside the new file).
4. `result-cache.test.ts` green, covering §7's cases.
5. `scripts/verify-F16.mjs` green against a real template: measured cache-hit is at least an order of magnitude faster than the initial miss, and cookie/proxy/TTL isolation all hold live.
6. **G4 Security sign-off (blocking)** explicitly confirms: (a) cross-context isolation — different cookie or proxy never returns another context's cached value; (b) no raw cookie string ever logged, printed, or stored anywhere in the module (only its hash); (c) memory is bounded (`MAX_ENTRIES` enforced); (d) `action-sequence` templates never enter the cache.
7. README + SKILL doc updated per S8.

## 7. Test plan

**`src/result-cache.test.ts` (Vitest, browser-free, use `vi.useFakeTimers()` for TTL):**
- `buildCacheKey`: identical params → identical key; differing `templateId`/`targetUrl`/`cookieString`/`proxyUrl` each → a different key; missing `cookieString`/`proxyUrl` → stable `"no-cookie"`/`"no-proxy"` sentinels (not `undefined` concatenation).
- `buildCacheKey` never contains the raw cookie substring in its output (assert the literal cookie value is NOT a substring of the returned key).
- `getCached`/`setCached`: set then get inside TTL → returns the value; advance fake timers past `APIMEMCP_CACHE_TTL_MS` → returns `undefined` and the entry is gone from a subsequent `getResultCacheStats().size`.
- `withResultCache`: first call invokes `run` (assert via a `vi.fn()` counter) and caches; a second call with the **same** params does not invoke `run` again (counter stays 1); a **rejecting** `run` is invoked on every call (counter increments each time) — nothing is ever cached from a rejection.
- Cross-key isolation: same `templateId`+`targetUrl`, `cookieString: "a"` vs `"b"` → two independent cache entries; retrieving one never returns the other's value.
- Eviction: fill past `MAX_ENTRIES` → oldest key is evicted first (`Map` insertion order), `size` stays at the cap.
- Concurrency: two concurrent `withResultCache` calls on an empty cache with the same key and a `run` that resolves after a `setTimeout` → `run` is invoked exactly once (`withLock` coalesced the second caller), both callers receive the same resolved value.

**`scripts/verify-F16.mjs` (reuses an existing verify fixture/template, no new Playwright fixture needed):**
1. Call `execute_native_extraction` for a real registered template/URL; record wall-clock time (expect the normal browser-launch-class duration) and the result.
2. Call again immediately with identical `templateId`/`targetUrl`/`cookieString`/`proxyUrl` → assert wall-clock time is at least ~10× faster and the result is deep-equal to step 1 (cache hit, no re-launch).
3. Call again with a **different** `cookieString` (or its omission) → assert it takes the slow path again (cache miss — proves cookie-identity isolation, not just presence).
4. Call again with a **different** `proxyUrl` → assert slow path again (proxy isolation).
5. Set `APIMEMCP_CACHE_TTL_MS=1000` for the script run, repeat step 1, sleep >1s, repeat the identical call → assert slow path again (TTL actually expires, lazy-expiry works).
6. Against a deliberately-failing target/template, call twice → assert **both** calls take the slow path (errors are never cached).

## 8. Acceptance criteria (live, observable proof)

- Running `node scripts/verify-F16.mjs` against the real MCP server prints PASS for all six steps above, with the measured hit/miss timing delta printed (not just asserted silently) so a reviewer can eyeball the order-of-magnitude claim.
- `npm run build && npx vitest run src/result-cache.test.ts` is green.
- Manually calling `execute_native_extraction` twice back-to-back for the same template/URL/cookies/proxy via the live MCP tool returns the second response in low-single-digit milliseconds and byte-identical JSON to the first.
- Swapping only the `cookieString` between those two calls demonstrably produces two independently-timed slow runs, never a cross-cookie cache hit.

## 9. Reuse notes

- **Reuse, don't reinstrument:** the existing single ADR-04 emission point inside `executeExtraction`/its wrapper — F16 adds zero new `logExtractionMetric`/measure calls.
- **Reuse `withLock`** (existing in-proc mutex module) to coalesce concurrent identical-key misses instead of building a new promise-memoization map.
- **Reuse the existing template-resolution path** (`findTemplateByUrl`-style lookup already in `index.ts`) — F16 keys off its *output* (`template.id`), it does not re-resolve or cache the resolution step itself.
- **Reuse `node:crypto`** (Node stdlib, already available) for the cookie-hash — no new dependency for something a one-line `createHash` call covers.
- **Reuse the ADR-02 convention** — no new `registerXxxTool`; the change lives inside the existing `execute_native_extraction` module's handler body.
- **Do not reuse/touch `cookie-store.ts`** — that module persists browser-profile cookies to disk for app-connections/session reuse (ADR-05 concern); `result-cache.ts` is a distinct, ephemeral, in-memory-only module for extraction *results*, not credentials. Keep them separate.
- **Not used, deliberately:** `atomicWriteFile` (no persistence — S2 is N/A), `captureForensics` (no failure-path forensics here — failures are never cached, just passed through), `buildStandaloneScript` (unrelated to F06 crystallization).

## 10. Skills (setup + when-to-use)

No external/vendor skill applies — this feature is ~40 lines of Node stdlib (`Map`, `Date.now`, `node:crypto`) plus reuse of an already-existing in-repo `lock.ts`; per the project's own skill-quality bar ("when no reputable ≥1K-install skill exists, don't settle for a weak one"), there is no ≥1K-install skill for "in-memory TTL cache" worth searching for — it would just be a wrapper around stdlib `Map`, which is rung 3 of the ladder, not a dependency to add. Use the already-available, no-install `.agents/skills/` disciplines instead:
- **`test-driven-development`** — write `result-cache.test.ts`'s cases (§7) before `result-cache.ts`'s implementation; guides **S3/S4/S6**.
- **`security-and-hardening`** — the cookie-hash-not-boolean key design and the `action-sequence` cache exclusion in §3.3–3.4 are exactly its concern; guides **S3/S4/S9** and the **G4** sign-off.
- **`performance-optimization`** — guides measuring/asserting the order-of-magnitude hit/miss delta in **S7**'s `verify-F16.mjs` rather than asserting a vague "is faster."
- Fallback: `context7-mcp` for official Node `node:crypto` API docs if any implementer is unsure of `createHash` usage — not expected to be needed given how standard the API is.
