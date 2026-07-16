# W03 — Registry browser + search

## 1. Summary

- **ID / Name:** W03 — Registry browser + search
- **Program / Surface:** Program 2 (Consumer Platform) — Web
- **Wave:** P1 (parallel with Program 1 Waves 1–2 — W03 has no F## dependency, only W01/W02/X07, so it is not gated by F18/F15/F03 the way W05/X01/X02 are)
- **Risk:** L
- **Gates flagged in catalog:** none (no Ar/Se/Lv block specific to this row) — standard G0–G2, G5, G7, G8 pipeline applies; see §6.

**What.** The searchable, filterable public catalog of community templates — the "npm-registry-for-websites" ledger called out in `07-platform-design/website-design.md`: one monospace row per template with a live verification badge (F03 nightly re-verify, mirrored via X07), run-count, category/tags, and a click-through to template detail (W04).

**Why (tied to the market angle in `00-vision.md`).** The vision's flywheel is "agents/devs contribute templates → instantly usable in web + app → consumers run/monitor them → coverage grows itself." W03 is the literal front door of that flywheel and the platform's first proof point: a first-time visitor typing their own vendor's name and seeing a *real, verified, already-working* template is the experiential demonstration of the core claim ("the ~99% of the web with no API now has one, crowd-supplied"). It is also the shared data surface M03 (mobile browse) depends on — get the contract right once here, reuse it there.

## 2. User / agent story

- **Visitor** lands on `/registry`, types "amazon" or picks category "e-commerce" → ledger narrows live, no full reload; sees name, verified badge + last-verified date, run count, one-line description, tags.
- **Returning user** flips "verified only", sorts by "most run", copies the URL to share the exact filtered view with a teammate.
- **Agent/dev** (future: exposing this same query as a public discovery endpoint, out of scope here) could hit the identical `/api/registry` contract to discover templates before calling X01 — the endpoint shape is written so that reuse is a non-event, not a redesign.
- Clicking any row navigates to `/templates/[id]` (W04), never runs anything itself — W03 is browse-only.

## 3. Design

**ADRs obeyed.**
- **ADR-06 (registry = cross-repo contract, hard dependency).** W03 imports `ManifestEntry`/`Manifest` **only** from the published `@neetigyashah/apimemcp` npm package and reads data **only** through X07's mirror — zero imports from engine `src/*`. This is the one contract-compliance fact G2/G7 check for this feature.
- **ADR-02 (tool-module convention) — not directly bound** (W03 registers no MCP tool; its table lists ADR-02 dependents as engine tool-adding features). W03's own Next.js Route Handler follows the same *spirit* (one thin, single-purpose handler that delegates to a typed function, no giant inline logic) but is not an ADR-02 contract obligation.

**Data shapes** (`apimemcp-platform/packages/shared/src/registry-types.ts`):

```ts
import type { ManifestEntry } from "@neetigyashah/apimemcp";

export interface RegistryListItem {
  id: string;                    // ManifestEntry key / templateId
  name: string;
  description: string;
  category: string;
  tags: string[];
  verified: boolean;             // F03 nightly badge, mirrored by X07
  lastVerifiedAt: string | null; // ISO 8601
  runCount: number;               // X07-aggregated usage
  outputSchemaPresent: boolean;   // ManifestEntry.outputSchema != null (ADR-01)
  source: ManifestEntry["source"];// contributor/repo link (already on ManifestEntry)
}

export interface RegistrySearchQuery {
  q?: string;
  category?: string;
  tag?: string;
  verifiedOnly?: boolean;
  sort?: "trending" | "most-run" | "recently-verified" | "az"; // default "trending"
  cursor?: string;
  limit?: number; // default 24, max 100
}

export interface RegistrySearchResult {
  items: RegistryListItem[];
  nextCursor: string | null;
  total: number;
}
```

Route-handler validation (`apps/web/app/api/registry/route.ts`), zod:

```ts
const RegistrySearchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  verifiedOnly: z.coerce.boolean().optional(),
  sort: z.enum(["trending", "most-run", "recently-verified", "az"]).default("trending"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
```

**Module-by-module changes** — all in the `apimemcp-platform` Turborepo (per W01's folder layout and `04-git-strategy.md`); **zero files under `D:/MCP/src`** (that's the engine repo; ADR-06 forbids reaching into it):

| Path | Role |
|---|---|
| `apimemcp-platform/packages/shared/src/registry-types.ts` | Shapes above — reused by W04, W08, M03. |
| `apimemcp-platform/packages/shared/src/registry-client.ts` | `searchRegistry(query: RegistrySearchQuery): Promise<RegistrySearchResult>` — calls X07's mirror (query fn or internal HTTP; transport is X07's call, W03 only codes to this signature). |
| `apimemcp-platform/apps/web/app/registry/page.tsx` | Server Component: reads `searchParams`, calls `searchRegistry`, renders `<RegistryLedger>`. **App screen: `GET /registry?q=&category=&tag=&verifiedOnly=&sort=&cursor=`.** |
| `apimemcp-platform/apps/web/app/registry/loading.tsx` | Streaming skeleton ledger rows. |
| `apimemcp-platform/apps/web/app/api/registry/route.ts` | Route Handler (Vercel Function). **Signature: `GET /api/registry` → validates via `RegistrySearchQuerySchema` → `searchRegistry(query)` → `RegistrySearchResult` JSON.** |
| `apimemcp-platform/apps/web/components/registry/registry-ledger.tsx` | The ledger table/list — monospace rows per `website-design.md`'s "structural device". |
| `apimemcp-platform/apps/web/components/registry/registry-row.tsx` | One row: name, badge, run-count, tags, description; click → `/templates/[id]`. |
| `apimemcp-platform/apps/web/components/registry/verification-badge.tsx` | Renders `verified`/`lastVerifiedAt` as a shields.io-style badge (data already computed by F03/X07 — this component only displays it). |
| `apimemcp-platform/apps/web/components/registry/registry-filters.tsx` | Client component: category/tag facets + verified-only toggle + sort select; writes to `searchParams` via `router.replace` (URL *is* the state). |
| `apimemcp-platform/apps/web/components/registry/registry-search-bar.tsx` | Debounced (~300ms, plain `useEffect`+`setTimeout`, no new dependency) search input. |

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `registry-types.ts` in `packages/shared`. |
| S2 Storage/API client | Applicable | `registry-client.ts::searchRegistry()` against X07. |
| S3 Screens/components | Applicable | `registry/page.tsx` + ledger/row/badge/filters/search-bar. |
| S4 Feature module | Applicable | `apps/web/app/registry/*` + `apps/web/components/registry/*` as one cohesive unit. |
| S5 Route/nav wiring | Applicable | `app/api/registry/route.ts` + one-line nav-link append (nav shell owned by W01/W08). |
| S6 Component tests | Applicable | Vitest + Testing Library, see §7. |
| S7 e2e/device | Applicable | Playwright e2e against a Vercel preview URL, see §7. |
| S8 Docs | Applicable | Short usage note in platform README pointing at this spec. |
| S9 Review | Applicable | G2 Code-Review (+ non-blocking Design-Lead spot-check, §6). |
| S10 Preview/device verify | Applicable | G6 preview-URL smoke, see §6/§8. |
| S11 Merge | Applicable | G7 Integration → platform `main`. |

