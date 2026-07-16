# W07 — Auth + Accounts + Dashboard

## 1. Summary

- **ID/Name:** W07 — Auth + accounts + dashboard
- **Pillar/Surface:** Web (Program 2 — Consumer Platform)
- **Wave:** P1 · **Risk:** M · **Gates:** Se (Security-Reviewer blocks)
- **Deps (catalog):** W01 · **Key skills (catalog):** `vercel:auth`, `vercel-storage`

**What.** Clerk-based sign-in/sign-up for the `apimemcp-platform` web app, a `/account` dashboard with three tabs — **Monitors**, **Run history**, **API keys** — and a thin "saved cookies" panel that proxies X06 rather than owning cookie storage itself.

**Why (tied to 00-vision).** The vision's flywheel depends on "consumers run/monitor them" being *durable*: a monitor subscription, a run history entry, or an API key only matters if it survives past one browser tab and follows the user across web and mobile. W07 is that persistence substrate — without it, X05's "killer mobile feature" (push-on-change monitors) has no per-user home to list from, and the RPA-replacement / financial-aggregation target markets (00-vision) can't get a durable API key for programmatic reuse. W07 is infrastructure, not a headline feature — it makes every other Account-page-shaped feature (W05's saved runs, M05's monitor list, M06's mobile account) possible.

## 2. User/agent story

- *As a visitor*, I sign up with email/GitHub/Google via Clerk, land on `/account`, and my session persists across web and (later) the mobile app under the same Clerk project.
- *As a returning user*, I open `/account/monitors` and see the monitors I subscribed to from a template detail page (W04/W05), each showing last-checked time and a pause/resume toggle.
- *As a developer/agent consumer*, I open `/account/keys`, generate an API key named "ci-bot", copy the plaintext once, and use it to call X01 (`POST /api/run`) headlessly — no browser session needed.
- *As the Security-Reviewer*, I need proof that user A can never see user B's history, monitors, or keys, and that a revoked key stops authenticating immediately.

## 3. Design

W07 is Program 2 / Web — it has **no footprint under `D:/MCP/src`** (the engine repo). All paths below are relative to the `apimemcp-platform` Turborepo root that W01 scaffolds (`apps/web`, `apps/mobile`, `packages/shared`). W07 touches only `apps/web` and `packages/shared`.

**ADRs obeyed.**
- **ADR-06 (registry = cross-repo contract).** W07 never imports engine internals. `RunHistoryEntry.templateId` is a plain string keyed to the registry manifest's `ManifestEntry.id`; any result/status shown in the history table is typed from X01/X04 responses (which themselves are typed from the published `@neetigyashah/apimemcp` package), never re-derived locally. The new types W07 adds to `packages/shared` are a **separate, narrower** intra-repo boundary (web ↔ mobile within `apimemcp-platform`), not the ADR-06 seam itself — don't conflate the two.
- **ADR-02 (tool-module convention), applied by analogy.** W07 has no MCP tool surface, so the literal `registerXxxTool(server, deps)` signature doesn't apply. Its *spirit* — one exported unit per file, collaborators explicitly imported rather than reached into globally, no feature edits another feature's registration — is already enforced for free by Next.js App Router file-system routing: one `route.ts` per endpoint exporting `GET`/`POST`/`PATCH`/`DELETE`, each handler taking its collaborators (Clerk `auth()`, the Drizzle `db` client, X05/X06 client functions) as top-of-file imports. New account endpoints are new files under `app/api/account/**`; W07 never edits X01/X04/X05's own route files, only imports their exported client functions.

