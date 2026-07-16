# W08 — Landing + Interactive Hero

## 1. Summary

| Field | Value |
|---|---|
| id | **W08** |
| name | Landing + interactive hero |
| surface | Web (Program 2, `apimemcp-platform` repo — **not** the engine repo `D:\MCP\src`) |
| wave | P2 |
| risk | M |
| deps | W02 (cross-surface design system), X01 (execution API gateway) |
| catalog gate flags | — (none; not a boundary-setting feature like W01/W02) |
| skills (catalog) | frontend-design, ui-ux-pro-max, banner-design |

**What & why.** The public front door: `/` (hero) plus a small set of static vision pages. The site's one signature element (per `07-platform-design/website-design.md`) lives here: a live interactive terminal that runs one **real, already-verified, already-registered** community template end-to-end — compile → run → stream — in front of the visitor. This is the page that has to sell 00-vision.md's inversion thesis ("access is crowd-and-agent-supplied, not vendor-supplied") and its moat ("solved once by an agent, replayed in ms forever, deterministically") in one glance, with **real data, never mocked** — the plan's own words for this exact element. A broken or faked demo here damages the pitch more than no demo at all, hence risk M despite being "just a landing page."

## 2. User / agent story

As a developer (or an agent operator) who has never heard of APImeMCP, I land on the homepage, see a phosphor-terminal hero, click a curated example chip ("amazon.com" / "sec.gov/edgar"), and watch — in real time, in my browser's own Network tab if I look — a real `POST /api/run` go out, a real job get polled, and real extracted fields stream into the terminal. In under 10 seconds I understand the product without reading docs, then click through into the registry (W03) to try my own domain. If the demo template is temporarily down, I see an honest "temporarily unavailable — browse the registry" state, never a canned fake success — the flywheel depends on this page being trustworthy, not just pretty.

## 3. Design

### ADRs obeyed
- **ADR-06 (registry = cross-repo contract) — the binding ADR.** W08 only ever calls X01's existing HTTP route and imports types from `packages/shared` (published-style, in-monorepo). Zero import from the engine's `D:\MCP\src\*` (no `findTemplateByUrl`, no `registry-client.ts`, nothing). This is the whole reason Program 2 can build W08 without touching the engine repo at all.
- **ADR-02 (tool-module convention) — N/A.** W08 registers no MCP tool and no new HTTP route; it is a pure *consumer* of X01's already-registered `POST /api/run` / `GET /api/run/:id`. If X01 isn't deployed yet when a builder starts W08, that's a wave-order stall, not a spec gap — X01 is wave P1, W08 is P2, so ordering already guarantees it lands first.

### Data shapes

```ts
// apps/web/app/(marketing)/_lib/hero-templates.ts
export interface HeroTemplateOption {
  templateId: string;   // ManifestEntry key, e.g. "amazon-product-search"
  domainLabel: string;  // "amazon.com" — shown as the terminal prompt target
  targetUrl: string;    // FIXED, curated — never the visitor's free-typed text (no SSRF surface)
  verified: boolean;    // mirrors ManifestEntry / F03 shields badge
  featured: boolean;    // only featured && verified entries may reach the hero
}
export const HERO_TEMPLATES: HeroTemplateOption[]; // 4–6 curated entries, checked in hero-templates.test.ts
```

```ts
// apps/web/app/(marketing)/_lib/use-run-poll.ts
import type { RunRequest, RunResult } from "@apimemcp/shared/api-client"; // per X01: {templateId,targetUrl?,cookieString?} / {status,data?,error?}

export type HeroPhase = "idle" | "resolving" | "compiling" | "running" | "streaming" | "done" | "error";

export interface HeroDemoState {
  phase: HeroPhase;
  selected?: HeroTemplateOption;
  jobId?: string;
  result?: RunResult;
  errorMessage?: string;
}

export function useRunPoll(): { state: HeroDemoState; start: (opt: HeroTemplateOption) => void; reset: () => void };
```

`RunRequest`/`RunResult` are **not redefined** here — they come from the same shared client X01/W01 publish for W05 to consume; W08 imports, never redeclares (avoids two drifting copies of the X01 contract).

