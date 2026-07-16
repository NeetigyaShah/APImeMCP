# X02 — Safe registry-only runtime

## 1. Summary

- **ID:** X02 · **Name:** Safe registry-only runtime · **Surface:** Cloud (Program 2) · **Wave:** P1 (its feasibility-spike sub-portion is P0, parallel with Program 1 Waves 1–2) · **Risk:** H · **Gates:** Se Lv
- **What:** The sandboxed execution primitive that actually *runs* a community template from a phone or browser tap — no self-hosted Playwright required. Given a registry `templateId` (+ optional `targetUrl`/`cookieString`/`input`), it validates the template is registry-vetted, enforces the item-5 network allowlist, executes via the cheapest safe backend for the template's kind (no-browser `static-http` fast path, or a real headless-Chromium backend for everything else), validates the result against ADR-01's `outputSchema` when declared, and returns — **never persisting** the input or result server-side by default.
- **Why (market angle, 00-vision.md):** This is the literal machinery behind the vision's "Cloud/consumer" track — *"registry-only community templates, safe + sandboxed, phone-first — everyone."* Phones can't run Playwright, so X02 is the mandatory bridge that makes the whole Program-2 promise ("run community APIs from your phone, results pushed to you") real instead of aspirational. It is the substrate directly under X01 (gateway), X03 (durable/heavy fallback), X05 (monitors — the consumer wedge), W05 (web run console) and M04 (mobile run screen). Without X02, none of those can show a real result.
- **Non-goals:** arbitrary/user-submitted script execution (only registry-manifest templates ever run); persistent storage of inputs/results (that's X04/X07's concern, off by default here); the public HTTP contract (that's X01 — X02 is the engine underneath it, not a public route).

## 2. User/agent story

- **As a phone user** browsing the community registry, when I tap **Run** on a template, I want my request executed against the real target site and real data streamed back in seconds — without my phone running a browser, and with certainty the platform only ever runs code the community has vetted (never my own arbitrary script).
- **As X01** (the execution API gateway), I need one dependency-injected, safely-scoped execution call I can invoke synchronously for light jobs and hand to X03 for heavy ones — so X01 never has to trust, sandbox, or directly touch template code itself; that responsibility is fully owned by X02.

## 3. Design

**Repo location (ADR-06).** X02 lives in the **new `apimemcp-platform` Turborepo** (created by W01: `apps/web`, `apps/mobile`, `packages/shared`), never in `D:/MCP/src`. Per ADR-06, the platform's only contact with the engine is the published `@neetigyashah/apimemcp` npm package (types +, for this feature specifically, F18's exported zero-state execution function) and the registry manifest — never engine-repo internals. **X02 makes zero changes to `D:/MCP/src`**; its one upstream requirement is a contract on F18 (below), which F18's own spec must satisfy.

**Directory decision (lazy, no new app).** W01's scaffold has no `apps/cloud`; adding one would be a speculative extra deployable for a feature that has no route of its own (see below). Instead: real logic lives in a new shared package `packages/cloud-runtime/`, and the one call site is a plain in-process import from X01's existing Next.js route handler in `apps/web`. This also keeps the Cloud/Infra Builder's diffs inside its own package directory, away from the Web Builder's `apps/web/app/(site)/**` files — the contention-avoidance the roster already wants, achieved without inventing a new app.

**Does X02 register its own route? No.** X01 owns the only public route (`POST /api/run`, `GET /api/run/:id`). X02 is a **library**, called in-process by X01 (inline path) and by X03's workflow step (durable path) — an extra internal HTTP hop to itself would be pure overhead. ADR-02's *substance* (explicit injected `deps`, one composition point, fake-`deps`-testable) is honored via a factory function instead of `registerXxxTool(server, deps)`, since there is no MCP `server` object in this repo:

