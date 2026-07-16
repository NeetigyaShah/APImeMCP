# F18 — Ephemeral hosted endpoint

## 1. Summary

| id | name | pillar | wave | risk | gates |
|---|---|---|---|---|---|
| **F18** | Ephemeral hosted endpoint | E (dist+perf) | 5 | **H** | Se, Lv |

**What.** A registry-only, zero-persistence, *synchronous* HTTP execution surface added to the engine package: given `{templateId, targetUrl?, cookieString?, proxyUrl?}`, it resolves the template **only** from the public `apimemcp-templates` manifest (never an arbitrary local/unregistered script), runs the extraction once, and returns the result — never writing the result or the cookies to disk, never reusing a browser profile across calls. It is explicitly the "quick, synchronous" path (bounded by a Function-style timeout), not a durable job queue.

**Why (tied to 00-vision).** 00-vision's "two-track product" and "the bridge" (07-platform-design) both hinge on one fact: phones and browsers cannot run Playwright. Program 2's entire "run a community API from your phone" promise is blocked until *something* in the engine repo exposes a hostable, safe, stateless execution surface that a cloud deployment can wrap without importing engine internals (ADR-06). F18 **is** that substrate — the catalog names it explicitly: *"the substrate X01/X02 productize."* X01 (Vercel Functions gateway) and X02 (Sandbox/`@sparticuz/chromium` safe runtime) are deployments of F18's exported handler; the Oracle Always-Free ARM worker in the free-hosting matrix runs F18's `createHostedServer` directly as a long-lived process for heavy templates. Without F18, Program 2 has no engine-side contract to build against — it would have to reach into `engine.ts` internals, which ADR-06 forbids.

## 2. User / agent story

- **Cloud/Infra Builder (X01).** "I need a Node function that runs a registry template and returns JSON, without importing `engine.ts` or `storage.ts`." → `import { handleHostedRun } from '@neetigyashah/apimemcp/hosted'`, wire it into a Vercel Function body, done.
- **Consumer (web/mobile).** Taps **Run** on a registry template in the app. Expects a fast JSON/table result within seconds, and trusts that their pasted cookie and the returned data are never sitting on some server after the request completes.
- **Self-host operator (Oracle Always-Free worker).** Wants to run the *whole* engine as a long-lived, always-on HTTP process for heavy paginated templates the Vercel tier rejects. Starts `createHostedServer(deps).listen(PORT)`, points X03's "too heavy for cloud" deep-link at it.
- **Security-Reviewer.** Needs to look at exactly one small module to verify: registry-only, no persistence, no cross-caller state — not audit the whole engine.

## 3. Design

### 3.1 ADRs obeyed

