# X04 — Results delivery

## 1. Summary

- **ID:** X04 · **Name:** Results delivery · **Program:** 2 (Consumer Platform) · **Surface:** Cloud (Program 2 has no Pillar taxonomy — Surface replaces it: Web/Cloud/Mobile)
- **Wave:** P2 · **Risk:** M · **Catalog gate flag:** Se (Security-Reviewer blocks)
- **Catalog one-liner:** "SSE/ws + Expo push; ephemeral no-persist."
- **What it does.** X04 is the transport that turns a decided job-state transition (owned by X03's durable orchestration) into something a human actually sees: a live SSE stream for the web run console (W05) while the tab is open, and an Expo push when the client isn't watching (mobile backgrounded, or the run finishes after the user navigated away). It does not decide *when* a job is done — X01/X03 own that — it only relays and notifies, and it persists nothing beyond what X01/X03 already hold ephemerally (the F18 zero-persist-by-default posture).
- **Why (market angle, 00-vision).** The whole Context pitch for Program 2 is "a native app that browses *and runs* community APIs and **pushes results straight to the phone**" — that sentence *is* X04. 00-vision's consumer wedge — "get a push when a price drops / item restocks / a filing appears" — is delivered by X05's monitor loop, but X05 has no delivery mechanism of its own; it is expected to call the same push primitive X04 builds here. X04 is the literal mechanism behind the phone-first "everyone" track's headline promise, not just a plumbing feature.

## 2. User / agent story

> As a web-console user, when I hit Run on a template I watch the result stream in live — status flips to running, then the actual result renders — without polling a button.
> As a mobile user, I start a run, background the app to do something else, and get a push the moment it finishes; tapping it deep-links straight to the result.
> As X05 (a later feature), I need to fire "price dropped" pushes on a schedule without re-implementing Expo SDK chunking/receipts — I call X04's `sendExpoPush` unmodified.

## 3. Design

### 3.1 ADRs this obeys

- **ADR-06 (registry = cross-repo contract, binds "all of Program 2").** The `result` field X04 relays is shaped by the engine's `ManifestEntry.outputSchema` (ADR-01) and must be typed by importing `@neetigyashah/apimemcp`'s **published** types — never a re-declared shape, never an engine-internals import. X04's own envelope types (`DeliveryEvent`, job status enum) are platform-only and don't cross the boundary.
- **ADR-02 (tool-module convention) — discipline, not literal tool registration.** X04 registers HTTP routes, not MCP tools, so the *file-contention* problem ADR-02 solves for engine's `index.ts` doesn't exist here (Next.js route files are already one-file-per-route). What **does** transfer is the other half of ADR-02: handlers take an explicit `deps` object (redis client, expo client) instead of reaching into module-level singletons, so `sse-hub.ts` and `push.ts` stay unit-testable with a fake `deps`.

### 3.2 Data shapes

New shared package so both `apps/web` (server) and `apps/mobile` (client parsing) import one definition instead of duplicating the union:

```ts
// packages/shared/src/delivery-events.ts
import { z } from 'zod';

export const JobStatusEnum = z.enum(['queued', 'running', 'succeeded', 'failed', 'too_heavy']);
export type JobStatus = z.infer<typeof JobStatusEnum>;

export const DeliveryEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), jobId: z.string(), status: JobStatusEnum, ts: z.number() }),
  // `result` is validated upstream (X01/X03) against ManifestEntry.outputSchema (ADR-01);
  // X04 relays it opaquely — it does not re-validate or re-shape it.
  z.object({ type: z.literal('result'), jobId: z.string(), templateId: z.string(), result: z.unknown(), ts: z.number() }),
  z.object({ type: z.literal('error'), jobId: z.string(), message: z.string(), ts: z.number() }),
  z.object({ type: z.literal('heartbeat'), ts: z.number() }),
]);
export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>;

export const PushNotificationPayloadSchema = z.object({
  jobId: z.string(),
  templateId: z.string(),
  title: z.string(),
  body: z.string(),
  deepLink: z.string(), // e.g. "apimemcp://runs/{jobId}"
});
export type PushNotificationPayload = z.infer<typeof PushNotificationPayloadSchema>;
```

Deliberate omission: the push payload carries **title/body/deepLink only, never `result`** — Expo push bodies transit through Expo's/Apple's/Google's infra, so raw extracted data never leaves the app's direct TLS session to the cloud API. This is the security-relevant shape decision G4 checks.

### 3.3 Module-by-module changes (`apimemcp-platform` repo, per `04-git-strategy.md`)

| Path | Status | Purpose |
|---|---|---|
| `packages/shared/src/delivery-events.ts` | new | Zod schemas above; single source for web + mobile. |
| `apps/web/lib/delivery/sse-hub.ts` | new | `publish(jobId, event, deps)` / `subscribe(jobId, onEvent, deps): unsubscribe`. Backed by the Redis/Upstash instance already provisioned for X06/X07 (`vercel-storage`) — pub/sub channel `job:{jobId}:events`, not a new data store. `// ponytail: cross-invocation bus is Redis pub/sub because two separate Vercel Function invocations (the workflow step that decides state, and the long-lived SSE response) don't share memory — an in-process Map only works for demo/local, upgrade path is already "use the Redis we have."` |
| `apps/web/lib/delivery/push.ts` | new | `sendExpoPush(tokens: string[], payload: PushNotificationPayload, deps): Promise<PushReceipt[]>` — thin wrapper over `expo-server-sdk`'s `Expo` client, using its own `chunkPushNotifications`/receipt APIs (never hand-rolled). |
| `apps/web/lib/delivery/index.ts` | new | Barrel export for the route handler and for X03's workflow step to call on each transition. |
| `apps/web/app/api/run/[id]/stream/route.ts` | new | `GET` — SSE Route Handler. Auth-checks the job belongs to the caller (Clerk session, per-user isolation), subscribes via `sse-hub`, writes `event: status|result|error\ndata: <json>\n\n` frames, sends a `heartbeat` comment every ~15s, closes the stream on the first terminal `DeliveryEvent` (`succeeded`/`failed`/`too_heavy`) or client disconnect. |
| `apps/web/app/api/run/route.ts` | modify (owned by X01) | **One additive-optional field** on the existing `POST /api/run` body: `pushToken?: string` (Expo push token) — X04's only touch to X01's contract, so it stays a non-breaking addition per ADR-06's additive-optional discipline. |

**Reused, not reimplemented:** the job-status store itself (queued/running/succeeded/failed/too_heavy transitions, and the "too heavy" self-host-redirect message) is X01/X03's — X04 does not duplicate it; `sse-hub.publish(...)` is called *from* that existing transition point, wherever X03's spec locates it.

### 3.4 Route / signature summary (no MCP tool; this is the ADR-02-in-spirit surface for Program 2)

- `GET /api/run/:id/stream` (new, SSE) — auth required, 404/403 on a job the caller doesn't own.
- `POST /api/run` (X01, modified) — `+ pushToken?: string` in the request body only.
- Client contract downstream features build against: web (W05) opens `new EventSource('/api/run/{id}/stream')`; mobile (M04/M05) registers an Expo push token at run-submit time and handles `Notifications.addNotificationResponseReceivedListener` to deep-link on tap. No screen belongs to X04 itself (W05/M04 own the UI) — this row only fixes the wire contract those screens render against.

## 4. Sub-tasks (S0–S11)

Cloud (X0#) has no dedicated row in `task-decomposition.md`; it reuses the **Web** column (Cloud routes live in `apps/web` per the Turborepo layout), with S3 read as "core modules" since X04 ships no screen.

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Yes | This document. |
| S1 Types | Yes | `packages/shared/src/delivery-events.ts`; import `ManifestEntry`/result types from `@neetigyashah/apimemcp` (ADR-06) — never redeclare. |
| S2 Data/API client | Yes | Redis/Upstash pub/sub client + `expo-server-sdk` client, both passed as explicit `deps` (ADR-02 discipline), no new persistent table (F18). |
| S3 Core modules | Yes | `sse-hub.ts`, `push.ts`. |
| S4 Feature module | Yes | `apps/web/lib/delivery/` assembled + barrel. |
| S5 Route/nav wiring | Yes | New `stream/route.ts`; additive field on X01's `route.ts`. |
| S6 Unit/component tests | Yes | See §7. |
| S7 e2e/device | Yes, reinterpreted | No Playwright (not engine/browser-touching) — a small Node smoke script against a live preview deploy (§7) stands in for `scripts/verify-*.mjs`. |
| S8 Docs | Yes | SSE event contract + push payload shape documented in `apps/web/lib/delivery/README.md` (or package-level doc) so W05/M04 builders don't have to read this spec. |
| S9 Review (G2) | Yes | Standard Code-Reviewer pass — check no raw `result` leaks into the push payload. |
| S10 Live/preview verify (G6) | Yes | Preview-URL smoke (§8) — a physical device isn't needed for X04 itself (M04/M05 own device verification for the app UI). |
| S11 Merge (G7) | Yes | Standard. |

## 5. Dependencies & sequencing

- **Hard dep (catalog):** **X01** — the execution API gateway must exist first (job creation + the status/result store X04 relays from).
- **Conceptual dep (cloud-architecture.md posture, not a separate catalog edge):** **F18** — the ephemeral, zero-persist-by-default substrate X04's "no server-side persistence" guarantee rests on.
- **Unblocks (catalog-declared):** **W05** (web run console — Deps include X04) and **M04** (mobile run screen + result views — Deps include X04) cannot ship live/push results without X04.
- **Not a catalog dependency, but a strong reuse expectation:** **X05** (monitors) is not declared dependent on X04 in the catalog DAG, but its "push-on-change" mechanism should call X04's `sendExpoPush` unmodified rather than re-implementing Expo SDK plumbing — flagged here as a reuse note for whoever builds X05, not as an invented dependency edge.
- **Wave:** P2, alongside W05/M04's own wave — sequence X04 to land in `integration` before those two so they don't stub the stream/push contract and rework it later.

## 6. Quality gates

Base pipeline always applies: G0 Spec → G1 Build → G2 Code-Review → G5 QA → G7 Integration → G8 Promote. For X04 specifically:
- **G3 Arch — applies.** Architect checks the `result` field is typed via published `@neetigyashah/apimemcp` types (ADR-06), not a redeclared shape, and that no engine-internal module is imported.
- **G3b Design — skipped.** X04 ships no screen/UI.
- **G4 Security — applies, blocks (the catalog's "Se" flag).** Security-Reviewer checks: (a) a caller cannot subscribe to another user's `jobId` stream (403/404 test in §7); (b) the push payload never carries `result` content, only title/body/deepLink; (c) nothing new is persisted server-side beyond the job's existing ephemeral TTL — no new DB table, no info-level log of result contents.
- **G6 Live-Verify — applies.** Cloud reinterpretation = preview-URL smoke (§7/§8), not Playwright.

**Definition of Done:** a real job's SSE stream delivers `status→result` (or `status→error`) frames in order and closes on the terminal frame; a real Expo push fires exactly once per terminal transition to the token supplied at submit time; the `POST /api/run` change is additive-only (existing callers without `pushToken` are unaffected); no new persistent store holds `result` or cookie content past the job's existing ephemeral lifetime; a second user's token cannot open a foreign job's stream.

## 7. Test plan

- `apps/web/lib/delivery/sse-hub.test.ts` — publish/subscribe fan-out to multiple listeners on one `jobId`; unsubscribe stops delivery; an event published on `jobId` A never reaches a subscriber on `jobId` B.
- `apps/web/lib/delivery/push.test.ts` — chunks >100 tokens via the SDK's own chunker (not hand-rolled); a dead/invalid-token receipt is captured, not thrown; asserts the built payload object has no `result`/`data` field beyond `jobId`/`templateId`/`deepLink`.
- `apps/web/app/api/run/[id]/stream/route.test.ts` — response has `Content-Type: text/event-stream`; a heartbeat frame appears within the idle window; stream closes after a terminal `DeliveryEvent`; a request for a `jobId` owned by a different authenticated user returns 403/404 before any subscribe happens.
- Not engine/Playwright-touching, so no `scripts/verify-X04.mjs`+fixture. Cloud-appropriate equivalent: `apimemcp-platform/scripts/smoke-x04.mjs` — a small Node script (no Playwright) that POSTs a real run to a preview deploy, opens the SSE stream with a plain `fetch`/`EventSource` polyfill, and asserts it observes `status` then a terminal frame within a timeout; run manually or in CI against the preview URL for G6.

## 8. Acceptance criteria (live, observable proof)

1. `curl -N https://<preview>/api/run/<jobId>/stream` (after a real `POST /api/run`) prints `event: status` frames then a terminal `event: result` or `event: error` frame, in order, and the connection closes.
2. Submitting a run with a real Expo push token (Expo Go on a test device or the Expo push tool's example token) produces an actual push notification within seconds of the job finishing; tapping it opens the app at the job's deep link.
3. Inspecting the platform DB/store after the job's TTL shows no row containing the run's `result` or cookie content — only whatever ephemeral entry X01/X03 already owned, now expired.
4. A second user's session cannot open `/api/run/<jobId>/stream` for a `jobId` they didn't create — verified 403/404, not a hang or a leaked frame.

## 9. Reuse notes

- **Reuse, don't redeclare:** `ManifestEntry` / output-schema-shaped result types from `@neetigyashah/apimemcp` (ADR-06) for the `result` field.
- **Reuse, don't hand-roll:** `expo-server-sdk`'s own `chunkPushNotifications` / `chunkPushNotificationReceiptRequests` for push delivery — ladder rung 5 (already-installed dependency).
- **Reuse, don't stand up twice:** the Redis/Upstash instance already provisioned for X06/X07 (`vercel-storage`) as the pub/sub bus — no second data store for delivery.
- **Reuse, don't duplicate the store:** X01/X03's existing ephemeral job-status store is the sole source of truth for job state; X04 only relays and notifies, it persists nothing of its own.
- **Built for reuse forward:** `sendExpoPush` is written generically (`tokens`, generic `PushNotificationPayload`) specifically so X05 (monitors, push-on-change) can call it unmodified instead of writing a second Expo-sending path.

## 10. Skills (setup + when-to-use)

- **`vercel:vercel-functions`** — already available, no install. Guides S3/S5: Next.js Route Handler streaming responses (the SSE endpoint) and the additive route change on `POST /api/run`.
- **`vercel:vercel-storage`** — already available, no install. Guides S2: wiring to the Redis/Upstash instance backing `sse-hub.ts`.
- **`context7-mcp` (fallback, per the plan's skill-quality bar and the standing "always use Context7 for library/SDK docs" rule)** — no ≥1K-install skill covers *server-side* Expo push sending: the available 1.6K `mindrally/skills@expo-react-native-typescript` skill teaches building the RN client app (used by M01–M07), not calling `expo-server-sdk` from a Node backend. Before writing `push.ts` (S3), run `resolve-library-id` for "expo-server-sdk" / "Expo push notifications" then `query-docs` for the send/receipt/chunking API, rather than relying on training-data memory of the SDK surface.
- **`security-and-hardening`** (`.agents/skills`, already available) — guides S2/S6/G4: the per-user stream-isolation test and the "push payload carries no result content" check.