```ts
// packages/cloud-runtime/src/safe-runtime.ts
export interface SafeRuntimeDeps {
  lookupTemplate: (templateId: string) => Promise<ManifestEntry | null>; // X07 mirror, jsDelivr fallback
  runHostedEntry: HostedEntryFn;      // published by engine F18 — see contract below
  sandboxBackend?: BrowserBackend;    // Vercel Sandbox microVM — present iff spike says "go"
  chromiumBackend?: BrowserBackend;   // @sparticuz/chromium inline-Function fallback
  now?: () => number;
}
export function createSafeRuntime(deps: SafeRuntimeDeps): {
  run(req: SafeRunRequest): Promise<SafeRunResult>;
}
```

**Data shapes** (`packages/cloud-runtime/src/types.ts`, zod-validated at the X01 boundary):

```ts
export const SafeRunRequestSchema = z.object({
  templateId: z.string().min(1),
  targetUrl: z.string().url().optional(),
  cookieString: z.string().optional(),   // encrypted-in-transit per X06; never logged/stored here
  input: z.record(z.unknown()).optional(),
});
export type SafeRunRequest = z.infer<typeof SafeRunRequestSchema>;

export interface SafeRunResult {
  status: 'ok' | 'error' | 'too_heavy';
  data?: unknown;              // validated against ManifestEntry.outputSchema (ADR-01) when present
  error?: string;
  durationMs: number;
  templateId: string;
  kind: 'static-http' | 'browser-sandbox' | 'browser-chromium';
}
```

