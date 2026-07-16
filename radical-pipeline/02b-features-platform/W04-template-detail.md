# W04 — Template detail + schema/docs

## 1. Summary

- **ID:** W04 · **Name:** Template detail + schema/docs · **Program:** 2 (Consumer Platform) · **Surface:** Web (Program 2 has no "pillar" axis — Surface substitutes)
- **Wave:** P1 · **Risk:** L
- **What:** The single-template page in the registry "ledger" — renders a community template's human-readable output-schema docs (ADR-01 `outputSchema`), its live F03 verification badge, run-count, an optional F11 provenance summary, a `.mjs` download, and the entry point into the Run console (W05).
- **Why (market angle, 00-vision):** the vision's moat is "determinism vs. computer-use" and a flywheel where verified community templates compound into coverage. A crowd-supplied template is only useful if a stranger can decide, in one page, whether to trust it — W04 *is* that trust surface: it turns "someone wrote a template for this site" into "I can see exactly what it returns, that it's currently verified, and how many people already ran it," which is the conversion moment website-design.md's "registry as monospace ledger" device points at (badge + run-count on the list row; this page is that row expanded).

## 2. User / agent story

**Visitor (human):** I searched/browsed the registry (W03), found a template for a site I care about. Before I paste a URL or my cookies into it, I want to see what data shape it promises, whether it's currently passing nightly re-verification, how many times it's been run, and — if I trust it — a one-tap path to Run (W05) or a raw `.mjs` I can run myself with the self-host engine.

