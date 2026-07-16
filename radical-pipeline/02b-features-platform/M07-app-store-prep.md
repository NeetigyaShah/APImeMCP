# M07 — App-store prep

## 1. Summary

- **ID:** M07 · **Name:** App-store prep · **Program:** 2 (Consumer Platform) · **Surface:** Mobile
- **Wave:** P4 (terminal mobile wave — the only P4 row in the Program 2 catalog; nothing downstream depends on it)
- **Gates flagged in catalog:** `—` (no Ar/Se/Lv super-gate required; standard pipeline only)
- **Risk:** L
- **Key skills (catalog):** `expo-react-native-performance`, `banner-design`
- **Deps:** M01–M06 (all six prior mobile features must be functionally complete — scaffold, design system, browse, run, monitors, history/account)

**What & why.** M01–M06 produce a working Expo app runnable via Expo Go / internal distribution / TestFlight. M07 is the packaging step that turns that working app into a **store-submittable artifact**: real icons/splash/app identity, EAS build profiles for `production`, an `eas submit` config, and store-listing metadata (title/description/keywords/screenshots/privacy policy). It does **not** create store developer accounts, pay the Apple $99/yr or Google $25 fee, or click "submit for review" — per the catalog, "fees = owner step" — those remain an explicit, manual, owner-only action outside this pipeline.

**Market tie (00-vision.md).** Distribution is locked as "EAS build both platforms; internal/TestFlight/Expo Go free first; public store launch later (owner: Apple $99/yr, Google $25)." The mobile **monitors** feature (push-on-change: price drop / restock / new filing) is called out as "the consumer wedge" — the whole point of a phone-native front end for the community registry. M07 is what makes that wedge reachable by ordinary users via the public App Store / Play Store rather than only sideloaded/internal builds — it removes every blocker to submission *except* the owner's own account/payment step.

## 2. User/agent story

- **As the owner**, once the app works end-to-end (Run + Monitors screens functioning against real registry templates), I want it fully store-ready — correct icons, splash, bundle identifiers, versioning, privacy policy link, screenshots, and an `eas submit` config — so that the moment I decide to pay the store fees, submission is one `eas submit` command away, not a scramble through missing assets.
- **As the Mobile Builder agent**, I take the finished M01–M06 app and produce every store-readiness artifact (assets, config, metadata, build profile) without needing real store developer credentials to do so (those are owner-supplied secrets at submit time), and I prove it works by getting a `production`-profile EAS build to install and launch correctly on a device/simulator (G6).

## 3. Design

All work is in the **`apimemcp-platform`** Turborepo (04-git-strategy.md), inside the Expo app created by M01: `apimemcp-platform/apps/mobile/`. Nothing here touches the engine repo (`D:\MCP`, `src/`).

**ADR obeyed:** **ADR-06** (registry as cross-repo contract) — `apps/mobile` may only depend on the published `@neetigyashah/apimemcp` types + the registry manifest, never engine internals. M07's Definition of Done includes a grep-based guard that no import from an engine-internal path slipped into `apps/mobile` while wiring store config. ADR-02 (tool-module convention) is **N/A** — M07 registers no MCP tool. No other ADR applies (ADR-01/03/04 are result-shape/transform/metrics contracts irrelevant to build packaging; ADR-05 is credential-store scoping, irrelevant here).

**MCP tool / HTTP route / app screen:** **None.** M07 adds no `registerXxxTool` call, no X## HTTP route, and no new interactive Expo Router screen — only build-time config and static assets consumed by the screen tree M01–M06 already wired.

**Exact files (module-by-module):**

