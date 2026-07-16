# X07 — Registry mirror/cache DB

## 1. Summary

- **ID:** X07 · **Name:** Registry mirror/cache DB · **Surface:** Cloud · **Wave:** P1 (catalog) · **Risk:** L
- **What:** A Postgres-backed read cache of the `apimemcp-templates` community registry manifest, kept in sync on a schedule, fronted by two public read routes (`search`, `get-by-id`) and one secret-gated write route (`sync`). It exists so the web registry browser (W03), template detail (W04), and mobile browse screens (M03) get sub-second, filterable/searchable catalog reads instead of each client fetching + parsing the whole `manifest.json` from jsDelivr on every visit.
- **Why (market angle, `00-vision.md`):** the vision's flywheel is "agents/devs contribute templates → **instantly usable** in web + app → consumers run/monitor them." "Instantly usable" is a UX promise the raw jsDelivr fetch can't keep at mobile scale (cold JSON parse of a growing manifest on a phone network, on every tap). X07 is the substrate that makes the registry feel like a live catalog, not a git file — the same role a package registry's search index plays for a package manifest. It is pure plumbing (Risk=L, no user secrets, no execution) but it gates the "phone-first, everyone" consumer pillar: without it, W03/M03 have no fast catalog to browse.
- **Sequencing note:** the catalog row lists Wave=**P1**, but PLAN.md's cross-program sequencing prose groups X07 into the **P0** batch ("Program 2's P0 (W01, W02, X07, X02-spike) runs in parallel with Program 1 Waves 1-2") because its only Dep is `registry` — a git repo served over jsDelivr that already exists and already works today (`src/registry-client.ts` proves the fetch is live). Read this as: X07 has no hard engine-feature blocker and **can start the moment W01's monorepo scaffold exists**, it does not need to wait for the rest of P1.

## 2. User/agent story

- As a **mobile user** on M03 (Browse/registry screens), I type "restock" or filter by category "e-commerce" and get results in well under a second, with a live verification badge per row — not a multi-hundred-KB JSON fetch-and-parse on my connection.
- As a **web visitor** on W03 (registry browser), I filter/search the same catalog; W04's template detail page reads one row by id instead of re-parsing the whole manifest.
- As the **platform's cron**, I want registry PRs that merge into `apimemcp-templates` (gated by F03 verify + F19 lint, per `04-git-strategy.md`) to show up in the app within one sync cycle, with zero manual redeploy.
- As **X01** (execution API gateway), I can optionally look up a `templateId`'s `outputSchema`/existence from the mirror before dispatching a run — cheaper than parsing the full manifest per request (soft dependency; X01's own Deps row lists only F18, so this is an optimization X01 may adopt, not a hard coupling).

## 3. Design

**Repo placement (per ADR-06 + git-strategy).** X07 is **100% a platform-repo feature** — it lives in `apimemcp-platform` (the new Turborepo), not `D:/MCP/src`. There is no engine change for this feature: no new MCP tool, no `src/` edit. The only tie to the engine repo is consuming `@neetigyashah/apimemcp`'s **published types** via npm (ADR-06) — never engine internals, and never importing `src/registry-client.ts` directly (that module is engine-internal and Node/Playwright-adjacent; X07 re-implements its ~10-line jsDelivr fetch locally, which is small enough that duplicating it is the ADR-06-compliant move, not reinvention).

**Data source.** Same manifest jsDelivr already serves the engine: `GET https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/registry/manifest.json` → `Manifest = Record<string, ManifestEntry>` (types imported from `@neetigyashah/apimemcp`, per ADR-06).

**Data shapes** (`packages/registry-mirror/types.ts`):

```ts
import { z } from "zod";
import type { ManifestEntry } from "@neetigyashah/apimemcp"; // ADR-06: published types only, never engine src

export const RegistryRowSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  domainPattern: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  outputSchema: z.record(z.unknown()).nullable(), // ADR-01 outputSchema, passthrough only — not re-validated here
  verifyStatus: z.enum(["passing", "failing", "unknown"]), // "unknown" until F03 badges exist
  verifiedAt: z.string().datetime().nullable(),
  runCount: z.number().int().nonnegative().default(0), // from ADR-04 metrics rollup, if/when exposed
  raw: z.custom<ManifestEntry>(), // full entry, forward-compat passthrough for fields not yet promoted to columns
  manifestSha: z.string(),
  syncedAt: z.string().datetime(),
});
export type RegistryRow = z.infer<typeof RegistryRowSchema>;

export const RegistrySearchQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type RegistrySearchQuery = z.infer<typeof RegistrySearchQuerySchema>;
```

