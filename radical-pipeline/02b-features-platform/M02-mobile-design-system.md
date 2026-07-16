# M02 — Mobile design system impl

## 1. Summary

- **ID:** M02 · **Name:** Mobile design system impl · **Surface:** Mobile (Program 2 has no pillar column; Program 1's Fnd/A/B/C/D/E/F pillars don't apply here)
- **Wave:** P1 · **Risk:** M · **Gate:** `Ar(Design Lead)` — an architecture-weight gate, but owned by the Design Lead, not the Architect
- **Deps:** W02 (cross-surface design system — token source), M01 (Expo app scaffold — the app shell M02 builds inside)
- **What:** A native-look themed React Native component library (`apps/mobile/src/components/*`) plus a theme layer that maps W02's shared design tokens into RN styles — buttons, cards, inputs, list rows, empty states, a monospace "machine output" text primitive, and a verification-status badge. No screens' business logic, no data fetching — pure presentational substrate for M03–M07.
- **Why / market angle:** `00-vision.md` frames Program 2 as the phone-first "everyone" track (vs. the self-host "devs/agents" track) and calls the push-on-change monitor the consumer wedge. That wedge only lands if the app *feels* native and trustworthy, not like a webview bolted onto a dev tool — `mobile-app-design.md` is explicit: "RN core + a themed component system … respects iOS/Android conventions (not a webview)". M02 is the one feature that turns the web's phosphor-amber-on-void "compiler/terminal" identity into believable native UI, and it gates every other mobile screen's look (G3b-equivalent) so the brand doesn't drift feature-by-feature.

## 2. User/agent story

As a **Mobile Builder** picking up M03 (Browse/registry screens) next, I import `Button`, `Card`, `ListItem`, `VerificationBadge`, `MonoText` from `apps/mobile/src/components` and a `useTheme()` hook, and every screen I build automatically matches the site's identity, respects OS accessibility settings, and needs zero ad-hoc `StyleSheet` color literals. As a **consumer** on iOS/Android, the app reads as a real native product — system fonts never leak through, tap targets are reachable, VoiceOver/TalkBack announce controls correctly, and Reduce Motion is honored.

## 3. Design

**Repo location.** M02 lives entirely in the platform Turborepo (`apimemcp-platform`, per `04-git-strategy.md`), not `D:/MCP/src` — that path is the engine repo and per **ADR-06** the platform never imports engine internals. M02 touches only:

```
apimemcp-platform/
  packages/shared/src/tokens.ts        # OWNED by W02, read-only for M02
  apps/mobile/src/theme/theme.ts       # NEW — token → RN theme mapping, ThemeProvider, useTheme()
  apps/mobile/src/theme/theme.test.ts  # NEW
  apps/mobile/src/theme/README.md      # NEW — token + usage docs (S8)
  apps/mobile/src/components/Button.tsx            # NEW
  apps/mobile/src/components/Button.test.tsx        # NEW
  apps/mobile/src/components/Card.tsx               # NEW
  apps/mobile/src/components/Input.tsx              # NEW
  apps/mobile/src/components/MonoText.tsx           # NEW
  apps/mobile/src/components/ListItem.tsx           # NEW
  apps/mobile/src/components/EmptyState.tsx         # NEW
  apps/mobile/src/components/VerificationBadge.tsx        # NEW
  apps/mobile/src/components/VerificationBadge.test.tsx    # NEW
  apps/mobile/src/components/index.ts               # NEW — barrel, append-only
  apps/mobile/app/_design-system.tsx                # NEW — dev-only live preview screen
```

