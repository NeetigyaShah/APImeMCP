# W06 — Contribute Flow

## 1. Summary
- **ID** W06 · **Name** Contribute flow · **Program** 2 (Consumer Platform) · **Surface** Web · **Wave** P2 · **Risk** L · **Gates flagged** — (no Ar/Se/Lv special block; still carries the baseline G0-G2/G5/G7/G8 pipeline + G3b Design since it's a UI surface).
- **What:** the `/contribute` pages on the public website — PR onboarding (how to add a community template to the `apimemcp-templates` registry) + a gate explainer (what G0-G8 / F03 verify / F19 lint actually check, so a rejected PR is legible instead of mysterious).
- **Why (market angle, 00-vision.md):** the whole platform is a flywheel — "Agents/devs contribute templates (registry PRs, verified nightly) → instantly usable in web + app → consumers run/monitor them → usage signals which matter → more contribution; self-healing keeps them working. Coverage grows itself." W06 is the front door of that loop. The target markets (RPA replacement, financial/gov data, healthcare portals, supply-chain, competitive intel) only get covered as fast as the barrier to contributing a template is low and gate feedback is legible — a confusing or absent contribute UX caps how fast the "~99% of the web with no API" gets closed. W06 has no engine dependency and blocks nothing critical-path; it is pure UX leverage on the flywheel's input side.

## 2. User/agent story
Two contributors land here:
- **Human developer** who used self-host APImeMCP to solve one site (hand-written script or `synthesize_schema`), now wants it in the community registry so web/app consumers get it too. They land on `/contribute`, see the manifest shape, scaffold via CLI, open a PR, and — critically — can find out *why* CI is red without first reading `quality-gates.md` themselves.
- **Calling agent** that ran F05 (`synthesize_schema`) or F06 (computer-use crystallization) and produced a working template+script. Per F04/F06's "never auto-merge" rule, a human still opens/reviews the PR, so the agent points its operator at `/contribute` (e.g. from the CLI's own output) to close the loop.

Both need the same two answers: "what exactly do I add, in what shape" and "what will automatically check it before any human looks at it."

## 3. Design

**Repo location — read this first.** W06 ships in the separate `apimemcp-platform` Turborepo (Locked decision ⑥ / `04-git-strategy.md`), **not** under `D:/MCP/src` — that path is the engine repo (Program 1) and this feature never touches it. Branch `feat/W06-contribute-flow` off `apimemcp-platform`'s `main` (that repo has no `integration` branch, unlike the engine repo — PRs land straight on `main` per the git-strategy table).

**ADR obeyed — ADR-06 (Registry as cross-repo contract):** "The `apimemcp-templates` manifest shape + the published `@neetigyashah/apimemcp` types are the ONLY contract between the engine repo and the platform repo. Platform consumes types via npm, never imports engine internals." Concretely: every type shown on this page (`ManifestEntry`, `outputSchema`) is `import type {...} from '@neetigyashah/apimemcp'` from the published npm package — never a relative import reaching into `D:/MCP/src`. If a shown field stops existing on the published type, this page's own `next build` (a type-check) fails — the drift guardrail is free.

**Routes/screens (Next.js App Router). No MCP tool here** — nothing registers via `registerXxxTool`; ADR-02 is engine-scoped (`src/tools/` convention) and doesn't apply to a content page:
- `apimemcp-platform/apps/web/app/contribute/page.tsx` — landing: why contribute, the step path (scaffold → verify locally → PR → gates), links to `apimemcp-templates`.
- `apimemcp-platform/apps/web/app/contribute/gates/page.tsx` — the gate explainer: G0-G8 as a timeline, plus the two registry-specific automated checks (F03 nightly re-verify, F19 lint-in-CI + `apimemcp add` scaffold).
- Nav wiring: add a `/contribute` entry to the shared nav config (`apimemcp-platform/apps/web/config/nav-links.ts` or the shared `layout.tsx`, whichever W01 established) and to the footer.