### Interaction flow (the "compile → run → stream" narrative, kept honest)
`idle` → click chip → `resolving` (~300ms cosmetic floor, copy: `$ registry lookup … verified 2h ago`) → `compiling` (canned narrative lines describing the *existing* one-time agent solve — copy must never claim live compilation is happening now, only that it *did*, once) → real `POST /api/run` via the shared client → `running` → poll `GET /api/run/:id` every ~700ms, capped at ~25 attempts (~18s) → `streaming` (each confirmed field of the real payload is typewritten in) → `done` (renders the actual returned JSON/table snippet) **or** `error` (non-200 / timeout → real error string, `reset` control offered). No branch of this state machine may substitute a fixture value for a failed live call.

### Module-by-module changes (all in `apimemcp-platform`, new repo per `04-git-strategy.md`)
| File | Purpose |
|---|---|
| `apps/web/app/page.tsx` | `GET /` — Server Component; static value-prop sections + mounts `<HeroTerminal/>` client island |
| `apps/web/app/vision/page.tsx` | `GET /vision` — fully static render of the 00-vision.md narrative (inversion, moat, two-track, flywheel, target markets) |
| `apps/web/app/(marketing)/_components/hero-terminal.tsx` | `"use client"` — the interactive terminal; owns the `HeroDemoState` machine via `useRunPoll` |
| `apps/web/app/(marketing)/_lib/hero-templates.ts` | curated `HERO_TEMPLATES` allowlist, sourced from X07's registry mirror at build/ISR time, filtered `verified && featured` |
| `apps/web/app/(marketing)/_lib/use-run-poll.ts` | poll-loop hook (interval, attempt cap, abort-on-unmount), wraps the shared X01 client |
| `apps/web/app/opengraph-image.tsx` | Next.js native OG-image convention (satori) — social/share card, banner-design skill's output baked in |
| `apps/web/e2e/hero-live-run.spec.ts` | Playwright live-verify spec against a deployed preview URL (this repo's analogue of the engine's `scripts/verify-<id>.mjs`, since W08 lives outside `D:\MCP` per ADR-06) |
| `packages/shared/src/api-client.ts` | **consumed, not owned** — the `runTemplate`/`getRun` wrapper W01/X01 publish; W08 only adds the two named exports if a parallel P2 builder (W05) hasn't already, coordinate via Integration |

### Screen / route signatures (no MCP tool — this is a pure web-screen feature)
- `GET /` → `apps/web/app/page.tsx`
- `GET /vision` → `apps/web/app/vision/page.tsx`
- `GET /opengraph-image` → `apps/web/app/opengraph-image.tsx` (Next.js file convention, not hand-rolled)
- Consumes, verbatim, X01's existing `POST /api/run {templateId,targetUrl?,cookieString?} → {jobId}` and `GET /api/run/:id → {status,data?,error?}` — **no new backend route is added by W08.**

## 4. Sub-tasks (S0–S11)