**Data shapes.** `packages/shared` owns the raw tokens (plain, serializable, no React import — consumable by web's Tailwind config *and* RN):

```ts
// packages/shared/src/tokens.ts (W02 owns; M02 reads)
export interface DesignTokens {
  colors: { bg: string; fg: string; accent: string; accentMuted: string;
            danger: string; warn: string; ok: string; border: string };
  typography: { mono: string; sans: string;
                scale: { xs: number; sm: number; md: number; lg: number; xl: number } };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
  radii: { sm: number; md: number; lg: number; pill: number };
  motion: { fast: number; normal: number; slow: number }; // ms
}
```

```ts
// apps/mobile/src/theme/theme.ts
export interface MobileTheme extends DesignTokens {
  fonts: { mono: string; sans: string }; // resolved post `useFonts()` family names
}
export function ThemeProvider({ children }: { children: React.ReactNode }): JSX.Element; // loads fonts, gates render until ready
export function useTheme(): MobileTheme;
export function useReducedMotionPref(): boolean; // wraps AccessibilityInfo.isReduceMotionEnabled + change listener
```

```ts
// apps/mobile/src/components/Button.tsx
export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; // default 'primary'
  size?: 'sm' | 'md' | 'lg';                                // default 'md'
  disabled?: boolean;
  accessibilityLabel?: string; // defaults to `label`
}
export function Button(props: ButtonProps): JSX.Element;
```

```ts
// apps/mobile/src/components/VerificationBadge.tsx — mirrors F03's shields.io badge states
export interface VerificationBadgeProps {
  status: 'verified' | 'stale' | 'broken';
  lastCheckedAt?: string; // ISO 8601, optional relative-time label
}
export function VerificationBadge(props: VerificationBadgeProps): JSX.Element;
```

`Card`, `Input`, `ListItem`, `EmptyState`, `MonoText` follow the same pattern (typed props interface + a single default export); each accepts no raw color/font props — everything comes from `useTheme()`.

**ADR-02 (tool-module convention) applicability.** ADR-02 governs MCP tool registration in the engine repo via `registerXxxTool(server, deps)`; M02 registers zero MCP tools. Its one "screen" — the dev preview — uses Expo Router's own file-based convention (`app/_design-system.tsx`, default-exported component), which is already append-only/conflict-free by construction, so no additional registry function is needed to satisfy the spirit of ADR-02. `apps/mobile/app/_design-system.tsx` guards itself: `if (!__DEV__) return null;` so it never ships in a store build.

**ADR-06 (registry = cross-repo contract) applicability.** M02 imports zero engine internals and zero published `@neetigyashah/apimemcp` types — it renders no template result data, only chrome/primitives. Its only cross-package import is `packages/shared` tokens, which is an in-monorepo (not cross-repo) dependency, so ADR-06 doesn't gate M02 directly. Flag for future specs: the moment any M02-family component needs to render a `ManifestEntry`/`outputSchema`-shaped value (that's M04's job), it must import it from the published npm package, never from `D:/MCP/src`.

**Theming approach (a deliberate reuse-over-build call).** `mobile-app-design.md` leaves the base open ("Tamagui / RN-Paper / custom"). M02 goes **custom**: a `React.Context` + `StyleSheet.create` per component, fed by `packages/shared` tokens. Tamagui/RN-Paper are compiler/theme frameworks sized for large multi-brand systems; this is ~10 brand-specific primitives on one theme. `// ponytail: custom context+StyleSheet over Tamagui — ceiling is ~15 primitives or multi-brand theming; revisit if either is crossed.`

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document |
| S1 Types | Applicable | `DesignTokens` (consumed), `MobileTheme`, per-component prop interfaces |
| S2 Data/API client | N/A | Pure presentational library; zero network/storage calls |
| S3 Screens/components | Applicable | `Button`, `Card`, `Input`, `MonoText`, `ListItem`, `EmptyState`, `VerificationBadge` |
| S4 Feature module | Applicable | `theme.ts` — `ThemeProvider`, `useTheme`, `useReducedMotionPref` |
| S5 Route/nav wiring | Applicable | `app/_design-system.tsx` dev-only preview route (Expo Router file convention) |
| S6 Component tests | Applicable | RN Testing Library render + a11y-prop assertions per primitive |
| S7 e2e/device (automated) | Applicable | Maestro flow: launch → open `_design-system` → tap through each variant/state |
| S8 Docs | Applicable | `apps/mobile/src/theme/README.md` — token list, usage, a11y floor |
| S9 Review (G2) | Applicable | Code-Reviewer: no hardcoded colors/fonts outside `theme.ts`, no reinvented RN primitives |
| S10 Device/preview verify (G6) | Applicable | Live-Verification Gatekeeper runs iOS simulator + Android emulator |
| S11 Merge (G7) | Applicable | Integration/Merge, platform repo `integration` → `main` |

## 5. Dependencies & sequencing

- **Hard deps:** W02 must have `packages/shared` tokens locked (colors/type/space/radii/motion) before M02's theme mapping is meaningful — M02 blocks on W02's spec landing, not necessarily its full G8. M01 must have `apps/mobile` scaffolded (Expo Router, TS config, EAS profile, Clerk auth wiring) since M02's files live inside it.
- **Unblocks:** M03 (Browse/registry screens), M04 (Run screen + result views), M05 (Monitors + push), M06 (Run history + account), M07 (App-store prep — icons/splash reuse the same token palette) — every later mobile screen imports M02's components instead of hand-rolling styles.
- **Wave:** P1, alongside W02, M01, X07, X02-spike — Program 2's foundational wave, running in parallel with Program 1 Waves 1–2 per PLAN.md's cross-program note.
- **Sequencing inside the wave:** land M02 early in P1 (same "clear the shared foundation first" principle as F00 on Program 1) so M03's builder never starts a screen against a moving component API.

## 6. Quality gates

| Gate | Applies? | Note |
|---|---|---|
| G0 Spec | Yes | Design Lead + Orchestrator sign off this spec |
| G1 Build | Yes | `apps/mobile` builds clean (Metro/EAS build check), lint passes |
| G2 Code-Review | Yes | Correctness + no reinvented RN/Expo primitives, minimal diff |
| G3 Arch (plain) | Skip | Superseded by the Design-Lead-owned gate below (catalog row: `Ar(Design Lead)`) |
| G3b / `Ar(Design Lead)` | Yes — **blocks** | Design Lead confirms token usage is exhaustive (zero raw hex/font-family literals in components), matches phosphor/void identity, sets the bar M03–M07's own G3b checks against |
| G4 Security | Skip | Not flagged; no X-surface, no secrets, no user data |
| G5 QA | Yes | Component test suite green (S6) |
| G6 Live/Device-Verify | Yes — **blocks** | Simulator (iOS) + emulator (Android) run of `_design-system`; Reduce Motion + VoiceOver/TalkBack spot-check |
| G7 Integration | Yes | Rebased onto platform `integration`, merged before M03 forks |
| G8 Promote | Yes (wave-level) | Part of P1 wave promote; EAS dev-client build succeeds with new fonts/components bundled |

**Definition of Done:** `apps/mobile/src/components` exports Button/Card/Input/MonoText/ListItem/EmptyState/VerificationBadge, all sourcing color/type/space/motion exclusively from `packages/shared` tokens via `useTheme()`; IBM Plex Mono + IBM Plex Sans load through `ThemeProvider` before first render; every interactive component carries an `accessibilityRole`/`accessibilityLabel` and a >=44×44pt hit target; Reduce Motion disables/shortens any animated transition; the `_design-system` dev screen renders every primitive/variant and is excluded from release builds; Design Lead has signed the `Ar(Design Lead)` gate.

## 7. Test plan

- `apps/mobile/src/theme/theme.test.ts` — pure: `ThemeProvider`'s token pass-through matches `packages/shared` input; `useReducedMotionPref` reflects `AccessibilityInfo` mock true/false.
- `apps/mobile/src/components/Button.test.tsx` — renders each `variant`/`size`; `onPress` fires; `accessibilityLabel` defaults to `label` when omitted; `disabled` blocks `onPress`.
- `apps/mobile/src/components/VerificationBadge.test.tsx` — each `status` renders its themed color + accessible label text (e.g. "Verified", "Stale", "Broken") rather than a bare color swatch.
- Not engine/browser-touching — **no `scripts/verify-M02.mjs`/Playwright fixture** (that pattern is for the Playwright-based engine repo). The live-proof equivalent is G6: Live-Verification Gatekeeper opens `_design-system` on an iOS simulator and an Android emulator and visually/behaviorally confirms it against this spec's Design section.
- Maestro flow (S7): `apps/mobile/.maestro/design-system-smoke.yaml` — launch app, navigate to preview route, tap each Button variant, assert no crash/red-box.

## 8. Acceptance criteria

1. `cd apimemcp-platform/apps/mobile && npx expo start`, press `i` (iOS simulator) and `a` (Android emulator); open the `_design-system` route from each.
2. Every primitive renders phosphor amber (`#ffb627`) accents on void (`#14100a`) background; `MonoText` visibly uses IBM Plex Mono, interface labels use IBM Plex Sans — no default system font visible anywhere on the screen.
3. Toggle the OS "Reduce Motion" accessibility setting; any pressed-state/transition animation in `Button`/`VerificationBadge` visibly shortens or disables.
4. Enable VoiceOver (iOS) / TalkBack (Android); focus each interactive component and hear its label/role announced correctly.
5. `npm test -w apps/mobile` is green (S6 suite).
6. The `_design-system` route returns `null` (invisible, unreachable) in an EAS release/production build.

## 9. Reuse notes

- Consume `packages/shared/src/tokens.ts` (W02) — never redefine colors/fonts/spacing locally in `apps/mobile`.
- Load fonts via Expo's own `expo-font` + `@expo-google-fonts/ibm-plex-mono` + `@expo-google-fonts/ibm-plex-sans` (already-published Expo Google Fonts packages) — do not vendor raw font files or write a custom font loader.
- Use `AccessibilityInfo.isReduceMotionEnabled()` (React Native core) and `react-native-reanimated`'s reduced-motion support (already a dependency of the default Expo Router template from M01) — do not write a custom OS-preference poller.
- `VerificationBadge`'s three-state semantics reuse F03's shields.io verified/stale/broken vocabulary (presentational mapping only — no network call, no dependency on `registry-client.ts`).
- Explicitly **not** reused (would be a boundary violation per ADR-06): `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript` — these are `D:/MCP/src` engine internals; M02 has no reason to and must not import them.
- Reuse RN core (`View`, `Pressable`, `Text`, `TextInput`, `FlatList`) + `StyleSheet.create` rather than adding Tamagui/RN-Paper (see Design section ladder call).

## 10. Skills (setup + when-to-use)

Run `npx skills check` first — M01's builder likely already installed the Expo/RN skill; only add what's missing.

| Skill | Signal | Guides |
|---|---|---|
| `frontend-design` (already available) | in-repo, no install | S0/S3 — visual fidelity to the phosphor/void identity |
| `expo-react-native-typescript` — `npx skills add mindrally/skills@expo-react-native-typescript -g -y` | 1.6K installs, verified | S3/S4/S5 — RN+TS component patterns, Expo Router file conventions for the dev preview route |
| `ui-ux-pro-max:design-system` (already available) | in-repo, no install | S0/S3 — token-to-component mapping discipline, a11y floor |

No ≥1K-install skill exists specifically for an RN theming framework (Tamagui/RN-Paper), which is moot here since M02 goes custom (Design section) — if a future feature needs one, fall back to `context7-mcp` for live official docs rather than a low-install skill.
