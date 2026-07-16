# W02 — Cross-surface design system

## 1. Summary

- **ID / Name:** W02 / Cross-surface design system
- **Surface:** Web (authored once, consumed by both Web and Mobile — this is the one feature explicitly cross-surface)
- **Wave:** P0 (same wave as W01; Design Lead is active from Phase 0 per `agent-roster.md`'s startup rule: *"Phase 0 = Orchestrator + Architect (+ Design Lead for Program 2 P0)"*)
- **Risk:** M
- **Gate owner:** Ar(Design Lead) — the Design Lead, not the generic Architect, blocks this feature (`agent-roster.md`: *"Design Lead … Owns the cross-surface design system (W02/M02); blocks UI PRs that break identity/a11y"*)

**What & why.** One shared token system (color/type/space/motion/a11y) codifying the already-decided "compiler/terminal" identity — phosphor amber `#ffb627` on void `#14100a`, **IBM Plex Mono** (machine output) + **IBM Plex Sans** (interface copy) — so the website (`shadcn` theme) and the mobile app (RN theme) render as *one product*, not two. Tied to the market angle in `00-vision.md`: the consumer platform's whole pitch is that community-run API access is trustworthy enough to paste your cookies into and safe enough to run from a phone — a deliberately distinctive, non-templated identity (explicitly avoiding "AI-default" cream+serif / black+neon / broadsheet looks) is part of *earning* that trust, and W08's "live compile-and-run hero" and W03's registry "ledger" only land if the whole surface — web today, native app once M02 lands — reads as the same coherent brand. W02 is the single place that identity is defined so every later screen inherits it instead of re-deriving it.

## 2. User / agent story

- *As a Web/Mobile Builder* about to implement any Program-2 screen (W03–W08, M02–M07), I import `@apimemcp/design-tokens`-equivalent exports instead of hand-picking a hex code or font — so every screen I ship matches the brand and clears the Design Lead's gate on the first pass instead of bouncing back from G3b.
- *As an end user* opening the website and later the mobile app, the two feel like one product — same amber-on-void terminal identity, same type rhythm, same focus/motion behavior — reinforcing "this is a coherent, deliberately-built thing" rather than "a website and an unrelated app that happen to share a backend."

## 3. Design

**Repo note (important):** W02 ships in the **`apimemcp-platform`** Turborepo (`04-git-strategy.md`), *not* under `D:/MCP/src` — that path is the separate engine repo (`apimemcp`) this spec's sibling F##-features live in. All paths below are relative to the platform repo root, which W01 (this feature's only hard dependency) scaffolds as `apps/web`, `apps/mobile`, `packages/shared`.

**ADRs obeyed.** No ADR lists W02 in its "Depended on by" column (checked against ADR-01..05 — schema/transform/metrics/vault/tool-module are all engine-internal concerns this feature never touches: no MCP tool, no runtime data, no secrets). The one that applies is the blanket **ADR-06** ("platform consumes engine types via npm, never engine internals — All of Program 2"), trivially satisfied: `packages/shared/design-tokens/` imports nothing from `apimemcp` at all, engine or published types. ADR-02 (`registerXxxTool`) is **N/A** — this feature registers no MCP tool and no HTTP route, only a static Next.js page.

**Scope call (ponytail):** kept inside the one named `packages/shared` package as a `design-tokens/` subfolder rather than registering a brand-new top-level workspace package — one less thing for G3(Arch) to review, one less `pnpm-workspace.yaml` entry. Add a dedicated `packages/design-tokens` member later only if `packages/shared` grows unwieldy.

**Scope call #2 (ponytail):** single dark "terminal" theme only. Nothing in `00-vision.md` / `website-design.md` asks for a light/dark toggle — the identity brief is one fixed palette ("phosphor amber on void"). Building theme-switching state, a second contrast-tested palette, and a toggle control would be unrequested scope. The schema below has **no** light/dark split; add a sibling palette + `ThemeProvider` toggle only when a future spec actually calls for it.

**Data shapes** (`packages/shared/design-tokens/schema.ts`):