| Path | Purpose |
|---|---|
| `apimemcp-platform/apps/mobile/app.json` | App identity: name, slug, version, bundle IDs, icon/splash refs, permission strings |
| `apimemcp-platform/apps/mobile/eas.json` | EAS build profiles (`development`/`preview`/`production`) + `submit` block |
| `apimemcp-platform/apps/mobile/assets/icon.png` | 1024×1024 master icon |
| `apimemcp-platform/apps/mobile/assets/adaptive-icon.png` | Android adaptive foreground layer |
| `apimemcp-platform/apps/mobile/assets/splash.png` | Cold-start splash image |
| `apimemcp-platform/apps/mobile/assets/favicon.png` | Expo-web fallback icon (Expo always builds a web target) |
| `apimemcp-platform/apps/mobile/assets/screenshots/{ios,android}/*.png` | Store screenshots captured from the working M04 (Run) + M05 (Monitors) screens |
| `apimemcp-platform/apps/mobile/store/listing.ts` | Typed store-listing metadata (see below) |
| `apimemcp-platform/apps/mobile/store/listing.en-US.json` | The actual listing copy, validated against `listing.ts`'s shape |
| `apimemcp-platform/apps/mobile/scripts/verify-store-config.mjs` | Config/asset validator (mirrors engine's `scripts/verify-*.mjs` naming convention) |

**Data shapes.**

```ts
// apimemcp-platform/apps/mobile/store/listing.ts
export interface StoreListing {
  platform: "ios" | "android";
  locale: string;              // e.g. "en-US"
  title: string;                // iOS <=30 chars, Android <=50 chars
  subtitle?: string;            // iOS-only, <=30 chars
  shortDescription?: string;    // Android-only, <=80 chars
  description: string;          // full store description
  keywords: string[];           // iOS keyword field (Android has no keyword field — derives from description)
  privacyPolicyUrl: string;
  supportUrl: string;
  screenshots: { path: string; deviceClass: string }[]; // e.g. deviceClass "6.7in" / "phone"
}
```

```jsonc
// apimemcp-platform/apps/mobile/app.json (shape, values illustrative)
{
  "expo": {
    "name": "APImeMCP", "slug": "apimemcp", "version": "1.0.0", "orientation": "portrait",
    "icon": "./assets/icon.png",
    "splash": { "image": "./assets/splash.png", "backgroundColor": "#14100a" },
    "ios": { "bundleIdentifier": "com.apimemcp.app", "buildNumber": "1" },
    "android": {
      "package": "com.apimemcp.app", "versionCode": 1,
      "adaptiveIcon": { "foregroundImage": "./assets/adaptive-icon.png", "backgroundColor": "#14100a" }
    },
    "extra": { "eas": { "projectId": "<set by M01>" } }
  }
}
```

```jsonc
// apimemcp-platform/apps/mobile/eas.json (shape)
{
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": { "autoIncrement": true }
  },
  "submit": {
    "production": {
      "ios": { "appleId": "<owner env var, not committed>", "ascAppId": "<owner env var>" },
      "android": { "serviceAccountKeyPath": "<owner secret path, not committed>", "track": "internal" }
    }
  }
}
```

```ts
// apimemcp-platform/apps/mobile/scripts/verify-store-config.mjs (signature)
async function verifyStoreConfig(appJsonPath: string, easJsonPath: string, listingDir: string):
  Promise<{ ok: boolean; problems: string[] }>
```

Colors (`#ffb627` phosphor amber on `#14100a` void) come from M02/W02's shared design tokens, not re-derived here — see Reuse notes.

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | **Applicable** | This document |
| S1 Types | **Applicable** | `StoreListing` interface in `store/listing.ts` |
| S2 Data/API client | N/A | No new API calls — pulls only static assets already in the repo |
| S3 Screens/components | N/A | No new screens; icons/splash/screenshots are static build assets, not UI code |
| S4 Feature module | **Applicable** | The `app.json`/`eas.json`/`assets/`/`store/` set *is* the module |
| S5 Route/nav wiring | N/A | No navigation change |
| S6 Component tests | **Applicable (reinterpreted)** | `verify-store-config.mjs` validates config/asset presence + dimensions instead of a component test |
| S7 e2e/device | **Applicable** | `eas build --profile production` for both platforms, install-and-launch check |
| S8 Docs | **Applicable** | `store/listing.en-US.json` copy + a short "how to `eas submit` once you have store accounts" doc |
| S9 Review | **Applicable** | G2 Code-Review of the config/asset diff |
| S10 Device/preview verify | **Applicable** | G6: production build installs, shows correct icon/splash/name on device or simulator |
| S11 Merge | **Applicable** | G7 merge to platform `integration`/`main` |

## 5. Dependencies & sequencing

- **Hard deps:** M01 (Expo scaffold + registered EAS project), M02 (design tokens for icon/splash colors), M03–M06 (working screens to screenshot — Run and Monitors are the headline shots). All six must be functionally complete because listing screenshots and permission strings (e.g., push-notification copy for M05) depend on the real, finished feature set.
- **Unblocks:** Nothing in the dependency DAG — M07 is the only Wave/P4 row in Program 2, i.e. terminal. It unblocks the **owner's** real-world action (create store accounts, pay fees, run `eas submit`), which is explicitly outside the automated pipeline.
- **Wave:** P4.

## 6. Quality gates

Catalog marks no Ar/Se/Lv super-gate, so the standard `G0→G1→G2→[G3]→[G3b]→[G4]→G5→[G6]→G7→G8` pipeline applies with these conditionals resolved:

| Gate | Applies? | Note |
|---|---|---|
| G0 Spec | Yes | This file |
| G1 Build | Yes | CI: `expo prebuild` + config lint clean |
| G2 Code-Review | Yes | Config/asset diff, versioning correctness, no leaked credentials in `eas.json` |
| G3 Arch | **Skip** | No type/module/boundary change (quality-gates.md: "boundary-neutral skip G3") |
| G3b Design | **Light-touch, non-blocking** | Design Lead confirms icon/splash match M02/W02 tokens — quick check, not a full UI review, since assets are generated *from* the existing design system rather than new UI |
| G4 Security | **Skip** | Catalog doesn't flag it; no template execution or user data here. EAS/Apple/Google credentials referenced in `eas.json` are env-var placeholders only, handled by the Deployment Agent under standard CI-secret hygiene, not a gated security review |
| G5 QA | Yes | `verify-store-config.mjs` green in CI |
| G6 Live/Device-Verify | Yes | Mobile features get device/simulator verification per quality-gates.md; this is M07's core proof |
| G7 Integration | Yes | Merge to platform repo `integration` |
| G8 Promote+Deploy | Yes | Deployment Agent runs `eas build --profile production` for both platforms green; tags M07 done |

**Definition of Done:**
1. `app.json`/`eas.json` populated (no placeholder bundle IDs/version), all required icon/splash/adaptive-icon assets present at correct pixel dimensions.
2. `eas.json` has `development`/`preview`/`production` build profiles + a `submit` block (real secrets NOT committed).
3. Store listing doc has non-placeholder title/description/keywords/privacy-policy-url/support-url + ≥3 screenshots per platform.
4. `eas build --profile production` succeeds for iOS and Android; resulting build installs and launches correctly on device/simulator.
5. ADR-06 guard passes: no engine-internal import in `apps/mobile`.
6. Real store submission/payment is explicitly NOT in scope — owner step.

## 7. Test plan

- **`apimemcp-platform/apps/mobile/scripts/verify-store-config.mjs`** (the one artifact covering S6+S7, mirroring the engine's `scripts/verify-*.mjs` convention): checks (a) `app.json` parses and required fields are non-placeholder, (b) icon/adaptive-icon/splash files exist at required pixel dimensions, (c) `eas.json` has all three build profiles + a `submit` block, (d) grep-based ADR-06 guard — no import path in `apps/mobile` resolves outside `packages/shared` or the published `apimemcp` package.
- **Fixture:** `apimemcp-platform/apps/mobile/store/listing.schema.json` — a small JSON Schema for `StoreListing` (title/description length limits, required URL fields); the verify script validates `listing.en-US.json` against it. A hand-rolled check is enough here (ponytail: six string fields don't need a zod dependency in a repo that may not even have zod as a mobile dep).
- **Live verify (G6):** `eas build --profile production --platform all --non-interactive`, then install the resulting `.ipa`/`.aab` on a simulator/device and confirm icon, splash, and app name.
- No engine-side `*.test.ts` applies — M07 touches only the platform repo.

## 8. Acceptance criteria (live, observable proof)

1. `eas build --profile production --platform ios` and `--platform android`, run from `apps/mobile`, both complete and produce a downloadable build artifact.
2. Installing that build on a real device or simulator shows the correct icon on the home screen, the correct splash on cold start, and the correct app name — not Expo Go defaults.
3. `node scripts/verify-store-config.mjs` exits 0 and prints exactly which assets/fields it checked.
4. `store/listing.en-US.json` contains real (non-placeholder) copy for every `StoreListing` field, and the screenshot files it references exist on disk for both platforms.
5. The exact `eas submit --platform ios --profile production` / `--platform android` commands are documented and fail ONLY on missing real store credentials (the expected owner-step gap) — not on missing local config.

## 9. Reuse notes

Engine-repo reuse helpers (`captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`) are **N/A** — M07 lives entirely in the platform repo and touches no engine module. What M07 *does* reuse, so nothing is re-derived:
- **M02's design tokens** (phosphor amber `#ffb627` / void `#14100a`, IBM Plex Mono/Sans) — icon/splash colors come from these, not picked fresh.
- **M01's EAS project registration** (`extra.eas.projectId` in `app.json`) — M07 extends the existing `app.json`, it doesn't create a new Expo project.
- **`packages/shared`** (W01's Turborepo package) as the single source of any cross-surface constant touched here.
- **W01's CI wiring** (`vercel:deployments-cicd` / Turborepo pipeline) — add an `eas build` job to the existing CI, not a parallel CI system.
- **The engine repo's `scripts/verify-*.mjs` naming pattern** — pattern reuse only (naming/convention), no code shared across repos, consistent with ADR-06.

## 10. Skills (setup + when-to-use)

- **`pproenca/dot-skills@expo-react-native-performance`** (1K installs — meets the ≥1K bar) — `npx skills check` first (likely already installed by an earlier mobile feature under the durable-skills model; only `npx skills add pproenca/dot-skills@expo-react-native-performance -g -y` if missing). Guides **S7/S10**: store review and real users both penalize slow cold start / jank, so verify startup performance on the `production` profile build before treating M07 as done.
- **`ui-ux-pro-max:banner-design`** — already available in this environment (no install). Guides **S4**: generating icon/splash/screenshot assets that match the phosphor/void identity rather than generic defaults.
- **`mindrally/skills@expo-react-native-typescript`** (1.6K installs, already available per the skills matrix and near-certainly installed by M01–M06) — `npx skills check` before assuming a fresh install is needed; guides **S1/S4** for correct `app.config.ts`/EAS conventions.
- **Fallback: `context7-mcp`** for anything EAS-CLI-syntax-specific (`eas.json` schema, `eas submit` flags, `eas build` profile options) — EAS's CLI surface moves fast and no reputable ≥1K-install "EAS submission" skill exists distinct from the general Expo skill above, so pull live official Expo/EAS docs via Context7 rather than relying on training data for exact flag names, per the skill-quality bar in 08-skills-matrix.md.
