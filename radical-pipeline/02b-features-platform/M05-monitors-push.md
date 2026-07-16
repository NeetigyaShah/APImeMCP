# M05 — Monitors + push

## 1. Summary

| Field | Value |
|---|---|
| ID | **M05** |
| Name | Monitors + push |
| Surface / Pillar | Mobile (Program 2, Consumer Platform) |
| Wave | P3 |
| Risk | M |
| Gates | Lv(device) — blocking |
| Deps | M04 (Run screen + result views), X05 (Monitors service) |

**What.** The mobile screens + client-side plumbing to (a) subscribe to a template+inputs on a schedule, (b) receive an Expo push notification when X05's cron+diff detects a change, and (c) tap that push to deep-link into a detail screen showing what changed. M05 owns no cron/diff logic — that's X05 (F20 productized). M05 is a thin, typed client of X05's HTTP contract plus the on-device push/permission/deep-link handling.

**Why.** `00-vision.md` names this directly: *"The mobile monitors feature (get a push when a price drops / item restocks / a filing appears) is the consumer wedge."* `06-creative-ideas.md` repeats it as the single biggest consumer hook ("Monitors-as-a-product"), and `cloud-architecture.md` calls X05 **"The killer mobile feature."** M05 is the surface where that value is actually felt — a push arriving with no app open is the whole pitch for "phones can't run Playwright but can run APImeMCP anyway."

## 2. User / agent story

> As a phone user browsing the registry, I open a template ("Bernhardt K1325 — list price"), tap **Monitor this**, pick a schedule, and forget about it. Days later my phone buzzes: *"Bernhardt K1325 → $649 (was $699)."* I tap it, land straight on that monitor's detail screen showing old vs new value, no manual re-run, no app-open required to notice the change.

## 3. Design

### ADRs obeyed