```ts
import { z } from "zod";

export const DesignTokensSchema = z.object({
  color: z.object({
    bg: z.string(),          // "#14100a" — void base
    bgElevated: z.string(),  // panel/card surface, one step up from bg
    fg: z.string(),          // primary text
    fgMuted: z.string(),     // secondary text
    accent: z.string(),      // "#ffb627" — phosphor amber
    accentMuted: z.string(), // hover/disabled accent
    border: z.string(),
    success: z.string(),
    warning: z.string(),
    danger: z.string(),
  }),
  font: z.object({
    mono: z.literal("IBM Plex Mono"),   // machine output — code, registry ledger, JSON results
    sans: z.literal("IBM Plex Sans"),   // interface copy
    scale: z.array(z.number()).length(9), // px, e.g. [12,14,16,18,20,24,32,40,56]
  }),
  space: z.array(z.number()),  // 4px-base scale, e.g. [0,2,4,8,12,16,24,32,48,64,96]
  radius: z.object({ sm: z.number(), md: z.number(), lg: z.number(), full: z.number() }),
  // terminal identity = sharp, not soft — radius values stay small deliberately
  motion: z.object({
    durationMs: z.object({ fast: z.number(), base: z.number(), slow: z.number() }),
    respectsReducedMotion: z.literal(true), // documents the contract; enforcement lives in CSS/RN, not here
  }),
  a11y: z.object({
    focusRingWidth: z.number(),
    focusRingColor: z.string(),
    minTapTarget: z.number(), // >= 44, iOS/Android HIG floor
  }),
});
export type DesignTokens = z.infer<typeof DesignTokensSchema>;
```

**Module-by-module changes (new files unless noted):**

| Path | Purpose |
|---|---|
| `packages/shared/design-tokens/tokens.ts` | The actual const values satisfying `DesignTokensSchema` — the single source of truth. |
| `packages/shared/design-tokens/schema.ts` | `DesignTokensSchema` + `DesignTokens` type (above). |
| `packages/shared/design-tokens/contrast.ts` | Pure `contrastRatio(hexA, hexB): number` (WCAG relative-luminance formula — ~10 lines, no dependency). |
| `packages/shared/design-tokens/fonts.ts` | Font-family + weight manifest consumed by both apps' font-loading. |
| `packages/shared/design-tokens/index.ts` | Barrel: `tokens`, `DesignTokensSchema`, `DesignTokens`, `contrastRatio`. |
| `packages/shared/design-tokens/web/tailwind-preset.ts` | Tailwind preset mapping tokens → CSS custom properties using shadcn's `--background`/`--foreground`/`--primary`/etc. naming convention. |
| `packages/shared/design-tokens/native/theme.ts` | Flat RN-consumable theme object (`{ colors, fonts, space, radius }`) — framework-light on purpose: a plain object + a `useTheme()` context, *not* a Tamagui/RN-Paper dependency, since `mobile-app-design.md` leaves that component-kit choice open to M02. |
| `apps/web/tailwind.config.ts` (modified) | `presets: [designTokensPreset]` instead of hand-authored theme colors. |
| `apps/web/app/globals.css` (modified) | `:root` CSS vars — hand-authored once, checked against `tokens.ts` by the preview smoke test (S7) rather than building a codegen step now; add codegen only if drift becomes a recurring bug. |
| `apps/web/app/design-system/page.tsx` | New living style-guide screen: every color swatch, the type scale, the spacing scale, button/input/badge states, all in the one dark theme — the artifact the Design Lead reviews at G3b and the target of the S7 preview smoke check. Not an MCP tool or API route (ADR-02 N/A) — a plain Next.js page. |
| `apps/mobile/app/_layout.tsx` (modified) | Wraps the root in a `ThemeProvider` sourced from `native/theme.ts`. |
| `apps/web/scripts/verify-w02-design-system.mjs` | Playwright smoke script against the deployed preview URL (detail in §7). |

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document; Design Lead + Orchestrator sign-off before any Program-2 UI feature forks. |
| S1 Types | Applicable | `DesignTokensSchema` / `DesignTokens` in `schema.ts`. |
| S2 Storage / data-client | **N/A** | Tokens are compile-time constants — no runtime data, no API client, nothing persisted. |
| S3 Screens/components | Applicable | `tokens.ts`, `fonts.ts`, and the `/design-system` living style-guide page. |
| S4 Feature module | Applicable | `packages/shared/design-tokens/` subfolder (see scope call above). |
| S5 Route/nav wiring | Applicable | Tailwind preset wired into `apps/web/tailwind.config.ts`; `native/theme.ts` wired into `apps/mobile/app/_layout.tsx`; `/design-system` linked from web footer/dev nav. |
| S6 Component tests | Applicable | `index.test.ts` (schema + contrast) — see §7. |
| S7 e2e/device verify | Applicable, web only | Playwright preview-URL smoke of `/design-system`; **N/A for device** — W02 ships no native *screens*, only the inert `native/theme.ts` object M02 will actually render. |
| S8 Docs | Applicable | This spec + a short `packages/shared/design-tokens/README.md` for consumers. |
| S9 Review (G2) | Applicable | Standard Code-Reviewer pass. |
| S10 Live/device/preview verify (G6) | Applicable, web only | Vercel preview URL smoke; device verify deferred to M02 for the same N/A reason as S7. |
| S11 Merge | Applicable | Standard G7. |