No N/A rows — W03 is a complete, self-contained web feature (unlike some rows, nothing here reduces to "N/A, no engine/device surface").

## 5. Dependencies & sequencing

- **Hard deps (by ID):**
  - **W01** — Turborepo scaffold + Vercel project must exist (`apps/web`, `packages/shared`).
  - **W02** — cross-surface design tokens; the ledger's typography/colors and the badge's "verified" color must come from the phosphor-amber/void system, not a hand-rolled palette.
  - **X07** — registry mirror/cache DB. Without it, W03 would have to filter the full jsDelivr `manifest.json` client-side, which is the *engine's* `registry-client.ts` pattern (Program 1) and is exactly what ADR-06 forbids the platform from importing — X07's Postgres-backed search is the only ADR-06-compliant fast path.
- **Unblocks:** **W04** (template detail — needs a row/id to link into), **W08** (landing hero — the "compile → run" demo targets a real registry entry and can reuse `registry-client.ts`), **M03** (mobile browse — same X07 dependency, reuses `registry-types.ts`/`RegistrySearchQuery` shape verbatim rather than reforking it for RN).
- **Wave:** P1. Runs in parallel with Program 1 (no F## dependency), per the plan's "Program 2's P0 runs in parallel with Program 1 Waves 1–2" note — W03 specifically is P1, one step past the W01/W02/X07-spike P0 set.

## 6. Quality gates

Per the feature catalog, **no Ar/Se/Lv flag** is set on this row (contrast W02's `Ar(Design Lead)`, W07's `Se`, W05's `Lv`). Applicable gates:

- **G0 Spec** — this document, Architect+Orchestrator sign-off.
- **G1 Build** — `turbo build` clean, lint passes.
- **G2 Code-Review** — correctness + no reinvented registry-client logic + ADR-06 import check.
- **G3 Arch** — non-blocking for this row: no new module boundary or cross-repo contract change beyond *consuming* the already-locked ADR-06 contract; self-certified at G2 rather than a separate Architect block.
- **G3b Design** — non-blocking/advisory for this row (only W02 itself carries the blocking `Ar(Design Lead)` flag); Design Lead may spot-check ledger/badge visuals against the system it owns, but this is not a per-PR gate for W03.
- **G4 Security** — N/A: public, read-only, unauthenticated registry browse; no user data, no secrets, no cookies in scope.
- **G5 QA** — Vitest component suite green (§7).
- **G6 Live-Verify** — satisfied as **preview-URL smoke** (the web variant per `quality-gates.md`), not the engine's `scripts/verify-*.mjs`/Playwright-against-localhost convention — see §7.
- **G7 Integration** — rebased, all above green, merged to platform `main` in wave order.
- **G8 Promote+Deploy** — Vercel deploy of `apps/web` green; tracker `status/W03.json` updated.

**Definition of Done.** `/registry` renders a real ledger from X07 on a deployed preview URL; search filters rows without a full reload (only an `/api/registry` XHR fires); category/tag/verified-only filters combine and are reflected in `searchParams` (a copied URL reproduces the identical view); each row shows name, badge (verified/unverified + last-verified date), run count, description, tags; row click navigates to `/templates/[id]`; zero imports of engine `src/*` anywhere in the diff; Vitest + Playwright e2e green; `turbo build` clean.

## 7. Test plan

- `apps/web/components/registry/registry-row.test.tsx` — badge state rendering (verified/unverified), run-count formatting (1234 → "1.2K"), tag truncation/overflow.
- `apps/web/components/registry/registry-filters.test.tsx` — toggling verified-only / changing category or sort produces the correct `RegistrySearchQuery` and the correct `searchParams` mutation.
- `packages/shared/src/registry-client.test.ts` — `searchRegistry()` builds the correct query string, parses a `RegistrySearchResult`, handles an empty result set, and surfaces a typed error (not an unhandled throw) when X07 is unreachable.
- `apps/web/app/api/registry/route.test.ts` — `RegistrySearchQuerySchema` rejects an out-of-range `limit`/invalid `sort`; a valid query round-trips into `searchRegistry`.
- **Live verify (web substitute for `scripts/verify-*.mjs`):** `apps/web/e2e/registry.spec.ts` (Playwright, run against the Vercel preview deployment per G6's "preview-URL smoke" definition — the engine-only `scripts/verify-<id>.mjs` convention does not apply to a Program 2/web feature). Scenarios: type a query → ledger narrows; toggle verified-only → non-verified rows disappear; click a row → lands on `/templates/<id>`.
- **Fixture:** `apps/web/e2e/fixtures/registry-search-fixture.json` — ~5 deterministic `RegistryListItem`s (mixed verified/unverified, distinct categories) served via a route mock in e2e mode so the spec isn't flaky against the live, changing registry contents.

## 8. Acceptance criteria (live, observable proof)

1. The deployed preview's `/registry` shows real rows sourced from the current `apimemcp-templates` manifest (not mock data in prod).
2. Typing "amazon" narrows the ledger within the debounce window with no full page reload — DevTools Network tab shows only an `/api/registry` request.
3. Toggling "verified only" removes every row whose badge is not green/verified.
4. Copying the post-filter URL into a new tab reproduces the identical filtered view (state lives in `searchParams`, server-readable).
5. Clicking a row navigates to `/templates/<that-id>`.
6. `grep -rn "apimemcp/src" apimemcp-platform/apps apimemcp-platform/packages` returns zero matches — live proof of ADR-06 compliance.

## 9. Reuse notes

- Reuse `ManifestEntry`/`Manifest` from the **published** `@neetigyashah/apimemcp` package — do not redeclare the template shape from scratch.
- Reuse X07's search/query contract; do **not** port the engine's `registry-client.ts` (jsDelivr full-manifest fetch) into the platform — that is the Program-1-only pattern ADR-06 exists to keep out of Program 2.
- Reuse W02's design tokens/components (typography, phosphor/void palette, badge colors) for the ledger — do not hand-roll a second color system.
- Reuse W01's `packages/shared` location for `registry-types.ts`/`registry-client.ts` specifically so M03 can import the same shapes rather than redefining `RegistryListItem` for React Native.
- The verification badge is a pure *display* of F03's nightly-verify result as mirrored by X07 — W03 performs no verification computation of its own.

## 10. Skills (setup + when-to-use)

`npx skills check` first — every skill below is already-global in this environment (08-skills-matrix.md's "Already available… no install" table), so this feature needs no `npx skills add` call, only confirmation of presence:

- **`vercel:nextjs`, `vercel:shadcn`, `vercel:react-best-practices`** — official Vercel-authored skills (source: vercel, reputable-vendor tier). Guides **S3** (App Router `page.tsx`/`loading.tsx`, shadcn `Table`/`Badge`/`Command`/`Input` primitives for the ledger and filters) and **S4** (feature-module structure/conventions).
- **`frontend-design`, `ui-ux-pro-max:design-system`, `ui-ux-pro-max:ui-styling`** — guides **S3** styling fidelity to the phosphor/void identity and W02's tokens, and **S9** (review-time visual-consistency check).
- **`context7-mcp`** — live official Next.js App Router / shadcn docs fallback for current API syntax (e.g. typed `searchParams` in Server Components, shadcn data-table/command patterns) instead of relying on training-data recall. Guides **S2**/**S3** whenever an exact current signature is needed.
- No external skills.sh package is required beyond the always-available set above — W03 is straightforward Next.js+shadcn work fully covered by it, unlike M01–M07/X03 which pull dedicated ≥1K-install packages (`expo-react-native-typescript`, `bullmq-specialist`).
