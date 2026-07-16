# M03 — Browse/registry screens

## 1. Summary

- **ID:** M03 · **Name:** Browse/registry screens · **Surface:** Mobile (Program 2 uses *Surface* — Web/Cloud/Mobile — not Program 1's Pillar taxonomy) · **Wave:** P2 · **Risk:** L
- **What:** The two screens that let a phone user discover the community template registry: a searchable/filterable **Browse list** (query, category, trending/newest/verified-first sort, verification badge, run-count) and a read-only **Template Detail** screen (schema summary, badges, description, a "Run" CTA that hands off to M04).
- **Why (tied to 00-vision):** 00-vision's flywheel is "agents/devs contribute templates → instantly usable in web + app → consumers run/monitor them → usage signals which matter → more contribution." M03 is the mobile half of the *discovery* step in that flywheel — the on-ramp that turns a growing, crowd-supplied registry (RPA replacement, financial data, gov/civic data, healthcare portals, etc. — 00-vision's target markets) into something a non-developer can find and tap, phone-first, with zero code. Without a working Browse, the registry's coverage growth never reaches "everyone."

## 2. User story

As a phone user (not a developer), I open the app, land on the **Browse** tab, type "restaurant availability" or tap a category chip, and see a list of community templates that match — each row showing its verification badge (F03 nightly re-verify) and run-count so I can judge trust/popularity at a glance. I tap **Trending** to see what's hot. I tap a row to see its **Template Detail** (what it returns, when it was last verified) and then tap **Run** to hand off to M04. This is a human-facing discovery screen, not an agent-facing API — there is no MCP tool here.

## 3. Design

### ADRs obeyed

- **ADR-06 (Registry = cross-repo contract) — primary.** M03 is Program 2, so its *only* allowed data sources are (a) the published `@neetigyashah/apimemcp` types and (b) X07's registry-mirror HTTP API. It must **never** import `D:/MCP/src/*` engine internals. The canonical `ManifestEntry`/`Manifest` shape (and the `outputSchema`/`waitStrategy`/`readySelector`/`source` fields ADR-06 calls out as the additive-optional precedent) lives in `D:/MCP/src/types.ts` and is served over jsDelivr by `D:/MCP/src/registry-client.ts` — M03 references those paths only as the *origin* of the type, consumed here via the npm package's `.d.ts`.
- **ADR-01 (Schema contract) — secondary.** `ManifestEntry.outputSchema?` (when present) drives the "has a documented output shape" affordance on Template Detail. M03 only reads the flag (`hasSchema`); it does not call `validateOutput`.
- **ADR-02 (Tool-module convention) — N/A.** M03 registers no MCP tool and defines no new HTTP route. The registry-mirror route (`GET /api/registry`) is X07's to own; M03 is purely a client of it. The "screen signature" analog of ADR-02 for this repo is: one screen = one file under `src/features/browse/`, thin Expo Router route files that just mount it (see below).

### Data shapes (client-side, `packages/shared/src/registry-types.ts`)

```ts
// Narrowed re-export of the published @neetigyashah/apimemcp types (ADR-06).
// Canonical source: D:/MCP/src/types.ts (shape) + D:/MCP/src/registry-client.ts (fetch/cache
// of manifest.json from https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/registry).
// Never import those files directly from apps/mobile — import from '@neetigyashah/apimemcp' only.
export interface ManifestEntry {
  templateId: string;                 // ^[a-z0-9]+(-[a-z0-9]+)*$
  domainPattern: string;
  fixedTargetUrl?: string;
  readySelector?: string;
  waitStrategy?: 'domcontentloaded' | 'load' | 'networkidle';
  outputSchema?: Record<string, unknown>;   // JSON Schema — ADR-01
  source?: 'community' | 'official';
  description?: string;
  category?: string;
}
export type Manifest = Record<string, ManifestEntry>;

// Browse-facing view-model. X07 owns the exact wire shape of its mirror API response;
// M03 maps whatever X07 returns into this local type so screen/component code never
// touches a raw ManifestEntry or reaches into engine internals.
export interface BrowseListItem {
  templateId: string;
  title: string;              // description ?? templateId
  category?: string;
  domainPattern: string;
  verified: boolean;          // F03 nightly-verify status, mirrored by X07
  lastVerifiedAt?: string;    // ISO date
  runCount: number;           // ADR-04 metric, aggregated by X07
  hasSchema: boolean;         // !!outputSchema
}

export interface BrowseFilters {
  q?: string;
  category?: string;
  sort: 'trending' | 'newest' | 'verifiedFirst';
  cursor?: string;
}
```