## 5. Dependencies & sequencing

- **Hard dep:** W01 (needs the Turborepo skeleton — `apps/web`, `apps/mobile`, `packages/shared`, Vercel project, CI — before `design-tokens/` has a workspace to join and a pipeline to test in).
- **Wave:** P0 — runs immediately alongside/after W01.
- **Unblocks (explicit `Deps` references in the catalog):** W03 (registry browser), W08 (landing/hero), M01 (Expo scaffold), M02 (mobile design-system impl) all list W02 directly.
- **Unblocks (implicit, via the gate, not the Deps column):** every other Program-2 UI feature (W04–W07, M03–M07) — the Design Lead's G3b check ("matches design system") has nothing to check against until W02 merges, so in practice **no UI PR should reach G3b before W02 is in `integration`**.
- **Nothing blocks W02** itself beyond W01.

## 6. Quality gates

| Gate | Applies? | Note |
|---|---|---|
| G0 Spec | Yes | This doc; Design-Lead-authored (P0 exception in `agent-roster.md`), Orchestrator countersigns rather than peer-reviews. |
| G1 Build | Yes | Turborepo build + typecheck clean, including the new `design-tokens` subfolder. |
| G2 Code-Review | Yes | Standard. |
| G3 Arch | Applicable | New module inside an existing package (not a new workspace member — see scope call); confirms zero import from the engine repo (ADR-06). |
| G3b Design | Applicable (self-authored) | Design Lead owns this feature directly per the P0 startup rule — this gate is Orchestrator sanity-check, not peer block. |
| G4 Security | **N/A** | No secrets, no user input, no network call, no sandbox surface. |
| G5 QA | Yes | Vitest schema + contrast tests green. |
| G6 Live/Device-Verify | Applicable, web only | Preview-URL smoke (per `quality-gates.md`'s G6 definition, which explicitly allows "preview-URL smoke (web)" as an alternative to device runs). N/A for device — see S7. |
| G7 Integration | Yes | Should merge to `apimemcp-platform`'s `integration` immediately after W01 — every other Program-2 UI builder rebases onto it. |
| G8 Promote+Deploy | Yes | Bundled into the P0 wave's Vercel preview deploy; no independent versioned release (internal workspace package, not published outside the monorepo). |

**Definition of Done:**
- `packages/shared/design-tokens` builds and typechecks in the Turborepo.
- `DesignTokensSchema.parse(tokens)` passes; `contrastRatio(fg, bg) >= 4.5` and `contrastRatio(accent, bg) >= 3.0` (WCAG AA body / large-or-UI text).
- `apps/web/tailwind.config.ts` consumes the preset — zero hand-duplicated hex values live outside `tokens.ts`.
- `/design-system` renders on a real Vercel preview URL: every swatch/scale/component state, visible focus ring on every interactive example, no motion when OS-level reduced-motion is on.
- `native/theme.ts` exported, typed, ready for M02 — no native screen renders it yet (that's M02's job).
- Design Lead has signed off; merged to `integration`.

## 7. Test plan

- `packages/shared/design-tokens/contrast.test.ts` — unit-tests `contrastRatio()` itself against known reference pairs (e.g., black vs white ≈ 21:1) before anything else trusts it.
- `packages/shared/design-tokens/index.test.ts` (Vitest):
  - `DesignTokensSchema.parse(tokens)` does not throw.
  - `tokens.font.mono === "IBM Plex Mono"`, `tokens.font.sans === "IBM Plex Sans"`.
  - `contrastRatio(tokens.color.fg, tokens.color.bg) >= 4.5`.
  - `contrastRatio(tokens.color.accent, tokens.color.bg) >= 3.0`.
  - `tokens.a11y.minTapTarget >= 44`.
- Browser-touching, so per the spec template's rule, a live script: `apps/web/scripts/verify-w02-design-system.mjs` — Playwright against `process.env.PREVIEW_URL`, navigates to `/design-system`, asserts zero console errors, asserts `getComputedStyle(root).backgroundColor` matches the token-derived RGB (catches "CSS var drifted from `tokens.ts`"), and saves a screenshot artifact for the Design Lead. No fixture needed — no external site, no auth, just the deployed preview URL. (This is the platform-repo analogue of the engine's `scripts/verify-*.mjs` convention, not the same file/location — the engine's Playwright-verify pattern lives in `apimemcp`, not `apimemcp-platform`.)

## 8. Acceptance criteria (live, observable)

- `pnpm --filter design-tokens test` → green, with the actual contrast-ratio numbers visible in the output.
- Opening the deployed `/design-system` preview URL in a real browser: tab through every interactive swatch and see a visible focus ring; enable OS-level "reduce motion" and confirm no token-driven transition plays.
- `node apps/web/scripts/verify-w02-design-system.mjs $PREVIEW_URL` exits 0 and writes a screenshot.
- `grep -rn "#[0-9a-fA-F]\{6\}"` across `apps/web` and `apps/mobile` source (excluding `packages/shared/design-tokens`) returns zero hits — single-source-of-truth proven, not asserted.

## 9. Reuse notes

None of the engine repo's reuse helpers apply here (`captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`) — different repo, and a pure design-tokens package has no browser-automation, template-registry, or file-locking surface for any of them to serve. W02's own reuse contract, for its downstream consumers:
- W03, W08, M01, M02 (and transitively W04–W07, M03–M07) **import** `tokens`/`contrastRatio`/the Tailwind preset/`native/theme.ts` — never re-declare a color, font, or spacing value.
- `contrast.ts`'s `contrastRatio()` is the one a11y-contrast helper for the whole platform repo — later a11y tests (M02, W03) call it rather than re-implementing WCAG luminance math.
- The Tailwind preset is *imported* into `tailwind.config.ts`'s `presets: []`, never copy-pasted into a second config.
- `fonts.ts`'s manifest is shared by `apps/web` (`next/font`) and `apps/mobile` (`expo-font`) so both apps load the same weights from the same declared source.

## 10. Skills (setup + when-to-use)

**Setup:** `npx skills check` — confirms all four skills below are present. **No `npx skills add` needed**: per `08-skills-matrix.md`'s "Already available — no install" table, `frontend-design`, `ui-ux-pro-max:*`, `vercel:shadcn`, and `context7-mcp` all ship pre-installed in this environment, and `frontend-design` + `ui-ux-pro-max:design-system` are W02's own named `Key skills` in the Program-2 catalog row.

| Skill | Signal | Guides |
|---|---|---|
| `frontend-design` | Named directly in W02's catalog row; used to keep the identity *grounded* (per `website-design.md`: explicitly avoid the AI-default cream+serif / black+neon / broadsheet looks) rather than templated. | S0 (spec grounding), S3 (`tokens.ts`, `/design-system` page) |
| `ui-ux-pro-max:design-system` | Named directly in W02's catalog row; purpose-built for token-system structure. | S1 (schema shape), S4 (module layout) |
| `vercel:shadcn` | Official first-party Vercel skill (no reputation concern) — needed to get shadcn's CSS-variable theming convention exactly right rather than guessing. | S5 (Tailwind preset wiring) |
| `context7-mcp` | Per the standing rule to fetch live docs for any library/framework/API question rather than rely on training data — used specifically for current Tailwind preset API, shadcn theming conventions, `next/font`, and `expo-font` syntax, all of which shift across versions. | S5 (wiring), whenever an exact current API signature is needed |

Deliberately **not** pulled in: `dataviz` (that's for chart-bearing screens like W05/M04 — W02 renders swatches and type, not charts) and any Tamagui/RN-Paper-specific skill (component-kit choice is M02's, not W02's, per `mobile-app-design.md`).
