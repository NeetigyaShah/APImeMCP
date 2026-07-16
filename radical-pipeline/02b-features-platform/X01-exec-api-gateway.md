# X01 — Execution API Gateway

## 1. Summary

| Field | Value |
|---|---|
| ID | **X01** |
| Name | Execution API gateway |
| Surface / Pillar | Cloud (Program 2) |
| Wave | P1 |
| Risk | H |
| Gates flagged | **Se** (Security-Reviewer, blocks), **Lv** (Live-Verification, blocks) |
| Deps | F18 (Ephemeral hosted endpoint — the engine-side substrate this productizes) |

**What.** The public HTTP front door of the cloud execution layer: `POST /api/run {templateId, targetUrl?, cookieString?}` → `{jobId}`; `GET /api/run/:id` → `{status, result?, error?}`. Clerk-authenticated, rate-limited, registry-only. It does **not** run Playwright itself — it validates, authorizes, creates a job record, and hands execution to X02 (inline sandboxed run) or X03 (durable workflow for heavier/multi-step jobs), then lets X04 fan the result out over SSE/push.

**Why (00-vision tie-in).** Phones and browsers cannot run Playwright, so per 00-vision's two-track model the "cloud/consumer" track only exists if there is a safe, thin API between a community template and a phone screen. X01 is literally **the bridge**: the moat (deterministic templates crystallized once) only reaches "everyone, phone-first" if there is one narrow, hardened gateway in front of it. It is the substrate every other consumer surface (W05 web console, W08 hero demo, M04 mobile run screen) calls — nothing in Program 2 can "run a community API" without X01.

## 2. User / agent story

