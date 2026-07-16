# M04 — Run screen + result views

## 1. Summary

- **ID:** M04 · **Name:** Run screen + result views · **Surface:** Mobile (Program 2 — Consumer Platform; Program-2 features carry no `Pil` — that column is Program-1-only)
- **Wave:** P2 · **Risk:** M · **Gates:** Lv(device) (headline gate; full G0–G8 applicability below)
- **Repo:** lives in the separate `apimemcp-platform` Turborepo (Locked decision ⑥), under `apps/mobile/`, sharing types with `packages/shared`. Never touches `D:/MCP/src` (the engine repo) — it consumes only the published `@neetigyashah/apimemcp` types + the registry manifest, per **ADR-06**.
- **What it does:** the screen where a phone user actually *runs* a community template — enter a target URL or tap a fixed-target, optionally paste cookies, submit to the cloud execution API (X01), watch live progress, and view the finished result as JSON / table / image gallery, with native share.
- **Why (market angle, 00-vision):** the vision names the mobile "results to your phone" moment as the consumer wedge — RPA-class access "from a phone" to sites with no API. M04 is the screen where that promise is redeemed: tap a template, get a real answer, no vendor endpoint required. It is also the direct precursor of the "killer mobile feature" (X05/M05 monitors are literally "run M04's flow on a schedule, push on diff") — nothing in M05/M06 works without M04's run+result plumbing existing first.

## 2. User/agent story

As a mobile user who just found a template on **Browse** (M03), I tap its card and land on `/run/[templateId]`. I see an input form seeded from the template's registry metadata (published via ADR-06 types): either a free-text target URL, or a one-tap "fixed target" button if the template doesn't need one, plus an optional cookie-paste field if the template's metadata flags `requiresCookie`. I tap **Run**. The screen enqueues the job against X01, shows `queued` → `running`, and — while I keep the app foregrounded — polls for completion. If I background the app, X04's Expo push tells me "run finished" and deep-links me straight back into the same result. The result renders as a table if it's an array of records, a gallery if it has image fields, or raw JSON otherwise, and I can flip between views and hit native Share. If the template is too heavy for the free cloud tier, I see X03's "run on your self-host server" message with a working deep link instead of a spinner that never ends.

## 3. Design

### 3.1 Data shapes (shared `packages/shared`, consumed by both M04 and W05 per ADR-01/ADR-03)

```ts
// packages/shared/src/api/run.ts
import type { JSONSchema7 } from 'json-schema';           // ADR-01 on-the-wire form
import type { TransformSpec } from '@neetigyashah/apimemcp'; // ADR-03 published type, NOT re-implemented

export interface RunRequest {
  templateId: string;
  targetUrl?: string;
  cookieString?: string;      // ephemeral only — never written to device storage by M04 itself
}

export interface RunJobRef { jobId: string; }

export type RunJobStatus =
  | { status: 'queued' | 'running' }
  | { status: 'done'; data: unknown; outputSchema?: JSONSchema7; durationMs: number }
  | { status: 'too_heavy'; selfHostUrl: string }   // X03 fallback, not an error
  | { status: 'error'; error: string };

// packages/shared/src/result-shape.ts  (pure, shared with W05 — ADR-03's own reuse principle)
export type ResultViewKind = 'table' | 'image' | 'json';
export function pickDefaultView(data: unknown, outputSchema?: JSONSchema7): ResultViewKind;
export function reshapeForView(data: unknown, spec?: TransformSpec): unknown; // thin wrapper over applyTransform
```