| # | Meaning (web) | Applicable? | Note |
|---|---|---|---|
| S0 Spec | this document | Applicable | — |
| S1 Types | `HeroTemplateOption`, `HeroPhase`, `HeroDemoState` | Applicable | `RunRequest`/`RunResult` reused from `packages/shared`, not redeclared |
| S2 Data/API client | `use-run-poll.ts` | Applicable | thin wrapper only — no second fetch/retry implementation |
| S3 Screens/components | `page.tsx`, `vision/page.tsx`, `hero-terminal.tsx`, `opengraph-image.tsx` | Applicable | brand-critical; heaviest sub-task, weight 2× |
| S4 Feature module | `(marketing)` route group + `_components`/`_lib` | Applicable | — |
| S5 Route/nav wiring | root `/` + `/vision` + nav links to W03 (registry) from hero CTA | Applicable | needs W02's shared nav shell |
| S6 Component tests | `hero-terminal.test.tsx`, `hero-templates.test.ts`, `use-run-poll.test.ts` | Applicable | — |
| S7 e2e/device | `hero-live-run.spec.ts` (Playwright, real preview URL) | Applicable | this *is* the "never mocked" proof; weight 2× |
| S8 Docs | short README section: curation rationale, how to add a featured template | Applicable | — |
| S9 Review | G2 code review | Applicable | checks ADR-06 import boundary |
| S10 Device/preview verify | Vercel preview-URL smoke (G6) | Applicable | non-blocking variant (catalog didn't flag `Lv`), weight 2× |
| S11 Merge | G7 integration | Applicable | sequence into the same G8 promote wave as W03–W07 (no dead nav links) |

All 12 sub-tasks are applicable; none N/A (W08 is a small but complete, self-contained screen feature).

## 5. Dependencies & sequencing

- **Hard deps:** W02 (P0 — must publish its tokens/Terminal/Card/Button primitives before the hero can be built to spec, not reinvented locally) and X01 (P1 — must be reachable, at least on preview, for the "real, never mocked" call). Both land in earlier waves than W08 (P2), so no reorder is needed.
- **Explicitly not a dep:** X04 (results delivery / SSE / websocket), unlike W05. The hero deliberately uses bounded client-side polling against X01's existing `GET /api/run/:id`, not a websocket — keeping W08's dependency footprint exactly what the catalog row states (W02, X01 only). If perceived hero latency ever becomes a problem, upgrading to X04 is a noted future path, not a day-one requirement — do not build it now.
- **Unblocks:** nothing formally — W08 is a leaf node in the W-graph (no feature lists it as a dependency).
- **Practical sequencing note (Orchestrator):** land W08 in the same G8 promote wave as W03/W04/W05/W06/W07 — its hero CTA and nav link into the registry, so a coherent public launch needs those pages live too.

## 6. Quality gates

| Gate | Applies? | Why |
|---|---|---|
| G0 Spec | Yes | this document |
| G1 Build | Yes | standard |
| G2 Code-Review | Yes | **also enforces ADR-06**: zero import from engine `src/`, curated-allowlist-only (no arbitrary user-typed scrape target) |
| G3 Arch | **N/A** | no new module boundary, no shared-type change — catalog leaves W08's Ar flag blank, unlike boundary-setting W01/W02 |
| G3b Design | Yes (standard for any UI feature) | Design Lead checks phosphor/void identity fidelity + a11y floor (focus visible, reduced-motion honors the typewriter animation) |
| G4 Security | **N/A** | not on the explicit flagged list (all X##, F00/F04/F06/F11/F12/F13/F16/F18); sandboxing is X02's job — W08's only obligation is to never let a visitor supply an arbitrary unvetted target (satisfied by the curated `HERO_TEMPLATES` allowlist) |
| G5 QA | Yes | component tests (S6) |
| G6 Live-Verify | Yes, **non-blocking preview-smoke variant** | catalog didn't flag `Lv` (unlike W05's blocking live-verify) — still runs `hero-live-run.spec.ts` against the deployed preview to prove the "never mocked" claim |
| G7 Integration | Yes | standard |
| G8 Promote+Deploy | Yes | sequenced with W03–W07 |

**Definition of Done:** `/` and `/vision` are live on a Vercel preview, visually matching W02's tokens (Design Lead sign-off); clicking a curated chip produces a real, observable `POST /api/run` + polled `GET /api/run/:id` round trip whose rendered output is provably derived from the actual response (not a fixture); the error path renders a real error, never a fake success; `hero-live-run.spec.ts` and all component tests are green; `grep`-level check shows zero imports from `apimemcp`'s engine `src/`; merged to `apimemcp-platform`'s `main` in the W03–W07 promote wave.

## 7. Test plan

- `apps/web/app/(marketing)/_components/hero-terminal.test.tsx` — phase-machine transitions `idle→…→done`, error path never substitutes a fake success, poll aborts on component unmount.
- `apps/web/app/(marketing)/_lib/hero-templates.test.ts` — asserts every entry in `HERO_TEMPLATES` has `verified === true && featured === true`; a fixture entry with `verified:false` must fail the test (guards the highest-traffic page from ever featuring a broken template).
- `apps/web/app/(marketing)/_lib/use-run-poll.test.ts` — bounded attempt cap, interval timing, abort-on-unmount, non-200/timeout maps to `phase:"error"` carrying the real error text (never swallowed).
- `apps/web/e2e/hero-live-run.spec.ts` (Playwright, **G6 live-verify** — this repo's equivalent of the engine's `scripts/verify-<id>.mjs`, run against a real deployed preview URL, CI-gated): click a curated chip, `page.waitForResponse('**/api/run/**')` to capture the *actual* network response, then assert the rendered terminal text is derived from that captured payload — not equality against a hardcoded golden value (live data changes day to day; the fixture asserts **shape**, not a frozen value).
- Fixture: `apps/web/e2e/fixtures/hero-expected-shape.json` — an expected-*keys* shape (e.g. `["title","price"]` for the Amazon template) used only to assert the response has the right structure; never a frozen expected value.

## 8. Acceptance criteria (live, observable proof)

1. Visiting the deployed preview `/` shows the phosphor-amber-on-void terminal hero in IBM Plex Mono, matching W02's tokens.
2. Clicking a curated domain chip triggers, in the browser's own Network tab, a real `POST {X01_BASE}/api/run` with a `templateId` drawn from `HERO_TEMPLATES`, followed by `GET {X01_BASE}/api/run/:jobId` polls until `status:"done"`; the terminal's rendered text is traceable to that exact response body (verified by the Playwright e2e diffing rendered DOM text against the captured response).
3. Forcing a 500/timeout from X01 (test-only) renders phase `error` with a real error string — never a canned success payload.
4. `/vision` is reachable from primary nav and renders all five named narrative beats (inversion, moat, two-track product, flywheel, target markets) as real static copy, not lorem-ipsum placeholder.
5. `grep -rn "apimemcp/src\|from ['\"].*engine" apps/web` returns zero hits — the ADR-06 boundary holds.
6. With the OS "reduce motion" setting on, the typewriter reveal is disabled or shortened (a11y floor).

## 9. Reuse notes

- **Reuse, don't rebuild:** W02's design-system package (`Terminal`/`Card`/`Badge`/`Button` primitives + color/type tokens) — never hand-roll a second phosphor-amber CSS palette locally.
- **Reuse:** `packages/shared`'s X01 API client (the same `runTemplate`/`getRun` wrapper W05's run console consumes) — `use-run-poll.ts` wraps it, it does not reimplement fetch/retry/polling from scratch.
- **Reuse:** X07's registry mirror for each curated entry's live `verified` flag — never fetch jsDelivr raw from the browser bundle.
- **Reuse (native platform feature, ladder rung 4):** Next.js's built-in `opengraph-image.tsx` file convention (satori) instead of a custom image-generation pipeline.
- **Explicitly do NOT reuse:** `findTemplateByUrl`, `buildStandaloneScript`, `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate` — these are engine-internal (`D:\MCP\src\*`) and **ADR-06 forbids importing them into the platform.** W08's only doors into template capability are X01 (run) and X07 (catalog metadata) via published-style shared types.

## 10. Skills (setup + when-to-use)

All skills W08 needs are already installed in this environment (per `08-skills-matrix.md`'s "Already available — no install" table); none of the "to install" skills apply (those are Expo/mobile/BullMQ-specific). Run `npx skills check` first per the plan's standing rule, confirm presence, skip install.

| Skill | Signal | Guides |
|---|---|---|
| `frontend-design` | bundled project skill, no install needed | S3 — hero/vision composition, the brand-critical first impression |
| `ui-ux-pro-max:design-system`, `ui-ux-pro-max:banner-design` | bundled | S3 — hero visual polish + the `opengraph-image.tsx` social card |
| `vercel:nextjs`, `vercel:shadcn`, `vercel:react-best-practices` | official Vercel vendor skills, bundled | S3/S4 — App Router conventions, `opengraph-image.tsx`, server/client component boundary for `<HeroTerminal/>` |
| `context7-mcp` | official live docs, bundled | any Next.js/Playwright/satori API question during S3/S7 — pull current docs rather than answer from memory, per standing project practice |
