# M01 — Expo app scaffold

## 1. Summary

| Field | Value |
|---|---|
| ID | **M01** |
| Name | Expo app scaffold |
| Surface | Mobile (Program 2 — Consumer Platform) |
| Wave | **P1** |
| Gates | **Ar** (Architect / G3 only) |
| Risk | M |
| Deps | W01 (platform monorepo scaffold), W02 (cross-surface design system) |
| Key skills | `expo-react-native-typescript`, `vercel:auth` |

**What.** Stand up the native mobile app inside the new `apimemcp-platform` Turborepo: Expo Router file-based navigation, an EAS build config for iOS+Android, and Clerk auth wired to the **same accounts** used on the web (W07). Four placeholder tabs (Browse / Monitors / Runs / Account) give M02–M06 a shell to attach real screens to. No data-fetching, no themed components, no engine calls — those are explicitly out of this feature's row and land with later mobile features.

**Why.** Per `00-vision.md`, the phone is the consumer wedge: "get a push when a price drops / item restocks / a filing appears" only exists if there is a native app at all. RN+Expo is the locked decision (owner ⑤) specifically because the whole stack shares TypeScript types with the engine via ADR-06 and gets native iOS+Android + Expo Push from one codebase. M01 is the load-bearing scaffold — every other mobile feature (M02–M07) is additive on top of it; get the navigation/auth/build seams wrong here and all six downstream features re-pay the cost.

## 2. Story

- **As a consumer**, I open the app (Expo Go / EAS internal build / TestFlight) and see a sign-in screen; after signing in with my existing APImeMCP account I land on a 4-tab home shell — even before Browse/Run/Monitors have real content, the app *feels* like the product, not a demo.
- **As the Mobile Builder agent** picking up M02 (design system) or M03 (browse), I need navigation, auth-gating, and the build pipeline already solved so my PR is scoped to *my* screen, not to re-plumbing `expo-router` + Clerk + EAS from scratch.

## 3. Design

**Repo grounding (read this before the paths below).** `D:\MCP` is the **engine repo** (Program 1, publishes `@neetigyashah/apimemcp` to npm). Per owner decision ⑥ and `04-git-strategy.md`, Program 2 lives in a **separate, new `apimemcp-platform` Turborepo**, sibling to `D:\MCP`, on its own `main` branch (`main ← feat/M##`, no `integration` tier). M01 owns everything under `apimemcp-platform/apps/mobile/`. It does **not** add or touch a single file under `D:\MCP\src` — there is no engine-side surface to this feature.

**ADRs obeyed.**
- **ADR-06 (registry = cross-repo contract) — binding.** M01 must never import engine internals. In practice M01 has *no* template/result data flow yet (Browse and Run are M03/M04), so there is nothing to import from the engine at all — G3 Arch's check is trivially "zero relative imports into `D:\MCP\src` anywhere under `apps/mobile`," enforced by grep in Definition of Done. The one forward-looking rule: if any placeholder screen needs a shape later, it comes from the published `@neetigyashah/apimemcp` barrel, never a hand-copied type.
- **ADR-02 (tool-module convention) — N/A.** M01 registers zero MCP tools and touches zero engine files; `registerXxxTool` doesn't apply. The mobile analog of "wiring" is Expo Router's file-based routes, enumerated below as the screen "signature" table.

**Screen/route signatures (the ADR-02-equivalent registration list for a UI surface):**

| Route file | URL path | Renders | Landed by |
|---|---|---|---|
| `app/_layout.tsx` | root | `<AppProviders>` (Clerk + theme) wrapping `<Slot/>` | M01 |
| `app/(auth)/_layout.tsx` | `/(auth)` | Unauthenticated stack | M01 |
| `app/(auth)/sign-in.tsx` | `/sign-in` | Clerk hosted `<SignIn/>` | M01 |
| `app/(auth)/sign-up.tsx` | `/sign-up` | Clerk hosted `<SignUp/>` | M01 |
| `app/(tabs)/_layout.tsx` | `/(tabs)` | Auth-redirect guard + `<Tabs>` navigator | M01 |
| `app/(tabs)/index.tsx` | `/` | "Browse — coming in M03" stub | M01 stub → M03 impl |
| `app/(tabs)/monitors.tsx` | `/monitors` | "Monitors — coming in M05" stub | M01 stub → M05 impl |
| `app/(tabs)/runs.tsx` | `/runs` | "Runs — coming in M06" stub | M01 stub → M06 impl |
| `app/(tabs)/account.tsx` | `/account` | "Account — coming in M06" stub | M01 stub → M06 impl |

**Exact file paths (new, all under `apimemcp-platform/apps/mobile/`):**

```
apps/mobile/
  app.config.ts        eas.json            package.json
  tsconfig.json         babel.config.js     metro.config.js      .env.example
  app/_layout.tsx
  app/(auth)/_layout.tsx  sign-in.tsx  sign-up.tsx
  app/(tabs)/_layout.tsx  index.tsx  monitors.tsx  runs.tsx  account.tsx
  src/providers/AppProviders.tsx
  src/providers/clerk-token-cache.ts
  src/theme/ThemeProvider.tsx
  src/lib/env.ts
  src/lib/env.test.ts
  src/providers/AppProviders.test.tsx
```

