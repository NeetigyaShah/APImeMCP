# W05 — Web run console

## 1. Summary

- **ID / Name:** W05 — Web run console
- **Surface:** Web (Program 2 — Consumer Platform). No F-style pillar tag applies to Program 2; the closest analog is Surface=Web.
- **Wave:** P2 · **Risk:** M · **Gates:** Lv (Live/Preview-Verify — blocking)
- **Deps:** W04 (template detail + schema/docs), X01 (execution API gateway), X04 (results delivery)
- **What:** The page a visitor lands on after clicking "Run" from a template's detail page (W04): an input form (target URL / cookies / one-tap fixed target), a Run button that calls X01, a live status ticker fed by X04's stream, and a result viewer that renders JSON, a table, or an image gallery depending on shape.
- **Why / market angle (00-vision):** This is the browser half of the "phones/browsers can't run Playwright → cloud execution is the bridge" architecture — it is literally the mechanism behind the site's signature hero element ("type a domain, watch a real community template compile → run → stream real results", 00-vision / website-design.md), proving the "moat = determinism vs computer-use" pitch with real, never-mocked data. It is also the on-ramp to the mobile "monitors" wedge: the same run contract (X01/X04 shapes) is what M04's Run screen consumes.

## 2. User / agent story

- **Visitor:** I found a template on the registry (W03), read its schema/docs (W04), and click Run. I either tap a fixed target or paste a URL + cookies, hit Run, and watch status go queued → running → done live, without refreshing. The result renders as a table if it's a list of records, an image gallery if it's photos, or a JSON view otherwise. I can copy a share link or download the JSON.
- **Agent/API consumer:** I don't touch the UI at all — I hit the same `POST /api/run` / `GET /api/run/:id` contract (X01) that this console calls; W05 adds nothing to that contract, it's a thin client of it.

## 3. Design

### Repo & boundary (ADR-06)

W05 lives in the **`apimemcp-platform`** Turborepo (Locked decision ⑥ / 04-git-strategy.md), **not** in the engine repo `D:/MCP/src`. Per ADR-06, it imports only the **published** `@neetigyashah/apimemcp` npm types — never reaches into engine internals. Two engine-side files are the source of truth it mirrors:
- `D:/MCP/src/types.ts` — `ManifestEntry.outputSchema?` (ADR-01) → published as `OutputSchema` type.
- `D:/MCP/src/transform.ts` — `TransformSpec` + `applyTransform` (ADR-03) → published and re-bundled client-side (see below).

### ADRs obeyed