- **ADR-06 (registry = cross-repo contract).** F18 *is* the "read-registry" seam ADR-06 formalizes: it resolves templates only via the same manifest (`Manifest`/`ManifestEntry`, incl. `outputSchema`) that `registry-client.ts` already fetches from jsDelivr, and it is consumed by X01/X02 only through a published npm subpath — never engine internals. The response envelope (`HostedRunResult`) is exported from the package barrel so Program 2 types against it, per ADR-06's "additive-optional, semver-major on break" discipline.
- **ADR-02 (tool-module convention), applied in spirit.** F18 adds zero MCP tools and does **not** touch `index.ts` (the catalog's Modules column for F18 lists only `hosted entry (new)` — no `index`, no `engine`, no `types`). It still follows ADR-02's DI discipline — one new module, an explicit `deps` object, no hidden cross-boundary imports — applied to an HTTP route table instead of the MCP server, so the handler is unit-testable with a fake `deps` exactly like a `registerXxxTool` handler is.
- **ADR-01 (schema contract), reused not re-implemented.** When a `ManifestEntry.outputSchema` is present, the result is run through the existing pure `validateOutput(value, schema)` before being returned; absent schema = no validation (same back-compat rule ADR-01 already defines).

### 3.2 Data shapes — `src/hosted-entry.ts` (new module, co-located, no new dir)

```ts
import { z } from 'zod';
import type { ManifestEntry } from './registry-client'; // existing type, reused
import type { ProvenanceReceipt } from './provenance';  // F11, once landed

export const HostedRunRequestSchema = z.object({
  templateId: z.string().min(1).optional(),   // registry key — required unless targetUrl resolves one
  targetUrl: z.string().url().optional(),     // used for findTemplateByUrl lookup when templateId omitted
  cookieString: z.string().optional(),        // transits encrypted upstream (X06); used in-memory only, never logged/written
  proxyUrl: z.string().url().optional(),
}).refine(r => r.templateId || r.targetUrl, { message: 'templateId or targetUrl required' });
export type HostedRunRequest = z.infer<typeof HostedRunRequestSchema>;

export interface HostedRunResult {
  ok: boolean;
  templateId: string;
  data?: unknown;
  error?: string;                 // 'not_in_registry' | 'validation_failed' | 'output_schema_mismatch' | 'timeout' | 'busy' | engine error message
  provenance?: ProvenanceReceipt;  // F11 signed receipt — present whenever deps.signReceipt is wired
  durationMs: number;
}

export interface HostedEntryDeps {
  resolveTemplate: (id: string) => Promise<ManifestEntry | undefined>;      // wraps registry-client.ts's existing manifest fetch — do not refetch/reimplement
  findByUrl: (url: string) => Promise<ManifestEntry | undefined>;           // reuses existing findTemplateByUrl
  runExtraction: (entry: ManifestEntry, input: HostedRunRequest) => Promise<unknown>; // delegates to the same runner execute_native_extraction already calls in engine.ts
  signReceipt?: (data: unknown, entry: ManifestEntry) => ProvenanceReceipt; // F11 export; optional so F18 degrades gracefully if F11 is feature-flagged off
  validateOutput?: (value: unknown, schema: unknown) => { ok: boolean; error?: string }; // ADR-01 pure fn
  captureForensicsOnError?: boolean;  // default false — zero-persist default; a self-host/Oracle operator may opt in for their own disk
  maxConcurrent?: number;             // default 4 — hard ceiling, see 3.3
}
```

No new `types.ts` export, no new Zod file — everything above is local to `hosted-entry.ts`, matching the catalog's single-module footprint for F18.

### 3.3 Module-by-module changes (exact paths)

- **`src/hosted-entry.ts` (new).** All types above, plus:
  - `handleHostedRun(req: HostedRunRequest, deps: HostedEntryDeps): Promise<HostedRunResult>` — validates `req` against `HostedRunRequestSchema`; resolves the template via `deps.resolveTemplate`/`deps.findByUrl` (registry-only — a miss returns `{ok:false, error:'not_in_registry'}`, it never falls back to a local/arbitrary script); acquires a concurrency slot (see below); calls `deps.runExtraction` in a **fresh, non-persistent** browser context (deliberately **not** F00's `launchPersistentContext` — that primitive exists to keep one caller's login session alive across *their own* repeated runs; reusing it here would leak session state across unrelated hosted callers, which is exactly the cross-caller leakage the Se gate forbids); validates output against `ManifestEntry.outputSchema` via `deps.validateOutput` when present; signs a receipt via `deps.signReceipt` when wired; returns. Never calls `atomicWriteFile` for the result or the cookie. Calls `captureForensics` only when `deps.captureForensicsOnError` is explicitly true.
  - `createHostedServer(deps: HostedEntryDeps): http.Server` — a ~30-line wrapper over Node's built-in `http` module (stdlib, no new dependency): reads a JSON body on `POST /run`, calls `handleHostedRun`, writes the JSON response with the same status-code mapping as X01 will use (`200` ok, `400` bad request/not-in-registry, `409` busy, `504` timeout). This is what the Oracle Always-Free worker runs directly; X01/X02 instead import `handleHostedRun` straight into a Vercel Function body and skip the raw server.
  - `registerHostedRunRoute(server: http.Server, deps: HostedEntryDeps): void` — the HTTP-surface sibling of ADR-02's `registerXxxTool`: same DI shape (explicit `deps`, no hidden imports), mounted once inside `createHostedServer`. This is *not* an MCP tool registration and does **not** touch `index.ts` — F18's Modules column has no `index` entry because there is nothing for a calling LLM agent to invoke here; the caller is an HTTP client (X01, or `curl`), not MCP/stdio.
- **`package.json` (existing, one addition).** Add an `exports["./hosted"]` subpath pointing at `dist/hosted-entry.js` (+ `.d.ts`), so X01/X02 do `import {...} from '@neetigyashah/apimemcp/hosted'` per ADR-06 — never a deep import into `dist/engine.js`. One appended map entry, same "append-only" spirit as ADR-02.
- **No changes to `engine.ts`, `types.ts`, `storage.ts`, or `index.ts`** — confirmed against the catalog's Modules column for F18 (`hosted entry (new)` only). All engine/registry logic is *called*, not duplicated.

### HTTP route signature

```
POST /run
  body: HostedRunRequest (JSON)
  200 -> HostedRunResult (ok:true)
  400 -> HostedRunResult (ok:false, error: 'not_in_registry' | 'validation_failed' | ...)
  409 -> HostedRunResult (ok:false, error:'busy')      # maxConcurrent exceeded
  504 -> HostedRunResult (ok:false, error:'timeout')
```

No `GET /run/:id` — F18 is intentionally synchronous/ephemeral only; the durable job/poll pattern (`POST /api/run` → `jobId` → `GET /api/run/:id`) belongs to X01/X03 wrapping this, not to F18 itself.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Yes | this document |
| S1 Types | Yes | `HostedRunRequestSchema`/`HostedRunResult`/`HostedEntryDeps`, co-located in `hosted-entry.ts` (no `types.ts` touch) |
| S2 Storage | **N/A** | zero-persistence is the point — no new `storage.ts` function, and existing ones (`atomicWriteFile`) are deliberately never called on the result/cookie path |
| S3 Core | Yes | `handleHostedRun` — registry resolve, allowlist, execute, validate, sign, return |
| S4 Module | Yes | `src/hosted-entry.ts` + `createHostedServer` |
| S5 Wiring | Yes (scoped) | one `package.json` `exports["./hosted"]` line only; `index.ts` intentionally untouched |
| S6 Unit | Yes | `src/hosted-entry.test.ts` (Vitest, fake `deps`, browser-free) |
| S7 Verify | Yes | `scripts/verify-F18.mjs` + fixture (real Playwright, real HTTP round trip) |
| S8 Docs | Yes | README "Hosted mode" section; note in ADR-06 cross-reference list |
| S9 Review | Yes | G2 Code-Review |
| S10 Live | Yes | G6 Live-Verification — engine/HTTP-touching |
| S11 Merge | Yes | G7 Integration, wave 5, after F11 is on `integration` |

## 5. Dependencies & sequencing

- **Hard deps:** **F11** (signed provenance receipts — `HostedEntryDeps.signReceipt`/`ProvenanceReceipt` type) and **registry** (`apimemcp-templates` manifest via the existing `registry-client.ts` fetch). Both land before wave 5 (F11 is wave 3; the registry repo/client already exists per grounded repo facts) — no forward dependency risk.
- **What it unblocks:** **X01** (Execution API gateway) and **X02** (Safe registry-only runtime) in Program 2 — per the cross-program note, "Program 2's 'run community APIs' core (X01/X02/W05/M04) lands after F18/F15/F03." F18 is the last engine-side gate before that core can start.
- **Related, not blocking:** F15 (`static-http`/cheerio fast path) is a natural future `runExtraction` variant for light templates — X02 lists F15 as its *own* dependency, not F18's; F18's `runExtraction` dep is written against whatever `execute_native_extraction` already calls today, and picks up F15's faster path for free once that lands, no F18 code change needed.
- **Wave:** 5 (final Program-1 wave, alongside F21/F24/F25) — deliberately last so F11's receipt shape is stable before F18 bakes it into the hosted response envelope.

## 6. Quality gates

Per the catalog's Gates column for F18: **Se, Lv** (G3 Arch and G3b Design are **not** flagged — no new module boundary beyond the single co-located file, no UI).

| Gate | Applies? | Definition of Done |
|---|---|---|
| G0 Spec | Yes | this spec, consistent with ADR-02/ADR-06/ADR-01 |
| G1 Build | Yes | `tsc`/build clean; lint passes |
| G2 Code-Review | Yes | no reinvented registry/extraction/validation logic; `hosted-entry.ts` only calls existing primitives |
| G3 Arch | N/A (per catalog) | no cross-module boundary change beyond the one new file + one `exports` line |
| G3b Design | N/A | no UI |
| **G4 Security** | **Yes (blocks)** | registry-only enforced (non-registry `templateId`/unmatched `targetUrl` → reject, never fall back to a local script); **no disk persistence** of result or `cookieString` anywhere in the call path; fresh non-persistent browser context per call (never `launchPersistentContext`); `cookieString` never appears in logs/errors; `maxConcurrent` ceiling present and enforced; output validated against `outputSchema` when present |
| G5 QA | Yes | `hosted-entry.test.ts` green, deterministic, fake `deps` |
| **G6 Live-Verify** | **Yes (blocks)** | `scripts/verify-F18.mjs` green against a real fixture: real HTTP round trip, real Playwright run, provenance receipt hash verifies, zero new files under `templates/`/`output/` after the run |
| G7 Integration | Yes | rebased onto `integration` after F11; `index.ts`/`types.ts` untouched so no ADR-02 conflict possible |
| G8 Promote | Yes | additive `exports` map entry only → no engine semver-major required (ADR-06); tag + changelog note "hosted subpath added" for the platform team |

## 7. Test plan

**`src/hosted-entry.test.ts`** (Vitest, browser-free, fake `deps`):
1. `templateId` not returned by `resolveTemplate` → `{ok:false, error:'not_in_registry'}`, `runExtraction` never called.
2. `targetUrl` with no matching `findByUrl` entry → same rejection path.
3. Malformed body (fails `HostedRunRequestSchema.safeParse`) → `{ok:false, error:'validation_failed'}` before any registry lookup.
4. Happy path: valid `templateId` → `runExtraction` called with the resolved `ManifestEntry` + request; result returned with `durationMs` set.
5. `signReceipt` wired → `data` result includes `provenance`; `signReceipt` omitted (F11 flagged off) → response still succeeds, `provenance` simply absent (ADR-01-style graceful degrade).
6. `ManifestEntry.outputSchema` present + `validateOutput` returns `{ok:false}` → result is `{ok:false, error:'output_schema_mismatch'}`, not the raw mismatched data.
7. Concurrency: with `maxConcurrent: 1`, a second call started before the first resolves gets `{ok:false, error:'busy'}` (reusing the existing in-proc `withLock` mutex — no new queue built).
8. **Zero-persistence assertion:** spy/mock on `atomicWriteFile` (and any other storage write) asserts it is **never called** during a full `handleHostedRun` cycle, success or failure.
9. **No-log-leak assertion:** a `cookieString` containing a recognizable sentinel value never appears in any captured console/log output during a run.
10. `captureForensicsOnError: true` on a forced `runExtraction` throw → forensics capture fires once; default (`false`/unset) → it never fires.

**`scripts/verify-F18.mjs` + fixture:** starts `createHostedServer` on an ephemeral local port; points it at the same low-churn fixture site the existing `scripts/verify-*.mjs` scripts already target (no new external dependency); POSTs a real `templateId` known to be registry-registered; asserts `200`, a valid `provenance.contentHash`, and that a concurrent burst of `maxConcurrent + 2` requests returns exactly `maxConcurrent + 2` responses with the excess marked `busy`, without the server crashing; asserts `git status`/directory listing of `templates/` and `output/` is unchanged before vs. after the run (the literal "ephemeral" proof).

## 8. Acceptance criteria (live, observable)

- `node scripts/verify-F18.mjs` exits 0 against a local `createHostedServer` instance.
- `curl -s -X POST localhost:<port>/run -d '{"templateId":"<real-registry-id>","targetUrl":"<its-url>"}'` returns a `200` JSON body with `ok:true`, a populated `data`, and a `provenance` object whose signature verifies.
- The same request with a made-up `templateId` (not in the manifest) returns `400 {ok:false,error:'not_in_registry'}` — it does not run anything.
- Diffing `templates/` and `output/` directory listings before and after a successful run shows **zero new files** — the zero-state claim is directly observable, not asserted.
- Firing `maxConcurrent + 1` simultaneous requests never crashes the process; the excess request(s) come back `409 busy`.

## 9. Reuse notes

Call, do not reimplement:
- **`registry-client.ts`**'s existing manifest fetch — `resolveTemplate`/`findByUrl` are thin wrappers, not a second registry client.
- **`findTemplateByUrl`** — reused verbatim for the `targetUrl`-only lookup path.
- **`withLock`** (existing in-proc mutex) — reused for the `maxConcurrent` ceiling; no new queue/semaphore module.
- **`validateOutput`** (ADR-01, `types.ts`/`schema.ts`) — reused for `outputSchema` checks; F18 adds zero validation logic of its own.
- **F11's `provenance.ts` signing export** — reused for `HostedEntryDeps.signReceipt`; F18 only defines the `deps` slot, F11 owns the signing implementation.
- **`captureForensics`** — reused, but gated behind an explicit opt-in flag (`captureForensicsOnError`) rather than called unconditionally, because F18's default posture is zero-persist while `captureForensics` writes to disk; this keeps the existing function untouched and simply chooses, per-deployment, whether to call it.
- **Deliberately not reused here:** `launchPersistentContext` (F00) — wrong primitive for a stateless multi-caller endpoint, see 3.3; `atomicWriteFile` — deliberately never called on this path; `registerTemplate`/`buildStandaloneScript` — those serve template *authoring*/export flows, out of scope for a *run* endpoint.

## 10. Skills (setup + when-to-use)

No new framework is introduced (Node's built-in `http` module covers the server; no Express/Fastify dependency added — ladder rung 3, stdlib), so no ≥1K-install skill applies to the core module itself.

| Skill | Status | Guides |
|---|---|---|
| `.agents/skills/security-and-hardening` | already available, no install | G4 Security sub-task — registry-only/zero-persist/no-cross-caller-leakage checklist (S3, S9) |
| `.agents/skills/test-driven-development` | already available, no install | S6 unit tests (fake-`deps` style, table above) |
| `.agents/skills/incremental-implementation` | already available, no install | keeping the module single-file/minimal per the catalog's one-module footprint (S4) |
| `using-apimemcp` | already available, no install | S3/S4 — existing engine usage patterns (`execute_native_extraction`-style calls, registry-client shape) |
| `context7-mcp` | already available, no install | **fallback for anything Vercel-Node-Function-specific** the Cloud/Infra Builder later needs when wrapping `handleHostedRun` in X01 (e.g., how a Vercel Node Function's request object differs from raw `http.IncomingMessage`) — per the skill-quality bar, no ≥1K-install skill targets "framework-agnostic hosted HTTP handler design," so live official docs are the correct fallback rather than settling for a low-install community skill |

Per 08-skills-matrix.md's rejection list, Cloudflare/serverless-Chromium skills (142/75 installs) are already excluded project-wide — F18 does not need them since it stays framework-agnostic and Node-stdlib-only; X02 (the deployment wrapping F18) is where that fallback is actually exercised.