**Postgres schema** (`packages/registry-mirror/schema.sql`, run via Vercel Postgres/Neon migration):

```sql
CREATE TABLE registry_templates (
  template_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  domain_pattern TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  output_schema JSONB,
  source        TEXT,
  verify_status TEXT NOT NULL DEFAULT 'unknown',
  verified_at   TIMESTAMPTZ,
  run_count     INTEGER NOT NULL DEFAULT 0,
  raw           JSONB NOT NULL,
  manifest_sha  TEXT NOT NULL,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX registry_templates_category_idx ON registry_templates (category);
CREATE INDEX registry_templates_search_idx ON registry_templates
  USING GIN (to_tsvector('english', name || ' ' || coalesce(description, '')));

CREATE TABLE registry_sync_log (
  id          SERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  manifest_sha TEXT,
  upserted    INTEGER,
  removed     INTEGER,
  ok          BOOLEAN,
  error       TEXT
);
```

**Module-by-module changes** (all under `apimemcp-platform/`; assumes W01's stated scaffold `apps/web, apps/mobile, packages/shared` — if W01 instead adds a separate `apps/cloud` for Vercel Functions, these route files move there unchanged, same package boundary):

| File | Purpose |
|---|---|
| `packages/registry-mirror/types.ts` | Zod shapes above (S1) |
| `packages/registry-mirror/schema.sql` | DDL above (S2) |
| `packages/registry-mirror/sync.ts` | `syncRegistryMirror(deps)` — fetch manifest, diff, upsert/remove, write `registry_sync_log` row (S3) |
| `packages/registry-mirror/query.ts` | `searchTemplates(db, query)`, `getTemplateById(db, id)` — pure functions, injected `db`, unit-testable with a fake client (mirrors ADR-02's deps-injection spirit) (S3) |
| `packages/registry-mirror/index.ts` | Barrel export (S4) |
| `apps/web/app/api/registry/search/route.ts` | `GET` → `searchTemplates` (S5) |
| `apps/web/app/api/registry/[templateId]/route.ts` | `GET` → `getTemplateById`, 404 if absent (S5) |
| `apps/web/app/api/registry/sync/route.ts` | `POST`, requires `x-cron-secret` header == `process.env.CRON_SECRET` else 401 → `syncRegistryMirror` (S5) |
| `vercel.json` | `crons: [{ path: "/api/registry/sync", schedule: "0 3 * * *" }]` — daily (Hobby-plan cron floor is 1/day; see §9 for a faster free option) (S5) |
| `packages/registry-mirror/sync.test.ts`, `query.test.ts` | Vitest, fixture manifest (S6) |
| `scripts/verify-x07-registry-mirror.mjs` | Live/preview verify (S7) |

**Routes/tool signature note (re: ADR-02).** ADR-02's `registerXxxTool(server, deps)` convention is an **engine-repo, MCP-server-specific** contract (`Depended on by: every tool-adding feature ... and any platform feature that adds an engine tool`) — X07 adds **no engine tool**, so it does not literally register anything via ADR-02. It mirrors ADR-02's *spirit* (one capability per module, explicit injected `deps`, no hidden cross-boundary imports) in `query.ts`/`sync.ts` for the same reason ADR-02 exists: parallel-safe, independently unit-testable modules.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document |
| S1 Types | Applicable | `RegistryRowSchema`, `RegistrySearchQuerySchema` in `types.ts` |
| S2 Storage | Applicable | `schema.sql` DDL + Postgres client wiring (`@vercel/postgres`) |
| S3 Core | Applicable | `sync.ts` (fetch+diff+upsert) + `query.ts` (search/get) |
| S4 Module | Applicable | `packages/registry-mirror/` package boundary + barrel |
| S5 Wiring | Applicable | 3 route handlers under `apps/web/app/api/registry/**` + `vercel.json` cron |
| S6 Unit tests | Applicable | `sync.test.ts`, `query.test.ts` against a fixture manifest + fake db |
| S7 Verify | Applicable | `scripts/verify-x07-registry-mirror.mjs` against a real preview DB + real jsDelivr fetch (network/DB-touching, so included per the template's engine/browser-touching rule, adapted to cloud) |
| S8 Docs | Applicable | `packages/registry-mirror/README.md` (schema, sync cadence, route contracts) |
| S9 Review | Applicable | G2 Code-Review |
| S10 Live/preview verify | Applicable | Preview-deploy smoke: hit `/api/registry/search` on the Vercel preview URL, assert real rows |
| S11 Merge | Applicable | G7 Integration — `apimemcp-platform` merges `feat/X07-registry-mirror` straight to `main` (no intermediate `integration` branch for this repo, per `04-git-strategy.md`'s per-repo model table) |

None are N/A — this is a small, complete, full-stack slice (schema → sync → routes → tests → verify).

## 5. Dependencies & sequencing

- **Hard dep:** `registry` (the `apimemcp-templates` manifest over jsDelivr) — already live, not blocked by any unbuilt engine feature.
- **Structural dep (not in the Deps column but load-bearing):** W01 (platform monorepo scaffold) must exist first — X07's files live inside it.
- **Soft/graceful deps:** F01 (`outputSchema`) and F03 (verify badges) enrich `output_schema`/`verify_status`, but neither blocks X07 — absent F03, every row simply mirrors `verify_status = 'unknown'` (ADR-01's own "absent = no validation, back-compat" precedent, applied the same way here).
- **Unblocks:** W03 (Registry browser, Deps: `W01,W02,X07`), M03 (Browse/registry screens, Deps: `M02,X07`) — both hard-depend on X07. Transitively required by W04 (depends on W03) and the mobile browse-to-run path into M04.
- **Optional consumer:** X01 may query X07 for fast `templateId` existence/`outputSchema` lookup instead of parsing the full manifest per run request — an optimization, not a hard coupling (X01's Deps row lists only F18).

## 6. Quality gates

Catalog Gates = **"—"** (no Se/Lv/Design flag mandated; Risk=L — no user secrets, no code execution, public registry metadata only). Applies:

- **G0 Spec** — this document, Architect + Orchestrator sign-off (no Design Lead — no screen/UI).
- **G1 Build** — `apimemcp-platform` build clean, lint passes, Vitest green.
- **G2 Code-Review** — correctness + minimal diff; **also** the one ADR-06 contract check: `packages/registry-mirror/**` imports only `@neetigyashah/apimemcp` (published) and never a relative path into the engine repo. This is ADR-06's own stated enforcement point ("Contract rule (G3 Arch, cross-repo — G7 Integration)") folded into G2/G7 as a checklist item rather than promoted to a separate blocking gate, since the catalog doesn't flag Arch as required for X07.
- **G3 Arch / G3b Design / G4 Security** — not flagged; skip as hard gates (non-UI, no secrets, no sandboxing surface). The one thing worth a Security-Reviewer glance without a full gate: the `sync` route's cron-secret check (prevents public callers from forcing unlimited jsDelivr fetches / DB writes).
- **G5 QA** — Vitest suite for `sync.ts`/`query.ts` green on a rebased branch.
- **G6 Live-Verify** — not flagged as mandatory, but S7/S10 (verify script + preview smoke) are still done because the task's own Definition of Done requires *live observable proof* (§8) — run in CI/preview, just not gated by a dedicated Live-Verification Gatekeeper sign-off.
- **G7 Integration → G8 Promote** — merge to `main`; Vercel deploy; cron active.

**Definition of Done:** Postgres schema migrated; `syncRegistryMirror` upserts/removes rows matching the live manifest and logs to `registry_sync_log`; `search`/`get` routes return correct fast results; `sync` route is secret-gated; daily Vercel Cron wired; Vitest green; `verify-x07-registry-mirror.mjs` passes against a real preview deploy; zero engine-internal imports (ADR-06); W03/M03 unblocked.

## 7. Test plan

- `packages/registry-mirror/sync.test.ts` (Vitest, fixture manifest, fake db client):
  - First sync inserts N rows matching fixture entries.
  - Re-sync with an unchanged manifest is idempotent (no duplicate rows, `manifest_sha` unchanged → still logs a sync-log row).
  - A template removed from the manifest is removed from `registry_templates` on next sync.
  - A changed `outputSchema`/`description` updates the existing row (upsert, not insert-only).
  - Sync failure (fetch throws) writes `registry_sync_log{ok:false, error}` and does not clobber existing rows.
- `packages/registry-mirror/query.test.ts`:
  - `searchTemplates` filters by `category` and full-text `q`; respects `limit`/`cursor` pagination.
  - `getTemplateById` returns `null`/undefined for an unknown id (route maps this to 404).
- `scripts/verify-x07-registry-mirror.mjs` (real network + real preview DB, fixture-free):
  1. `POST /api/registry/sync` with correct secret → 200, `upserted >= 1`.
  2. `POST /api/registry/sync` with no/wrong secret → 401.
  3. `GET /api/registry/search?q=<known-template-name-substring>` → 200, response includes that template.
  4. `GET /api/registry/<known-template-id>` → 200, matches the live manifest entry's `domainPattern`.

## 8. Acceptance criteria (live, observable proof)

- Running `node scripts/verify-x07-registry-mirror.mjs` against the deployed preview populates `registry_templates` with rows that match today's real `apimemcp-templates` manifest, and one new `registry_sync_log` row shows `ok = true`.
- `curl https://<preview>.vercel.app/api/registry/search?q=<term>` returns matching templates in well under a second (Postgres-indexed read, no jsDelivr round-trip on the request path).
- `curl -X POST .../api/registry/sync` with no header → `401`; with `x-cron-secret: $CRON_SECRET` → `200` and upsert/remove counts that match the manifest diff since the last sync.
- `vercel.json`'s cron entry is visible in the Vercel dashboard and has fired at least once in deploy logs.

## 9. Reuse notes

- **Do not import** `src/registry-client.ts` (engine-internal) — re-implement the same ~10-line jsDelivr `manifest.json` fetch locally in `sync.ts`; this is the ADR-06-compliant move (duplication of a trivial fetch, not "reinventing a module").
- **Do import** `ManifestEntry`/`Manifest` from `@neetigyashah/apimemcp` (published package) — never redefine these shapes locally (ADR-06).
- `outputSchema` is ADR-01's addition to `ManifestEntry` — pass through as opaque JSONB; X07 does not validate it (that's X01/X02's job at run time).
- Cron-secret gating reuses Vercel's own `CRON_SECRET` env-var convention — no new library.
- If daily Vercel Cron (Hobby-plan floor) is too slow for a given launch need, the free-hosting-matrix's GitHub Actions option (scheduled `workflow_dispatch`, unlimited minutes on public repos) can hit the same secret-gated `/sync` route more often, at $0 — same route, no code change, just an additional caller. Not required for DoD; note only.
- A registry-repo webhook (`repository_dispatch` on merge to `apimemcp-templates`'s `main`) for near-instant sync is a nice-to-have, deliberately out of scope here (YAGNI) — daily cron already matches F03's nightly-verify cadence.

## 10. Skills (setup + when-to-use)

All skills X07 needs are **already available, first-party, no `npx skills add` install** — matching the master skills-matrix's own placement of X07 in the "no install" table (`vercel:vercel-storage, vercel:auth, vercel:env-vars, vercel:vercel-cli, vercel:deployments-cicd → X07/W07/M01`). Run `npx skills check` first regardless (idempotent, reuses anything a sibling agent already installed) — expect nothing missing for this feature.

| Skill | Source/signal | Guides |
|---|---|---|
| `vercel:vercel-storage` | Official Vercel first-party skill (top reputation tier per the plan's own bar) | S2 — Postgres/Neon schema + client setup |
| `vercel:nextjs` | Official Vercel first-party | S5 — App Router route handlers, `vercel.json` cron config |
| `vercel:runtime-cache` | Official Vercel first-party | S3/S5 — optional route-level cache layer on top of the DB read path |
| `context7-mcp` | Live official docs (per the standing project-wide context7 rule — use for any library/API/CLI question, even a familiar one) | Fallback for `@vercel/postgres` client API / Vercel Cron header-verification specifics not covered by the bundled skill's own examples (S2/S5) |

No skills.sh install needed here — `mindrally/skills@expo-react-native-typescript` and the other install-list entries are mobile-only and don't apply to this feature.