- *Consumer on mobile*: taps **Run** on a template detail screen → app `POST`s to X01 → gets a `jobId` immediately → shows a progress state → polls/subscribes (X04) → sees the result in-app and gets a push when done.
- *Visitor on the marketing site*: types a domain into the live hero terminal (W08) → the demo calls X01 for a real, already-verified template → streams the real result back (never mocked, per website-design.md's "real data, never mocked" rule).
- *Agent/dev without a browser runtime*: hits X01 directly with a bearer token to run a registry template headlessly — same contract, no SDK required.

## 3. Design

### 3.1 ADRs obeyed

- **ADR-06 (registry = cross-repo contract) — the one X01 lives and dies by.** X01 imports **only** the published `@neetigyashah/apimemcp` npm types (`ManifestEntry`, `outputSchema`-validated result shapes) and reaches templates through the registry manifest (mirrored by X07) — **never** `D:/MCP/src` internals. A PR in `apimemcp-platform` importing anything from the engine repo other than the npm package is an ADR-06 violation and is rejected at G3 Arch / G7 Integration. X01 does not modify anything under `D:/MCP/src`; it only *depends on* the engine having exported a stable public types barrel (a prerequisite of F18/ADR-01, not X01's job to build).
- **ADR-02 (tool-module convention) — N/A, noted not skipped.** ADR-02 governs `registerXxxTool(server, deps)` for **MCP tools** inside the engine repo (`D:/MCP/src`). X01 registers **HTTP routes**, not MCP tools, in a different repo entirely, so ADR-02 itself does not apply. The platform-side analogue with the same "small, isolated, no shared-state contention" spirit is the Next.js App Router convention used below: one route-handler file per endpoint, thin, delegating all logic to `lib/*.ts` modules owned by a single feature.

### 3.2 Where this lives

Per `04-git-strategy.md`, Program 2 lives in the **new** `apimemcp-platform` Turborepo (not `D:/MCP`). X01 gets its own app, **`apps/cloud`**, distinct from `apps/web` (W01's site) — the catalog's Surface column already separates Cloud (X01–X07) from Web (W01–W08), and keeping the execution gateway in its own deployable lets the Cloud/Infra Builder ship independently of the Web Builder without touching the same Vercel project. Both are Next.js App Router apps on Vercel (Vercel Functions = the route handlers below); `apps/web` calls `apps/cloud`'s public URL exactly like any other client.

### 3.3 Data shapes

```ts
// apps/cloud/lib/types.ts
import { z } from "zod";

export const RunRequestSchema = z.object({
  templateId: z.string().min(1),
  targetUrl: z.string().url().optional(),        // required unless the template has a fixedTargetUrl (ManifestEntry)
  cookieString: z.string().max(8192).optional(), // encrypted in transit (X06); never persisted server-side by default (F18 zero-state)
  inputs: z.record(z.string(), z.unknown()).optional(), // forward-compat: extra template args
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "done", "error", "too_heavy"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export interface JobRecord {
  jobId: string;          // crypto.randomUUID()
  userId: string;         // Clerk sub — per-user isolation boundary
  templateId: string;
  status: JobStatus;
  createdAt: string;      // ISO
  updatedAt: string;
  result?: unknown;       // validated against ManifestEntry.outputSchema (ADR-01) before being written
  error?: string;
  selfHostHint?: string;  // set only when status === "too_heavy" (X03's fallback message, ⑦/free-tier-first)
}
```

### 3.4 Routes (Vercel Functions via Next.js App Router)

- **`apps/cloud/app/api/run/route.ts`** — `POST`. Order of work: (1) Clerk auth via `apps/cloud/middleware.ts` (401 if absent/invalid); (2) rate-limit check in `lib/rate-limit.ts` keyed by `userId` (429 on trip); (3) `RunRequestSchema.parse(body)` (400 on failure); (4) `getTemplate(templateId)` from X07's mirror — **404/400 if not found**, this is the registry-only enforcement point, X01 never executes a templateId that isn't in the mirrored manifest; (5) `createJob(...)` via `lib/jobs.ts` with `status: "queued"`; (6) route by the template's declared cost class — light/quick → call X02's `executeTemplate(job)` (fire-and-forget, updates the job record on completion); heavy/multi-step → hand off to X03's durable workflow, which itself may resolve to `status: "too_heavy"` + `selfHostHint` per the free-tier-first tradeoff; (7) respond `202 {"jobId": "..."}` immediately — this endpoint never blocks on execution.
- **`apps/cloud/app/api/run/[id]/route.ts`** — `GET`. Auth same as above; loads the `JobRecord` via `lib/jobs.ts`; **if `job.userId !== auth().userId`, return 404** (not 403 — never confirm another user's job even exists; this is the per-user isolation floor from `cloud-architecture.md`'s safety posture); otherwise returns `{status, result?, error?, selfHostHint?}`.

### 3.5 Module-by-module changes (all new, all in `apimemcp-platform`)

| Path | Owner | Purpose |
|---|---|---|
| `apps/cloud/app/api/run/route.ts` | X01 | POST handler (job creation) |
| `apps/cloud/app/api/run/[id]/route.ts` | X01 | GET handler (status/result) |
| `apps/cloud/lib/types.ts` | X01 | Zod schemas + `JobRecord` (above) — X04/X05 extend this, never fork it |
| `apps/cloud/lib/jobs.ts` | X01 | `createJob`, `getJob(jobId, userId)`, `updateJobStatus(jobId, patch)` against X07's Postgres, one row-scoped `UPDATE` per transition (no read-modify-write races) |
| `apps/cloud/lib/rate-limit.ts` | X01 | Per-user token bucket (Vercel KV, or `vercel:vercel-firewall` rule) |
| `apps/cloud/middleware.ts` | X01 | Clerk auth gate on `/api/run*` |
| `apps/cloud/lib/executor.ts` (interface only, body owned by **X02**) | X02 | `executeTemplate(job: JobRecord): Promise<void>` — X01 imports and calls this; does not implement it |
| `apps/cloud/lib/registry-mirror.ts` (interface only, body owned by **X07**) | X07 | `getTemplate(templateId): Promise<ManifestEntry \| null>` — X01 imports and calls this |
| `D:/MCP/src/*` | Engine (F18/ADR-01) | **Read-only dependency, not touched by X01.** X01 consumes the published npm barrel these modules export; no file under `D:/MCP/src` is created or edited by this feature. |

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Yes | This document + G0 sign-off (Architect+Orchestrator) |
| S1 Types | Yes | `apps/cloud/lib/types.ts` (§3.3), imports `ManifestEntry` from `@neetigyashah/apimemcp` |
| S2 Data/API client | Yes | `lib/jobs.ts` (Postgres via X07's shared client), `lib/registry-mirror.ts` call-site |
| S3 Screens/components | **N/A** | X01 is an API, no UI |
| S4 Feature module | Yes | `lib/rate-limit.ts`, `lib/executor.ts` call-site, cost-class routing logic in the POST handler |
| S5 Route/nav wiring | Yes | `app/api/run/route.ts`, `app/api/run/[id]/route.ts`, `middleware.ts` |
| S6 Component tests | Yes (as unit/integration) | Vitest on route handlers with `executeTemplate`/`getTemplate` mocked (§7) |
| S7 e2e/device | Yes (as live HTTP) | `scripts/verify-X01.mjs` against a deployed preview (§7) |
| S8 Docs | Yes | This spec + a short `apps/cloud/README.md` route table |
| S9 Review | Yes | G2 Code-Review + G3 Arch (ADR-06 boundary check) |
| S10 Device/preview verify | Yes | G6 live preview-URL smoke (§8) |
| S11 Merge | Yes | G7 Integration into `apimemcp-platform`'s `main` |

## 5. Dependencies & sequencing

- **Hard dep:** F18 (engine hosted-endpoint substrate) — its public contract (types barrel, ADR-06) must be frozen before X01's `executor.ts`/`registry-mirror.ts` interfaces are stable.
- **De-facto co-deps (same wave, not X01's to build):** X02 (execution), X07 (registry mirror) — X01's routes call both but neither's internals are this feature's scope.
- **Unblocks:** X03 (wraps X01's `JobRecord` model for durable/heavy jobs), X04 (delivery attaches to `JobRecord` lifecycle), W05 (web run console), W08 (landing hero demo), M04 (mobile run screen) — none of these can call "run a template" without X01 existing first.
- **Wave:** P1. Per `Program 2 depends on Program 1`: X01/X02/W05/M04 (the "run community APIs" core) land after F18/F15/F03 are green upstream, even though X01 itself starts in P1 alongside W01/W02/X07/X02-spike.

## 6. Quality gates

Baseline pipeline applies in full: G0 Spec → G1 Build → G2 Code-Review → G5 QA → G7 Integration → G8 Promote+Deploy. Conditional gates per the catalog's flags for X01:
- **G4 Security (flagged `Se`, blocks).** Security-Reviewer checks: registry-only enforcement (unknown `templateId` never reaches an executor), zero-persist-by-default for cookies (F18 posture — `cookieString` must not be written to the `JobRecord` or logs), per-user isolation on `GET /api/run/:id` (404 not 403 across users), rate-limit actually trips, auth cannot be bypassed by omitting/forging the Clerk session.
- **G6 Live-Verify (flagged `Lv`, blocks).** Live-Verification Gatekeeper runs `scripts/verify-X01.mjs` (§7) against a real Vercel preview deployment — this is the platform-repo equivalent of engine `verify-*.mjs`.
- **G3 Arch / G3b Design.** Not separately flagged in the catalog row for X01, but ADR-06's cross-repo contract rule is still enforced at G2/G7 (any import from engine internals is rejected on sight). G3b is N/A — no UI.

**Definition of Done.** A deployed Vercel preview of `apps/cloud` accepts `POST /api/run` for a real, verified registry template and returns a `jobId` within the function timeout; `GET /api/run/:id` transitions `queued → done` with a `result` that validates against that template's `outputSchema`; unauthenticated calls return 401; an unknown `templateId` returns 400/404 without ever invoking `executeTemplate`; a user polling another user's `jobId` gets 404; the Nth+1 request in a rate-limit window gets 429.

## 7. Test plan

- `apps/cloud/lib/types.test.ts` — `RunRequestSchema` accepts a minimal valid body, rejects missing `templateId`, rejects `targetUrl` that isn't a URL, rejects an oversized `cookieString`.
- `apps/cloud/lib/jobs.test.ts` — `createJob`/`getJob`/`updateJobStatus` round-trip against a test DB (or the shared test harness from X07); ownership check (`getJob` returns `null`/throws for a mismatched `userId`).
- `apps/cloud/app/api/run/route.test.ts` — POST handler with `executeTemplate` and `getTemplate` mocked: happy path returns 202+jobId; unknown template → 400; missing auth → 401; rate-limited user → 429; heavy-cost template routes to the X03 stub instead of `executeTemplate`.
- `apps/cloud/app/api/run/[id]/route.test.ts` — GET handler: known job for the owning user → 200 with status; job owned by a different user → 404; unknown jobId → 404.
- **Live verify:** `scripts/verify-X01.mjs` (new, platform repo, Node/`fetch`, no Playwright — X01 itself never touches a browser) — against a preview URL: `POST` a real, already-verified fixture templateId (reuse one that's already green in the engine's nightly-verify, F03), poll `GET` until `status !== "queued"|"running"` (bounded retries/timeout), assert `result` matches the template's published `outputSchema`, then repeat the auth/ownership/rate-limit negative cases from above as live HTTP calls. Fixture: `apps/cloud/fixtures/verify-template-id.json` holding that one known-good templateId + expected result shape.

## 8. Acceptance criteria

```
curl -s -X POST https://<preview>.vercel.app/api/run \
  -H "Authorization: Bearer <clerk-jwt>" -H "content-type: application/json" \
  -d '{"templateId":"<verified-template-id>"}'
# → 202 {"jobId":"<uuid>"}

curl -s https://<preview>.vercel.app/api/run/<uuid> -H "Authorization: Bearer <clerk-jwt>"
# → eventually 200 {"status":"done","result":{ ... matches outputSchema ... }}
```
- No `Authorization` header → `401`.
- `{"templateId":"not-a-real-template"}` → `400`/`404`, and `executeTemplate` is never invoked (assert via the mock in tests; assert via absence of a job/side-effect in the live check).
- `GET /api/run/<uuid>` with a different user's bearer token → `404`.
- (N+1)th request inside the rate-limit window from the same user → `429`.
- Cookie strings never appear in the `JobRecord` row or any log line (grep the DB row + function logs in the live check).

## 9. Reuse notes

- **Do not** import `src/registry-client.ts`'s fetch logic directly (ADR-06) — X07 owns a server-side mirror sync that replicates that pattern; X01 only calls X07's `getTemplate`.
- **Do not** hand-roll JWT verification or a custom in-memory rate limiter (serverless invocations don't share memory) — use Clerk's own middleware (`vercel:auth`) and `vercel:vercel-firewall`/Vercel KV for rate-limiting.
- Engine patterns worth mirroring in spirit (not code, per ADR-06): `atomicWriteFile`/`withLock`'s "single atomic transition, no partial state" discipline → apply as one scoped `UPDATE ... WHERE jobId = $1` per status transition in `lib/jobs.ts`, not a read-modify-write.
- `captureForensics`, `buildStandaloneScript`, `registerTemplate`, `findTemplateByUrl` — engine-internal (F04/F05/F06), not applicable to X01's scope.

## 10. Skills

All four of X01's skills are already available per `08-skills-matrix.md` (official Vercel/Clerk vendor skills — no `context7` fallback needed here, unlike Cloudflare/serverless-Chromium in this same table). Run `npx skills check` first (idempotent, per the shared setup protocol) before assuming any install is needed:

| Skill | Signal | Guides |
|---|---|---|
| `vercel:vercel-functions` | Official Vercel skill, already available | S4/S5 — route-handler implementation, Vercel Functions runtime/timeout semantics |
| `vercel:vercel-firewall` | Official Vercel skill, already available | S4 — rate-limit implementation |
| `vercel:routing-middleware` | Official Vercel skill, already available | S5 — `middleware.ts` auth-gate wiring |
| `vercel:auth` | Official Vercel/Clerk integration skill, already available | S1/S4 — `auth().userId`, session verification |

`context7-mcp` remains available for live Next.js/Clerk/Vercel API doc lookups during build (per the "Already available" table), used ad hoc rather than as a named per-sub-task skill.
