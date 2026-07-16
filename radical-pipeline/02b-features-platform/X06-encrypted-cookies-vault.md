# X06 — Encrypted cookies + vault

## 1. Summary

- **ID/Name:** X06 · Encrypted cookies + vault
- **Surface/Pillar:** Cloud (Program 2)
- **Wave:** P2
- **Risk:** H
- **Gates (catalog):** **Se (blocks)** — Security-Reviewer required; no Ar/Lv flag
- **Deps:** F13 (engine vault), ADR-05

**What.** Two things, one boundary (ADR-05): (a) **encrypted cookie transit** — a `cookieString` posted to the X01 run gateway is encrypted the instant it lands, never sits in plaintext in a queue/log, and is zero-persist by default (X04); (b) an **optional, opt-in, per-user cloud vault** — if a user chooses to, their cookie is stored encrypted-at-rest, keyed by `userId`, so recurring runs (especially X05 monitors) don't require re-pasting a cookie every time.

**Why (00-vision tie-in).** 00-vision's target markets (RPA replacement, financial aggregation, healthcare payer portals, gov/civic data, competitive intel) are overwhelmingly **login-walled**. Without X06, the phone-first cloud track can only ever run anonymous public-page templates — the entire "everyone from a phone" promise collapses to the fraction of the web that needs no login. X06 is also the precondition for the single feature 00-vision names as **the consumer wedge**: X05 monitors ("price drop", "restock", "new filing") only work on authenticated targets (a bank portal balance, a supplier's private catalog) if a session can survive across scheduled runs without a human re-pasting a cookie each time.

## 2. User/agent story

- *Mobile user:* "I paste my retailer-account cookie once, tap 'remember this', and my nightly restock monitor keeps working without me touching the app again — and I trust the platform can't read my session outside my own runs."
- *Cloud gateway (agent-facing):* "A client hands me a raw cookie for one run. I encrypt it before it touches any durable store or log line, use it once, and discard it — unless the caller explicitly opted into the vault."

## 3. Design

**Repo boundary (ADR-06 — read this before touching anything).** X06 is Program 2 code. The platform repo (`apimemcp-platform`, new Turborepo, not yet created) may import **only published `@neetigyashah/apimemcp` npm types** — never engine internals. So X06 does **not** add code to `D:/MCP/src`; it *depends on* two existing/planned exports there and *mirrors* their shape on the cloud side. Anyone implementing X06 should resist the urge to import `src/vault.ts` directly — that's the exact mistake ADR-05/06 exist to prevent.

