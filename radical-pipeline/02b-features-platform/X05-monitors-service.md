# X05 — Monitors service

## 1. Summary

| id | name | program | surface | wave | gates | risk |
|---|---|---|---|---|---|---|
| **X05** | Monitors service | 2 (Consumer Platform) | Cloud | P3 | Se, Lv | M |

*(Program 2's catalog carries no "Pillar" column — that's a Program-1-only field. Conceptually X05 is the productized form of F20's pillar-F "creative/consumer-hook" — see below.)*

**What & why.** Cron + F02 diff + push-on-change. A user (or the mobile app on their behalf) subscribes a registry template + inputs + a schedule; a Vercel Cron tick runs the template via the existing cloud execution stack, diffs the new result against the last one using F02's diff primitive, and — only on a real change — fires an Expo push. cloud-architecture.md names this explicitly: *"X05 Monitors (F20 productized + Vercel Cron)… The killer mobile feature."* 00-vision.md ties it directly to the market thesis: *"The mobile monitors feature (get a push when a price drops / item restocks / a filing appears) is the consumer wedge."* This is the feature that turns "you can run a community template" into "a community template runs itself and taps you on the shoulder" — the flywheel's proof of retention, and the one screen (M05) most likely to make someone open the app unprompted.

## 2. User/agent story

- *As a phone user*, I subscribe to a Bernhardt furniture SKU template with my target price; I do nothing else, and a week later I get a push: "Bernhardt K1325 → $1,249" — I tap it and land on the result in the app.
- *As an agent* (or the web console) acting on a user's behalf, I `POST /api/monitors` after a run looks interesting ("watch this for changes") instead of asking the human to re-run it manually.
- *As the platform*, I must never run a monitor's un-vetted template outside the sandboxed, registry-only, network-allowlisted path (X02) just because it's now unattended and recurring — unattended execution is a *higher* trust bar, not a lower one.

## 3. Design

### ADRs obeyed
- **ADR-04 (metrics measure-model)** — X05 is a named direct consumer. It emits/reads the same `{templateId, kind, success, durationMs, timestamp, error?}` record shape as the engine, but persisted in Postgres (X07's instance) instead of the engine's local CSV, because a serverless Function has no durable local disk across invocations. Same shape, different backing store — that *is* ADR-04's point (one model, many consumers/backends).
- **ADR-01 (schema contract)** — a monitor's `diffPaths` (see below) are JSON pointers into the template's declared `outputSchema`; X05 doesn't invent its own notion of "the interesting fields."
- **ADR-06 (registry = cross-repo contract)** — X05 lives in the `apimemcp-platform` Turborepo, never in `D:/MCP/src`. It consumes F02's diff primitive and F01's types only via the published `@neetigyashah/apimemcp` npm package, never via a relative import into the engine repo. **Prerequisite on F02:** F02 must export its pure diff function from the package's public entrypoint (e.g. `@neetigyashah/apimemcp` root or a `/drift` subpath) — if F02 keeps `drift.ts` internal-only, X05 has no legal way to reuse it and would be forced to re-implement, which is exactly what ADR-04/ADR-06 exist to prevent. Flag this to F02's builder.
- **ADR-02 (tool-module convention)** — does **not** apply directly: X05 adds no new *engine* MCP tool, so there is no `registerXxxTool` call to append in `D:/MCP/src/index.ts`. What X05 *does* add is HTTP routes in the platform repo's Next.js App Router (the X01 convention: one file per resource, handlers exported per HTTP verb) — the same "small, append-only, independently testable unit" spirit as ADR-02, just in the other repo.

### Note on file paths
The task template asks for exact paths "under `D:/MCP/src`" — for X05 that would violate ADR-06 (Cloud/Program-2 code doesn't live in the engine repo). Paths below are in the planned `apimemcp-platform` Turborepo (git-strategy.md), reusing W01's `apps/web` + `packages/shared` layout since no separate "apps/cloud" is defined anywhere in the plan — Vercel Functions in this design *are* Next.js App Router routes in `apps/web`, exactly as X01's `POST /api/run` already establishes.

### Data shapes (`apimemcp-platform/packages/shared/src/monitors/types.ts`)
```typescript
export interface MonitorSubscription {
  id: string;                 // uuid
  userId: string;              // Clerk user id — hard per-user isolation boundary
  templateId: string;          // registry manifest id (ADR-06)
  targetUrl?: string;
  inputs?: Record<string, unknown>;
  cookieRef?: string;          // X06 vault reference; NEVER a raw cookie string at rest
  schedule: string;            // cron expr, evaluated app-side against lastRunAt (see below)
  diffPaths?: string[];        // JSON-pointer subset of outputSchema (ADR-01); absent = whole-result diff
  notifyChannels: Array<'expo-push'>;  // v1: expo-push only, extensible
  active: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResultHash?: string;
}

// ADR-04 shape, Postgres-backed instead of the engine's CSV
export interface MonitorRunRecord {
  id: string;
  monitorId: string;
  templateId: string;
  kind: 'extraction' | 'action-sequence' | 'static-http'; // matches ManifestEntry.kind incl. F15
  success: boolean;
  durationMs: number;
  timestamp: string;
  error?: string;
  resultHash?: string;
  changed: boolean;            // true only when a diff fired a notification
}

export interface MonitorChangeNotification {
  monitorId: string;
  runId: string;
  title: string;                // e.g. "Bernhardt K1325 → $1,249"
  body: string;
  deepLink: string;              // e.g. apimemcp://monitors/<monitorId> → M05
}
```
`diffResults(prev, curr, diffPaths?)` itself is **not redefined here** — it's F02's pure function, imported from the published package (see ADR-06 note above), not re-implemented.

### Module-by-module changes
| Path | Change |
|---|---|
| `apimemcp-platform/packages/shared/src/monitors/types.ts` | New. Shapes above; shared by web, cron handler, and mobile (M05). |
| `apimemcp-platform/apps/web/app/api/monitors/route.ts` | New. `POST` create, `GET` list (current user only). |
| `apimemcp-platform/apps/web/app/api/monitors/[id]/route.ts` | New. `GET` detail+runs, `PATCH` update/pause, `DELETE` unsubscribe — 404 (not 403) on any other user's id. |
| `apimemcp-platform/apps/web/app/api/cron/monitors-tick/route.ts` | New. Vercel Cron target; validates `Authorization: Bearer $CRON_SECRET`; fans due monitors into X03 workflow steps. |
| `apimemcp-platform/apps/web/lib/monitors/tick.ts` | New. `tickDueMonitors(now)` + `runMonitorOnce(monitor)` — the core diff-and-notify loop. |
| `apimemcp-platform/apps/web/lib/monitors/db.ts` | New. Postgres queries against the two tables below (reuses X07's connection/client, no new DB). |
| `apimemcp-platform/apps/web/lib/monitors/workflow.ts` | New. X03 Vercel Workflow definition wrapping `runMonitorOnce` per monitor (retries/timeout live here, not in the tick route, so one slow monitor can't blow the cron Function's timeout budget). |
| `apimemcp-platform/vercel.json` | Add one `crons` entry. |

### HTTP route signatures
```
POST   /api/monitors            { templateId, targetUrl?, inputs?, cookieRef?, schedule, diffPaths? } → 201 { monitorId }
GET    /api/monitors             → 200 { monitors: MonitorSubscription[] }        // current user only
GET    /api/monitors/:id         → 200 { monitor, runs: MonitorRunRecord[] }        // last 20
PATCH  /api/monitors/:id         { schedule?, active?, diffPaths? } → 200 { monitor }
DELETE /api/monitors/:id         → 204
POST   /api/cron/monitors-tick   (Cron only) → 200 { checked, changed, failed }
```
`vercel.json`: `{ "crons": [{ "path": "/api/cron/monitors-tick", "schedule": "*/15 * * * *" }] }`. Vercel Cron gives one fixed top-level schedule per path (and Hobby-tier free cron is daily-granularity only) — per-monitor cadence is application logic inside `tickDueMonitors` comparing `schedule`/`lastRunAt`/`now`, not N separate cron entries. Sub-daily monitors on the pure-free tier alias to the **GitHub Actions** cron runner named in cloud-architecture's free-hosting matrix (`workflow_dispatch`/scheduled workflow hitting the same tick route) — same handler, different trigger.

### Postgres schema (X07's instance — no new database)
```sql
create table monitors (
  id uuid primary key default gen_random_uuid(),
  user_id text not null, template_id text not null,
  target_url text, inputs jsonb, cookie_ref text,
  schedule text not null, diff_paths jsonb,
  notify_channels text[] not null default '{expo-push}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_run_at timestamptz, last_result_hash text
);
create table monitor_runs (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references monitors(id) on delete cascade,
  template_id text not null, kind text not null, success boolean not null,
  duration_ms integer not null, ts timestamptz not null default now(),
  error text, result_hash text, changed boolean not null default false
);
```

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `packages/shared/src/monitors/types.ts`. |
| S2 Storage/API client | Applicable | `db.ts` against the two tables; reuses X07's Postgres client, no new infra. |
| S3 Core | Applicable | `tick.ts` — diff-and-notify loop (stands in for "screens": X05 has no UI). |
| S4 Module | Applicable | `app/api/monitors/**` + `app/api/cron/monitors-tick` as one cohesive route group. |
| S5 Wiring | Applicable | `vercel.json` cron entry + X03 workflow registration + X04 push-sender call. |
| S6 Tests | Applicable | `tick.test.ts`, `route.test.ts` (see §7). |
| S7 Verify/e2e | Applicable | `scripts/verify-X05.mjs` against a preview deploy. |
| S8 Docs | Applicable | This spec + a short "How monitors work" section in the platform README/W07 account docs. |
| S9 Review | Applicable | G2 code review. |
| S10 Live/preview verify | Applicable | Preview-URL cron dry-run + a real Expo push to a device/Expo Go (G6). |
| S11 Merge | Applicable | Integration agent, `apimemcp-platform` `main`, per git-strategy.md. |

No N/A rows — X05 is a self-contained full-stack cloud service with no UI-only or engine-only sub-tasks to skip.

## 5. Dependencies & sequencing

**Hard deps (catalog row):** `X03` (durable Workflow — fan-out and per-monitor retry/timeout isolation), `F02/F20` (the diff primitive and the "productized" precedent). Both must have their public surface (F02's exported diff fn; X03's workflow API) usable before X05's `tick.ts`/`workflow.ts` can be written for real rather than stubbed.

**Runtime deps, not gating build order but load-bearing at execution time:** X01 (route/auth convention it follows), X02 (the actual sandboxed template execution — X05 never runs Playwright itself), X04 (Expo push transport — X05 calls it, doesn't reimplement push), X06 (resolves `cookieRef` for auth-gated monitors at tick time — soft, opt-in; a monitor without a stored vault entry simply can't watch an auth-gated template), X07 (same Postgres instance, same manifest mirror to resolve `templateId → outputSchema`).

**What it unblocks:** `M05` (Monitors + push, mobile) depends directly on X05 per the catalog and is the same wave (P3) — M05's builder can start against this spec's route/type contract as soon as it's frozen, without waiting for X05's implementation to finish. `W07` (web account dashboard) is expected to surface monitor CRUD through these same routes per its own catalog description ("monitors/history/keys"), though W07's hard deps list only `W01`. The 06-creative-ideas "vertical monitor packs" idea is a later, unscheduled extension of this same subscription model — not in scope here.

**Wave:** P3.

## 6. Quality gates

Default pipeline applies: G0 Spec → G1 Build → G2 Code-Review → G5 QA → G7 Integration → G8 Promote+Deploy. Per the catalog row's flags:
- **G3 Arch, G3b Design** — N/A (no UI; the only boundary-relevant thing, the ADR-06 no-internal-import rule, is checked as part of G2/G4, not a separate architect gate for this feature).
- **G4 Security (Se, blocks)** — per-user isolation on every route (a monitor/run is only ever visible to its `userId`, verified with a real cross-user attempt, not just a query filter review); `cookieRef` never returns raw secret material in any API response or log; `CRON_SECRET` bearer check on the tick route (unauthenticated callers can't trigger runs); execution still goes through X02's sandbox/allowlist even though it's now unattended/recurring — recurring is not a lower trust bar.
- **G6 Live-Verify (Lv, blocks)** — preview-deploy cron dry run + one real Expo push delivered to a device/Expo Go.

**Definition of Done:** a user can create, list, view, pause, and delete a monitor, scoped strictly to their own account; a scheduled tick that finds no change persists a run record and sends zero notifications; a tick that finds a change persists a run record with `changed:true` and sends **exactly one** push, even if the tick route is retried (idempotent on `(monitorId, scheduled-window)`); a paused monitor never runs; nothing about a monitor (cookies, targetUrl, diff content) leaks across users.

## 7. Test plan

- `apimemcp-platform/apps/web/lib/monitors/tick.test.ts` — `runMonitorOnce`: (a) first-ever run establishes a baseline hash and sends no notification (nothing to diff against); (b) unchanged result → `changed:false`, no push, `lastRunAt` still updated; (c) changed result → `changed:true`, exactly one push call with the correct `MonitorChangeNotification` payload, `lastResultHash` updated; (d) extraction failure → run recorded `success:false` with `error`, no push, monitor stays active (a single failure doesn't disable it); (e) `tickDueMonitors` only selects monitors that are `active` and actually due per `schedule`/`lastRunAt`.
- `apimemcp-platform/apps/web/app/api/monitors/route.test.ts` (+ `[id]/route.test.ts`) — CRUD happy path, plus the isolation case: user A's token requesting user B's `monitorId` gets 404, never a 403 that would confirm the id exists.
- `apimemcp-platform/scripts/verify-X05.mjs` (G6, mirrors the engine's `scripts/verify-*.mjs` convention) — against a preview deploy: create a monitor on a fixture/static-http template, run the tick handler twice with no change (assert zero pushes), mutate the fixture's target, run the tick handler again (assert one push, via a test Expo push receipt or a mocked push endpoint), then call the tick route twice for the same due window (assert still exactly one push — idempotency).

## 8. Acceptance criteria (live, observable proof)

1. `POST /api/monitors` against a real registry template with a short schedule; after two cron ticks with no underlying change, `GET /api/monitors/:id` shows two `success:true` runs, both `changed:false`, and zero pushes were sent.
2. The underlying target changes (e.g., a fixture price edit); the next tick produces a run with `changed:true` and a real Expo push arrives on a test device/Expo Go, deep-linking into the M05 monitors screen showing the new value.
3. `PATCH /api/monitors/:id { active:false }` — across the next tick window, no run row is created and no push fires.
4. Two different user accounts each monitor the same `templateId`; each can only list/view/delete their own `monitorId` — cross-account access attempts return 404.

## 9. Reuse notes

- **F02's diff primitive** — imported via the published package per ADR-06; not re-implemented. (Contingent on F02 exporting it publicly — see §3.)
- **ADR-04 record shape** — reused verbatim, Postgres-backed instead of CSV-backed; X05 is a listed consumer, not a second instrumentation path.
- **X02 / X03 / X04 / X07** — X05 delegates actual sandboxed execution (X02), durable retry/fan-out (X03), and push delivery (X04) to those features rather than building its own sandbox, job queue, or push client; it shares X07's Postgres instance rather than provisioning a new one.
- **The engine's existing `schedule_stock_check` and `send_notification` MCP tools** (already shipped, per ADR-02's tool inventory — `scheduler.ts`/`notifier.ts`) are the self-host precedent for "schedule a check, notify on result." X05 mirrors that same conceptual loop (schedule → check → notify-on-change) cloud-natively for a stateless serverless environment; it does not call these MCP tools (no cross-repo MCP dependency from the platform into the engine), it reimplements the loop with Vercel Cron/Workflow + Expo push, per F20 being "productized" here.
- **What does NOT apply:** the engine's local-filesystem helpers (`atomicWriteFile`, `withLock`, `findTemplateByUrl`, `registerTemplate`, `buildStandaloneScript`, `captureForensics`) are self-host/local-disk concerns with no equivalent need in a stateless-serverless + Postgres design — don't force a dependency on them just to check a reuse box.

## 10. Skills (setup + when-to-use)

Already available in this environment per 08-skills-matrix.md — no install step:

| Skill | Guides | Note |
|---|---|---|
| `vercel:workflow` | S3/S5 (`workflow.ts`, per-monitor retry/timeout) | Catalog's own "Key skills" pick for X05; durable multi-step orchestration is exactly the fan-out-many-monitors problem. |
| `vercel:vercel-functions` | S4/S5 (route handlers, `vercel.json` cron config) | Vercel Cron syntax and Function/route conventions. |
| `vercel:vercel-storage` | S2 (`db.ts`, schema) | Reuses the same Postgres story as X07 — no new skill needed for storage. |
| `vercel:routing-middleware`, `vercel:vercel-firewall` | S4/G4 | Per-user auth check + rate-limiting on `/api/monitors/**` and the cron route's bearer check. |
| `security-and-hardening` (`.agents/skills/`) | G4 | Isolation + secret-handling review discipline (already installed, provider-neutral). |

**Fallback per the global context7 rule:** before writing the exact `vercel.json` cron schema or the Workflow SDK step API, pull current docs via `context7-mcp` (`resolve-library-id` → the Vercel Workflow/Cron docs) rather than relying on training-data syntax — these are exactly the "library/API/CLI, even well-known" cases that rule calls out, and Vercel's Function/Cron/Workflow APIs have moved fast enough that memorized syntax is a real risk here.