**Agent consumer:** An external agent (or APImeMCP's own `deep-research`/`find-skills`-style tooling) hits the page's JSON sibling endpoint to learn "what does template X return" *without* executing it or scraping rendered HTML — the schema must be available as structured data, not just prose.

## 3. Design

**Repo/location note:** W04 is a Program 2 feature. Per `04-git-strategy.md` it lives in the **separate `apimemcp-platform` Turborepo** (NOT `D:/MCP/src`, which is the engine repo). Paths below are relative to `apimemcp-platform/`, using the `apps/web`, `packages/shared` layout W01 scaffolds.

### ADRs this obeys
- **ADR-01 (schema contract):** `outputSchema?` is optional on `ManifestEntry` — W04 must render correctly when it's **absent** (hide the schema section, no error), exactly mirroring the back-compat rule F01 enforces engine-side.
- **ADR-06 (registry = cross-repo contract):** W04 imports only the **published** `@neetigyashah/apimemcp` types (`ManifestEntry`, the schema shape) and reads the **registry mirror** (X07) — it never imports engine internals (`src/engine.ts`, `src/storage.ts`, etc.) and never calls `buildStandaloneScript` itself.
- **ADR-02 (tool-module convention):** does not directly apply — W04 adds no MCP tool and requires no new engine-side tool, so the "platform features that need an engine tool follow the same convention" clause is N/A here. The one HTTP surface W04 adds (below) is a plain Next.js Route Handler in the platform repo, not an MCP tool.

### Data shapes

```ts
// packages/shared/src/registry-types.ts  (new)
import { z } from "zod";
import type { ManifestEntry } from "@neetigyashah/apimemcp"; // ADR-06: published type, not re-authored

export const TemplateIdParam = z.object({ templateId: z.string().min(1) });

export type VerificationStatus = "verified" | "stale" | "failing" | "unknown";

export interface TemplateDetailViewModel {
  entry: ManifestEntry;                 // id, name, url pattern, outputSchema? (ADR-01), source, waitStrategy?, readySelector?
  verification: {
    status: VerificationStatus;         // F03 nightly-verify result, as mirrored into X07
    lastVerifiedAt: string | null;      // ISO timestamp
    badgeUrl: string;                   // shields.io URL F03 already produces — render as an <img>, don't recompute
  };
  runCount: number;                     // aggregate rollup from X07 (ADR-04 metrics)
  scriptDownloadUrl: string | null;     // pre-built .mjs artifact location; null if not yet built for this template
  provenance: {                         // F11 — absent until F11 ships (same optional/back-compat shape as ADR-01)
    contentHash: string;
    version: string;
    schemaValid: boolean;
  } | null;
}
```

`entry.outputSchema`'s exact field name/shape and `scriptDownloadUrl`'s source field are **owned by F01/X07** — confirm the literal property names against the shipped `@neetigyashah/apimemcp` types and the X07 mirror row shape at build time; don't hand-guess a second time.

### Module-by-module changes (new files, `apimemcp-platform`)

| Path | Purpose |
|---|---|
| `packages/shared/src/registry-types.ts` | `TemplateDetailViewModel`, `TemplateIdParam` (above) |
| `packages/shared/src/registry-client.ts` (**extend**, owned by W03) | add `getTemplateDetail(templateId): Promise<TemplateDetailViewModel \| null>` next to W03's existing list/search calls — same X07 data path, one more query, not a new fetch stack |
| `apps/web/app/registry/[templateId]/page.tsx` | Server Component: fetch via `getTemplateDetail`, render sub-components, `notFound()` on null |
| `apps/web/app/registry/[templateId]/not-found.tsx` | 404 UI for unknown template id |
| `apps/web/app/registry/[templateId]/_components/SchemaDocs.tsx` | renders `entry.outputSchema` as a field/type table; hidden entirely when absent |
| `apps/web/app/registry/[templateId]/_components/VerificationBadge.tsx` | `<img src={verification.badgeUrl}>` + status text/color |
| `apps/web/app/registry/[templateId]/_components/RunEntryCta.tsx` | link/button to the W05 run route (assume `/run/[templateId]`; confirm against W05's actual route) |
| `apps/web/app/registry/[templateId]/_components/DownloadScriptButton.tsx` | link to `scriptDownloadUrl`; disabled/hidden when null |
| `apps/web/app/registry/[templateId]/_components/ProvenanceSummary.tsx` | hidden when `provenance` is null; else renders hash/version/schema-valid |
| `apps/web/app/api/registry/[templateId]/route.ts` | JSON GET sibling endpoint (agent story + client prefetch) |

### HTTP route signature (Next.js Route Handler, not an MCP tool — see ADR-02 note above)

```ts
// apps/web/app/api/registry/[templateId]/route.ts
export async function GET(
  _req: Request,
  { params }: { params: { templateId: string } }
): Promise<Response>
// 200 → TemplateDetailViewModel JSON (same object the page renders — one data path, two consumers)
// 404 → { error: "not_found" }
```

### Screen signature

```ts
// apps/web/app/registry/[templateId]/page.tsx
export default async function TemplateDetailPage({
  params,
}: { params: { templateId: string } }): Promise<JSX.Element>
```

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `TemplateDetailViewModel` + `TemplateIdParam` in `packages/shared` |
| S2 Data/API client | Applicable | extend W03's `registry-client.ts` with `getTemplateDetail` — no new fetch stack |
| S3 Screens/components | Applicable | page + 5 components listed above |
| S4 Feature module | Applicable | colocated under `app/registry/[templateId]/` |
| S5 Route/nav wiring | Applicable | file-route + Route Handler + link this page from W03's list rows |
| S6 Component tests | Applicable | Vitest + React Testing Library (matches engine repo's Vitest convention) |
| S7 e2e/device | N/A | no `Lv` flag on W04 in the catalog; component tests + a preview-URL smoke at G7 suffice |
| S8 Docs | Applicable | brief in-file doc comments; page's role already documented in `website-design.md` |
| S9 Review | Applicable | G2 always required |
| S10 Live/preview verify | N/A | no `Lv` flag on W04 — no gated live/device verify step |
| S11 Merge | Applicable | G7 Integration |

## 5. Dependencies & sequencing

- **Hard deps (catalog):** **W03** (registry browser — this page is linked from W03's rows and reuses its `registry-client` data layer) · **F01** (schema contract — `outputSchema` field + the back-compat rule this page must honor).
- **Soft/data deps (inherited via W03, not re-integrated by W04):** **X07** (registry mirror/cache — W03 already wires this; W04 adds one more read, doesn't stand up new plumbing) · **F03** (nightly-verify badge/status data, surfaced through X07).
- **Unblocks:** **W05** (Run console — needs a template-detail entry point to deep-link "Run" into); pattern (viewmodel shape + optional-provenance handling) is mirrored by **M04** on mobile, sharing the `packages/shared` types.
- **Wave:** P1, alongside W03/W07/X01/X02/X07.

## 6. Quality gates

Path: `G0 Spec → G1 Build → G2 Code-Review → [G3b Design] → G5 QA → G7 Integration → (wave P1) G8 Promote`. `G3 Arch` and `G4 Security` skip (no boundary/type-shape change beyond consuming published types; no auth/cookie/user-data surface — Run itself happens on W05). `G6 Live/Device-Verify` skips — no `Lv` flag in the catalog row.

**Definition of Done:**
- Renders correctly for a template **with** `outputSchema` (fields shown) and **without** one (section hidden, no error) — proves ADR-01 back-compat.
- Verification badge reflects live F03 status; run-count is the real X07 aggregate, not a placeholder.
- Run CTA deep-links to the W05 route; download button serves the pre-built `.mjs` (or is absent/disabled, never a broken link).
- Provenance section absent until F11 ships (additive-optional, same posture as `outputSchema`).
- Matches W02 design tokens; a11y floor met (focus states, alt text on the badge image).
- No import of engine internals anywhere in the diff (`@neetigyashah/apimemcp`'s public export only) — ADR-06 respected.
- Build + component tests green; G2 review passed.

## 7. Test plan

Engine/browser is not touched by W04 (pure rendering of already-fetched registry data) → **no `scripts/verify-W04.mjs`/fixture** (that mechanism is for engine- or Playwright-touching features per the spec template's own caveat).

`*.test.tsx` / `*.test.ts` (Vitest + React Testing Library):
- `SchemaDocs.test.tsx` — renders field rows from a sample `outputSchema`; renders nothing/"no schema documented" fallback when `outputSchema` is `undefined`.
- `VerificationBadge.test.tsx` — all four `VerificationStatus` values render distinct badge/text.
- `RunEntryCta.test.tsx` — link `href` matches `/run/:templateId`.
- `DownloadScriptButton.test.tsx` — correct `href` when `scriptDownloadUrl` set; disabled/hidden when `null`.
- `ProvenanceSummary.test.tsx` — hidden when `provenance` is `null`; renders hash/version/valid flag when present.
- `registry-client.getTemplateDetail.test.ts` — parses a mock X07 response into `TemplateDetailViewModel`; returns `null` (not a throw) for an unknown id.
- `api/registry/[templateId]/route.test.ts` — `GET` returns 200 + matching JSON shape for a known id, 404 `{error:"not_found"}` for an unknown one.

## 8. Acceptance criteria (live, observable)

- Visiting `/registry/<real-template-id>` on a deployed preview shows the template's name/description, schema fields matching its actual `outputSchema`, a badge reflecting real F03 status, a non-fabricated run-count, a working Run link landing on the W05 route, and a `.mjs` download that downloads a non-empty file.
- Visiting a template with no `outputSchema` shows the page with the schema section absent and **no error** — the back-compat proof.
- Visiting an unknown id renders the Next.js not-found UI, not a crash/500.
- `curl https://<preview>/api/registry/<id>` returns `200` with a JSON body matching `TemplateDetailViewModel`; an unknown id returns `404`.

## 9. Reuse notes

- `getTemplateDetail` **extends** W03's existing registry-client rather than standing up a second fetch/query path.
- The verification badge **reuses F03's shields.io URL as-is** (`<img src={badgeUrl}>`) — no custom badge renderer.
- The `.mjs` download link points at the artifact the engine's `buildStandaloneScript` **already produced at registry-publish/nightly-verify time**; W04 must never call `buildStandaloneScript` or import engine internals directly (ADR-06) — it only surfaces a URL the mirror already stores.
- `ManifestEntry`/`outputSchema` types are **the published package's types**, not re-authored in the platform repo (ADR-01 + ADR-06).
- Visual tokens (phosphor/void identity, spacing, type) come from **W02** — no one-off styles.
- Provenance (F11) is rendered with the **same optional/absent-means-hidden pattern** ADR-01 already establishes for `outputSchema` — don't stub or fake it before F11 ships.

## 10. Skills (setup + when-to-use)

**Already available, no install (per `08-skills-matrix.md`):**
- `vercel:nextjs`, `vercel:shadcn`, `vercel:react-best-practices` — App Router page/Route Handler conventions and component structure (guides S3, S4, S5).
- `dataviz` — guides `SchemaDocs`' field/type rendering (color-coded type badges, consistent with the design system) and the run-count treatment; it's schema-table + one number, not a chart library (guides S3).
- `context7-mcp` — per the standing global rule, pull current Next.js App Router / Route Handler docs before writing framework-syntax code even where the pattern looks familiar (guides S1–S5).
- `using-apimemcp` — confirms the exact shape/behavior of `ManifestEntry`/`outputSchema` and any registry-mirror fields against the real published package rather than guessing twice (guides S1, S2).

**Not installing anything new for W04:** no ≥1K-install skill gap exists here (no mobile/cloud-specific need); a JSON-Schema-to-table renderer is simple enough to hand-write (ladder rungs 6/7) rather than pull in a schema-UI dependency — skip it, add a library only if `outputSchema` complexity (nested/`oneOf`/`$ref`) later outgrows a flat field table.
