# M06 — Run history + account + cookies

## 1. Summary

- **ID:** M06 · **Name:** Run history + account + cookies · **Surface:** Mobile (Program 2 catalog has no Pillar column — Surface is the Program-2 analog of Program 1's Pillar) · **Wave:** P3 · **Gates:** Se · **Risk:** M
- **What:** Two screens in the Expo app — **Runs** (device-local history of past executions) and **Account** (Clerk profile, API key, sign-out, and a device-encrypted **Cookie Vault** with an opt-in per-entry sync to X06's server-side vault).
- **Why (tied to 00-vision):** 00-vision names the mobile **monitor** (push on price-drop/restock/filing) as "the consumer wedge." A monitor is worthless if the user can't (a) see proof of what ran and when — Run History — or (b) keep auth cookies around instead of re-pasting them every run — Cookie Vault. The cloud-sync toggle is also the enabler for X05 monitors that must keep running **while the phone is closed** (a monitor needs its cookie available server-side, not just in the app's SecureStore). M06 is the trust/retention layer that makes the wedge usable, not a new capability of its own — it deliberately adds no new engine or cloud logic beyond one small X06 route contract.

## 2. User/agent story

> As a mobile user who ran the "Bernhardt product page" template last week with a pasted session cookie, I open the app, tap **Runs**, see that execution with its status and timestamp, tap it to re-view the result, then go to **Account → Cookie Vault**, find the cookie I saved, and flip "sync to cloud" so my price-drop monitor (M05/X05) can keep checking it after I close the app — without ever seeing the raw cookie string appear anywhere but the one screen I saved it from.

## 3. Design

### 3.1 Governing ADR

**ADR-05 (Vault vs app-connections)** is the ADR M06 must obey. Its rule: app-connections (browser-identity profiles, engine-side) and Vault (encrypted secret values) are **separate stores that may cross-reference but never merge**. M06 introduces a *third*, device-local analog — the on-device Cookie Vault — and the same rule applies transitively: the device store and X06's cloud store are separate stores linked only by an opaque `vaultKeyId` reference; neither ever copies the other's raw value into its own persistence format, and the cloud side is strictly per-user isolated (ADR-05's G4 contract rule). Per **ADR-06**, M06 (platform repo) never imports engine (`D:/MCP/src`) internals — it does not call `app-connections.ts`, `vault.ts`, or any engine module directly; it only calls X01/X06 HTTP routes and platform-local shared types.

### 3.2 Repo & exact file paths (`apimemcp-platform` Turborepo — per PLAN.md's `apps/web, apps/mobile, packages/shared` layout; W01/M01/M02/M03/M04 scaffold these first)

```
packages/shared/types.ts                         MODIFIED — add RunHistoryEntry, DeviceCookieEntry, AccountProfile (+ zod schemas)

apps/mobile/lib/secure-cookie-store.ts            NEW — device-encrypted cookie CRUD (expo-secure-store)
apps/mobile/lib/run-history-store.ts              NEW — local run-history log (AsyncStorage) + pending-status reconcile
apps/mobile/lib/api-client.ts                     MODIFIED — add getRunStatus(), syncCookieToCloudVault(), unsyncCookieFromCloudVault()

apps/mobile/app/(tabs)/history.tsx                NEW — Run History screen
apps/mobile/app/history/[runId].tsx               NEW — Run detail (re-view past result; reuses M04 result-view components)
apps/mobile/app/(tabs)/account/index.tsx          NEW — Account screen (profile, API key, sign-out)
apps/mobile/app/(tabs)/account/cookies.tsx        NEW — Cookie Vault screen (list/add/delete/sync)
apps/mobile/app/(tabs)/_layout.tsx                MODIFIED — add History + Account tab entries (Expo Router file-based routing auto-registers the nested history/[runId] and account/cookies stack children — no manual index needed, unlike ADR-02's engine-side index.ts convention)

apps/mobile/components/RunHistoryListItem.tsx     NEW
apps/mobile/components/CookieVaultListItem.tsx    NEW
```

### 3.3 Data shapes (`packages/shared/types.ts`)

```ts
import { z } from 'zod';

export const RunHistoryEntrySchema = z.object({
  runId: z.string(),               // == X01 jobId
  templateId: z.string(),
  templateName: z.string(),
  targetUrl: z.string().optional(),
  status: z.enum(['pending', 'success', 'error']),
  startedAt: z.string(),           // ISO
  completedAt: z.string().optional(),
  resultPreview: z.unknown().optional(),  // small preview only — device holds the full result per X04 zero-persist-server-side
  error: z.string().optional(),
});
export type RunHistoryEntry = z.infer<typeof RunHistoryEntrySchema>;

export const DeviceCookieEntrySchema = z.object({
  id: z.string(),                  // local uuid
  domain: z.string(),              // domainPattern, naming aligned with AppConnection.domainPattern (ADR-05) — no store merge, naming only
  label: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  vaultKeyId: z.string().optional(), // set only when synced to X06; presence = "synced"
});
export type DeviceCookieEntry = z.infer<typeof DeviceCookieEntrySchema>;
// NOTE: cookieString is intentionally NOT in this shared type — it never leaves secure-cookie-store.ts as a JS value
// except at the single point of use (M04 Run screen) or the single sync call to X06. Metadata and secret are split types.

export const AccountProfileSchema = z.object({
  userId: z.string(),               // Clerk user id
  email: z.string(),
  apiKeyMasked: z.string(),         // last 4 chars only — full key never enters app state
  cloudVaultOptIn: z.boolean(),
});
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
```

### 3.4 Module signatures

```ts
// apps/mobile/lib/secure-cookie-store.ts
// SecureStore has no "list keys" API, so an index array is kept under one key, scoped by Clerk userId
// (Se-gate decision: shared-device account switch must not leak the previous user's cookies).
export async function listCookieSummaries(userId: string): Promise<DeviceCookieEntry[]>;      // metadata only, no secret
export async function getCookieValue(userId: string, id: string): Promise<string | null>;      // raw cookieString, read only at point of use (M04)
export async function saveCookie(userId: string, domain: string, label: string, cookieString: string): Promise<DeviceCookieEntry>;
export async function deleteCookie(userId: string, id: string): Promise<void>;
export async function markSynced(userId: string, id: string, vaultKeyId: string | null): Promise<void>;

// apps/mobile/lib/run-history-store.ts
export async function appendRun(userId: string, entry: RunHistoryEntry): Promise<void>;  // called from M04's run-completion hook
export async function listRuns(userId: string): Promise<RunHistoryEntry[]>;              // most-recent-first, capped at 200
export async function reconcilePending(userId: string): Promise<void>;                   // for entries still 'pending', calls api-client.getRunStatus()

// apps/mobile/lib/api-client.ts (additions)
export async function getRunStatus(runId: string): Promise<{ status: RunHistoryEntry['status']; resultPreview?: unknown; error?: string }>; // GET /api/run/:id — X01, REUSED not re-implemented
export async function syncCookieToCloudVault(body: { domain: string; label: string; cookieString: string }): Promise<{ vaultKeyId: string }>; // POST /api/vault/cookies — X06
export async function unsyncCookieFromCloudVault(vaultKeyId: string): Promise<void>;      // DELETE /api/vault/cookies/:vaultKeyId — X06
```

### 3.5 Screen signatures

```tsx
export default function HistoryScreen(): JSX.Element              // apps/mobile/app/(tabs)/history.tsx
export default function RunDetailScreen(): JSX.Element             // apps/mobile/app/history/[runId].tsx — runId via useLocalSearchParams()
export default function AccountScreen(): JSX.Element                // apps/mobile/app/(tabs)/account/index.tsx
export default function CookieVaultScreen(): JSX.Element            // apps/mobile/app/(tabs)/account/cookies.tsx
```

### 3.6 X06 route contract M06 depends on (owned/implemented by the Cloud/Infra Builder on X06, M06 only consumes it)

```
POST   /api/vault/cookies        { domain, label, cookieString }  -> { vaultKeyId }   (Clerk-authed; per-user isolated)
DELETE /api/vault/cookies/:id    -> 204
GET    /api/vault/cookies        -> { vaultKeyId, domain, label, createdAt }[]        (never returns cookieString)
```

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `RunHistoryEntry`/`DeviceCookieEntry`/`AccountProfile` + zod, `packages/shared/types.ts` |
| S2 Storage/API client | Applicable | `secure-cookie-store.ts`, `run-history-store.ts`, `api-client.ts` additions |
| S3 Screens/components | Applicable (2×) | 4 screens + 2 list-item components, §3.5 |
| S4 Feature module | Applicable | the 3 `lib/` modules form the cohesive unit; no separate wrapper needed |
| S5 Route/nav wiring | Applicable | 2 tab entries in `(tabs)/_layout.tsx`; nested routes auto-registered by Expo Router file convention |
| S6 Component tests | Applicable (2×) | §7 |
| S7 e2e/device | Applicable (light) | manual SecureStore-persists-across-relaunch smoke; not a full Detox suite — G6 isn't a flagged gate for M06 (catalog Gates=Se only) |
| S8 Docs | Applicable | short section in platform README screens list |
| S9 Review (G2) | Applicable | Code-Reviewer pass |
| S10 Live/device verify (G6) | N/A | catalog Gates column = `Se` only, no `Lv`/device marker — no blocking device-verify gate required |
| S11 Merge (G7) | Applicable | Integration merge, platform repo |

## 5. Dependencies & sequencing

- **Hard deps (catalog):** `M04` (Run screen + result views) — M06 hooks `run-history-store.appendRun()` into M04's run-completion callback and feeds M04's cookie-paste/webview-capture flow into `secure-cookie-store.saveCookie()`; reuses rather than duplicates both. `X06` (Encrypted cookies + optional vault) — needed for the cloud-sync toggle's `POST/DELETE/GET /api/vault/cookies` routes.
- **Transitive:** X06 itself depends on `F13` (vault) and `ADR-05` — M06 does not depend on F13 directly (never touches the engine repo), only on X06's already-ADR-05-compliant HTTP surface.
- **Unblocks:** `M07` (App-store prep) depends on `M01–M06` inclusive — M06 is one of its gating features.
- **Soft/non-blocking synergy:** `M05` (Monitors + push) depends on `M04, X05` per the catalog, not on M06 — M05 ships independently, but its "push while the phone is closed" case only becomes fully useful once a user has opted a cookie into M06's cloud vault. Not a hard dependency; noted for sequencing awareness only.
- **Wave:** P3, alongside M05.

## 6. Quality gates

Applicable from the G0→G8 pipeline: **G0** Spec (this doc) → **G1** Build → **G2** Code-Review → ~~G3 Arch~~ (skip — no boundary/cross-repo-contract change, additive screens + one local store module) → **G3b Design** (light — Design Lead confirms the 4 new screens use M02's existing component/token set, no new design-system surface) → **G4 Security** (flagged `Se` in the catalog — Security-Reviewer gates the cookie-handling path specifically) → **G5** QA (component tests) → ~~G6 Live/Device-Verify~~ (skip — not flagged for M06) → **G7** Integration → **G8** Promote with the rest of wave P3.

**Definition of Done:**
1. Runs tab lists local run history, newest first, reflecting M04 completions in real time.
2. Tapping a history row opens the past result via M04's existing result-view components (no re-implementation).
3. Account screen shows Clerk profile, masked API key, sign-out.
4. Cookie Vault screen: add/list/delete device-encrypted entries; per-entry "sync to cloud" toggle calls X06 and reflects synced state via `vaultKeyId`.
5. Raw `cookieString` never enters shared/global app state, is never logged, and crosses the network exactly once per explicit user sync action (TLS to X06).
6. Storage keys are scoped per signed-in Clerk `userId` — switching accounts on a shared device shows neither the previous user's history nor cookies.
7. Security-Reviewer (G4) sign-off obtained; component tests green; build clean.

## 7. Test plan

- `packages/shared/types.test.ts` — zod round-trip for `RunHistoryEntrySchema`/`DeviceCookieEntrySchema`/`AccountProfileSchema` (valid + invalid-shape rejection).
- `apps/mobile/lib/secure-cookie-store.test.ts` — CRUD against a mocked `expo-secure-store`: save→listCookieSummaries omits `cookieString`; getCookieValue returns it; delete removes from the userId-scoped index; two different `userId`s never see each other's entries.
- `apps/mobile/lib/run-history-store.test.ts` — append/list ordering, 200-entry cap, `reconcilePending()` updates a `pending` entry to `success`/`error` via a mocked `api-client.getRunStatus`.
- Component tests (React Native Testing Library) for `HistoryScreen`, `AccountScreen`, `CookieVaultScreen`: render against mocked stores; delete button invokes `deleteCookie`; sync-toggle invokes `syncCookieToCloudVault` exactly once and re-renders with the cloud indicator.
- No `scripts/verify-M06.mjs` — that pattern is engine/Playwright-specific (per the spec template's item 7 caveat); M06 is not engine/browser-touching, so N/A. The one live check is the manual S7 smoke below.

## 8. Acceptance criteria (live, observable)

- On a device/simulator: complete a run from the M04 Run screen → open the Runs tab → the run appears at the top with correct status within ~1s, with no network call needed to populate the list (device is the source of truth).
- Add a cookie in Cookie Vault → force-quit the app → relaunch → the cookie is still listed (proves Keychain/Keystore persistence, not just in-memory state).
- Toggle "sync to cloud" on one entry → exactly one network request to `POST /api/vault/cookies` fires, a `vaultKeyId` is stored, and a cloud icon appears; toggling off calls `DELETE /api/vault/cookies/:id` and only unlinks (`vaultKeyId` cleared) — the local entry itself remains.
- Sign out via Account → sign in as a second Clerk test user on the same device → Runs and Cookie Vault are both empty for that user (key-scoping proof), then sign back into the first account → the original history/cookies reappear.

## 9. Reuse notes

M06 is mobile-only, so the usual engine-side reuse targets (`captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`) **do not apply** — ADR-06 forbids the platform from importing engine internals at all. The platform-appropriate reuse targets instead:
- **M04's** run-completion callback and cookie-paste/webview-capture flow — hook into, don't duplicate.
- **M01's** Clerk auth context/hooks — reused for Account's profile + sign-out, no separate auth implementation.
- **X01's** existing `GET /api/run/:id` — reused by `reconcilePending()` instead of inventing a new history-listing server endpoint (device list is authoritative; server is only consulted to resolve `pending` rows).
- **M02's** design-system components/tokens — all 4 new screens compose existing primitives (list rows, empty states, buttons); no new visual primitives introduced.
- **ADR-05's** separation principle itself, applied by extension to the device Cookie Vault vs X06's cloud vault — the reused *pattern*, not code.

## 10. Skills (setup + when-to-use)

- `npx skills check` first (global, durable — reuse anything installed by earlier M01–M05 agents).
- **`mindrally/skills@expo-react-native-typescript`** — 1.6K installs, reputable — `npx skills add mindrally/skills@expo-react-native-typescript -g -y` — guides S2 (typed API client additions), S3 (the 4 screens + 2 list components), S5 (Expo Router tab/stack wiring).
- **`security-and-hardening`** (one of the 24 already-available `.agents/skills/`, no install) — guides the SecureStore-vs-plaintext decisions in §3.4, the per-`userId` key-scoping call in §8, and G4 prep.
- **`frontend-design` / `ui-ux-pro-max:*`** (already available) — guides S3 to stay inside M02's existing design system rather than inventing new component styling.
- **`context7-mcp`** (already available) — fallback for live `expo-secure-store` / `expo-router` API specifics during build; no ≥1K-install skill needed here since these are official Expo APIs well covered by their own docs.