- **ADR-06 (registry = cross-repo contract) — the one M05 must obey.** `MonitorSubscription`/`MonitorEvent` below are **not** engine-internal types reached-into — they're the platform's own API contract for X05 (analogous to X01's request/response shapes), so defining them in `packages/shared` does not violate ADR-06. The one place M05 *does* touch an engine-derived type is rendering a template's result value (`MonitorEvent.diff`), which reuses `ManifestEntry.outputSchema` (ADR-01) via the **published** `@neetigyashah/apimemcp` types — never redefined, never imported from engine source.
- **ADR-02 (tool-module convention) — does not apply.** M05 adds no MCP tool and no `src/index.ts` wiring; it only calls X05's HTTP routes. Noted for completeness per the fan-out's own rule of citing ADRs directly rather than assuming.

### Data shapes (`packages/shared/src/monitors.ts`, new)

```ts
export type MonitorStatus = "active" | "paused" | "error";

export interface MonitorSubscription {
  id: string;                    // server-assigned uuid
  templateId: string;            // ManifestEntry key (registry manifest, ADR-06)
  inputs?: Record<string, string>;
  schedule: string;              // cron expression, matches X05/Vercel Cron
  label: string;                 // user-facing name, e.g. "Bernhardt K1325 price"
  lastValue?: unknown;           // ADR-01 outputSchema-typed last result
  lastCheckedAt?: string;        // ISO
  lastChangedAt?: string;        // ISO
  status: MonitorStatus;
  createdAt: string;
}

export interface MonitorEvent {
  id: string;
  subscriptionId: string;
  diff: unknown;                 // F02 diff shape, surfaced as-is through X05 — no re-encoding
  occurredAt: string;
}

export interface CreateMonitorInput {
  templateId: string;
  inputs?: Record<string, string>;
  schedule: string;
  label: string;
}
```

`packages/shared/src/push.ts` (reuse if M01/X04 already created it for "run finished" pushes — see Reuse notes; only add if it doesn't exist):

```ts
export interface RegisterPushTokenRequest {
  pushToken: string;             // "ExponentPushToken[xxxx]"
  platform: "ios" | "android";
  deviceId: string;
}
```

### HTTP contract consumed (owned/implemented by X05 + X04 — Cloud/Infra Builder; M05 codes against this, does not implement it)

```
POST   /api/monitors                body: CreateMonitorInput        → 201 { subscription: MonitorSubscription }
GET    /api/monitors                                                 → 200 { subscriptions: MonitorSubscription[] }
PATCH  /api/monitors/:id            body: { schedule?; status? }    → 200 { subscription: MonitorSubscription }
DELETE /api/monitors/:id                                              → 204
GET    /api/monitors/:id/events?since=<ISO>                          → 200 { events: MonitorEvent[] }
POST   /api/push-tokens             body: RegisterPushTokenRequest  → 204   (X04-owned; see reuse note)
```

### Module-by-module changes (`apimemcp-platform` repo, `apps/mobile/`)

```
packages/shared/src/monitors.ts                              (new) — types above
packages/shared/src/push.ts                                  (new only if absent — check M01/X04 first)

apps/mobile/app/(tabs)/monitors.tsx                           (new) MonitorsListScreen(): JSX.Element
apps/mobile/app/monitor/[id].tsx                              (new) MonitorDetailScreen({ id }): JSX.Element
apps/mobile/app/monitor/new.tsx                               (new) NewMonitorScreen({ templateId, inputs? }): JSX.Element
                                                                     — reached from Template Detail's "Monitor this" (M03/M04)

apps/mobile/src/features/monitors/api.ts                      (new) typed fetch wrappers for the routes above
apps/mobile/src/features/monitors/useMonitors.ts              (new) React Query hooks:
    useMonitors(): UseQueryResult<MonitorSubscription[]>
    useMonitor(id): UseQueryResult<MonitorSubscription>
    useMonitorEvents(id): UseQueryResult<MonitorEvent[]>
    useCreateMonitor(): UseMutationResult<MonitorSubscription, Error, CreateMonitorInput>
    useUpdateMonitor(id): UseMutationResult<MonitorSubscription, Error, Partial<Pick<MonitorSubscription,"schedule"|"status">>>
    useDeleteMonitor(id): UseMutationResult<void, Error, void>
apps/mobile/src/features/monitors/MonitorCard.tsx              (new) — list row: label, lastValue, status badge
apps/mobile/src/features/monitors/__fixtures__/monitor.json    (new) — fixture for component/unit tests

apps/mobile/src/notifications/registerForPushNotificationsAsync.ts  (new/extend) → Promise<string|null>
apps/mobile/src/notifications/notificationHandler.ts                (new) setupNotificationHandling(router): () => void
    — foreground handler + Notifications.addNotificationResponseReceivedListener (tap while running)
    — Notifications.getLastNotificationResponseAsync() on mount (cold-start tap — the case most RN push
      implementations forget: app was killed, tap must still deep-link)
    — both resolve to router.push(`/monitor/${data.subscriptionId}`)
```

No engine repo (`D:\MCP`) files change for M05 — it is Mobile-only per its Surface column; per ADR-06 it reaches templates only through X05's API + the registry manifest already mirrored by X07, never engine internals.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `MonitorSubscription`/`MonitorEvent`/`CreateMonitorInput` in `packages/shared` |
| S2 Data/API client | Applicable | `features/monitors/api.ts` — typed fetch against X05, reuses M04's client base |
| S3 Screens/components | Applicable | Monitors list / detail / new + `MonitorCard` (2× weight — bulk of the work) |
| S4 Feature module | Applicable | `useMonitors.ts` hooks + `notifications/` module |
| S5 Route/nav wiring | Applicable | Expo Router tab entry + `monitor/[id]` + `monitor/new`; notification-tap → `router.push` |
| S6 Component tests | Applicable | Jest + RN Testing Library, see Test plan |
| S7 e2e/device | Applicable | simulated push → tap → deep-link, incl. cold-start path |
| S8 Docs | Applicable | short README section in `apps/mobile` on monitors + push-token flow |
| S9 Review | Applicable | G2 Code-Review |
| S10 Device/preview verify | Applicable | G6 Live/Device-Verify — the flagged blocking gate for M05 |
| S11 Merge | Applicable | G7 Integration into `apimemcp-platform` `main` |

No N/A items — M05 is a self-contained vertical slice (types → client → UI → push → tests → device-verify).

## 5. Dependencies & sequencing

- **Hard deps:** **M04** (Run screen + result views) — reuse its API-client base and its JSON/table result-view components to render `MonitorEvent.diff`, don't build a second renderer. **X05** (Monitors service) — M05 is purely a client of X05's cron+diff+push contract; if X05's routes aren't live yet, M05 builds against a mocked API using the fixture and blocks only S7/S10 (device-verify) on X05 landing.
- **Transitive:** M01 (Expo scaffold, EAS, push permission plumbing), M02 (themed Card/Badge components used by `MonitorCard`) via M04; X05's own deps (X03 durable jobs, F02/F20 diff) are X05's concern, not re-verified here.
- **Unblocks:** M06 (Run history + account) — account screen references monitor count/list alongside run history. M07 (App-store prep) needs M01–M06 complete, so M05 must land before store submission.
- **Wave:** P3, alongside X05 and after M04.

## 6. Quality gates

`G0 Spec → G1 Build → G2 Code-Review → [G3b Design] → G5 QA → G6 Live/Device-Verify → G7 Integration → G8 Promote`

- **G3 Arch — skip.** No new engine module, no cross-repo boundary change beyond the already-established X05 contract.
- **G3b Design — applies.** Design Lead checks Monitors screens against the M02 design system + a11y floor (push-permission denial banner must be readable/focusable, not just a toast).
- **G4 Security — skip (not flagged in the catalog row).** M05 carries no cookies/secrets; auth + per-user isolation on subscription data is enforced by X01/X05, not re-implemented here.
- **G6 Live/Device-Verify — blocks (the flagged gate).** Real device or simulator run per Test plan §S7/S10.

**Definition of Done:** subscribe flow creates a live `MonitorSubscription` via X05; Monitors tab lists subscriptions with last value + last-changed time; a real (or manually-fired) X05 diff event produces an Expo push that, tapped from foreground, background, *and killed* app states, deep-links to the correct `monitor/[id]`; denying push permission degrades gracefully (no crash, explains value, links to OS settings); unsubscribe stops further pushes; component tests green; G6 device-verify recorded.

## 7. Test plan

`apps/mobile/src/features/monitors/*.test.ts(x)` (Jest + `@testing-library/react-native` — already in the Expo/M01 scaffold, no new test runner added):

- `api.test.ts` — request/response mapping; 401/404/5xx surfaced as typed error states, not thrown raw.
- `useMonitors.test.ts` — React Query cache/refetch/mutation behavior against a mocked `api.ts`.
- `MonitorCard.test.tsx` — renders label/lastValue; `active`/`paused`/`error` states visually distinct.
- `notificationHandler.test.ts` — given a mocked notification response `{ data: { subscriptionId } }`, asserts `router.push('/monitor/<id>')` fires, including via the cold-start (`getLastNotificationResponseAsync`) path.
- `subscribeForm.test.tsx` — schedule/cron validation; submit disabled until template+schedule valid.

**Device-verify (replaces `scripts/verify-M05.mjs`** — Program 2 mobile substitutes a device/simulator run for the engine's Playwright script, per `quality-gates.md`'s G6 definition):
1. On a physical device (Expo Go or EAS internal build — iOS + Android per M01), subscribe to a real registry template.
2. Trigger a change — either wait for X05's real schedule, or ask Cloud/Infra Builder for a manual test-fire route on X05 (nice-to-have, not M05's to build).
3. Confirm the OS push arrives outside the app.
4. Tap it from three states — foregrounded, backgrounded, **and force-killed** — confirm all three deep-link to `monitor/[id]` with the new value shown.
5. Deny push permission on a fresh install; confirm the Monitors screen still renders with an explanatory banner, no crash.

Fixture: `apps/mobile/src/features/monitors/__fixtures__/monitor.json` — one subscription + one event, so unit/component tests never hit the network.

## 8. Acceptance criteria (live, observable)

- `GET /api/monitors` for the test user shows the new subscription immediately after the subscribe flow completes.
- A real or manually-triggered X05 diff event results in a system-level push notification appearing on-device within the schedule window.
- Tapping the notification in all three app-lifecycle states opens the correct monitor detail with old-vs-new value visible.
- Push-permission denial leaves the Monitors screen usable, not broken.
- Deleting a subscription removes its card and no further pushes arrive for it.

## 9. Reuse notes

- Reuse M04's typed API-client base (auth header injection via Clerk session) — don't stand up a second HTTP client.
- Reuse M02's themed `Card`/`Badge`/`EmptyState` components for `MonitorCard` — no parallel UI primitives.
- **Check whether M01/M04 already registered an Expo push token** (for "run finished" notifications, since X04 already owns general push delivery) before adding `push.ts`/the registration call — one device should have one token, one registration call, reused by both "run finished" and "monitor changed" notifications.
- Reuse M04's JSON/table result-view components (ADR-01 `outputSchema`-typed) to render `MonitorEvent.diff` instead of a bespoke diff viewer.
- Reuse F02's diff shape as-is (surfaced through X05) as the wire format for `MonitorEvent.diff` — don't invent a client-side diff representation.

## 10. Skills

- **`mindrally/skills@expo-react-native-typescript`** — 1.6K installs, the vetted pick for all M01–M07. Guides S3/S4/S5 (Expo Router screens, typed hooks, nav wiring). Install: `npx skills add mindrally/skills@expo-react-native-typescript -g -y`.
- **Expo push / notification handling — no reputable ≥1K skill exists** (the plan's own audit rejected the Swift-native push skill as iOS-only; cross-platform push is just the Expo Notifications API). Fallback per the user's global Context7 rule: use **`context7-mcp`** to pull live `expo-notifications` / `expo-router` docs for exact API surface (`addNotificationResponseReceivedListener`, `getLastNotificationResponseAsync` for cold-start, permission-request flow) before implementing S4/S7 — the SDK changes across Expo versions, don't rely on training-data recall.
- **`pproenca/dot-skills@expo-react-native-performance`** (1K) — only if the monitors list needs virtualization at scale; skip for the initial build (a user's own subscription list is small — YAGNI until proven otherwise).
- Already-available `.agents/skills/test-driven-development` + `incremental-implementation` — guide S6.