**Data shapes — `packages/shared/src/types/account.ts` (Zod):**
```ts
import { z } from "zod";

export const ApiKeyRecord = z.object({
  id: z.string().uuid(),
  userId: z.string(),                 // Clerk user id, e.g. "user_2f..."
  name: z.string().min(1).max(60),
  keyPrefix: z.string().length(8),    // e.g. "amk_7f2a", shown forever
  keyHash: z.string(),                // sha256 hex — server-only, never serialized to client
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type ApiKeyRecord = z.infer<typeof ApiKeyRecord>;
export const ApiKeyPublic = ApiKeyRecord.omit({ keyHash: true });
export type ApiKeyPublic = z.infer<typeof ApiKeyPublic>;

export const RunHistoryEntry = z.object({
  jobId: z.string(),
  userId: z.string(),
  templateId: z.string(),             // ManifestEntry.id (ADR-06)
  targetUrl: z.string().url().optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "too_heavy"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
});
export type RunHistoryEntry = z.infer<typeof RunHistoryEntry>;

// Read-only projection of X05's own monitor state — W07 does not own this table.
export const MonitorSummary = z.object({
  id: z.string().uuid(),
  templateId: z.string(),
  schedule: z.string(),
  lastCheckedAt: z.string().datetime().nullable(),
  lastChangeAt: z.string().datetime().nullable(),
  active: z.boolean(),
});
export type MonitorSummary = z.infer<typeof MonitorSummary>;
```