**Engine-repo touchpoints (owned by F13, not modified by X06):**
- `D:/MCP/src/types.ts` — must export the `VaultEntry` shape / `vaultKeyId` format (F13's job). X06 is blocked on this export existing (see §5).
- `D:/MCP/src/vault.ts` — F13's local encrypted-at-rest store. X06 references only its **key-id format convention**, per ADR-05 "MAY reference" rule — never its code.

**Platform-repo files (new, under the future `apimemcp-platform/`):**

```
apimemcp-platform/packages/shared/src/vault/types.ts        # CloudVaultEntry, CookieTransitPayload
apimemcp-platform/packages/shared/src/vault/crypto.ts       # encryptCookie/decryptCookie (Node stdlib crypto)
apimemcp-platform/apps/web/app/api/vault/cookies/route.ts           # POST save, GET list
apimemcp-platform/apps/web/app/api/vault/cookies/[vaultKeyId]/route.ts  # DELETE
apimemcp-platform/apps/web/lib/vault-resolve.ts             # resolveVaultCookie(), called mid-job by X02/X03
apimemcp-platform/apps/web/app/api/run/route.ts             # X01's route — MODIFIED to encrypt on receipt
apimemcp-platform/apps/web/db/schema/vault.ts               # Drizzle/SQL schema for cloud_vault_entries
```

**Data shapes:**

```ts
// packages/shared/src/vault/types.ts
import type { VaultEntry } from '@neetigyashah/apimemcp'; // ADR-06: published type only

export interface CloudVaultEntry extends Pick<VaultEntry, 'vaultKeyId'> {
  userId: string;         // Clerk user id — the only valid partition key, never client-supplied
  templateId?: string;    // optional: scope a saved cookie to one template
  label: string;
  ciphertext: string;     // base64 AES-256-GCM
  iv: string;              // base64, unique per encryption
  authTag: string;         // base64 GCM auth tag
  keyId: string;           // which server KEK version encrypted this (rotation)
  createdAt: string;
  updatedAt: string;
}

export interface CookieTransitPayload {
  ciphertext: string; iv: string; authTag: string; keyId: string;
}
```

```ts
// packages/shared/src/vault/crypto.ts — Node stdlib `crypto`, no new dependency
export function encryptCookie(plaintext: string, kek: Buffer): CookieTransitPayload;
export function decryptCookie(payload: CookieTransitPayload, kek: Buffer): string; // throws on tamper (GCM auth)
```

**Route signatures** (Next.js App Router route handlers — the platform-repo analogue of ADR-02's `registerXxxTool(server, deps)`; same DI shape, different framework, so handlers stay unit-testable without booting Next):

```ts
// apps/web/app/api/vault/cookies/route.ts
export const POST = createVaultHandler(saveCookie);   // body: {templateId?, label, cookieString} -> {vaultKeyId}
export const GET  = createVaultHandler(listCookies);  // -> {vaultKeyId,label,templateId,createdAt,updatedAt}[] — NEVER ciphertext/iv/authTag

// apps/web/app/api/vault/cookies/[vaultKeyId]/route.ts
export const DELETE = createVaultHandler(deleteCookie); // scoped to session userId; foreign vaultKeyId -> 404
```

```ts
// apps/web/lib/vault-resolve.ts — internal only, called from X02/X03 job execution, never exposed as a route
export async function resolveVaultCookie(userId: string, vaultKeyId: string): Promise<string | null>;
```

**Transit-encryption flow (X01 integration):** `POST /api/run {templateId, targetUrl?, cookieString?, vaultKeyId?}` → if `cookieString` present, `encryptCookie()` runs **before** the payload is handed to X03's durable Workflow queue — the plaintext never reaches a log line or a durable record. Decryption happens once, in-memory, inside the X02 sandbox process right before the Playwright/HTTP context is seeded; the decrypted value is never written back to any store. If `vaultKeyId` is present instead, `resolveVaultCookie()` performs the same in-memory decrypt from the vault row.

**Key management (ponytail-simple, upgrade path noted):** single server-side KEK from a Vercel env var (`VAULT_KEK`), AES-256-GCM directly on the cookie string. `// ponytail: one static KEK, no per-user DEK/KMS envelope yet — upgrade to envelope encryption (per-user DEK wrapped by KEK) if/when key-rotation-without-full-re-encrypt becomes a real requirement.`

**Per-user isolation (ADR-05 contract rule, G4 DoD):** every vault query filters by `userId` taken from the authenticated Clerk session — never a client-supplied field. No code path ever copies a vault ciphertext into an app-connections-equivalent store or vice versa (there is no app-connections analogue in the cloud; X06 is the only session-credential store there).

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `CloudVaultEntry`, `CookieTransitPayload` in `packages/shared/src/vault/types.ts`, extending published `VaultEntry`. |
| S2 Storage | Applicable | `cloud_vault_entries` Postgres table (Vercel Storage/Neon) — see §3 schema file. |
| S3 Core | Applicable | `crypto.ts` encrypt/decrypt + `vault-resolve.ts`. |
| S4 Module | Applicable | `packages/shared/src/vault/` boundary — shared by web + mobile (M06) + the run route. |
| S5 Wiring | Applicable | Vault routes + X01's `/api/run` modified to encrypt on receipt. |
| S6 Unit tests | Applicable | Crypto round-trip, tamper detection, isolation-by-user (§7). |
| S7 Verify | Applicable (adapted) | No browser involved — `scripts/verify-X06-vault.mjs` hits the route handlers over real HTTP against a test DB, not Playwright. |
| S8 Docs | Applicable | API reference section (routes + security posture) in platform docs. |
| S9 Review | Applicable | G2 Code-Review + G4 Security (blocking). |
| S10 Live/device verify | **N/A** | Catalog Gates cell = `Se` only, no `Lv` flag → G6 not required for this feature; G4 Security substitutes as the blocking gate. |
| S11 Merge | Applicable | G7 into `apimemcp-platform`'s `integration`, after W01/X01/W07/F13 per §5. |

## 5. Dependencies & sequencing

- **Hard deps:** **F13** (engine vault — X06 mirrors its `vaultKeyId` format; if F13 isn't green yet, X06 codes against ADR-05's frozen surface, per the git-strategy fallback). **ADR-05** (Accepted/locked — this spec implements its cloud half).
- **Soft/infra deps (must exist first, one wave earlier per catalog):** **W01** (Turborepo scaffold — `packages/shared`, `apps/web`), **W07** (Clerk auth — supplies `userId`), **X07**/Vercel Storage (Postgres available), **X01** (the `/api/run` route X06 modifies).
- **Unblocks:** **X05** (Monitors — recurring runs on authenticated templates are only viable with a vault entry instead of a re-pasted cookie every cron tick). **M06** (mobile run history + device-encrypted cookies — depends directly on X06 per catalog).
- **Wave:** P2.

## 6. Quality gates

| Gate | Applies? | Note |
|---|---|---|
| G0 Spec | Yes | Architect + Security-Reviewer sign-off (ADR-05's own deciders list). |
| G1 Build | Yes | Turborepo build + lint green. |
| G2 Code-Review | Yes | No reinvented crypto (stdlib `crypto` only); minimal diff; ADR-06 import boundary respected. |
| G3 Arch | Not flagged | Catalog shows no `Ar` flag for X06; ADR-06 compliance is instead checked as part of G0/G2 since this spec's own boundary IS the ADR-06 test case. |
| G3b Design | N/A | No UI screen — backend/API only; consuming screens (W07/M06) own their own G3b. |
| G4 Security | **Yes — blocking** | No plaintext cookie ever logged/persisted outside the ciphertext column; per-user isolation enforced at the query layer; zero-persist-by-default holds absent opt-in. |
| G5 QA | Yes | Unit suite green (crypto + isolation tests). |
| G6 Live/Device-Verify | Not flagged | No `Lv` in catalog Gates cell — no browser/device surface to verify. |
| G7 Integration | Yes | Merged to `apimemcp-platform` `integration`, ordered after its deps. |
| G8 Promote+Deploy | Yes | Vercel preview green; `VAULT_KEK` present in Vercel project env (Deployment Agent owner step). |

**Definition of Done:** save → list (metadata-only) → run-with-vaultKeyId → delete all work end-to-end; a grep of the raw DB row and of request logs for a known test-cookie value returns zero plaintext matches; a cross-user isolation test proves user A cannot list, resolve, or delete user B's vault entry.

## 7. Test plan

- `packages/shared/src/vault/crypto.test.ts` — encrypt→decrypt round-trips to the original string; a flipped byte in `ciphertext` or `authTag` throws (GCM auth failure); two calls on the same plaintext never reuse an `iv`.
- `apps/web/app/api/vault/cookies/route.test.ts` — POST creates a row scoped to the session `userId`; GET response JSON asserted to **not** contain `ciphertext`/`iv`/`authTag` keys at all (not just redacted — absent).
- `apps/web/app/api/vault/cookies/[vaultKeyId]/route.test.ts` — DELETE on another user's `vaultKeyId` returns 404 and leaves the row intact.
- Isolation test — seed two fake users' rows; `resolveVaultCookie(userA, userB'sVaultKeyId)` returns `null`, never the secret.
- `apimemcp-platform/scripts/verify-X06-vault.mjs` — live smoke script (fixture: throwaway test user + fake cookie string, no real templates/network) exercising save→list→resolve→delete over real HTTP against a test DB; the one runnable check for the route wiring that unit tests, which mock the DB, would miss.

## 8. Acceptance criteria

- `POST /api/vault/cookies {label:"test", cookieString:"sid=abc123"}` as an authenticated test user → the Postgres row's `ciphertext` column is provably not `"sid=abc123"` and not substring-matchable to it.
- `GET /api/vault/cookies` for that user → `[{vaultKeyId, label:"test", templateId, createdAt, updatedAt}]`, no ciphertext-family fields present.
- `POST /api/run {templateId, vaultKeyId}` succeeds, the template's own result shows the session was authenticated (e.g. a "logged in as X" field), and grepping that request's server logs for `"sid=abc123"` returns zero matches.
- A second test user's `DELETE /api/vault/cookies/:vaultKeyId` against the first user's entry returns 404; the row is unchanged.

## 9. Reuse notes

- Node's built-in `crypto` (`createCipheriv('aes-256-gcm', …)`) — stdlib, no new dependency; the same primitive family F13's `src/vault.ts` uses at rest engine-side, keeping the two vaults conceptually consistent though physically separate stores (ADR-05).
- Reuse F13's `vaultKeyId` format (`D:/MCP/src/vault.ts` + `src/types.ts`) via the published npm types — do not invent a second key-id scheme.
- Reuse Clerk session (`vercel:auth`, wired by W07) for `userId` — never accept a client-supplied user id, ever.
- Reuse the existing self-host `save_template_cookies` MCP-tool UX ("paste a cookie string, we store it") as the product-shape precedent for the vault's save flow — same mental model, different store, different threat model.
- Reuse `packages/shared` (scaffolded by W01) for the vault type/crypto module rather than duplicating it per-app — M06 needs `CloudVaultEntry`'s type too.
- Do **not** reuse `atomicWriteFile`/`withLock` (engine-repo local-file concurrency helpers) — X06's store is Postgres; a unique constraint on `(userId, vaultKeyId)` handles concurrency, not file locking.

## 10. Skills (setup + when-to-use)

- **`security-and-hardening`** (one of the 24 `.agents/skills/`, already installed — no setup step). Guides S3 (crypto core: AES-GCM correctness, key handling) and the G4 gate's DoD (no leakage, per-user isolation, envelope-encryption tradeoffs).
- **`vercel:vercel-storage`** (official Vercel skill, already available per the skills matrix — same skill X07/W07/M01 use). Guides S2 (Postgres schema/migration for `cloud_vault_entries`) and S5 (Vercel env-var wiring for `VAULT_KEK`).
- **`context7-mcp`** — fallback for live Node `crypto` (AES-256-GCM) API details and Next.js Route Handler signatures during build. No ≥1K-install reputable skill exists specifically for a cookie/crypto vault, so per the skill-quality bar this is the documented fallback, not a gap.
- Setup: `npx skills check` first — both named skills are global and very likely already installed by the W01/F13/W07 builders; install only what's missing with `npx skills add <pkg> -g -y`.
