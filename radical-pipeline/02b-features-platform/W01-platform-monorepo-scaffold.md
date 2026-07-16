# W01 — Platform monorepo scaffold

## 1. Summary

| Field | Value |
|---|---|
| ID | **W01** |
| Name | Platform monorepo scaffold |
| Surface (Program 2's "pillar" column) | Web |
| Wave | **P0** (Program 2's foundation wave — runs in parallel with Program 1 Waves 1–2, per PLAN.md's cross-program note) |
| Risk | L |
| Gates | **Ar** (G3 Architecture — blocking) |
| Deps | — (none; W01 is the root of Program 2) |

**What.** Stand up the new **`apimemcp-platform`** Turborepo — `apps/web`, `apps/mobile`, `packages/shared` — with a linked Vercel project and CI/CD, per locked decision ⑥ ("Platform lives in a separate `apimemcp-platform` Turborepo"). This is scaffolding only: placeholder screens, no features.

**Why.** Every other Program 2 feature (W02–W08 web, X01–X07 cloud, M01–M07 mobile) forks a branch off this repo. Per **00-vision.md**, Program 2 is the "everyone, phone-first" track of the two-track product — the consumer wedge (registry browsing, run console, push-on-change monitors) that turns community-contributed templates into something a non-developer can use from a phone. W01 is the physical seam where that track starts existing as code; nothing in Program 2 can be built before it.

## 2. User/agent story

- As the **Orchestrator**, I need W01 merged with zero dependencies so the Program 2 pod (Web/Mobile/Cloud/Infra Builders) can fan out in Wave P0 without contending with Engine Builders on `D:\MCP\src` files or with each other on repo setup.
- As the **Web Builder** picking up W02–W08, I clone `apimemcp-platform`, run one install command, and my first PR adds a feature — not `turbo.json`.
- As the **Cloud/Infra Builder** picking up X01, I already have a Vercel project linked and an `apps/web/app/api/` convention to drop route handlers into.
- As the **Mobile Builder** picking up M01, I already have `apps/mobile` booting in Expo Go and `packages/shared` to import types from.

## 3. Design

**Template-adaptation note (read first):** the per-feature template asks for "exact file paths under `D:/MCP/src`". W01 has **none** — its entire deliverable lives in a **new, separate repository**, not inside `D:\MCP`. That separation is the point of **ADR-06**: the platform must never import engine internals. The only place `D:\MCP` is referenced below is as the npm dependency name (`@neetigyashah/apimemcp`) and as the sibling directory the new repo is cloned next to.

**ADR obeyed:** **ADR-06 (Registry = cross-repo contract)** — the only ADR W01 depends on (confirmed: ADR-06's "Depended on by" line lists "all of Program 2"; ADR-01/03/04/05 gate F## data-shape features, ADR-02 gates MCP-tool-adding features — W01 registers no tool). Concretely: `packages/shared` may import **only** `@neetigyashah/apimemcp`'s published types and the `apimemcp-templates` manifest shape — never a relative path into `D:\MCP\src`.

**Repo layout** (new repo, e.g. `D:\apimemcp-platform`, sibling to `D:\MCP`):

```
apimemcp-platform/
  package.json            # root: "workspaces": ["apps/*","packages/*"], packageManager: pnpm
  pnpm-workspace.yaml      # packages: ["apps/*","packages/*"]
  turbo.json               # pipeline: build, dev, lint, test, typecheck
  tsconfig.base.json       # shared compilerOptions; each workspace tsconfig extends this by relative path
  .gitignore               # node_modules, .next, .expo, .turbo, .vercel, dist, .env*.local
  .github/workflows/ci.yml # turbo build/lint/test/typecheck on push+PR
  README.md                # workspace map, ADR-06 boundary rule, local-dev steps
  apps/
    web/                   # Next.js App Router — hosts the SITE (W02-W08) AND cloud API routes (X01-X07)
      package.json         # deps: next, react, @apimemcp-platform/shared
      next.config.ts
      app/layout.tsx       # root layout placeholder
      app/page.tsx         # placeholder home page
      app/api/             # RESERVED, empty — X01 drops app/api/run/route.ts etc. here later
    mobile/                # Expo (React Native + TS) — bootstrapped via `npx create-expo-app`
      package.json         # deps: expo, react-native, expo-router, @apimemcp-platform/shared
      app.json
      app/_layout.tsx      # Expo Router root layout placeholder
      app/index.tsx        # placeholder home screen
  packages/
    shared/
      package.json         # name: "@apimemcp-platform/shared"; deps: "@neetigyashah/apimemcp"
      src/index.ts          # barrel — see below
      tsconfig.json         # extends ../../tsconfig.base.json
```

**Why cloud code lives inside `apps/web`, not a 4th app:** the catalog's own What-it-does column enumerates exactly three workspaces (`apps/web, apps/mobile, packages/shared`), and 04-git-strategy.md's deploy column lists **"web+cloud→Vercel"** as one target. X01's Vercel Functions are therefore Next.js Route Handlers under `apps/web/app/api/*/route.ts`, deployed as part of the same Vercel project — not a separate app. W01 reserves the empty `app/api/` directory; it creates no routes.

**`packages/shared/src/index.ts` sketch** (ADR-06 barrel — zero Playwright/Node-only imports, so it's consumable from web *and* Expo/edge):

```ts
// Re-export only the published contract (ADR-06) — never a relative import into D:\MCP\src.
export type { ManifestEntry, Manifest } from "@neetigyashah/apimemcp";
// outputSchema (ADR-01) rides along on ManifestEntry — nothing extra to re-declare yet.
// Later features (W04/X01/M04) add their own types here — this file is the shared home,
// not a finished contract. W01 seeds the barrel; it does not invent execution/result types.
```

No Zod schema is introduced by W01 — there is no runtime data to validate yet (X01 doesn't exist until P1). The "exact data shape" for this feature *is* the workspace/config wiring above, not a payload type.

**App screen signatures (placeholders only, per the "app screen" part of the ADR-02-style ask — no MCP tool, no HTTP route is registered by W01 itself):**

```tsx
// apps/web/app/page.tsx
export default function HomePage() { return <main>apimemcp-platform</main>; }

// apps/mobile/app/index.tsx  (Expo Router)
export default function HomeScreen() { return <View><Text>apimemcp-platform</Text></View>; }
```

**CI/CD & Vercel/EAS wiring:**
- `.github/workflows/ci.yml`: on push/PR to `main` and `feat/*` — `pnpm install --frozen-lockfile`, `turbo run build lint test typecheck`.
- Vercel project linked (`vercel link`) with **Root Directory = `apps/web`**; native Vercel GitHub integration handles preview deploys per PR and production deploy on `main` merge — no bespoke deploy workflow needed. Optional: `npx turbo-ignore` as the Vercel "Ignored Build Step" so an `apps/mobile`-only change doesn't trigger a web rebuild (standard Vercel+Turborepo recipe).
- `apps/mobile`: `eas init` to create the EAS project (build config only; no submit yet — that's M07).

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `packages/shared/src/index.ts` barrel re-exporting `@neetigyashah/apimemcp` types (ADR-06); root `tsconfig.base.json`. |
| S2 Data/API client | **N/A** | No backend exists yet — X01 lands P1. `packages/shared` today only re-exports types (S1), no client. |
| S3 Screens/components | Applicable | Placeholder root page (`apps/web/app/page.tsx`) + placeholder root screen (`apps/mobile/app/index.tsx`) only — real screens are W03+/M03+. |
| S4 Feature module | **N/A** | W01 *creates* the apps/packages; there's no single feature module inside an app yet — each later feature adds its own. |
| S5 Route/nav wiring | Applicable | Turborepo workspace wiring (`pnpm-workspace.yaml`, `turbo.json`), Next.js root layout, Expo Router root layout, reserved (empty) `app/api/` dir. |
| S6 Component tests | Applicable | One smoke test per workspace — build succeeds + placeholder renders without throwing. No deep logic yet to unit-test. |
| S7 e2e/device (author) | **N/A** | Catalog marks only **Ar** for W01 (no Lv gate) — no bespoke e2e/preview script authored. See Acceptance Criteria for the manual proof used anyway. |
| S8 Docs | Applicable | `apimemcp-platform/README.md`: workspace map, ADR-06 boundary rule, local-dev + deploy steps. |
| S9 Review | Applicable | G2 Code-Review — minimal diff, no premature abstractions (e.g., no `packages/config` split until a 4th workspace actually needs divergent tsconfig/eslint — see Reuse notes). |
| S10 Device/preview verify (execute) | **N/A** | Same reasoning as S7 — no Lv gate required; G1 build-green + G8 deploy-green is the operative proof for a scaffold. |
| S11 Merge | Applicable | G7 Integration — this is the **first** merge into `apimemcp-platform`'s `main` (bootstraps the repo, analogous to F00 being the first merge into `apimemcp`'s `integration`). |

## 5. Dependencies & sequencing

- **Hard deps:** none (catalog: `Deps: —`). W01 is the Wave-P0 root of Program 2.
- **What it unblocks (by catalog `Deps` column):**
  - **W02** (Deps: W01) — cross-surface design system needs the repo to place shared tokens in.
  - **W07** (Deps: W01) — auth/accounts/dashboard.
  - **W03/W04/W05/W06/W08** — transitively via W02/X07/F01/X01/X04 chains that all assume `apps/web` exists.
  - **M01** (Deps: **W01**, W02) — Expo app scaffold; explicit direct dependency.
  - **M02–M07** — transitively via M01.
  - **X01–X07**: their *formal* catalog `Deps` cite Program-1 prerequisites (F18, F15, registry, …), not W01 — but per the Design decision above, X01's Vercel Functions physically live inside `apps/web`. So W01 is a **de facto infra prerequisite** for all of X01–X07 even though it isn't in their listed Deps column; flagging this explicitly so the Cloud/Infra Builder doesn't look for a separate `apps/cloud` that doesn't exist.
- **Its wave:** P0 — the only Program 2 feature with zero deps, so it must land before any other W/X/M branch forks (mirrors F00's role as Program 1's Wave-0 foundation).

## 6. Quality gates

Pipeline: `Assigned → G0 Spec → G1 Build → G2 Code-Review → G3 Arch → [G5 QA] → G7 Integration → G8 Promote(+Deploy)`. G3b Design and G4 Security are skipped (non-UI, not security-flagged); G6 Live-Verify is skipped (catalog marks only **Ar**, no **Lv**).

| Gate | Owner | What it checks for W01 |
|---|---|---|
| G0 Spec | Architect + Orchestrator | This doc matches ADR-06, not a duplicate of any other W##. |
| G1 Build | Builder/CI | `turbo run build lint test typecheck` green for all 3 workspaces. |
| G2 Code-Review | Code-Reviewer | Minimal diff; no invented `packages/config`/`packages/ui` split before there's a second consumer needing it; workspace wiring correct. |
| **G3 Arch (blocks)** | Architect | ADR-06 compliance: `packages/shared` imports **only** `@neetigyashah/apimemcp` (verify via its `package.json` deps — no relative path resolves into `D:\MCP\src`); confirms `apimemcp-platform` is a genuinely separate git repo/remote from `apimemcp`; confirms the 3-workspace layout matches the catalog. |
| G5 QA | QA | Vitest (web + shared) / Jest+`jest-expo` (mobile) green; not deep, just non-empty and real. |
| G7 Integration | Integration | First merge to `apimemcp-platform`'s `main`; branch protection (no direct push, no self-merge) turned on immediately after. |
| G8 Promote+Deploy | Integration + Deployment + Orchestrator | Vercel project linked and first deploy green (placeholder page live at a real `*.vercel.app` URL); `eas init` done for `apps/mobile`. |

**Definition of Done:** `apimemcp-platform` exists as its own repo with `apps/web`, `apps/mobile`, `packages/shared` wired via `pnpm-workspace.yaml` + `turbo.json`; `packages/shared` has zero engine-internal imports (ADR-06 verified); `.github/workflows/ci.yml` runs `turbo build lint test typecheck` green on PR; a Vercel project is linked with Root Directory `apps/web` and has a green first deploy; `apps/mobile` boots in Expo Go/simulator; `main` has branch protection (no direct push, Integration sole-merger, per 04-git-strategy.md); README documents the workspace map and the ADR-06 boundary rule.

## 7. Test plan

- `packages/shared/src/index.test.ts` — Vitest: asserts the barrel's named re-exports (`ManifestEntry`, `Manifest`) resolve/compile from `@neetigyashah/apimemcp`. Boundary check is enforced as an **ESLint `no-restricted-imports` rule** (root `eslint.config.js`, pattern banning any specifier reaching into a sibling `MCP`/`apimemcp` path) rather than a bespoke script — reuses existing lint tooling instead of hand-rolling a new one; CI additionally runs a one-line `grep -rL` sanity check over `packages/shared/src` as cheap belt-and-suspenders.
- `apps/web/app/page.test.tsx` — Vitest + React Testing Library: renders `HomePage`, asserts no throw.
- `apps/mobile/app/index.test.tsx` — Jest (`jest-expo` preset, Expo's own default) + `@testing-library/react-native`: renders `HomeScreen`, asserts no throw.
- **No `scripts/verify-W01.mjs`.** W01 doesn't touch the engine or a browser-automation path (per the template's own "if engine/browser-touching" condition) — the operative proof is CI-green (G1) + a real Vercel deploy (G8), not a Playwright verify script.

## 8. Acceptance criteria (live, observable proof)

- Fresh `git clone` of `apimemcp-platform` + `pnpm install` at root succeeds with no manual steps.
- `npx turbo build` builds all three workspaces with zero errors.
- `npx turbo test` is green.
- `curl` (or a browser) against the deployed Vercel URL returns 200 and shows the placeholder home page text.
- `cd apps/mobile && npx expo start` boots Metro; the placeholder screen loads in Expo Go without a red-screen error.
- `grep` for any import specifier resolving outside `packages/shared` into a sibling `MCP`/engine path returns zero hits — the ADR-06 boundary is intact in practice, not just in the ESLint config.
- The CI badge on the initial `main` commit is green.

## 9. Reuse notes

- **Reuse `@neetigyashah/apimemcp`'s published types via npm** — this *is* the reuse mechanism ADR-06 mandates, instead of re-declaring `ManifestEntry`/`Manifest` by hand.
- **None of `captureForensics` / `atomicWriteFile` / `withLock` / `registerTemplate` / `findTemplateByUrl` / `buildStandaloneScript` apply here** — those are engine-internal (Playwright/file-IO) helpers in `D:\MCP\src`, explicitly out of bounds for the platform per ADR-06. Naming this so the builder doesn't go looking for them.
- **Reuse `vercel:next-forge`'s own Turborepo conventions** (turbo.json pipeline shape, root tsconfig pattern, pnpm choice) instead of hand-rolling a monorepo from scratch.
- **Reuse Vercel's native GitHub integration** for preview/production deploys instead of writing a custom deploy-on-PR workflow.
- **Reuse Expo's default TypeScript template** (`npx create-expo-app --template`) to bootstrap `apps/mobile` instead of hand-configuring Metro/Babel.
- **Deliberate simplification (ponytail):** a single root `tsconfig.base.json` extended by each workspace, no separate `packages/typescript-config`/`packages/eslint-config` — add a config package only when a 4th workspace needs genuinely divergent compiler/lint options, not preemptively for 3.

## 10. Skills (setup + when-to-use)

| Skill | Signal | Guides |
|---|---|---|
| `vercel:next-forge` | Official Vercel vendor skill, already available in this environment (no `npx skills add` needed — exempt from the install-count check per the skill-quality bar's "official vendor" tier) | S1/S5 — Turborepo layout, workspace/app conventions |
| `vercel:deployments-cicd` | Official Vercel vendor skill, already available | S8/S11/G8 — CI pipeline authoring, Vercel project link, promote/deploy |
| `context7-mcp` (fallback/supplement) | Already available; per 08-skills-matrix, "Live docs for Next/Expo/Playwright/Clerk during build" | Any point implementation needs exact current Next.js App Router / Turborepo / Expo Router API syntax rather than trained-in memory |

Both primary skills are **already installed/available** per PLAN.md's 08-skills-matrix (no `npx skills add` step for W01) — the matrix explicitly lists `vercel:next-forge` under "W01–W08 (Next.js App Router site, shadcn/ui, Turborepo scaffold)". The Web Builder should still run `npx skills check` first (idempotent, catches anything already installed for a prior feature) before assuming a gap.