`validateOutput`/`outputSchema` (ADR-01) and `TransformSpec`/`applyTransform` (ADR-03) are consumed strictly as published-package imports — M04 never re-implements a schema or mapper (both ADRs' contract rules reject that).

### 3.2 Screens (Expo Router, `apps/mobile/app/`)

- `app/run/[templateId].tsx` — params `{ templateId, name?, fixedTargetUrl?, requiresCookie? }` (passed from M03's card tap, sourced from the registry manifest). Renders `RunInputForm`, calls `submitRun`, then `router.replace('/jobs/' + jobId)`.
- `app/jobs/[jobId].tsx` — params `{ jobId }`. Polls `getRunStatus(jobId)` every 1.5s while foregrounded (no persistent-connection client needed on RN); renders progress, then `ResultViewSwitcher`, or the `too_heavy` self-host banner. **This is also the push deep-link target** — M01's `Notifications.addNotificationResponseReceivedListener` routes `router.push('/jobs/' + data.jobId)` here, so a completed run opens to the same screen whether the user watched it live or got the push. Reused as-is by M05 (monitor "view latest run").

### 3.3 Components (`apps/mobile/components/`)

- `RunInputForm.tsx` — target URL vs fixed-target one-tap button, optional `CookiePasteField`, submit-disabled validation.
- `CookiePasteField.tsx` — paste-only, nothing auto-saved (mirrors the shipped browser-extension "Grab Cookies Only" UX contract, reimplemented natively — no code-share possible across extension/RN but same product behavior). Saving to persistent storage is explicitly out of scope here — that is M06's device-encrypted vault, opt-in only.
- `result-views/JsonView.tsx`, `result-views/TableView.tsx`, `result-views/ImageGalleryView.tsx`, `result-views/ResultViewSwitcher.tsx` (uses `pickDefaultView`, lets the user override).
- All built from M02's themed primitives (buttons/inputs/cards) — no parallel one-off styling.

### 3.4 API client (`apps/mobile/lib/api/run-client.ts`)

Thin wrapper, no business logic: `submitRun(req: RunRequest): Promise<RunJobRef>` → `POST /api/run` (X01), `getRunStatus(jobId): Promise<RunJobStatus>` → `GET /api/run/:id` (X01). Both routes and their shapes are owned by X01 (cloud-architecture.md); M04 is a pure client and never re-implements queuing, retries, or orchestration.

### 3.5 ADR-02 note

ADR-02 (`registerXxxTool`) governs MCP-tool registration in the **engine** repo's `src/index.ts` — **N/A for M04**, which is a mobile UI feature in a different repo and registers nothing there. M04's only "registered signatures" are the two Expo Router screen routes above and its calls into X01's already-defined HTTP contract.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `packages/shared/src/api/run.ts`, `result-shape.ts` |
| S2 Storage (data/API client) | Applicable | `apps/mobile/lib/api/run-client.ts` |
| S3 Screens/components | Applicable (2×) | Run + Job screens, form, 3 result views, switcher |
| S4 Feature module | Applicable | group under a `features/run/` (or route-colocated) module per M02 conventions |
| S5 Route/nav wiring | Applicable | Expo Router routes above + M03 card → `/run/[templateId]` + push deep-link → `/jobs/[jobId]` |
| S6 Component tests | Applicable | see §7 |
| S7 e2e/device | Applicable | manual device-verify checklist, see §7 |
| S8 Docs | Applicable | screen doc + `verify-M04.md` checklist |
| S9 Review (G2) | Applicable | |
| S10 device/preview verify (G6) | Applicable | Live-Verification Gatekeeper, simulator + device |
| S11 Merge (G7) | Applicable | `feat/M04-run-screen` → `apimemcp-platform` `main` |

None N/A — M04 is a full-stack-on-device UI feature.

## 5. Dependencies & sequencing

- **Hard deps:** M03 (Browse — source of `templateId`/card tap, transitively M01 scaffold + M02 design system), X01 (execution API gateway — must exist to call), X04 (results delivery — Expo push channel for background completion).
- **Cross-repo:** ADR-01 + ADR-03 published types must be on the `@neetigyashah/apimemcp` npm version the platform depends on (ADR-06) — a breaking engine type change is a semver bump the platform must absorb before M04 can build.
- **Unblocks:** M05 (Monitors + push — reuses the `/jobs/[jobId]` screen and run-client), M06 (Run history + account + cookies — reuses `RunJobStatus`/result views for history rows and adds the opt-in persistence M04 deliberately omits).
- **Wave:** P2, parallel with W05 (the web run console) — same X01/X04 dependency, same ADR-01/03 contracts, sibling not sequential.

## 6. Quality gates

| Gate | Applies? | Why |
|---|---|---|
| G0 Spec | Yes | this doc (Design Lead + Architect + Orchestrator) |
| G1 Build | Yes | typecheck/lint/expo build clean |
| G2 Code-Review | Yes | |
| G3 Arch | Yes | touches shared `packages/shared`; must prove ADR-06 boundary (published types only, zero engine-internal imports) |
| G3b Design | Yes | UI feature — Design Lead checks vs M02 design system + a11y floor |
| G4 Security | **N/A** | M04 keeps cookies ephemeral (pass-through to X01 over TLS, never persisted) — no vault/sandbox surface of its own; the moment it persists, that's M06's gated territory |
| G5 QA | Yes | component tests green |
| G6 Live/Device-Verify | Yes (catalog headline gate) | simulator + physical device, per §7 |
| G7 Integration | Yes | merge to platform `main` (no `integration` branch on this repo — direct `feat/M##` → `main` per 04-git-strategy.md) |
| G8 Promote+Deploy | Yes | EAS build/preview at wave boundary |

**Definition of Done:** a user can go Browse → Run → real result on both a foreground and a backgrounded/push-delivered path, in all three result views, with working share and a correct heavy-template fallback message — verified on iOS and Android — with zero imports from `D:/MCP/src` and all cookie handling ephemeral by default.

## 7. Test plan

Component tests (Jest + React Native Testing Library):
- `apps/mobile/components/__tests__/RunInputForm.test.tsx` — URL required unless fixed-target set; cookie field only rendered when `requiresCookie`; submit disabled until valid.
- `apps/mobile/components/result-views/__tests__/ResultViewSwitcher.test.tsx` — array-of-records → table default, image-field data → gallery default, else → json; manual override switches.
- `apps/mobile/lib/api/__tests__/run-client.test.ts` — maps X01 responses to `RunJobStatus` incl. the `too_heavy` (X03) branch and network-error branch.
- `packages/shared/src/__tests__/result-shape.test.ts` — `pickDefaultView`/`reshapeForView` pure-function cases; shared fixture reused by W05's own tests.

Live/device verify (G6 — M04 is not engine/browser-touching, so no Playwright `scripts/verify-M04.mjs`; per the roster, mobile G6 is a **simulator/device run**, not an automated script): `apps/mobile/docs/verify-M04.md` checklist —
1. Launch on iOS simulator/device and Android emulator/device (or Expo Go).
2. From Browse, open a real registry template with a known `outputSchema` (array-of-objects) → Run → confirm queued→running→table result.
3. Open a template with an image-bearing result → confirm gallery view.
4. Confirm Share opens the native sheet.
5. Start a run, background the app, confirm the Expo push arrives and deep-links into `/jobs/[jobId]` showing the completed result.
6. Attempt a known heavy/paginated template → confirm the `too_heavy` self-host message renders with a working deep link.

## 8. Acceptance criteria

On a real iOS device/simulator **and** an Android device/emulator: tapping a template on Browse lands on its Run screen; submitting a valid input reaches `queued`→`running`→a rendered result in the auto-picked view; switching views works; Share opens the OS share sheet; backgrounding mid-run and tapping the resulting push notification opens `/jobs/[jobId]` with the same completed result; a heavy template shows X03's "too heavy for the cloud tier" message with a functioning self-host deep link instead of hanging. All component tests green; `npm run build`/EAS preview clean; zero `D:/MCP/src` imports anywhere in the diff.

## 9. Reuse notes

- ADR-01's `outputSchema`/validation types and ADR-03's `TransformSpec`/`applyTransform` — imported from `@neetigyashah/apimemcp`, never re-implemented.
- X01's `RunRequest`/job-status HTTP contract and X04's Expo push registration (set up once in M01) — M04 is a pure client of both, no parallel queuing or push-registration logic.
- M02's themed component primitives for all form/card chrome.
- `packages/shared/src/result-shape.ts` is written once and shared with W05 — coordinate, don't fork a second picker.
- Cookie-paste UX intentionally mirrors the engine's already-shipped browser-extension "Grab Cookies Only" behavior (paste, nothing auto-saved) for product consistency, not code-share.
- Explicitly does **not** touch or reimplement engine-repo internals — `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript` are `D:/MCP/src` implementation details behind the ADR-06 boundary; M04 only ever calls X01's public HTTP surface.

## 10. Skills

- **Setup:** `npx skills check` first (global, durable — likely already installed by the M01/M02/M03 builders); install only what's missing.
- **`mindrally/skills@expo-react-native-typescript`** — 1.6K installs, reputable, already the catalog's assigned M01–M07 skill. Install: `npx skills add mindrally/skills@expo-react-native-typescript -g -y`. Guides S3 (Run/Job screens, form, result-view components), S4 (feature module layout), S5 (Expo Router dynamic routes + push deep-link wiring).
- **`dataviz`** (already available, no install) — read before writing any of `TableView`/`ImageGalleryView`/`ResultViewSwitcher`; governs table/gallery/JSON presentation conventions consistent with W05's web result views.
- **`context7-mcp`** (already available; per the user's global rule, always used for live library docs rather than memory) — pulls current Expo Router deep-linking API and `expo-notifications` response-listener API while wiring S5's push-to-screen path.
- **Deliberately not installed:** no mobile e2e framework skill (Detox/Maestro) — none surfaced at the ≥1K-install reputable bar for this plan, so S7/S10 stays a manual Live-Verification Gatekeeper device checklist (`verify-M04.md`) rather than a shaky automated one.