- **ADR-01 (schema contract):** result views are driven by `outputSchema` (JSON Schema) when present; absent schema = fall back to a generic JSON/table heuristic (never a hard requirement — matches ADR-01's "absent = skip, run unchanged").
- **ADR-03 (transform interface):** W05 is named explicitly as a dependent — "Applies (and previews) a transform on live results in the browser." `applyTransform` is pure/total/no-IO, so it is safe to bundle directly into the browser for instant client-side preview, no server round-trip needed for the preview path.
- **ADR-02 (tool-module convention):** N/A — W05 registers no MCP tool; it is a web screen, not an engine feature. It consumes routes owned by X01/X04 (below), it does not define them.

### Data shapes (`packages/shared/src/run-console-types.ts`)

```ts
import { z } from "zod";
import type { TransformSpec, OutputSchema } from "@neetigyashah/apimemcp"; // ADR-03 / ADR-01, published

export const RunRequestSchema = z.object({
  templateId: z.string(),
  targetUrl: z.string().url().optional(),
  cookieString: z.string().optional(),
  transform: z.custom<TransformSpec>().optional(), // ADR-03, optional client-attached reshape
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export interface RunStatus {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  progress?: number;                 // 0..1 best-effort
  result?: unknown;
  resultSchema?: OutputSchema;        // ADR-01 outputSchema, carried through for typed rendering
  error?: string;
  tookMs?: number;
}
```

`RunStatus` is the same shape whether read from `GET /api/run/:id` (X01, poll fallback) or an X04 stream event (SSE) — one type, one parser, no duplicate mapping.

### Module-by-module changes (all new, `apimemcp-platform` repo)

| File | Responsibility |
|---|---|
| `apps/web/app/run/[templateId]/page.tsx` | Server component shell. `RunConsolePage({ params: { templateId } }): Promise<JSX.Element>`. Reads optional `?target=&schema=` query (handed off by W04's Run link) so it doesn't re-hit X07 for what W04 already fetched. |
| `apps/web/app/run/[templateId]/RunConsole.tsx` | Client component: `RunConsole(props: { templateId: string; defaultTarget?: string; outputSchema?: OutputSchema }): JSX.Element`. Input form, Run button, status ticker, tabs (JSON/Table/Image), Share + Download JSON. |
| `apps/web/app/run/[templateId]/useRunStream.ts` | Hook: `useRunStream(jobId?: string): RunStatus \| undefined`. Opens `EventSource` against X04's stream route (assumed `GET /api/run/:id/stream` — **exact path owned by X04's spec**, confirm at implementation time); on `EventSource` unavailable/blocked (corporate proxy), falls back to polling `GET /api/run/:id` (X01) every 1.5s until a terminal status. |
| `apps/web/app/run/[templateId]/ResultView.tsx` | `ResultView(props: { result: unknown; schema?: OutputSchema }): JSX.Element`. Array-of-flat-objects → shadcn `<Table>`; schema/heuristic-flagged image URLs → `<img>` grid; else → JSON view (`<pre>` + syntax highlight — no new JSON-tree dependency for v1). |
| `apps/web/app/run/[templateId]/TransformBar.tsx` | Collapsed-by-default. Builds a `TransformSpec` (map/rename/pick/coerce, ADR-03); previews instantly client-side via bundled `applyTransform`; "Apply to next run" attaches it to the next `RunRequest`. |
| `packages/shared/src/run-console-types.ts` | `RunRequestSchema`, `RunRequest`, `RunStatus` (above) — shared with M04, not duplicated. |
| `packages/shared/src/api-client.ts` | Extend (create if W04 hasn't yet): `postRun(req: RunRequest): Promise<{jobId:string}>`, `getRun(jobId): Promise<RunStatus>`, `streamRun(jobId): EventSource`. One client, used by both W05 and M04. |

### Screen entry point

Entered from W04 via `<Link href={\`/run/${template.id}?target=${defaultTarget}\`}>Run</Link>`. No MCP tool, no new HTTP route is *owned* by W05 — it is purely a consumer of X01 (`POST /api/run`, `GET /api/run/:id`) and X04 (stream/push).

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document |
| S1 Types | Applicable | `run-console-types.ts` (RunRequest/RunStatus) |
| S2 Data/API client | Applicable | `api-client.ts` postRun/getRun/streamRun |
| S3 Screens/components | Applicable | RunConsole, ResultView, TransformBar, useRunStream |
| S4 Feature module | Applicable | the `run/[templateId]` route as a cohesive unit |
| S5 Route/nav wiring | Applicable | Next.js dynamic route + Link from W04 |
| S6 Component tests | Applicable | Vitest + RTL for RunConsole/ResultView/useRunStream |
| S7 e2e/device | Applicable | `scripts/verify-W05.mjs` against a Vercel preview URL |
| S8 Docs | Applicable | Contributes a short "how runs stream live" note to the site's existing Docs > API-ref page (W06-owned infra) — not a new docs system |
| S9 Review | Applicable | G2 code review |
| S10 Preview verify | Applicable | G6 — required, this feature carries the "Lv" gate flag |
| S11 Merge | Applicable | G7 integration merge |

All 12 apply — no N/A here; this is a live-data, streaming UI feature, exactly the shape the Lv gate exists for.

## 5. Dependencies & sequencing

- **Hard deps:** W04 (Run entry point + already-resolved `outputSchema`/default target handed off, so W05 doesn't re-fetch), X01 (POST/GET run contract), X04 (stream/push delivery + the ephemeral no-persist policy W05 must respect client-side).
- **Transitive/soft:** W01 (Turborepo scaffold must exist first), W02 (design tokens for the console's ticker/tabs/buttons), W07 (Clerk session likely used for auth'd rate-limit headers on the X01 call — soft runtime dependency, not a hard blocker for starting the branch), X07 (already satisfied via W04, not re-queried).
- **Unblocks:** W08 (landing hero demo reuses `useRunStream`/`ResultView` for its live compile-and-run interaction), W06 (contribute flow can deep-link "see it run" into W05), M04 (mobile Run screen shares `RunRequest`/`RunStatus`/`api-client.ts` — parallel work, not blocked by W05, but avoids re-deriving the contract).
- **Wave:** P2. In practice this branch forks once whichever of W04/X01/X04 lands last is green — it is the convergence point of three P1/P2 lanes, so expect it to start late in P2 relative to its siblings.

## 6. Quality gates

Universal pipeline applies (`G0→G1→G2→[G3]→[G3b]→[G4]→G5→[G6]→G7→G8`); bracketed gates are conditional on the change's properties, not only on the catalog's single-flag column:
- **G0 Spec:** this doc, Architect + Design Lead sign-off (UI feature).
- **G1 Build:** Turborepo build/typecheck/lint clean.
- **G2 Code-Review:** correctness + no reinvented mapping/table/tab components (reuse shadcn, reuse `applyTransform`).
- **G3 Arch (light-touch, applicable):** not flagged in the catalog's Gates column, but this feature crosses the repo boundary (ADR-06) — Architect confirms only `@neetigyashah/apimemcp` published types are imported, zero engine-internal imports.
- **G3b Design (applicable, all Program 2 UI):** Design Lead confirms phosphor/void identity (W02 tokens), a11y floor (focus states on tabs/buttons, reduced-motion for the status ticker).
- **G4 Security:** not separately flagged for W05 (X01/X04 own the actual transit/storage security), but the Definition of Done still requires: `cookieString` is never written to `localStorage`/`sessionStorage`/client logs, sent once over HTTPS to X01 only.
- **G5 QA:** component test suite green.
- **G6 Live/Preview-Verify (blocking — this feature's named gate):** `scripts/verify-W05.mjs` green against a real Vercel preview URL, real registry template, real X01/X04 endpoints — no mocks.
- **G7 Integration → G8 Promote:** rebased, wave-coherent, Vercel deploy green.

**Definition of Done:** a real (non-mocked) registry template run, started from the Run Console UI on a Vercel preview URL, streams live status through to a rendered result in at least JSON + one of {Table, Image} depending on the template's `outputSchema`; Share/Download works; devtools confirms no persisted cookie value.

## 7. Test plan

- `apps/web/app/run/[templateId]/RunConsole.test.tsx` — submit calls `postRun` once with the expected `RunRequest`; Run button disabled while `status==="running"`; renders an error state on a 4xx/5xx from X01.
- `apps/web/app/run/[templateId]/useRunStream.test.ts` — mocked `EventSource`: asserts state transitions queued→running→done update hook state; asserts polling fallback engages when `EventSource` construction throws.
- `apps/web/app/run/[templateId]/ResultView.test.tsx` — array-of-flat-objects → `<table>`; nested object → JSON view; schema-flagged image URLs → `<img>` grid; empty result → empty state, not a crash.
- `packages/shared/src/run-console-types.test.ts` — `RunRequestSchema` round-trips valid input, rejects malformed `targetUrl`.
- `scripts/verify-W05.mjs` (Playwright, browser-touching): opens a Vercel preview `/run/<known-good public template id>`, clicks Run, waits for a terminal status (SSE or fallback), asserts the DOM shows a non-empty result view, and asserts no literal cookie string appears in `page.content()` or in a `localStorage`/`sessionStorage` dump. Fixture: one small, stable, no-auth public registry template (mirrors the simple GET-style templates already used by other `verify-*.mjs` scripts) so the check doesn't depend on volatile live-site state.

## 8. Acceptance criteria

- Open the preview URL for a real registry template's run console, click Run, watch the status ticker move queued → running → done live (no page reload), see the result render as Table or Image (per that template's `outputSchema`) with a JSON tab always available.
- Share produces a working link; Download JSON produces the raw result.
- Devtools Network + Application tabs confirm: `cookieString` sent once over HTTPS to X01's route only, never written to any storage.
- `scripts/verify-W05.mjs` green in CI against a preview deployment; full Vitest suite for this feature green.

## 9. Reuse notes

- **`applyTransform`** (ADR-03, published, mirrors `D:/MCP/src/transform.ts`) — bundle and call directly for the client-side transform preview; do not hand-roll reshaping logic in the web app.
- **`outputSchema`** (ADR-01, published, mirrors `D:/MCP/src/types.ts`) — reuse exactly what W04 already fetched/rendered; pass it down via the Run link's query/props rather than re-deriving or re-fetching from X07.
- **X01/X04 contract types** — one `RunRequest`/`RunStatus` pair in `packages/shared`, one `api-client.ts`, consumed identically by W05 and M04 — this is the concrete instance of ADR-03's "written once, shared by both client surfaces."
- **shadcn `<Table>`, `<Tabs>`, `<Card>`** (already in the W01/W02 scaffold) — use as-is for the view switcher; no new UI-kit dependency.
- **W04's template fetch** — don't re-query the registry mirror (X07) for metadata W04 already has; receive it via navigation.

## 10. Skills (setup + when-to-use)

Per 08-skills-matrix.md, W05's key skills (`nextjs`, `dataviz`, `ui-styling`) are already available in this environment — **no install needed**, just `npx skills check` to confirm before starting:
- **`vercel:nextjs`** (already available) — guides S3/S4/S5: App Router dynamic route (`app/run/[templateId]`), client-component boundary for the streaming console, Suspense around the server shell.
- **`dataviz`** (already available) — guides S3's `ResultView`: the skill's own trigger list covers "table"/"visualize data"/"stat tile", directly applicable to choosing Table vs JSON vs Image presentation and any numeric-result stat tiles.
- **`ui-ux-pro-max:ui-styling`** (already available) — guides S3/G3b: matching the phosphor-amber/void identity and W02's shared tokens on the status ticker, tabs, and buttons.
- **`context7-mcp`** (already available, blanket matrix entry) — fallback for live Next.js Route Handler / SSE specifics and shadcn `<Table>`/`<Tabs>` prop APIs; use instead of relying on memory when wiring `useRunStream` or the result tabs.
- No `npx skills add` is expected for W05 specifically — all three key skills are already covered by the environment-wide table; only run `npx skills check` first per the matrix's setup rule.
