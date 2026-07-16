# F12 — Policy engine

## 1. Summary

- **ID / Name:** F12 — Policy engine
- **Pillar:** D (compliance)
- **Wave:** 4
- **Gates:** Se, Lv (no Ar — see §3, F12 registers no new tool/boundary; no Design gate — no UI)
- **Risk:** M

**What.** A pure compliance layer — `src/policy.ts` — that every extraction run passes through before it touches the network: (1) fetch/parse the target origin's `robots.txt` and refuse disallowed paths, (2) refuse known-ToS-restricted origins outright, (3) enforce a minimum interval between runs of the same template ("per-template rate limits" — each `templateId` gets its own throttle bucket).

**Why (tied to 00-vision).** The vision's flywheel depends on a *public, crowd-supplied registry* of templates (00-vision: "agents/devs contribute templates … instantly usable in web + app"). A registry that lets anyone run community templates against arbitrary sites (Program 2's X02 "safe registry-only runtime", phone-first) is a legal and reputational liability the moment a run ignores `robots.txt` or hammers a site — exactly the target verticals in 00-vision (financial data aggregation, healthcare portals, government/civic data) are the ones with the strictest access terms. F12 is the difference between "a responsible RPA-replacement platform" (00-vision's positioning against ad-hoc scraping/computer-use) and "a scraper that gets registry templates IP-banned." It is infrastructure for trust, sitting alongside F11 (provenance) and F13 (vault) as the three pillar-D features that make the registry safe to make public.

## 2. User / agent story

> As an agent calling `execute_native_extraction` against a community template, I never see a policy check — it either runs normally, or fails fast with a clear reason (`policy:robots`, `policy:rate-limit`, `policy:tos`) I can act on (wait and retry, or stop). As the project owner, I never have to manually audit which templates behave — every run, from every surface (self-host MCP, F07 pipelines, the future cloud X02 runtime), is gated by the same one module, so "does this respect the site" is answered once, not per-caller.

## 3. Design

**Modules touched (exact, matches the catalog's Modules cell — `policy.ts (new), engine` — nothing else):**

- `D:/MCP/src/policy.ts` — **new**, pure-ish module (network calls only to fetch `robots.txt`; otherwise in-memory).
- `D:/MCP/src/engine.ts` — **modify**: one `await enforcePolicy(...)` call inserted into `executeExtraction`, the same function ADR-04 names as "the one place that assembles `ExtractionResult`."

**Deliberately NOT touched:** `types.ts` / `storage.ts` / `index.ts`. The catalog's Modules cell lists only `policy.ts` + `engine` — no manifest field, no new tool. Concretely this means:
- No `ManifestEntry` field for rate limits. "Per-template" describes the *tracking granularity* (one throttle bucket keyed by `templateId`), not per-template configurability — a single global default interval applies to all templates. Config lives inside `policy.ts` itself (constants + env-var overrides), never a manifest field or a config file (a config file would need `storage.ts`, which is also out of the Modules cell).
- No new MCP tool. **ADR-02's explicit dependents list** (`F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25`) does **not** include F12 — confirming by omission that this feature is transparent enforcement inside the existing `execute_native_extraction` path, not a new `registerXxxTool` surface. This is also why F12's gates are `Se Lv` and not `Ar Se Lv`: no new module boundary/tool means no G3 Arch review.

**ADRs obeyed:**
- **ADR-02** (tool-module convention) — obeyed by *absence*: F12 adds zero tool wiring, so `index.ts` needs zero appended lines and zero G3 Arch gate.
- **ADR-04** (metrics measure-model) — obeyed directly: F12 does **not** add a parallel instrumentation/logging path (the ADR's contract rule). A policy block simply throws inside `executeExtraction`; the existing single emission point (landed by F14, wave 1) records it as `{ templateId, kind, success:false, durationMs, timestamp, error }` like any other failure. `error` is formatted `policy:<reason>[:<detail>]` (e.g. `policy:robots:disallow /search`, `policy:rate-limit:1800ms`) so later consumers (F20 diff mesh, F24 reputation) can `.startsWith('policy:')` without a new field.

**`src/policy.ts` sketch:**

```ts
export type PolicyBlockReason = 'robots' | 'rate-limit' | 'tos';

export class PolicyBlockedError extends Error {
  constructor(
    public reason: PolicyBlockReason,
    message: string,
    public retryAfterMs?: number,
  ) { super(message); this.name = 'PolicyBlockedError'; }
}

interface PolicyConfig {
  respectRobotsTxt: boolean;        // default true
  minIntervalMsPerTemplate: number; // default 3000 — ponytail: min-interval gate, not a token bucket; add burst allowance if a template needs bursts
  userAgent: string;                // default 'APImeMCP-bot/1.0 (+https://github.com/neetigyashah/apimemcp)'
  robotsCacheTtlMs: number;         // default 3_600_000 (1h)
  tosRestrictedDomains: string[];   // default [] — curated denylist, source-edited (no UI/tool to manage it)
}

// memoized; reads APIMEMCP_POLICY_MIN_INTERVAL_MS / APIMEMCP_POLICY_RESPECT_ROBOTS env overrides once
export function getPolicyConfig(): PolicyConfig;
// test-only / advanced override hook — mutates the memoized config in place
export function configurePolicy(overrides: Partial<PolicyConfig>): void;

// throws PolicyBlockedError, resolves void — call before any navigation/fetch in executeExtraction
export async function enforcePolicy(templateId: string, url: string): Promise<void>;

function checkRateLimit(templateId: string, cfg: PolicyConfig): void;         // in-mem, no network — checked first (cheapest)
async function checkRobotsAndTos(url: string, cfg: PolicyConfig): Promise<void>; // tos denylist (cheap) then robots.txt (network)
async function fetchRobotsTxt(origin: string, cfg: PolicyConfig): Promise<{ disallow: string[] }>;
function isPathDisallowed(pathname: string, disallow: string[]): boolean;
```

State: `const lastRunAt = new Map<string, number>()` and `const robotsCache = new Map<string, { disallow: string[]; fetchedAt: number }>()` — module-level in-mem Maps, mirroring F16's `result-cache.ts` in-mem-Map-with-TTL pattern (no new caching abstraction). Ponytail: in-mem only, resets on process restart — acceptable for a local-first single-process server; upgrade path is a persisted store only if F12 ever needs to survive restarts mid-throttle-window.

**Robots.txt fetch semantics (RFC 9309-style, safer-default given pillar D):** use built-in `fetch` with `AbortSignal.timeout(3000)`. HTTP 404/4xx → treat as "allow all" (no restriction file = no restriction, the standard convention). 5xx / network error / timeout → **fail closed** (`PolicyBlockedError('robots', …)`) — we can't confirm permission, so we don't guess permissive. Parser handles only `User-agent: *` and the configured UA's `Disallow:` prefix lines (first-prefix-match wins); no `Allow:`-override, no wildcard/`$` support — documented ponytail limitation, upgrade path noted inline if a real template needs it.

**Ordering inside `enforcePolicy`:** rate-limit (in-mem, cheapest) → tos denylist (in-mem) → robots.txt (network, cached). On pass, `lastRunAt.set(templateId, Date.now())` is recorded immediately (throttles attempt frequency regardless of the run's own success/failure).

**`src/engine.ts` change:**
```ts
import { enforcePolicy } from './policy.js';
// inside executeExtraction(templateId, targetUrl, ...), first line of the body, before page.goto(...):
await enforcePolicy(templateId, targetUrl);
```
`PolicyBlockedError` propagates through whatever try/catch already wraps `executeExtraction` for ADR-04 emission — no new catch block, no new emission call.

**MCP tool / HTTP route / screen:** none. No `registerXxxTool` module, no `index.ts` append. (If a future feature wants an audit surface — e.g. "why was this blocked" — that is new scope, not F12's; out of bounds per this spec's strict-scope rule.)

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | **N/A** | No `ManifestEntry`/Zod change — policy config is engine-internal (see §3 rationale). |
| S2 Storage | **N/A** | No persisted file; in-mem Maps only. |
| S3 Core | Applicable | `enforcePolicy`, `checkRateLimit`, `checkRobotsAndTos`, `fetchRobotsTxt`, `isPathDisallowed` in `policy.ts`. |
| S4 Module | Applicable | New `src/policy.ts` file itself. |
| S5 Wiring | **N/A** | No tool registration, no `index.ts` append (absent from ADR-02's dependents list). |
| S6 Unit | Applicable | `src/policy.test.ts` (see §7). |
| S7 Verify | Applicable | Engine/network-touching (real `robots.txt` fetch) → `scripts/verify-F12.mjs` + fixture (see §7). |
| S8 Docs | Applicable | One-paragraph README/SKILL note: runs are policy-gated; env vars to tune. |
| S9 Review | Applicable | G2 code-review (every feature). |
| S10 Live | Applicable | G6 Live-Verify — Lv gate is listed for F12. |
| S11 Merge | Applicable | G7 Integration. |

## 5. Dependencies & sequencing

- **Hard deps (catalog Deps column): none** (`—`). F12 is a leaf/standalone compliance feature.
- **What it unblocks:** nothing formally — no other row in the F00–F25 or W/X/M catalogs lists F12 in its Deps column. Its value propagates *implicitly*: every feature that runs extractions through `executeExtraction` (F00, F05/F06 crystallization, F07 pipelines — each step, F09 bidirectional flows, F15 static-http fast path once it exists) is automatically policy-gated without referencing F12 directly, because the enforcement sits at the shared choke point ADR-04 already designates.
- **Soft sequencing (not hard deps, just sane build order):** land after F14 (wave 1) so the ADR-04 single emission point exists in practice to carry the failure; land after F00 (wave 0) so `engine.ts`'s structure is already stabilized (F00 fixes the engine↔app-connections erosion) before F12's one-line insertion. Wave 4 already places it after both.
- **Wave:** 4.

## 6. Quality gates

- **G4 Security (Se):** Security-Reviewer confirms: fail-closed on robots.txt-unreachable (not fail-open) is actually implemented; the `tosRestrictedDomains` denylist is checked unconditionally (not skippable by any param); rate-limit state is never keyed by anything user-cookie/secret-derived (only `templateId`) — no leakage risk. No new module reads app-connections/vault data (stays out of ADR-05's territory entirely).
- **G6 Live-Verify (Lv):** `scripts/verify-F12.mjs` runs against a real local fixture with real `fetch`/Playwright (not mocks) and demonstrates all three block reasons plus the allow path.
- **G3/G3b:** skipped — no new tool/boundary (§3), no UI.

**Definition of Done:**
1. `enforcePolicy()` runs on every `executeExtraction` call before any navigation.
2. A `Disallow`-matched path throws `PolicyBlockedError('robots', …)`; an allowed path proceeds untouched.
3. A `robots.txt` fetch failure other than 404/4xx blocks (fail-closed); a 404 allows.
4. Two calls for the same `templateId` inside `minIntervalMsPerTemplate` — second throws `PolicyBlockedError('rate-limit', …, retryAfterMs>0)`; after the interval elapses, it succeeds.
5. A `tosRestrictedDomains` match blocks regardless of `robots.txt` content.
6. The failure reaches the existing ADR-04 measure record as `error: 'policy:<reason>...'` — no second logging path added.
7. Unit + live-verify suites both green; no new tool appears in `listTools()`.

## 7. Test plan

**`src/policy.test.ts` (Vitest, browser-free):**
- `isPathDisallowed`: matches a simple prefix; no match → allowed; empty `disallow` → allow-all.
- `fetchRobotsTxt` (mocked `fetch`): 200 with `Disallow: /x` → parsed; 404 → `{disallow: []}` (allow-all); 500/network-throw → the caller (`checkRobotsAndTos`) surfaces `PolicyBlockedError('robots', …)` (fail-closed).
- `checkRateLimit`: first call for a fresh `templateId` passes; immediate second call throws `PolicyBlockedError('rate-limit', …)` with `retryAfterMs > 0`; using `configurePolicy({ minIntervalMsPerTemplate: 0 })` (or `vi.useFakeTimers()` + advancing past the interval) the next call passes again.
- `tosRestrictedDomains`: `configurePolicy({ tosRestrictedDomains: ['blocked.example'] })` → `enforcePolicy(..., 'https://blocked.example/anything')` throws `PolicyBlockedError('tos', …)` even with a mocked permissive `robots.txt`.
- Regression: a normal, well-spaced, robots-allowed call to `enforcePolicy` resolves (no false positive).

**`scripts/verify-F12.mjs` + fixture (engine/network-touching → Lv gate):**
- Fixture at `scripts/fixtures/f12-policy-site/`: `robots.txt` (`User-agent: *` / `Disallow: /blocked`), `allowed.html`, `blocked.html` — served by a tiny `node:http` server started inline in the verify script (no new dependency, mirrors the existing `verify-*.mjs` local-fixture pattern).
- Steps: (1) register a temp template pointed at `/allowed` → `execute_native_extraction` succeeds. (2) register/point a temp template at `/blocked` → run fails with `policy:robots` in the error. (3) call the `/allowed` template twice back-to-back → second call fails with `policy:rate-limit`; wait out `retryAfterMs` → third call succeeds. (4) tear down the local server and clean up temp templates.
- Prints explicit `PASS`/`FAIL` lines per step (existing verify-script convention) and exits non-zero on any failure so CI can gate on it.

## 8. Acceptance criteria (live, observable proof)

- Running `node scripts/verify-F12.mjs` locally prints 4 `PASS` lines (allowed-succeeds, robots-blocks, rate-limit-blocks-then-recovers, cleanup) and exits 0.
- `npm test` is green including `src/policy.test.ts`, with no changes required to any other `*.test.ts` file (confirms zero-footprint on existing behavior).
- `node dist/index.js`'s tool list is byte-identical before/after this feature (no new tool appeared) — a one-line diff check in the verify script or CI is sufficient proof.

## 9. Reuse notes

- **Reuse:** the in-mem `Map` + TTL pattern from F16's `result-cache.ts` (same shape of problem: cache keyed by a string, expire by timestamp) — don't invent a second caching abstraction.
- **Reuse:** the existing ADR-04 single instrumentation/emission point in `engine.ts`'s `executeExtraction` wrapper for failure recording — this is a hard contract rule ("no parallel instrumentation path"), not optional.
- **Reuse:** built-in `fetch` (already used by `registry-client.ts` for jsDelivr calls) for the `robots.txt` request — no new HTTP dependency.
- **Reuse:** the existing `scripts/verify-*.mjs` + local-fixture convention (same shape as F03's `verify-registry.mjs`) rather than a new test harness.
- **N/A for this feature** (listed in the shared template but not relevant here — noting explicitly rather than force-fitting): `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript` — none of these apply; F12 touches no persisted files and no template-registration path.

## 10. Skills (setup + when-to-use)

- **`.agents/skills/security-and-hardening`** (already installed, no `npx skills add` needed — part of the 24-skill discipline library every builder/reviewer already has). Guides **S3/S9**: fail-closed-by-default design on the robots.txt-unreachable path, and what the Security-Reviewer checks at G4.
- **`.agents/skills/test-driven-development`** (already installed). Guides **S6**: write `policy.test.ts`'s block/allow/recover cases before wiring `enforcePolicy` into `engine.ts`.
- **No new package install.** Ran the skill-quality bar mentally per PLAN's 08-skills-matrix protocol (`npx skills find robots.txt`, `npx skills find "rate limit"`) — this is a ~150-line hand-rolled parser over Node's built-in `fetch`, not a library integration; no ≥1K-install skill exists for "parse robots.txt in Node" and none is needed. Fallback per the skill-quality bar: **`context7-mcp`** only if/when Node's `AbortSignal.timeout`/`fetch` semantics need a docs check — pull `Node.js` official docs via `resolve-library-id` → `query-docs`, not general web search.
