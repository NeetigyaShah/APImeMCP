# 08 — Skills Matrix: feature → best-quality skill, install list, and the context7 fallback

> **Rule in one line.** Every builder agent picks the *best* skill for its job —
> not merely *a* skill — installs only what it is actually missing, and where no
> reputable high-install skill exists it falls back to `context7` (live official
> docs) plus the vendor's own skill rather than settling for a weak community one.

This document is the single source of truth for **which skill guides which
feature**. It is consumed twice:

1. **At dispatch** — the Orchestrator copies a feature's row (its "best skill(s)"
   + install command + which sub-task each guides) into that feature's builder
   subagent prompt. The builder needs nothing else to set up.
2. **At verification** — every `Key skills` entry in the two feature catalogs
   (Program 1 `F00–F25`, Program 2 `W/X/M`) must resolve to a row here. If a spec
   names a skill this file does not list, the cross-reference check fails.

Skills are **global, durable, shared memory across all agents** (installed with
`-g`). A skill installed for an early feature is automatically present for every
later agent — that is the whole mechanism by which agents "reuse previous
skills." There is no per-agent skill store and no human in the install loop.

---

## 1. The skill-quality bar — pick the *best*, not just *a* skill

For each feature need, evaluate the candidate skills and take the strongest. The
bar, in priority order:

| Signal | Bar |
|---|---|
| **Install count** | **Prefer ≥ 1K installs. Reject anything < 100** — a skill nobody installs is unvetted surface area, not leverage. |
| **Source reputation** | Official vendor (`vercel:*`, `anthropics`, `microsoft`) **>** known community owner **>** unknown author. A first-party skill tracks the product; a random fork drifts. |
| **Repo stars / freshness** | Break ties by stars and recency. A 2K-install skill last touched two years ago loses to a fresher 1.2K one. |

**When no reputable ≥ 1K-install skill exists for a need, do not settle for a
weak one.** Use `context7` (live official docs, always current) together with the
vendor's own first-party skill. A shallow 60-install community wrapper is worse
than the real docs — it adds a layer to debug without adding correctness.

**Verified rejections (measured, not assumed).** The three areas people would
reach for a community skill all top out well under the bar:

| Area | Best community skill found | Installs | Verdict |
|---|---|---|---|
| Cloudflare / Workers | top hit | **142** | ❌ rejected → `context7` + official Cloudflare docs |
| serverless-Chromium (`@sparticuz/chromium`) | top hit | **75** | ❌ rejected → `context7` + package README/docs |
| Playwright | top hit | **63** | ❌ rejected → `context7` (and we own the Playwright layer deeply already) |