**Components:**
- `apimemcp-platform/apps/web/components/contribute/contribute-steps.tsx` — renders `ContributeStep[]`.
- `apimemcp-platform/apps/web/components/contribute/gate-timeline.tsx` — renders `GateStep[]` (mirrors `03-orchestration/quality-gates.md`'s G0-G8 table verbatim, so it never quietly drifts from the source of truth — resync by hand when that table changes).
- `apimemcp-platform/apps/web/components/contribute/example-manifest-card.tsx` — shows one real, already-merged template's manifest as a code sample + its live verification badge.

**Data shapes** — plain TS interfaces, not Zod. This is static, developer-authored content, never user input crossing a trust boundary, so runtime validation buys nothing; ADR-01's schema contract is for *template output*, a different thing:

```ts
// apimemcp-platform/apps/web/content/contribute-steps.ts
export interface ContributeStep {
  id: 'scaffold' | 'verify-local' | 'open-pr' | 'automated-gates' | 'human-review' | 'merged-live';
  title: string;
  body: string;          // markdown/MDX string
  cliHint?: string;      // e.g. "npx @neetigyashah/apimemcp add <domain>" (F19)
  gateRefs?: string[];   // e.g. ["F03","F19"] — cross-links into gate-timeline
}

// apimemcp-platform/apps/web/content/gate-steps.ts
export interface GateStep {
  gate: 'G0'|'G1'|'G2'|'G3'|'G3b'|'G4'|'G5'|'G6'|'G7'|'G8';
  name: string;          // "Spec","Build","Code-Review",...
  owner: string;         // role name from agent-roster.md
  dod: string;           // Definition of Done, copied verbatim from quality-gates.md
  conditional: boolean;  // true for G3/G3b/G4/G6 (bracketed in quality-gates.md)
  rejectsTo?: string;
}

// apimemcp-platform/apps/web/content/example-manifest.json
// a static snapshot of one real merged ManifestEntry (not fetched live — see Reuse notes)
```

```ts
// type-checked against the published package, never redeclared:
import type { ManifestEntry } from '@neetigyashah/apimemcp';
```

No new HTTP route, no new MCP tool, no new mobile screen — Web-only, read-only content surface.

## 4. Sub-tasks (S0-S11)
All 12 applicable — a content-and-nav feature still touches every S-slot at web scope; none N/A.
- **S0 Spec** — this document.
- **S1 Types** — `ContributeStep`/`GateStep` interfaces above; `ManifestEntry` imported (never redeclared) per ADR-06.
- **S2 Data/API client** — minimal: `example-manifest.json` is a checked-in static snapshot of one real merged template, not a live X07 fetch — W06's own Deps (`W03, registry`) don't include X07, and wiring a live call for one illustrative code sample isn't worth the dependency (refresh by hand if it goes stale; upgrade to a live X07 fetch only if that becomes a real complaint).
- **S3 Screens/components** — the 2 pages + 3 components above.
- **S4 Feature module** — co-located under `apps/web/{app/contribute,components/contribute,content}`.
- **S5 Route/nav wiring** — nav + footer link.
- **S6 Component tests** — see Test plan.
- **S7 e2e/device** — Playwright preview-smoke spec (web meaning); no device test (no mobile surface).
- **S8 Docs** — this spec; the page must *link to*, not fork, `apimemcp-templates/CONTRIBUTING.md` (single source of truth for contribution prose lives in the templates repo, since that's what a contributor actually clones).
- **S9 Review** — G2 Code-Review.
- **S10 Device/preview verify** — Vercel preview URL + axe a11y scan + Design Lead sign-off (web meaning: preview verify, no device involved).
- **S11 Merge** — PR into `apimemcp-platform`'s `main` (no integration branch on this repo).

## 5. Dependencies & sequencing
- **Hard dep: W03 (Registry browser + search).** W06 reuses W03's verification-badge/card rendering for the example-manifest preview rather than re-implementing it — must exist first (or at least export that component) before `example-manifest-card.tsx` can consume it.
- **Hard dep: "registry" (`apimemcp-templates` repo + F03/F19, Program 1).** The gate-explainer's registry-specific content (nightly re-verify badge meaning, `apimemcp add` CLI) is only accurate once F03 (nightly re-verify + badges) and F19 (`apimemcp add` CLI + lint-in-CI) have shipped. If W06 builds before F19 lands, the "scaffold via CLI" step ships as "coming soon — for now, copy this manifest by hand" (degrade gracefully; don't block on Program 1's wave).
- **Transitive:** W01 (monorepo scaffold) and W02 (design system) must exist — W06 is just another `apps/web` route consuming W02's tokens.
- **Unblocks:** nothing critical-path; it's a flywheel-strength feature, not a dependency of any other W/X/M feature.
- **Wave:** P2, alongside W05 (web run console) — both are "make the loop real" features landing after P0/P1 scaffolding.

## 6. Quality gates
**Applicable:** G0 Spec (Architect+Design Lead+Orchestrator) · G1 Build (`next build`/lint/component tests green — a `ManifestEntry` field drift breaks this, per ADR-06) · G2 Code-Review · **G3b Design** (Design Lead — matches phosphor/void identity + a11y floor; every UI PR gets this regardless of the catalog's Ar/Se/Lv flags, per quality-gates.md's "non-UI skip G3b") · G5 QA (component tests) · G6 Live-Verify, web meaning = preview-URL smoke, not a full Live-Verification-Gatekeeper escalation (catalog lists no "Lv" flag for W06 — Risk L, no perf claims to measure) · G7 Integration (merge to `apimemcp-platform` `main`) · G8 Promote+Deploy (Vercel deploy).
**Not applicable:** G3 Arch (no types/boundary/module/cross-repo *contract* change — it only consumes the existing ADR-06 contract, doesn't define a new one) · G4 Security (no auth, no secrets, no sandbox surface — public read-only content, no user data collected).

**Definition of Done:** `/contribute` and `/contribute/gates` are live on the deployed site and nav-linked; onboarding steps and gate table match `03-orchestration/quality-gates.md` and `apimemcp-templates/CONTRIBUTING.md` with no contradicting prose; the example manifest type-checks against published `@neetigyashah/apimemcp`; axe a11y scan reports 0 critical violations; Design Lead sign-off recorded; component tests + preview-smoke green; `status/W06.json` shows all 12 S-cells Done.

## 7. Test plan
Component tests (Vitest + React Testing Library, co-located):
- `apimemcp-platform/apps/web/components/contribute/contribute-steps.test.tsx` — renders all `ContributeStep` entries in order; the `open-pr` step's link href points at `github.com/.../apimemcp-templates`; `cliHint` renders as a `<code>` block verbatim.
- `apimemcp-platform/apps/web/components/contribute/gate-timeline.test.tsx` — renders exactly 9 gates (G0-G8, including the conditional G3/G3b/G4/G6); each `conditional: true` gate renders a "conditional" badge; owner strings match `agent-roster.md` role names.
- `apimemcp-platform/apps/web/components/contribute/example-manifest-card.test.tsx` — renders without throwing when fed a real `ManifestEntry`-shaped fixture; badge image `src` matches the same URL pattern W03's card uses (regex, not a hardcoded string, so it doesn't hard-couple to W03's exact markup).

Not engine/browser-touching in the `scripts/verify-*.mjs` sense (that pattern is for Playwright *template* verification — N/A here). Web equivalent instead:
- `apimemcp-platform/apps/web/e2e/contribute.spec.ts` (Playwright) — hits the deployed preview URL, asserts `/contribute` returns 200, the CTA link resolves (not a 404), and `/contribute/gates` renders 9 gate rows. This is what satisfies G6 for a web feature; no separate fixture file needed (fixture = the one static `example-manifest.json`).

## 8. Acceptance criteria (live, observable)
1. `curl -I https://<preview>.vercel.app/contribute` → `200`; page visibly lists the `ContributeStep`s including the exact CLI command from F19.
2. `/contribute/gates` renders 9 rows whose `name`/`owner`/`dod` text is byte-identical to the corresponding row in `03-orchestration/quality-gates.md` (diffable, not paraphrased).
3. `next build` fails loudly if `@neetigyashah/apimemcp` ships a semver-major that removes a `ManifestEntry` field this page renders — proving the ADR-06 type-only contract is load-bearing, not decorative.
4. The example template's badge `<img src>` on `/contribute` and its badge on `/registry` (W03) are the identical URL for the same `templateId` — screenshot-diffable via Playwright.
5. An axe-core scan (`@axe-core/playwright` or equivalent) against `/contribute` reports 0 critical/serious violations.

## 9. Reuse notes
- **Reuse W03's verification-badge/card component** for `example-manifest-card.tsx` — do not re-implement shields.io badge URL construction or card layout; import/compose it.
- **Reuse the published `ManifestEntry` type** (`@neetigyashah/apimemcp`) — do not redeclare a parallel "what a template looks like" interface; that's exactly the drift ADR-06 exists to prevent.
- **Reuse `03-orchestration/quality-gates.md` and `04-git-strategy.md`** as the copy source for the gate timeline and branch instructions — hand-sync, don't re-derive from memory.
- **Reuse `apimemcp-templates/CONTRIBUTING.md`** as the canonical contribution-steps prose — link/embed, don't fork a second copy that will drift.
- **Reuse W02's design tokens/components** (shadcn theme, phosphor/void palette) — no bespoke styling.
- No engine-side reuse targets apply here (`captureForensics`/`atomicWriteFile`/`withLock`/`registerTemplate`/`findTemplateByUrl`/`buildStandaloneScript` are all `D:/MCP/src` internals — ADR-06 forbids this repo from importing any of them).

## 10. Skills (setup + when-to-use)
Both key skills for W06 (`nextjs`, `documentation-and-adrs`) are **already available in this environment — no install step**, per `08-skills-matrix.md`'s "Already available" table. Builder still runs `npx skills check` first (idempotent, confirms both are present before writing code — that check *is* the reuse mechanism, not a formality).
- **`vercel:nextjs`** — official Vercel-authored skill (top reputation tier per the skill-quality bar: vendor > community > unknown). Guides **S3** (App Router conventions for the two new pages) and **S5** (nav/route wiring).
- **`documentation-and-adrs`** (one of the 24 `.agents/skills/` discipline skills, already installed). Guides **S0** (this spec) and **S8** — specifically its "don't fork a second source of truth" discipline, which is why this spec links to `CONTRIBUTING.md`/`quality-gates.md` rather than re-authoring their prose.
- **`context7-mcp`** — per the standing rule to fetch current library docs live: pull current Next.js App Router docs from Context7 for any live-doc question (route conventions, metadata API, etc.) during build rather than from training-data memory, per `08-skills-matrix.md`'s "Live docs for Next/Expo/Playwright/Clerk during build" row.
- No skills.sh install needed (unlike M-series' `expo-react-native-typescript`, etc.) — W06 has no candidate skill below the ≥1K-install bar to reject; the two it needs are already vendor/discipline-grade and present.