**Contract required of F18 (engine, `D:/MCP/src`, module `hosted entry (new)` per the F##catalog — X02's upstream dependency, not X02's own work):** a Playwright-import-clean-at-the-type-level, zero-state function exported from the package's public entry, callable as a plain library function (not over MCP stdio):
```ts
type HostedEntryFn = (
  entry: ManifestEntry,
  opts: { targetUrl?: string; cookieString?: string; input?: Record<string, unknown>; allowedDomains: string[] }
) => Promise<{ data: unknown; durationMs: number }>;
```
X02 does not reimplement extraction or the network allowlist — it calls this function and passes `entry.allowedDomains` (or equivalent manifest field) through untouched.

**`run()` logic (module-by-module):**
1. `packages/cloud-runtime/src/registry-lookup.ts` — `lookupTemplate(id)`: reads X07's Postgres mirror first (fast path), falls back to the live jsDelivr `manifest.json` (same shape `registry-client.ts` already fetches engine-side, per ADR-06 — reimplemented thin here, not imported, since platform never imports engine internals). Unknown `templateId` → `{status:'error', error:'unknown template'}`, **never executes**.
2. Allowlist check — if `targetUrl` given, its hostname must be in the template's declared domain(s); reject **before any network egress** if not.
3. Backend selection by `entry.kind`: `'static-http'` (F15) → call `deps.runHostedEntry` directly, no browser at all (`kind:'static-http'` in the result). Anything else → route to `deps.sandboxBackend` or `deps.chromiumBackend` per the `CLOUD_EXEC_BACKEND=sandbox|chromium` env flag the feasibility spike resolves (S0 below).
4. Timeout: `Promise.race` against `entry.declaredTimeoutMs ?? DEFAULT_CEILING_MS`; on trip, return `{status:'too_heavy'}` (a clean signal, not a hung Function/crash) so X03 can show the self-host fallback message.
5. If `entry.outputSchema` (ADR-01) is present, validate `data` before returning; mismatch → `{status:'error', error:'schema mismatch'}`.
6. `cookieString` is never logged, never included in the returned result, never written to disk/DB — zero-persist-by-default (X04) enforced at this layer, not left to the caller.

**Backends:** `packages/cloud-runtime/src/backends/static-http.ts`, `browser-sandbox.ts` (Vercel Sandbox SDK: `Sandbox.create()` + run the hosted-entry call inside it), `browser-chromium.ts` (`@sparticuz/chromium` + `playwright-core` inline in the same Vercel Function). Both browser backends implement one `BrowserBackend` interface so swapping the spike's chosen default is a one-line change, not a rewrite.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document + the feasibility-spike plan (Sandbox vs `@sparticuz/chromium`, go/no-go before full build). |
| S1 Types | Applicable | `SafeRunRequest`/`SafeRunResult` zod schemas; re-export published `ManifestEntry`/`outputSchema` types (npm, per ADR-06). |
| S2 Storage | Applicable (minimal) | Read-only: X07 mirror query + jsDelivr fallback. No result/cookie persistence by design — that's the point of the feature. |
| S3 Core | Applicable | `createSafeRuntime` — backend selection, allowlist, timeout, schema validation. |
| S4 Module | Applicable | New package `packages/cloud-runtime/`. |
| S5 Wiring | Applicable | One in-process import + call from X01's `apps/web/app/api/run/route.ts`; a second call site in X03's workflow step. |
| S6 Unit | Applicable | `safe-runtime.test.ts` — see §7. |
| S7 Verify | Applicable | `packages/cloud-runtime/scripts/verify-x02.mjs` — Cloud's analogue of engine's `verify-*.mjs`, hits a real preview deploy. |
| S8 Docs | Applicable | `packages/cloud-runtime/README.md` (backend selection, timeout ceiling, allowlist contract on F18). |
| S9 Review | Applicable | G2 Code-Review, mandatory on every PR. |
| S10 Live | Applicable | G6 Live-Verify = preview-URL smoke (per quality-gates.md's Cloud mapping) + the spike's own go/no-go run is itself an early live-verify checkpoint. |
| S11 Merge | Applicable | G7 Integration into `apimemcp-platform`'s `main` (per 04-git-strategy.md, no self-merge). |

## 5. Dependencies & sequencing

- **Hard deps (catalog):** `F18` (Ephemeral hosted endpoint, Program 1 Wave 5 — supplies `HostedEntryFn`, the contract above), `F15` (`static-http` kind, Program 1 Wave 3 — the no-browser fast path X02 special-cases), `item-5` sandboxing (network allowlist/resource caps, **already shipped** in engine commit `94b6101` — inherited transitively through F18's export, not rebuilt here).
- **Two-phase sequencing (per PLAN.md's Program 2 architecture note — do not collapse this):** **Phase A — feasibility spike** runs in Program 2 **P0**, in parallel with Program 1 Waves 1–2; it does *not* wait on F18/F15 — it only needs a throwaway registry-shaped fixture + Vercel Sandbox/`@sparticuz/chromium` to answer "does Playwright run acceptably here," resolving `CLOUD_EXEC_BACKEND`. **Phase B — full build** is Program 2 **P1** and genuinely cannot complete until F18 (the real hosted-entry export), F15 (the `static-http` kind must exist in real manifests) and F03 (nightly-verify badges, so what X02 runs is actually trustworthy) have shipped from Program 1.
- **Unblocks:** X01 (has nothing to execute without X02), X03 (needs X02's `too_heavy` signal to trigger its self-host fallback message, and calls the same runtime for its steps), X05/W05/M04 (nothing to show a user without a real execution result).

## 6. Quality gates

Catalog-flagged: **Se** (Security-Reviewer, blocking), **Lv** (Live-Verification, blocking) — plus the always-on defaults G0/G1/G2/G5/G7/G8. ADR-06's own text additionally states its cross-repo contract rule is policed at **G7 Integration** regardless of per-feature flags ("a platform PR importing anything but published types / the manifest is rejected") — a standing check on this feature specifically, since it's the first real consumer of a Program-1 export.

**Definition of Done:**
- Unknown `templateId` is rejected pre-execution, no exceptions.
- `targetUrl` outside the template's declared allowlist domain(s) is rejected before any network egress.
- `static-http`-kind templates never spin up a browser backend (verified by asserting `kind` in the result and by a spy on both browser backends in tests).
- Feasibility spike has a written go/no-go and `CLOUD_EXEC_BACKEND` reflects it before Phase B is called done.
- Timeout produces a structured `too_heavy` result, never a hung Function or an unhandled crash.
- `cookieString` never appears in logs, error messages, or the returned `SafeRunResult`.
- No result or input is written to any datastore by this feature (zero-persist default holds).

## 7. Test plan

`packages/cloud-runtime/src/safe-runtime.test.ts` (Vitest, matching the engine repo's choice and the `next-forge` scaffold default):
- Rejects unknown `templateId` without calling `runHostedEntry`.
- Rejects `targetUrl` whose hostname isn't in the template's allowlist, before `runHostedEntry` is called.
- `static-http`-kind entry routes to `runHostedEntry` directly; both `sandboxBackend`/`chromiumBackend` spies are never invoked.
- Non-`static-http` entry routes to whichever backend `CLOUD_EXEC_BACKEND` selects.
- `outputSchema` present + mismatched result → `{status:'error'}`, valid result → `{status:'ok', data}`.
- Simulated slow backend past `declaredTimeoutMs` → `{status:'too_heavy'}`, not a thrown/hung promise.
- `cookieString` passed in never shows up in the returned `SafeRunResult` or in any `console.*` call (spy on console).

`packages/cloud-runtime/scripts/verify-x02.mjs` + fixture (browser-touching, so required per template rules): deploys/targets a Vercel preview URL, calls X01's route with a known-good `static-http` community template + a real `targetUrl`, asserts a schema-valid, real (non-mocked) result within a few seconds; then repeats against a Playwright-requiring fixture template to exercise whichever backend the spike selected. Wired into the platform repo's CI equivalent of `.github/workflows/verify.yml`.

## 8. Acceptance criteria (live, observable proof)

- On a real Vercel preview deploy: calling X01's route with a real `static-http` registry template + real `targetUrl` returns real, schema-valid data in low seconds, with `kind:"static-http"` and no browser backend invoked.
- Calling with a real Playwright-requiring registry template returns real data via the spike-selected backend (`kind:"browser-sandbox"` or `"browser-chromium"`).
- Calling with a made-up `templateId` returns a clean rejection — confirmed nothing executed (no egress in logs/network trace).
- Calling with a `targetUrl` outside the template's declared domain returns a clean rejection with zero egress.
- Forcing a fixture past the timeout ceiling returns `too_heavy`, and X03's fallback message path is demonstrably reachable from that signal.

## 9. Reuse notes

- **F18's published hosted-entry export** — the actual extraction call; X02 imports and calls it, never reimplements extraction.
- **item-5 sandboxing** (network allowlist / resource caps, shipped in commit `94b6101`) — inherited transitively through F18's export; X02 only *passes through* `allowedDomains`, it does not re-enforce allowlisting itself at a second layer beyond the pre-egress hostname check in step 2.
- **F15's `static-http` kind** — reused as the routing key that skips the browser backend entirely.
- **ADR-01's `outputSchema`** — reused as-is (published type) to validate results before they reach X01/X04.
- **ADR-06's `Manifest`/`ManifestEntry` shape** — consumed via npm types, never redefined locally.
- **X07's registry mirror** — reused for fast lookup instead of hitting jsDelivr per request.

## 10. Skills (setup + when-to-use)

Already available, no install (per 08-skills-matrix.md):
- `vercel:vercel-sandbox`, `vercel:vercel-functions` — guide S3 (backend implementation) and S10 (live/preview verification); official Vercel skills, no install-count concern.
- `security-and-hardening` (one of the 24 `.agents/skills/`) — guides S3's allowlist/zero-persist enforcement and the G4/Se review itself.
- `test-driven-development` (`.agents/skills/`) — guides S6.

Fallback (per skills-matrix's explicit rejection of Cloudflare/serverless-Chromium skills at 142/75 installs — below the ≥1K bar): use `context7-mcp` for live, current `@sparticuz/chromium` and Vercel Sandbox SDK API docs during the S0 feasibility spike and the S3 backend build — do not settle for a low-install community skill here.
