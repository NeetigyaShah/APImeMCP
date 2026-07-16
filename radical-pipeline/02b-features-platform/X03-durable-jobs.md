# X03 — Durable Jobs + Heavy Fallback

## 1. Summary

- **ID / name:** X03 — Durable jobs + heavy fallback
- **Surface / pillar:** Cloud (Program 2 — Consumer Platform), sits between X02 (safe runtime) and X05 (monitors)
- **Wave:** P2 · **Risk:** M · **Gates:** Se, Lv (+ conditional G3 Arch — see §6)
- **Deps:** X02 (hard — needs the sandboxed registry-only runtime as its per-step executor). Consumes the contract X01 already owns (`POST/GET /api/run`); assumed merged (X01 is P1, X03 is P2). Reads X07's registry mirror for manifest lookups.
- **Unblocks:** X05 (Monitors service — a monitor *is* a recurring durable job that calls into X03), and feeds X04 (Results delivery) the "job finished/changed" event it pushes over SSE/Expo.

**What.** `POST /api/run` today assumes a template either runs synchronously inline (X02) or doesn't run at all. X03 adds the missing middle: a Vercel-Workflow-backed durable orchestration path for templates whose execution spans more than one Function invocation (pagination, multi-step), with automatic retries and checkpointed pause/resume. It also adds the other end of that spectrum: a **classify-before-you-run** step that recognizes a template as too heavy for the free-tier cloud budget and returns a clear, immediate `too_heavy` fallback (message + self-host deep link) instead of ever attempting a run that would hang or time out.

**Why / market angle (00-vision).** Phones and browsers can't run Playwright, so the cloud execution layer is "mandatory... the bridge" (07-platform-design/cloud-architecture.md). The owner's locked posture is Vercel-native, free-tier-first (⑦): that only stays honest if the system *never* silently hangs past serverless limits — it either completes durably or fails loud with an actionable next step. X03 is that seam. It also directly unblocks the plan's stated consumer wedge — mobile monitors ("price drops / item restocks / a filing appears") — because a monitor is nothing more than X03's durable-job machinery invoked on a cron (X05). Without X03, "run community APIs from your phone" degrades to "run only the ones that finish in one HTTP request."

## 2. User / agent story

- As a mobile user, I tap Run on a community template with 40 pages of results. I expect an immediate `jobId` + `running` status, a progress signal while it works, and a push when it's done — not a spinner that times out at 60s.
- As a monitor subscriber (X05), my subscription re-runs on a schedule indefinitely; each scheduled run is a fresh durable job that must retry transient failures on its own rather than silently missing a cycle.
- As an agent calling X01's API directly, I POST a template+target and get back one of three honest outcomes: `succeeded` (small/fast, ran inline via X02), `running`→`succeeded`/`failed` (durable, ran as a Workflow), or `too_heavy` immediately (never attempted, with a self-host deep link) — never an unbounded hang.

## 3. Design