Each feature's `Key skills` catalog column is the **vetted pick**. Each spec's
*Skills* section (template item 10) carries three things per skill: the **quality
signal** (install count / source), the **install command**, and **which sub-task
(S#)** it guides.

---

## 2. Independent per-task setup & reuse (self-service, no human step)

Every builder agent, **before writing any code**, runs exactly this sequence:

```bash
npx skills check                      # what's already installed globally — reuse it, install nothing twice
npx skills add <pkg> -g -y            # only for THIS feature's still-missing skills
```

- **Reuse first.** `npx skills check` reflects the shared global store. If an
  earlier feature already installed the skill this feature needs, it is already
  here — the agent skips straight to coding.
- **Install only the delta.** The agent installs only the skills its own feature
  requires and that `check` reports missing. No bulk pre-install, no "just in
  case."
- **Idempotent & per-task.** Re-running `add` on an already-installed skill is a
  no-op. Setup is safe to repeat and needs no coordination between parallel
  agents.
- **No human step.** `-y` accepts non-interactively. A dispatched subagent sets
  itself up start to finish with zero prompts.

---

## 3. Already available in this environment — **no install** (assign at build time)

These are present now. Builders assign them directly; `npx skills add` is never
run for anything in this section.

| Skill(s) | Applied to |
|---|---|
| **The 24 `.agents/skills/`** (see full list below) | Every builder / QA / review / orchestration role — the disciplines each role enforces on every PR |
| `frontend-design`, `ui-ux-pro-max:*` (`design`, `design-system`, `ui-styling`, `banner-design`), `dataviz` | W02 / W03–W08 / W05, M02–M06 — result charts & tables, the cross-surface design system, marketing + app-store assets |
| `vercel:nextjs`, `vercel:shadcn`, `vercel:react-best-practices`, `vercel:next-forge` | **W01–W08** — Next.js App Router site, shadcn/ui, Turborepo scaffold |
| `vercel:vercel-functions`, `vercel:vercel-sandbox`, `vercel:workflow`, `vercel:runtime-cache`, `vercel:routing-middleware`, `vercel:vercel-firewall` | **X01–X05** — serverless exec API, **microVM to run untrusted community templates**, **durable jobs/monitors**, edge rate-limit / WAF |
| `vercel:vercel-storage`, `vercel:auth`, `vercel:env-vars`, `vercel:vercel-cli`, `vercel:deployments-cicd` | **X07 / W07 / M01** — Postgres / Redis / Blob, Clerk auth, deploys, EAS |
| `context7-mcp` | Live docs for Next / Expo / Playwright / Clerk / Cloudflare / OTel during build — **and the mandated fallback** (§5) |
| `using-apimemcp`, `deep-research` | Engine usage patterns; market / competitive validation |

**The 24 `.agents/skills/` in full** (all first-party, all present — the discipline layer every role runs):

`api-and-interface-design` · `browser-testing-with-devtools` · `ci-cd-and-automation` · `code-review-and-quality` · `code-simplification` · `context-engineering` · `debugging-and-error-recovery` · `deprecation-and-migration` · `documentation-and-adrs` · `doubt-driven-development` · `frontend-ui-engineering` · `git-workflow-and-versioning` · `idea-refine` · `incremental-implementation` · `interview-me` · `observability-and-instrumentation` · `performance-optimization` · `planning-and-task-breakdown` · `security-and-hardening` · `shipping-and-launch` · `source-driven-development` · `spec-driven-development` · `test-driven-development` · `using-agent-skills`

---

## 4. To install from skills.sh (verified install counts)

Only **three** skills clear the bar and are not already present. Each is ≥ 1K
installs from a reputable owner. Install with the command shown.

| Skill | Installs | Source | Used by | Install |
|---|---|---|---|---|
| `mindrally/skills@expo-react-native-typescript` | **1.6K** | known community | **M01–M07** — Expo + React Native + TypeScript mobile app | `npx skills add mindrally/skills@expo-react-native-typescript -g -y` |
| `pproenca/dot-skills@expo-react-native-performance` | **1K** | known community | **M** (list virtualization, startup time, mobile perf) | `npx skills add pproenca/dot-skills@expo-react-native-performance -g -y` |
| `sickn33/antigravity-awesome-skills@bullmq-specialist` | **1.5K** | known community | **X03 only if/when a worker is added** (deferred by the free-tier-first decision) | `npx skills add sickn33/antigravity-awesome-skills@bullmq-specialist -g -y` |

**Deliberately NOT installed:**

- **Playwright skills** — top hit only **63** installs. The project *is*
  Playwright and we know it deeply; use `context7` for API docs.
- **Swift-native push skill** — iOS-only. Expo's own Notifications API covers
  cross-platform push (APNs + FCM), already covered by the Expo skill.
- **Cloudflare / Workers** (**142**) and **serverless-Chromium** (**75**) — both
  below the bar. The Cloud/Infra Builder uses `context7` + official Vercel /
  Cloudflare docs for X01 / X02 instead (§5).
- **Oracle Cloud Always-Free** (hosting-options free matrix) — no skill exists at
  any install count; `context7` + official Oracle docs.

The execution agent **re-runs `npx skills find <query>` per workstream** in case a
higher-quality skill has appeared since this plan was written, and installs only
≥ 1K-install skills from reputable owners.

---

## 5. The context7 fallback — areas with no ≥ 1K-install skill

Three build areas have **no** skill that clears the quality bar. The rule is not
"install the best available" — it is **use the live docs, which are always
current, plus the relevant first-party vendor skill.** `context7-mcp` is already
present (§3), so this needs no install.

| Area | Why no skill | What to use instead | Features |
|---|---|---|---|
| **Cloudflare / Workers / Pages / Browser Rendering / D1 / R2** | best community skill 142 installs, below bar | `context7` (live Cloudflare docs) + official Cloudflare docs | X01/X02 alt hosting path, the $0 free matrix (hosting-options) |
| **serverless-Chromium** (`@sparticuz/chromium` in a Vercel Function) | best community skill 75 installs, below bar | `context7` + the package's own README/docs; pair with the first-party `vercel:vercel-functions` / `vercel:vercel-sandbox` skills for the surrounding runtime | X02 light-path execution, the X02 feasibility spike |
| **Playwright** | best community skill 63 installs; we own this layer | `context7` (live Playwright API docs) — no wrapper skill | F00, F04, F05, F06, F09 and every browser-driving engine feature |

Pattern: **first-party vendor skill for the surrounding platform** (`vercel:*`) **+
`context7` for the specific library API** that has no worthy skill. That
combination is strictly better than a sub-100-install community wrapper: current
docs, no extra layer to debug.

---

## 6. Per-feature best-skill assignment

### 6a. Program 1 — API Engine (F00–F25)

**Baseline for every engine feature** (assumed, not repeated per row):
`test-driven-development` + `incremental-implementation` for the build;
`code-review-and-quality` + `code-simplification` at review; plus the gate-owning
disciplines (`security-and-hardening` on Security-gated features,
`browser-testing-with-devtools` + `performance-optimization` at Live-Verify). The
column below names each feature's **standout** skill(s) and the **`context7`
target** — the specific library it integrates that has no worthy skill.

| ID | Feature | Standout skill(s) beyond baseline | context7 target |
|---|---|---|---|
| **F00**★ | App-connections hardening & merge | `security-and-hardening`, `git-workflow-and-versioning` (merge in-flight work), `browser-testing-with-devtools` | Playwright persistent context / storage state |
| **F01**★ | Schema contracts | `spec-driven-development`, `api-and-interface-design` | zod, JSON Schema |
| **F02**★ | Drift detection | `code-simplification` (reusable diff primitive) | — |
| **F03**★ | Nightly re-verification + badges | `ci-cd-and-automation` | GitHub Actions, shields.io |
| **F04**★ | Self-healing templates | `security-and-hardening` (**never auto-merge**), `browser-testing-with-devtools` | Playwright DOM forensics |
| **F05** | synthesize_schema (agent-native) | `spec-driven-development`, `api-and-interface-design` | Playwright `renderPage` |
| **F06** | Computer-use crystallization | `security-and-hardening`, `browser-testing-with-devtools` | computer-use / Playwright recording |
| **F07** | Template pipelines / DAG | `spec-driven-development`, `api-and-interface-design` | — |
| **F08** | CEL conditional branching | `test-driven-development` (port Kriya's evaluator) | CEL spec / `cel-js` |
| **F09** | Bidirectional flows | `security-and-hardening` (write path), `spec-driven-development` | Playwright form-fill |
| **F10** | Transform / normalize layer | `code-simplification`, `api-and-interface-design` | — (jq-like, in-house) |
| **F11** | Signed provenance receipts | `security-and-hardening` | `node:crypto` signing |
| **F12** | Policy engine | `security-and-hardening` | robots.txt / ToS parsing |
| **F13** | Encrypted credential vault | `security-and-hardening` | `node:crypto` (AEAD) |
| **F14** | Metrics 2.0 (SLA) | `observability-and-instrumentation` | — |
| **F15** | `static-http` template kind | `performance-optimization` (10–50× claim) | cheerio |
| **F16** | Short-TTL result cache | `performance-optimization` | — (in-mem Map TTL) |
| **F17** | OpenTelemetry observability | `observability-and-instrumentation` | OpenTelemetry JS SDK |
| **F18** | Ephemeral hosted endpoint | `security-and-hardening`, `shipping-and-launch` | Node HTTP / Vercel Function (via `vercel:vercel-functions`) |
| **F19** | Close items 4/5 gaps | `ci-cd-and-automation`, `documentation-and-adrs` | GitHub Actions (lint-in-CI) |
| **F20** | Change-monitoring mesh | `observability-and-instrumentation` (**reuses F02 diff**) | — |
| **F21** | NL→template one-shot | `spec-driven-development`; `using-apimemcp` | — (wraps F05+F06) |
| **F22** | Semantic template discovery | `api-and-interface-design` | embeddings / local search lib (if adopted) |
| **F23** | Golden-snapshot regression | `test-driven-development` | — |
| **F24** | Marketplace reputation + semver | `git-workflow-and-versioning`, `documentation-and-adrs` | semver |
| **F25** | OpenAPI + client export | `api-and-interface-design`, `spec-driven-development` | OpenAPI generators |

★ = critical path.

### 6b. Program 2 — Consumer Platform (W / X / M)

From the catalog `Key skills` column. Web/Cloud skills are first-party
`vercel:*` (already present, §3); Mobile adds the two Expo skills from §4.

| ID | Feature | Surface | Best skill(s) |
|---|---|---|---|
| **W01** | Platform monorepo scaffold | Web | `vercel:next-forge`, `vercel:deployments-cicd` |
| **W02** | Cross-surface design system | Web | `frontend-design`, `ui-ux-pro-max:design-system`, `vercel:shadcn` |
| **W03** | Registry browser + search | Web | `vercel:nextjs`, `vercel:shadcn`, `ui-ux-pro-max` |
| **W04** | Template detail + schema/docs | Web | `vercel:nextjs`, `dataviz` |
| **W05** | Web run console | Web | `vercel:nextjs`, `dataviz`, `ui-ux-pro-max:ui-styling` |
| **W06** | Contribute flow | Web | `vercel:nextjs`, `documentation-and-adrs` |
| **W07** | Auth + accounts + dashboard | Web | `vercel:auth`, `vercel:vercel-storage` |
| **W08** | Landing + interactive hero | Web | `frontend-design`, `ui-ux-pro-max`, `ui-ux-pro-max:banner-design` |
| **X01** | Execution API gateway | Cloud | `vercel:vercel-functions`, `vercel:vercel-firewall`, `vercel:routing-middleware`, `vercel:auth` |
| **X02** | Safe registry-only runtime | Cloud | `vercel:vercel-sandbox`, `vercel:vercel-functions`, `security-and-hardening` — **+ `context7` for `@sparticuz/chromium`** (§5) |
| **X03** | Durable jobs + heavy fallback | Cloud | `vercel:workflow` (`bullmq-specialist` deferred until a worker is added) |
| **X04** | Results delivery | Cloud | `vercel:vercel-functions`, Expo push (via `expo-react-native-typescript`) |
| **X05** | Monitors service | Cloud | `vercel:workflow`, Vercel Cron |
| **X06** | Encrypted cookies + vault | Cloud | `security-and-hardening`, `vercel:vercel-storage` |
| **X07** | Registry mirror/cache DB | Cloud | `vercel:vercel-storage`, `vercel:runtime-cache` |
| **M01** | Expo app scaffold | Mobile | `expo-react-native-typescript`, `vercel:auth` |
| **M02** | Mobile design system impl | Mobile | `frontend-design`, `expo-react-native-typescript`, `ui-ux-pro-max` |
| **M03** | Browse/registry screens | Mobile | `expo-react-native-typescript` |
| **M04** | Run screen + result views | Mobile | `expo-react-native-typescript`, `dataviz` |
| **M05** | Monitors + push | Mobile | `expo-react-native-typescript` + Expo push |
| **M06** | Run history + account + cookies | Mobile | `expo-react-native-typescript`, `security-and-hardening` |
| **M07** | App-store prep | Mobile | `expo-react-native-performance`, `ui-ux-pro-max:banner-design` |

**Cloudflare note (free-tier / hosting-options).** Any feature routed through the
$0 free matrix (Cloudflare Pages / Browser Rendering / D1 / R2, Oracle Always-Free
worker, GitHub Actions cron) has **no qualifying skill** and uses `context7` +
official vendor docs per §5.

---

## 7. Refresh & cross-reference contract

- **Refresh.** Before each workstream, the execution agent re-runs
  `npx skills find <query>` for that workstream's needs. If a new ≥ 1K-install
  skill from a reputable owner has appeared, add it here and update the affected
  specs; otherwise the picks above stand.
- **Cross-reference (verification hook).** Every `Key skills` entry in both
  feature catalogs, and every skill named in any `02a/02b-*` spec's *Skills*
  section, **must appear in this file** — either in §3 (already available), §4 (to
  install), or as a §5 `context7` fallback. A dangling skill reference fails the
  package coherence check (PLAN "Cross-refs resolve").