**DB schema — `packages/shared/src/db/schema.ts` (Drizzle, Postgres/Neon via the `vercel-storage` integration; reuses W01's existing `packages/shared`, no new package):**
```ts
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
}, (t) => ({ userIdx: index("api_keys_user_idx").on(t.userId) }));

export const runHistory = pgTable("run_history", {
  jobId: text("job_id").primaryKey(),
  userId: text("user_id").notNull(),
  templateId: text("template_id").notNull(),
  targetUrl: text("target_url"),
  status: text("status").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  errorMessage: text("error_message"),
}, (t) => ({ userIdx: index("run_history_user_idx").on(t.userId) }));
```
W07 owns **only** `api_keys` and `run_history` — the two tables uniquely "account" shaped. Monitor subscriptions stay owned by X05 (its cron+diff logic needs to write them anyway); cookie profiles stay owned by X06 (ADR-05's vault/app-connections separation, carried into the cloud tier). `run_history` rows are written by X01 at job start / X04 at completion via a shared insert/update helper in `packages/shared/src/db/runHistory.ts` — one owner of the schema, multiple typed writers, mirroring ADR-02's "collaborators passed in explicitly" ethos even off the engine.

**Module-by-module changes (`apps/web/`):**
- `middleware.ts` — `clerkMiddleware()` (`@clerk/nextjs/server`), matcher covering `/account/:path*` and `/api/account/:path*`; unauthenticated → redirect to `/sign-in` (pages) / 401 JSON (API).
- `app/layout.tsx` — wrap root in `<ClerkProvider>`.
- `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx` — Clerk `<SignIn/>`/`<SignUp/>` catch-all routes.
- `app/account/layout.tsx` — server-side `auth()` guard + redirect; tab nav (Monitors / History / Keys) using W02 design-system nav components.
- `app/account/page.tsx` — redirects to `/account/monitors`.
- `app/account/monitors/page.tsx` — Server Component, fetches `MonitorSummary[]` via the API route below.
- `app/account/history/page.tsx` — `RunHistoryEntry[]` table; `too_heavy` rows deep-link to X03's self-host instructions.
- `app/account/keys/page.tsx` — Client Component: create-key dialog (shows plaintext once, copy-to-clipboard), list with revoke action.
- `app/account/cookies/page.tsx` — thin list sourced from X06 (name, domain, createdAt only — no secret material ever reaches this page's props).
- `app/api/account/keys/route.ts` — `GET` list `ApiKeyPublic[]` for `auth().userId`; `POST {name}` → generates `amk_<32 hex>`, stores `sha256(key)` + `keyPrefix`, returns the **plaintext key once**.
- `app/api/account/keys/[id]/route.ts` — `DELETE` → sets `revokedAt`, 204.
- `app/api/account/history/route.ts` — `GET ?cursor&limit` → paginated, `WHERE userId = auth().userId` only.
- `app/api/account/monitors/route.ts` — `GET` proxies `x05Client.listMonitors(userId)`.
- `app/api/account/monitors/[id]/route.ts` — `PATCH {active}` proxies `x05Client.setMonitorActive(id, userId, active)` — does not reimplement scheduling.
- `app/api/account/cookies/route.ts` — `GET`/`DELETE` proxy `x06Client.listCookieProfiles`/`revokeCookieProfile`.

**Env (Vercel, set once here, reused by M01/W05/etc.):** `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `POSTGRES_URL` (Neon via Vercel Storage).

## 4. Sub-tasks (S0–S11, Web meaning)

| # | Meaning (Web) | Applicable? | Note |
|---|---|---|---|
| S0 Spec | This document | Applicable | — |
| S1 Types | `packages/shared/src/types/account.ts` + `db/schema.ts` | Applicable | Shared with `apps/mobile` (M06) |
| S2 Data/API client | Drizzle client + `runHistory.ts` write helper | Applicable | Consumed by X01/X04 too |
| S3 Screens/components | account pages, sign-in/up, key dialog | Applicable | Uses W02 tokens |
| S4 Feature module | `apps/web/lib/account/*` (key hashing, pagination) | Applicable | — |
| S5 Route/nav wiring | middleware + `app/api/account/**` + header nav link | Applicable | — |
| S6 Component tests | Vitest + RTL for key dialog / history table / monitor toggle | Applicable | — |
| S7 e2e/device | Playwright e2e (web, not device) | Applicable | Reuses existing Playwright convention, not a new tool |
| S8 Docs | README section, this spec | Applicable | — |
| S9 Review | G2 code-review | Applicable | — |
| S10 Device/preview verify | Vercel preview-URL smoke (not device — web surface) | Applicable | G6 |
| S11 Merge | G7 integration | Applicable | — |

None are N/A — this is a full CRUD account surface.

## 5. Dependencies & sequencing

- **Hard dep (catalog):** W01 (Turborepo scaffold, so `apps/web`/`packages/shared` exist).
- **Not a formal catalog dependency, but true in practice — flagging for the Orchestrator:**
  - **M01** (mobile scaffold) shares "the same Clerk accounts" (mobile-app-design.md) — the Clerk *project/keys* W07 provisions in Vercel should exist before M01 wires Expo auth, even though M01's code doesn't import W07's code.
  - **M06** (mobile run history/account/cookies) reuses `ApiKeyPublic`/`RunHistoryEntry` from `packages/shared` — sequence W07's S1 (types) before M06 starts.
  - **X06**'s UI slice is embedded in `/account/cookies` — land W07's cookie panel behind a feature flag if X06 isn't merged yet, rather than blocking on it.
  - **X01/X04/X05** call into W07-owned tables/types (`runHistory` writer, `MonitorSummary` shape) — their builders need W07's S1 landed to compile against it.
- **Wave:** P1. **Unblocks (functionally):** the "my monitors / my history / my keys" experience that W05, M05, M06 each render into.

## 6. Quality gates

- **G0–G2, G5, G7, G8:** standard — spec, build, code-review, QA (unit+component), integration, promote+deploy.
- **G3 Arch:** light-touch only — W07 adds *additive* shared types (no breaking change to any existing published shape), so it doesn't hard-block, but Architect should confirm `packages/shared` stays free of Node-only server code importable by `apps/mobile`.
- **G3b Design:** applies (UI feature) — Design Lead checks account pages against W02 tokens + a11y floor.
- **G4 Security — blocks (catalog: Se).** Definition of Done: (1) `keyHash` never serialized to any client response — verified by a test asserting the API route's response type; (2) plaintext key shown exactly once, never re-fetchable; (3) revoked key fails a subsequent X01 auth check; (4) `history`/`monitors`/`keys` queries are always scoped by `auth().userId` — a cross-user isolation test is mandatory, not optional; (5) key-creation endpoint rate-limited (reuse X01's `vercel:vercel-firewall` middleware pattern, don't reinvent).
- **G6:** Vercel preview-URL smoke test (sign in → create key → revoke → sign out).

## 7. Test plan

- `packages/shared/src/types/account.test.ts` — `ApiKeyPublic` omits `keyHash`; `RunHistoryEntry.status` rejects values outside the enum.
- `apps/web/app/api/account/keys/route.test.ts` — faked `auth()` + faked db: create returns plaintext once and a distinct stored hash; list never includes `keyHash`; revoke rejects further use.
- `apps/web/app/api/account/history/route.test.ts` — **the security-critical case:** seed rows for user A and user B, assert a request authed as A returns only A's rows.
- `apps/web/app/api/account/monitors/route.test.ts` — PATCH proxies to a faked `x05Client`, never touches a local monitors table (guards against W07 accidentally growing its own copy).
- `apps/web/components/account/ApiKeyList.test.tsx` (RTL) — revoke button calls `DELETE`, row disappears optimistically.
- `apps/web/components/account/MonitorList.test.tsx` (RTL) — toggle calls `PATCH`, shows `lastCheckedAt`.
- `apps/web/e2e/account.spec.ts` (Playwright, reusing the repo's existing e2e convention — not a new `verify-*.mjs`, since W07 is Web, not engine/browser-extraction): Clerk test-mode sign-in → `/account/keys` → create "test" → visible once → revoke → gone. Runs against the Vercel preview URL for G6.

## 8. Acceptance criteria

- Visiting `/account` signed-out redirects to `/sign-in`; `/api/account/*` signed-out returns 401 JSON.
- Signed in, `/account/keys` → create "ci-bot" → full key shown once in a copyable field → page reload shows only `amk_7f2a…` prefix.
- Two distinct signed-in test accounts hitting `/api/account/history` get disjoint row sets — no cross-user row ever appears (Security-Reviewer proof artifact).
- Revoking a key, then calling X01's `POST /api/run` with it, returns 401.
- A monitor created via W04/W05's "subscribe" action shows up on `/account/monitors` with live `lastCheckedAt` from X05 — not a stale W07-local value.

## 9. Reuse notes

- Clerk's `auth()` / `currentUser()` / `clerkMiddleware()` — never hand-roll session/cookie handling.
- `packages/shared` (already exists from W01) — add to it, don't create a new package for types or DB schema.
- W02's design-system components (buttons, tables, dialogs, nav) — restyle nothing from scratch.
- X05's monitor read/update client functions — import and call; W07 does not reimplement scheduling or F02-derived diffing.
- X06's cookie-profile list/revoke client functions — import and call; W07 stores zero cookie secret material itself (ADR-05 boundary, carried into the cloud tier by X06).
- X01's rate-limit middleware pattern (`vercel:vercel-firewall`) — reuse for the key-creation endpoint rather than writing a new limiter.
- Engine-side helpers (`captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`) are Program 1 internals under `D:/MCP/src` — out of scope per ADR-06; W07 never imports them.

## 10. Skills (setup + when-to-use)

Both key skills are in the **"already available — no install"** table, assigned specifically to W07 — official first-party Vercel vendor skills, exempt from the ≥1K-install bar per the skill-quality rule ("official vendor `vercel:*` preferred"). Still run `npx skills check` first (idempotent, confirms nothing drifted).

- **`vercel:auth`** — Clerk integration patterns (middleware, provider, server `auth()`). Guides **S4/S5** (route/middleware wiring) and the sign-in/up screens in **S3**.
- **`vercel-storage`** — Postgres/Neon provisioning + client setup. Guides **S1/S2** (schema + data-access helpers).
- **`context7-mcp`** (already available) — fallback for live Clerk/Drizzle/Next.js API docs during implementation whenever the vendor skill's cached guidance is ambiguous or version-specific; use for exact `clerkMiddleware()`/`auth()` signatures against the installed `@clerk/nextjs` version.
- **`ui-ux-pro-max:design-system`** / `frontend-design` (already available, W02-scoped) — guides **S3** so account screens match the phosphor/void identity rather than shipping ad-hoc styling.

No `npx skills add` needed for W07 — nothing on its list falls below the reputable-source or install-count bar, so there is no context7-only fallback required beyond the doc-lookup role above.