### Module-by-module changes (all in the **new** `apimemcp-platform` Turborepo — 04-git-strategy.md; nothing under `D:/MCP/src` changes for this feature)

| File | Change |
|---|---|
| `apimemcp-platform/packages/shared/src/registry-types.ts` | New. `ManifestEntry`/`Manifest`/`BrowseListItem`/`BrowseFilters` above. |
| `apimemcp-platform/packages/shared/src/__fixtures__/manifest.sample.json` | New. 6-8 representative `BrowseListItem` rows (mixed verified/unverified, with/without `outputSchema`, varying `runCount`) for tests + local dev. |
| `apimemcp-platform/apps/mobile/src/features/browse/registry-queries.ts` | New. `useBrowseTemplates(filters: BrowseFilters)` — React Query `useInfiniteQuery` over `GET {API_BASE}/api/registry?q=&category=&sort=&cursor=` (X07's route), returns `{items: BrowseListItem[], nextCursor?}`. `useTemplateDetail(templateId: string)` — `useQuery` for one item incl. `outputSchema`. Both cache-first per mobile-app-design.md's "cache catalog / offline" note. |
| `apimemcp-platform/apps/mobile/src/features/browse/BrowseScreen.tsx` | New. `BrowseScreen(): JSX.Element` — `FilterBar` + virtualized list (`FlashList`, not `FlatList` — perf skill below) of `TemplateCard`, empty/error/offline states, pull-to-refresh. |
| `apimemcp-platform/apps/mobile/src/features/browse/TemplateDetailScreen.tsx` | New. `TemplateDetailScreen({ templateId }: { templateId: string }): JSX.Element` — badge, category, `hasSchema` summary block, description, "Run" CTA navigating to M04's run route with `templateId`. |
| `apimemcp-platform/apps/mobile/src/components/browse/TemplateCard.tsx` | New. `TemplateCard({ item, onPress }: { item: BrowseListItem; onPress: (id: string) => void }): JSX.Element`. Built from M02's themed `Card`/`Badge`/`Chip` primitives — no new base components. |
| `apimemcp-platform/apps/mobile/src/components/browse/FilterBar.tsx` | New. `FilterBar({ filters, onChange }: { filters: BrowseFilters; onChange: (f: BrowseFilters) => void }): JSX.Element` — search input (debounced), category chips, trending/newest/verified segmented control. |
| `apimemcp-platform/apps/mobile/app/(tabs)/browse/index.tsx` | New. Thin Expo Router route: `export default () => <BrowseScreen />`. |
| `apimemcp-platform/apps/mobile/app/(tabs)/browse/[templateId].tsx` | New. Thin route: reads `useLocalSearchParams<{templateId: string}>()`, renders `<TemplateDetailScreen templateId={templateId!} />`. |

### App-screen "signature" (the ADR-02 analog for this repo)

- Route `app/(tabs)/browse/index.tsx` → mounts `BrowseScreen()` (no params).
- Route `app/(tabs)/browse/[templateId].tsx` → mounts `TemplateDetailScreen({ templateId: string })`.
- Consumed HTTP route (owned by X07, not defined here): `GET /api/registry?q=&category=&sort=trending|newest|verifiedFirst&cursor=` → `{ items: BrowseListItem[], nextCursor?: string }`.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `registry-types.ts` (§3) + sample fixture. |
| S2 Storage/API client | Applicable | `registry-queries.ts` (React Query hooks against X07's route). |
| S3 Screens/components | Applicable | `BrowseScreen`, `TemplateDetailScreen`, `TemplateCard`, `FilterBar`. |
| S4 Feature module | Applicable | `src/features/browse/` as the self-contained module. |
| S5 Route/nav wiring | Applicable | Two Expo Router files under `app/(tabs)/browse/`. |
| S6 Component tests | Applicable | RNTL tests for hooks + the two components (§7). |
| S7 e2e/device | Applicable, light-weight | No G6 flag for M03 (catalog Gates = "—"); one manual Expo Go / simulator smoke pass, no Detox/Maestro suite required. |
| S8 Docs | Applicable | Short section in platform repo README/`apps/mobile/README.md` describing the Browse module and its query params. |
| S9 Review (G2) | Applicable | Code-Reviewer pass — confirms M02 component reuse, no raw `ManifestEntry` leaking past the mapping boundary. |
| S10 Device/preview verify | N/A | Catalog Gates column is "—" (no `Lv(device)` flag, unlike M04/M05) — folded into the light S7 pass instead of a blocking gate. |
| S11 Merge (G7) | Applicable | Merge to `apimemcp-platform` `main` via Integration, rebased. |

## 5. Dependencies & sequencing

- **Hard deps:** `M02` (mobile design-system impl — `Card`/`Badge`/`Chip`/`SearchInput`/`EmptyState` primitives must exist before `TemplateCard`/`FilterBar` can be built without inventing new base components) and `X07` (registry mirror/cache DB — M03's only data source; M03 cannot start real integration until X07's `/api/registry` route is live, though UI can be built against the fixture in parallel).
- **Unblocks:** `M04` (Run screen + result views) — its entry point is the "Run" CTA on M03's Template Detail screen, passing `templateId`.
- **Wave:** P2, alongside W03/W04 (the web equivalents), X03/X04/X06. Program 2's P0/P1 (`W01`,`W02`,`M01`,`M02`,`X07`) must land first per PLAN.md's Program-2 sequencing note.

## 6. Quality gates

Gates flagged for M03 in the catalog: **none** (`Gates: —`) — i.e. only the standard, always-on pipeline applies; the conditional gates (G3 Arch, G3b Design, G4 Security, G6 Live/Device-Verify) are not specially flagged for this feature.

- **G0 Spec** — Architect **+ Design Lead** (M03 is UI, so Design Lead co-signs G0 per quality-gates.md even though G3b isn't separately flagged post-build) **+ Orchestrator.**
- **G1 Build** — Mobile Builder/CI: typecheck, lint, RN/Expo build clean.
- **G2 Code-Review** — Correctness vs. this spec; confirms M02 primitives are reused (not re-implemented) and the `ManifestEntry → BrowseListItem` mapping boundary is respected.
- **G3 Arch** — N/A. No new shared-type change, no engine-internal import, no module-boundary risk.
- **G3b Design** — Not separately blocking per catalog; folded into G0/G2 (tokens/components already locked at M02).
- **G4 Security** — N/A. Read-only registry browse; no cookies, secrets, or code execution touched.
- **G5 QA** — Component tests (§7) green on a rebased branch.
- **G6 Live/Device-Verify** — N/A per catalog flag; optional light Expo Go smoke (S7) recommended, not blocking.
- **G7 Integration** — Rebased onto `apimemcp-platform main`, merged in Program-2 P2 order.
- **G8 Promote** — Included in the next Mobile EAS build/OTA update at the wave promote.

**Definition of Done:** Browse tab shows a searchable, filterable, sortable (trending/newest/verified-first) list of `BrowseListItem`s sourced only from X07's API/published types; each row shows verification badge + run-count; tapping a row opens Template Detail with description/category/schema-presence/badge and a working "Run" CTA that navigates to M04 with the correct `templateId`; empty, error, and offline (last-cached list) states are all handled — not blank screens; no import of any `D:/MCP/src/*` engine module anywhere in the diff; component tests green; G2-reviewed; merged.

## 7. Test plan

- `apimemcp-platform/apps/mobile/src/features/browse/registry-queries.test.ts` — maps a mocked X07 response into `BrowseListItem[]`; handles empty result set; handles fetch error (returns cached data, not a throw); cursor pagination appends correctly.
- `apimemcp-platform/apps/mobile/src/components/browse/TemplateCard.test.tsx` — shows the verified badge only when `verified === true`; renders `runCount`; renders category chip when present, omits it when absent.
- `apimemcp-platform/apps/mobile/src/components/browse/FilterBar.test.tsx` — search input debounces and calls `onChange` with `{q}`; category chip tap calls `onChange` with `{category}`; sort control cycles trending → newest → verifiedFirst.
- `apimemcp-platform/apps/mobile/src/features/browse/BrowseScreen.test.tsx` — renders a list from a mocked hook; tapping a card fires navigation with the tapped item's `templateId`; empty-state and offline-cached-state render correctly.
- No `scripts/verify-M03.mjs` — that pattern is engine-only (real Playwright against a live site). Mobile's equivalent is the light S7 manual Expo Go/simulator pass; no Detox/Maestro e2e file is required given the "—" gate flag (add one later only if M03 gets promoted to a `Lv(device)` feature).
- Fixture: `apimemcp-platform/packages/shared/src/__fixtures__/manifest.sample.json` (6-8 rows, mixed verified/unverified/with-and-without-schema) backs all of the above plus local dev without hitting X07.

## 8. Acceptance criteria (live, observable proof)

Run the mobile app in Expo Go or an iOS/Android simulator against a real (or staged) X07 endpoint: open the **Browse** tab; type a query matching a real entry in the `apimemcp-templates` registry and see it appear with its actual current verification badge state and run-count; toggle **Trending** and see the order change; tap through to **Template Detail** and see the correct category/description/schema-presence/badge; tap **Run** and land on M04 with the right `templateId`; enable airplane mode and reopen the tab — the last-fetched list still renders (not a blank/error screen).

## 9. Reuse notes

- **`ManifestEntry`/`Manifest` + jsDelivr fetch/cache logic** — `D:/MCP/src/types.ts` + `D:/MCP/src/registry-client.ts`. Reference only; consume via the npm-published types + X07's mirror API (ADR-06), never by importing these files.
- **M02's themed primitives** (`Card`, `Badge`, `Chip`, `SearchInput`, `EmptyState`) — build `TemplateCard`/`FilterBar` from these; do not hand-roll new base components.
- **X07's registry-mirror query/sort/pagination** — let X07 do search/category/sort server-side; M03 does not reimplement client-side filtering logic beyond passing `BrowseFilters` through.
- **M01's Expo Router shell + Clerk auth context** — Browse slots into the existing tab layout; no new navigation shell.
- **F03 verification-badge semantics / ADR-04 metrics** — `verified`/`lastVerifiedAt`/`runCount` are mirrored, not recomputed; don't invent a new trust or popularity model here.

## 10. Skills (setup + when-to-use)

- **`mindrally/skills@expo-react-native-typescript`** — 1.6K installs (PLAN.md's vetted Program-2 table). `npx skills add mindrally/skills@expo-react-native-typescript -g -y`. Guides S1 (shared types), S3 (screens/components), S4 (feature module), S5 (Expo Router wiring).
- **`pproenca/dot-skills@expo-react-native-performance`** — 1K installs. `npx skills add pproenca/dot-skills@expo-react-native-performance -g -y`. Guides S3 specifically for the searchable/filterable list (virtualized `FlashList`, avoiding re-render thrash on every keystroke/filter change).
- **`frontend-design`, `ui-ux-pro-max:ui-styling`** — already available, no install. Guides S3/G0 consistency with M02's design-system tokens.
- **`context7-mcp`** — fallback for live Expo Router / React Query API specifics encountered during S2/S5 build (per PLAN.md: "Live docs for Next/Expo/Playwright/Clerk during build"). No dedicated ≥1K-install "registry browse UI" skill exists, and none is needed — this is standard list/search/filter UI covered by the two skills above plus the design system.
- Run `npx skills check` first each session — a skill installed for an earlier Program-2 feature (e.g. by the M01/M02 builder) is already available; only install what's missing.