**ADRs obeyed.** **ADR-06** (governs, hard): X03 lives in `apimemcp-platform`, imports only the published `@neetigyashah/apimemcp` types + the registry manifest shape — never `engine.ts`/`storage.ts`/`app-connections.ts` internals. Any new field this feature wants on `ManifestEntry` (e.g. a future heaviness hint) must land as an **additive-optional** engine-side field per the ADR-06 precedent (`waitStrategy`, `readySelector`, `source`), proposed as an engine PR, not assumed here. **ADR-02** (spirit only, not a literal dependency — X03 adds no MCP tool to the engine's `index.ts`): each concern below is one file, one responsibility, mirroring the "no shared contention file" discipline; there is no `registerXxxTool` call because there is no new engine tool, only modified Next.js route handlers.

**Repo/paths.** All paths below are in the **`apimemcp-platform` Turborepo** (sibling repo to `D:\MCP`, scaffolded by W01 as `apps/web`, `apps/mobile`, `packages/shared`) — explicitly **not** `D:/MCP/src`, since ADR-06 forbids this feature from touching engine internals.

```ts
// packages/shared/src/jobs.ts (NEW) — consumed by apps/web + apps/mobile, ADR-06-clean (no engine imports)
export type JobPhase = "queued" | "running" | "succeeded" | "failed" | "too_heavy";

export interface JobRecord {
  jobId: string;
  templateId: string;        // ManifestEntry id (published registry types)
  targetUrl?: string;
  phase: JobPhase;
  attempt: number;            // retry counter, durable jobs only
  step?: string;               // current checkpointed Workflow step name
  result?: unknown;            // set when phase === "succeeded"; shape = ManifestEntry.outputSchema when declared (ADR-01)
  error?: string;               // set when phase === "failed"
  fallback?: { message: string; selfHostDocsUrl: string }; // set when phase === "too_heavy"
  createdAt: string;            // ISO
  updatedAt: string;            // ISO
}
```

```ts
// apps/web/lib/jobs/classify.ts (NEW)
export interface ClassifyBudget { maxDurationMs: number; maxSteps: number } // sourced from env/plan-tier config —
  // confirm current Vercel Function/Workflow duration ceilings via context7 (vercel:workflow, vercel:vercel-functions) at build time, don't hardcode a number that will go stale.
export type Classification = "light" | "durable" | "too_heavy";
export function classify(entry: ManifestEntryLite, budget: ClassifyBudget): Classification;
// Primary signal: template's declared pagination style if the manifest exposes one (optional, ADR-06-additive).
// Fallback signal (default path, no engine schema change required): attempt as "durable" and let the Workflow's
// own maxSteps/maxDurationMs ceiling (below) trip to too_heavy mid-run if no hint exists — keeps X03 shippable
// without a cross-repo schema PR as a prerequisite.
```

```ts
// apps/web/lib/jobs/store.ts (NEW) — JobRecord CRUD; reuses X07's Postgres connection/pool, no second datastore
export function createJob(rec: Omit<JobRecord, "createdAt" | "updatedAt">): Promise<JobRecord>;
export function getJob(jobId: string): Promise<JobRecord | null>;
export function updateJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord>;
```

```ts
// apps/web/lib/workflows/run-template.workflow.ts (NEW)
// Sketch only — confirm exact Workflow SDK step/retry/resume API via context7 (vercel:workflow) before implementing.
export const runTemplateWorkflow = defineWorkflow("run-template", async (ctx, input: { jobId: string; templateId: string; targetUrl?: string }) => {
  const budget = getBudgetForPlanTier();
  const entry = await loadManifestEntry(input.templateId);        // X07 mirror lookup
  if (classify(entry, budget) === "too_heavy") return markTooHeavy(input.jobId, budget);
  let items: unknown[] = [];
  for (let page = 0; page < budget.maxSteps; page++) {
    const chunk = await ctx.step(`extract-page-${page}`, () => callX02Runtime(input, page), { retries: 3 }); // X02 is the executor
    items = items.concat(chunk.items);
    await updateJob(input.jobId, { step: `extract-page-${page}`, attempt: chunk.attempt });
    if (chunk.done) return markSucceeded(input.jobId, items);
  }
  return markTooHeavy(input.jobId, budget);                        // mid-run safety net if step ceiling reached
});
```

```ts
// apps/web/app/api/run/route.ts (X01-owned, MODIFIED here)
export async function POST(req: Request): Promise<Response> {
  // body validated by X01's existing RunRequestSchema (zod: { templateId, targetUrl?, cookieString? })
  // classify() up front:
  //   "light"     -> call X02 inline, return { ...JobRecord, phase: "succeeded" } synchronously (unchanged X01 path)
  //   "durable"   -> store.createJob(...), runTemplateWorkflow.start({...}), return { jobId, phase: "running" }
  //   "too_heavy" -> return { jobId, phase: "too_heavy", fallback } immediately, never enters the Workflow
}
// apps/web/app/api/run/[id]/route.ts (X01-owned, MODIFIED here)
export async function GET(req: Request, ctx: { params: { id: string } }): Promise<Response> {
  // return store.getJob(params.id) as JobRecord — durable jobs reflect the Workflow's own checkpointed step/phase
  // because the workflow writes through `store.updateJob` after every step; no direct Workflow-internals import.
}
```

No new public route is introduced — X03 backs X01's existing `jobId` contract rather than creating a second "job" concept, per the plan's own "Web + mobile are thin clients of the cloud API" framing.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `packages/shared/src/jobs.ts` (`JobPhase`, `JobRecord`) — shared web+mobile, ADR-06-clean. |
| S2 Storage/data client | Applicable | `apps/web/lib/jobs/store.ts`, reusing X07's Postgres pool — no new datastore. |
| S3 Core logic | Applicable | `classify.ts` + `run-template.workflow.ts` — the actual durable-orchestration artifact. |
| S4 Feature module | Applicable | `apps/web/lib/jobs/` + `apps/web/lib/workflows/` as one cohesive module. |
| S5 Route/wiring | Applicable | Modify X01's `app/api/run/route.ts` + `[id]/route.ts`; no new route. |
| S6 Unit tests | Applicable | `classify.test.ts`, `store.test.ts`, workflow-step logic with a mocked `ctx`. |
| S7 e2e/integration | Applicable | `apps/web/scripts/smoke-durable-jobs.mjs` against a Vercel preview deploy (see §7). |
| S8 Docs | Applicable | Cross-link this spec from `07-platform-design/cloud-architecture.md` and `08-skills-matrix.md`. |
| S9 Review (G2) | Applicable | Code-Reviewer pass — minimal diff on X01's routes, no reinvented sandboxing. |
| S10 Live/preview verify (G6) | Applicable | Preview-URL smoke (the "web" G6 option — X03 deploys to Vercel like the rest of the platform repo). |
| S11 Merge (G7) | Applicable | Integration/Merge agent, `apimemcp-platform` repo. |

## 5. Dependencies & sequencing

- **Hard:** X02 — the sandboxed, registry-only, network-allowlisted runtime that every Workflow step actually invokes; X03 orchestrates, it never re-implements sandboxing.
- **Contract (assumed merged, earlier wave):** X01 owns `POST/GET /api/run`; X03 extends its handler bodies, doesn't fork the contract. X07 (registry mirror) backs `classify()`'s manifest lookups and `store.ts`'s connection — both P1, precede X03's P2 per 04-git-strategy.md's "critical-path/foundation feature to `integration` first" rule.
- **Unblocks:** X05 (Monitors) — a monitor subscription is `runTemplateWorkflow` invoked by Vercel Cron instead of a user tap; X05 cannot start until X03's Workflow + `JobRecord` shape exist. Feeds X04 (Results delivery) the phase-change event it relays over SSE/Expo push.
- **Wave:** P2, alongside X04/X06; after X01/X02/X07 (P1).

## 6. Quality gates

Pipeline: `Assigned → G0 → G1 → G2 → [G3 Arch: triggered] → G4 Security → G5 QA → G6 Live-Verify → G7 Integration → G8 Promote+Deploy`.

- **G3 Arch (conditional, triggered here):** `packages/shared/src/jobs.ts` is a *new cross-app shared type* — Architect confirms it's additive, ADR-06-clean (no engine-internal imports), and doesn't duplicate X01's existing request/response shape.
- **G4 Security (⚫ required, Se):** registry-only templates only (no arbitrary URL execution beyond what X02 already allowlists); `JobRecord`s are per-user isolated (no cross-user job-ID guessing — random/opaque `jobId`, ownership check on GET); cookies passed into a Workflow step transit encrypted and are never persisted beyond the run (ties to X06); a stuck/failed job never leaks partial results to another user.
- **G5 QA:** unit suite green (classify boundaries, store CRUD, mocked workflow-step logic).
- **G6 Live-Verify (⚫ required, Lv):** preview-URL smoke script (§7) — no direct Playwright/device requirement since X03 doesn't touch a browser directly (X02 does).
- **G3b Design:** N/A — no UI screen, this is a backend orchestration layer.

**Definition of Done:** a durable multi-page template run completes via checkpointed retries without exceeding a single Function's duration; a heavy-classified template returns `too_heavy` + a working self-host link in seconds, never after a timeout; a forced step failure retries then resolves to `succeeded` or `failed` — never stuck `running`; G3/G4/G6 all green.

## 7. Test plan

- `apps/web/lib/jobs/classify.test.ts` — light/durable/too_heavy boundary cases at the `maxDurationMs`/`maxSteps` edges; missing-manifest-hint falls back to "durable" (not "light" or a crash).
- `apps/web/lib/jobs/store.test.ts` — create/get/update roundtrip against a test DB fixture; concurrent `updateJob` calls don't clobber `attempt`/`step`.
- `apps/web/lib/workflows/run-template.workflow.test.ts` — mocked `ctx.step` runner: asserts retry count is honored, asserts `too_heavy` short-circuit fires both pre-run (classify) and mid-run (step-ceiling safety net), asserts a simulated resume (re-invoke with partial `items`/`step` state) doesn't re-fetch already-completed pages.
- `apps/web/scripts/smoke-durable-jobs.mjs` (NEW, the platform-side analog of an engine `verify-*.mjs`, since this feature is cloud/preview-touching rather than engine/browser-touching): against a deployed preview URL, POST a known multi-page fixture template, poll `GET /api/run/:id` until `step` has advanced at least twice and `phase` reaches `succeeded`; POST a fixture template tagged over-budget and assert `too_heavy` returns within a few seconds, never after a timeout.

## 8. Acceptance criteria (live, observable proof)

- `POST /api/run` with a durable-class fixture template on a live preview deploy returns `{jobId, phase:"running"}` well inside X01's normal Function timeout.
- Polling `GET /api/run/:id` on that job shows `step` advance across ≥2 checkpoints, ending at `phase:"succeeded"` with a non-empty `result`.
- Re-polling after a mid-run redeploy/restart resumes from the last checkpointed `step` (verified by page count / no duplicate items in `result`), not from page 0.
- `POST /api/run` with a fixture template flagged over the configured budget returns `phase:"too_heavy"` with `fallback.message` and a resolvable `fallback.selfHostDocsUrl`, observably within seconds — never left pending.
- A fixture that fails its first 2 attempts then succeeds ends `succeeded` with `attempt >= 3`; a fixture that always fails ends `failed` with `error` set — in both cases the job never sits at `running` indefinitely.

## 9. Reuse notes

- **Reuse X02** as the sole per-step executor (sandboxing/allowlisting lives there — X03 must not reimplement it).
- **Reuse X07's** Postgres connection/pool for `store.ts` instead of a second datastore.
- **Reuse X01's** `jobId`/`RunRequestSchema` contract; extend the response shape (`JobRecord`), don't add a parallel route.
- **Do not reuse engine internals.** `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript` are all Program-1 (`D:\MCP\src`) internals — ADR-06 forbids importing them from the platform repo. Where X03 needs an equivalent (e.g. atomic status writes), reimplement the small platform-local version rather than reach across repos; this is the intended cost of ADR-06's isolation, not an oversight.

## 10. Skills (setup + when-to-use)

- **`vercel:workflow`** — already available, no install. Primary skill; guides S3/S4 (the Workflow step/retry/resume definition) and S6 (writing tests that match real checkpoint/resume semantics). Confirm the exact SDK surface here before implementing `run-template.workflow.ts` — this spec's Workflow code is a sketch, not a verified signature.
- **`vercel:vercel-functions`** — already available. Guides S5 (Next.js route-handler wiring in `apps/web/app/api`).
- **`vercel:vercel-storage`** — already available. Guides S2 (`store.ts` against X07's Postgres, or Vercel KV if lighter-weight fits the job-record access pattern better).
- **`security-and-hardening`** (`.agents/skills/`, already available) — guides G4/S6 (per-user isolation tests, cookie-in-transit handling).
- **`context7-mcp`** — already available. Use for any live Vercel Workflow/Function API confirmation at build time (see above) instead of trusting this spec's sketch verbatim.
- **Explicitly not installed:** `sickn33/antigravity-awesome-skills@bullmq-specialist` (1.5K installs) — per PLAN.md's own skills matrix this is deferred "only if/when a worker is added," which the free-tier-first decision (⑦) defers past X03; Vercel Workflow, not BullMQ, is this feature's execution model.