**Data shapes.**

```ts
// src/lib/env.ts — validated once at boot (trust-boundary check, not padding)
import { z } from 'zod';
const EnvSchema = z.object({
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  EXPO_PUBLIC_API_BASE_URL: z.string().url(), // consumed starting M04, validated now so config drift fails at boot, not at first fetch
});
export const env = EnvSchema.parse(process.env);
```

```ts
// src/providers/clerk-token-cache.ts — Clerk's TokenCache interface, expo-secure-store backed
import * as SecureStore from 'expo-secure-store';
export const clerkTokenCache = {
  getToken: (key: string) => SecureStore.getItemAsync(key),
  saveToken: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  clearToken: (key: string) => SecureStore.deleteItemAsync(key),
};
```

```tsx
// app/(tabs)/_layout.tsx — auth gate, the crux of M01's navigation wiring
export default function TabsLayout() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: 'Browse' }} />
      <Tabs.Screen name="monitors" options={{ title: 'Monitors' }} />
      <Tabs.Screen name="runs" options={{ title: 'Runs' }} />
      <Tabs.Screen name="account" options={{ title: 'Account' }} />
    </Tabs>
  );
}
```

**Explicitly out of scope (do not build in M01 — matches the catalog row exactly, no scope creep):** no API client to X01 (M01 has no dep on X01; M04 owns that per its own Deps column), no TanStack Query / data-fetching provider (no M01 screen fetches anything — first fetch is M03's Browse, add the provider there when it's actually needed), no themed component library (M02's job — M01 only exposes a `ThemeProvider` seam that re-exports whatever token object W02 lands in `packages/shared`), no push-notification registration (M05).

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `env.ts` Zod schema; no engine types consumed yet (nothing to fetch) |
| S2 Data/API client | N/A | no dep on X01 in this feature's row; first client lands with M04 |
| S3 Screens/components | Applicable | `(auth)` sign-in/up, `(tabs)` 4 placeholder screens |
| S4 Feature module | Applicable | `AppProviders.tsx` (Clerk + theme composition) |
| S5 Route/nav wiring | Applicable | Expo Router groups + `eas.json` build profiles — the crux of this feature |
| S6 Component tests | Applicable | jest-expo smoke + redirect-guard tests (§7) |
| S7 e2e/device | N/A | catalog Gates = `Ar` only, no `Lv` flag for M01; first formal device-verify gate is M04. Manual simulator boot done as acceptance proof only (§8), not a blocking gate |
| S8 Docs | Applicable | `apps/mobile/README.md` — dev setup, env vars, EAS profiles |
| S9 Review | Applicable | G2 Code-Review, standard |
| S10 Device/preview verify | N/A | same reasoning as S7 |
| S11 Merge | Applicable | G7 Integration into `apimemcp-platform` `main` |

## 5. Dependencies & sequencing

- **Hard deps:** W01 (must exist first — provides the Turborepo root, the `apps/mobile` stub, `packages/shared`, `packages/config`, CI/CD) and W02 (provides the token object M01's `ThemeProvider` re-exports; M01 does not need M02's *component* implementation, just W02's raw tokens).
- **No Program 1 (engine) dependency.** Unlike M04 (needs F18/X01) or M06 (needs X06), M01 has zero F## in its Deps column — it can start the moment W01+W02 land, independent of engine wave progress.
- **Unblocks:** M02 (mobile design system impl — needs the provider tree + navigation to attach themed components to), which in turn unblocks M03→M04→M05/M06→M07. M01 is the single hard prerequisite for the entire M02–M07 chain.
- **Wave:** P1, inside Program 2's parallel pod (runs alongside W03/W07/X01-spike, concurrently with Program 1 Waves 1–2 per the "Program 2 depends on Program 1" note — M01 itself needs none of that, only later M03/M04 do).

## 6. Quality gates

Applicable: **G0** Spec (this doc) · **G1** Build (turborepo build clean, `expo-doctor` clean, lint) · **G2** Code-Review · **G3 Arch** (flagged `Ar` in the catalog — Architect confirms: zero imports into `D:\MCP\src`; `apps/mobile` imports only from `packages/*` + npm, never `apps/web` internals; ADR-02 confirmed N/A) · **G5** QA (jest-expo unit/component suite green) · **G7** Integration (merge to `apimemcp-platform` `main`, ordered after W01+W02) · **G8** Promote (EAS `development` profile build succeeds).

N/A: **G3b Design** (Design Lead gate belongs to M02, which owns the actual themed components; M01 ships Expo/Clerk defaults through a bare provider seam) · **G4 Security** (no secrets/cookies/untrusted templates touched — the Clerk publishable key is public-safe by design) · **G6 Live/Device-Verify** (not flagged `Lv` for M01; see S7/S10).

**Definition of Done:** `pnpm turbo run build --filter=mobile` exits 0; `expo-doctor` clean; app boots via `npx expo start` to `/sign-in` when signed out and to the 4-tab shell when signed in with a real Clerk test account; `eas build --profile development --platform android --local` succeeds; `grep -RE "MCP/src|\.\./apimemcp/src"  apps/mobile/src apps/mobile/app` returns nothing (ADR-06 clean); unit tests green; Architect G3 sign-off recorded in `radical-pipeline/05-tracking/status/M01.json`.

## 7. Test plan

Colocated `*.test.ts(x)` (jest-expo + RTL), following the engine repo's own colocated-test convention (`src/types.test.ts`):

- `src/lib/env.test.ts` — `EnvSchema.parse` throws on a missing `EXPO_PUBLIC_API_BASE_URL`; succeeds on a valid fixture env.
- `src/providers/AppProviders.test.tsx` — renders children without throwing; Clerk + Theme context values are readable by a probe child (smoke test for the provider tree).
- `app/(tabs)/_layout.test.tsx` — mocked `useAuth()` returning `{isSignedIn:false, isLoaded:true}` renders a `Redirect` to `/(auth)/sign-in`; `{isSignedIn:true}` renders `<Tabs>` with exactly 4 screens named `index/monitors/runs/account`.

**`scripts/verify-M01.mjs` — N/A.** That pattern is the engine repo's Playwright-driven live-verification for browser/engine-touching features (per the per-feature template's own qualifier, "if engine/browser-touching"). M01 has no engine or browser surface; its live-proof step is the manual simulator/EAS check in §8, not a scripted verify fixture.

## 8. Acceptance criteria (live, observable proof)

1. `cd apimemcp-platform && pnpm install && pnpm turbo run build --filter=mobile` → exit 0.
2. `pnpm --filter mobile exec expo start`, press `i`/`a` → app opens in iOS Simulator / Android emulator and shows the Clerk sign-in screen (signed-out state) — screenshot as evidence.
3. Sign in with a Clerk test user → navigates to the 4-tab shell; each tab shows its "coming in M0x" stub — proves the redirect guard and tab wiring work with zero real screen content.
4. `eas build --profile development --platform android --local` → completes, produces an installable `.apk`/build artifact.
5. `grep -RE "MCP/src|\.\./apimemcp/src" apps/mobile/src apps/mobile/app` → no output (ADR-06 boundary clean).
6. `pnpm --filter mobile test` → all green.

## 9. Reuse notes

The named engine helpers in the generic template (`captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`) are **N/A** — M01 makes zero engine calls, so none of them apply. Platform-side equivalents to reuse instead of reinventing:

- **W01's Turborepo scaffold** (`packages/shared`, `packages/config` tsconfig/eslint base, CI/CD) — extend it, don't hand-roll a parallel monorepo config.
- **W02's design tokens** — import the raw token object from `packages/shared` (exact workspace specifier is whatever W01/W02 name it — treat `packages/shared/package.json#name` as source of truth) rather than hardcoding colors/spacing; `ThemeProvider` in M01 is a thin pass-through seam, not a new token system.
- **`@clerk/clerk-expo`'s hosted `<SignIn/>`/`<SignUp/>`** components for the `(auth)` screens instead of hand-built auth forms — same vendor/account system as W07's web Clerk integration.
- **`expo-secure-store`** as Clerk's `tokenCache` — the standard, already-solves-it dependency; no bespoke secure-storage wrapper.
- **Expo Router's file-based routing** — the locked mobile-nav decision; no hand-rolled route registry.
- **The engine repo's `src/types.test.ts` Zod-test idiom** — same pattern (parse-success / parse-fail cases), reused for `env.test.ts` in a different repo.

## 10. Skills (setup + when-to-use)

- **`mindrally/skills@expo-react-native-typescript`** — 1.6K installs, clears the ≥1K bar. `npx skills check` first (reuse if a prior Program-2 agent already installed it); else `npx skills add mindrally/skills@expo-react-native-typescript -g -y`. Guides S1 (TS project config), S3/S5 (Expo Router conventions), and the EAS profile setup in S5.
- **`vercel:auth`** — already available, no install. Guides S2/S4's Clerk-Expo wiring (same auth vendor/account model as web's W07).
- **`context7-mcp`** — already available. Per the standing rule to fetch live docs for any library/SDK/CLI question rather than rely on training data: use it during actual implementation for current Expo Router API surface, `@clerk/clerk-expo` quickstart specifics, and `eas.json` schema/CLI flags, since these move fast enough that trained knowledge can lag. Not invoked while writing this spec (planning-only task, no implementation questions to resolve yet).
- **Deliberately not installing anything else.** No bespoke Expo/RN alternative skill — `expo-react-native-typescript` already clears the install-count bar, so per the skill-quality rule there's no reason to add a second, weaker one.
