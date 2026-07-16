# APImeMCP "Radical Pipeline" — Master Blueprint (Two Programs)

## Context

**Why this exists.** APImeMCP (local-first TypeScript MCP server, npm `@neetigyashah/apimemcp` v1.5.0) is the seed of *an open, agent-native, self-growing universal API layer over the ~99% of the web and enterprise software that has no API*. The owner wants the full realization of that vision planned in depth — as **plans only**, to hand to *other* agents — split into two programs:

- **Program 1 — API Engine (MCP server).** The deterministic universal-API engine: schema contracts, drift detection, self-healing, agent-native authoring, pipelines, provenance, sandboxing, perf. Features **F00–F25**.
- **Program 2 — Consumer Platform.** Makes community APIs usable by *anyone from a phone*: a **community website** (Vercel), a **cloud execution layer** (because phones can't run Playwright), and a **native iOS+Android mobile app** that browses *and runs* community APIs and pushes results straight to the phone. Features **W01–W08 (web), X01–X07 (cloud), M01–M07 (mobile)**.

**This plan builds the plans, not the product.** On approval, an executing agent creates the in-repo `radical-pipeline/` package (deep specs for all ~48 features, orchestration playbook, git strategy, skills matrix, design docs, and a styled 3-sheet Excel tracker). It does **not** build any feature.

**Locked decisions (owner).** ① Package in-repo at `D:\MCP\radical-pipeline\` (committed). ② Excel via `pip install openpyxl` → styled `.xlsx`. ③ **Full deep spec for every feature.** ④ In-flight "app-connections" work folded in as **F00**, reviewed/merged first. ⑤ Mobile = **React Native + Expo** (my decision — shared TS/types with backend+web, one codebase → native iOS+Android via EAS, first-class Expo Push for "results to your phone"). ⑥ Platform lives in a **separate `apimemcp-platform` Turborepo**. ⑦ Cloud execution = **Vercel-native, free-tier-first** (Functions + Sandbox + Workflow + Cron; heavy paginated templates fall back to "run on self-host" until a worker is added). ⑧ Mobile **built for both stores, distributed free first** (EAS internal / TestFlight / Expo Go; public store launch is a later owner step: Apple $99/yr, Google $25). ⑨ A **free-hosting matrix** is documented (see cloud-architecture) — the recommended **$0 full-stack** adds an **Oracle Cloud Always-Free ARM worker** + **GitHub Actions** (free cron/on-demand) so even heavy templates run in-cloud for free instead of falling back to self-host; adopting the Oracle worker is a small free owner-signup step that strictly upgrades ⑦ (still $0).

**⚑ CURRENT GIT STATE (verified now — supersedes the earlier grounding).** HEAD is on **`master`**, and `master == codex/lead-applicant-sync == origin/master == 94b6101` (byte-identical — **a merge is a no-op; there is nothing to merge**). The app-connections work is **uncommitted & untracked** in master's working tree (`git`: `src/app-connections.ts` "did not match any file known to git"). It is one cohesive **app-connections** feature: `src/app-connections.ts` + `.test.ts` (untracked) + 3 tool registrations in `index.ts` (`connect_app`/`confirm_app_connection`/`list_app_connections`) + `launchPersistentContext` in `engine.ts` + `types.ts`/`dashboard.ts` wiring + README/SKILL docs (~369 insertions across 7 tracked files). Also untracked: `.agents/` (377K skills lib), `skills-lock.json` (6K), `docs/…System-Design.docx` (520K binary). `templates/` (incl. `saved-cookies.json`), `output/`, `dist/`, `.env`, `.mcp-*.json` are **gitignored** (real session cookies stay local). → Phase −1 below preserves all of this.

**Grounded repo facts.** `master`/`origin/master` = base (last: `94b6101`). **11 MCP tools** in `src/index.ts` (incl. 3 uncommitted app-connections tools), 1 prompt, 1 resource. 4-module separation holds (`types.ts`=Zod/interfaces; `storage.ts`=file IO; `engine.ts`=Playwright; `index.ts`=sole wiring) — **one erosion**: `engine.ts` now imports/mutates `app-connections.ts` state (F00 resolves). Small modules exist: cookie-store, scheduler, metrics, notifier, downloader, updater, progress, lock (in-proc mutex), registry-client, usage, dashboard. Testing = Vitest (browser-free) + `scripts/verify-*.mjs` (Playwright) + `.github/workflows/verify.yml`. Pending roadmap: 6/7/8b/9/P1/P2/P3 — no `verify-registry.mjs`, `self-heal.mjs`, `nightly-verify.yml`, `@anthropic-ai/sdk`, `cheerio`, or `apimemcp add` CLI. A `.agents/skills/` library of **24 provider-neutral engineering-discipline skills** exists. Excel tooling: Python 3.13.2 present, no openpyxl (→ `pip install`).

---

## Phase −1 — Pre-flight: preserve current work (EXECUTE FIRST, before the pipeline)

Owner decisions: commit app-connections **straight to master**; include **everything** (code + `.agents/` + `skills-lock.json` + the `.docx`); **commit the plan blueprint now**, build the full package later.

1. **Secret-safety gate (MANDATORY before staging).** `git status --short` — confirm the ONLY entries are the app-connections files (`src/app-connections.ts`, `src/app-connections.test.ts`, and the 7 modified: README, SKILL, dashboard, engine, index, types, types.test), `.agents/`, `skills-lock.json`, and `docs/…System-Design.docx`. Confirm `templates/`, `templates/saved-cookies.json`, `.env`, `output/`, `.mcp-*.json` do **NOT** appear. If anything sensitive shows, STOP and fix `.gitignore` first — pushing session cookies to public GitHub is a real leak.
2. `git add -A` (stages the feature + `.agents/` + `skills-lock.json` + the `.docx`, per "everything").
3. Commit to `master`:
   `feat: app-connections — persistent-login browser profiles (connect_app / confirm_app_connection / list_app_connections)`
   body: the 3 MCP tools, `launchPersistentContext` in engine.ts, `app-connections.ts` store + tests, `.agents/` discipline-skills library, `skills-lock.json`, the design `.docx`. End with the repo's Co-Authored-By trailer.
4. **Preserve the pipeline:** create `radical-pipeline/PLAN.md` = a verbatim copy of this blueprint (`C:\Users\neeti\.claude\plans\cheeky-stirring-shannon.md`); `git add radical-pipeline/PLAN.md`; commit `docs: radical-pipeline master blueprint (two-program plan + orchestration + tracker + cold-start handoff)`.
5. `git push origin master`.
6. Cleanup: `git branch -d codex/lead-applicant-sync` (redundant — identical to master).
7. Verify: `git status` clean; `git log origin/master -2` shows both new commits; `npm run build` clean; a fresh `node dist/index.js` `listTools()` shows the 3 app-connection tools. **master's working tree is now clean** → the pipeline can branch `integration` off a clean master.

Only after Phase −1 is green does the pipeline proceed (build the full `radical-pipeline/` package per the Execution checklist, then the Cold-start loop). `radical-pipeline/PLAN.md` (committed in step 4) is the in-repo copy the Cold-start prompt can also point to.

---

## Package folder structure (what execution creates)

```
radical-pipeline/
  README.md                       # entry point + index + how other agents consume this package
  START-HERE.md                   # cold-start handoff brief — paste-and-go, resumable from zero chat history
  00-vision.md                    # the radical idea, the two-track model, the flywheel, target markets
  01-adrs/                        # cross-cutting contracts — lock BEFORE any feature branch forks
    ADR-01-schema-contract.md · ADR-02-tool-module-convention.md · ADR-03-transform-interface.md
    ADR-04-metrics-measure-model.md · ADR-05-vault-vs-appconnections.md · ADR-06-registry-as-cross-repo-contract.md
  02a-features-engine/            # 26 FULL specs, F00..F25 (per-feature template)
  02b-features-platform/          # 22 FULL specs, W01..W08 · X01..X07 · M01..M07
  03-orchestration/
    agent-roster.md · dependency-dag-and-waves.md · quality-gates.md · task-decomposition.md · handoff-protocol.md
  04-git-strategy.md              # 3 repos; branch models; F00 reconcile; cross-repo contract
  05-tracking/
    tracker-data.json             # STATIC definitions (features, sub-tasks, deps, waves, targets, START_DATE)
    status/<ID>.json              # LIVE per-feature status — one file per feature (no cross-agent write-contention)
    update_status.mjs · generate_tracker.py · APImeMCP-Radical-Tracker.xlsx · README.md
  06-creative-ideas.md            # moonshot idea bank (unscheduled)
  07-platform-design/
    website-design.md · cloud-architecture.md · mobile-app-design.md · design-system.md · hosting-options.md
  08-skills-matrix.md             # feature→skill mapping + install list (from find-skills)
```

---

## 00-vision.md (outline)

- **The inversion.** You get a programmatic interface today only if a *vendor* builds one. APImeMCP makes a *template* a portable, versioned, verified unit of "programmatic access to a screen" — so access is **crowd-and-agent-supplied**, not vendor-supplied. The API economy inverts.
- **The moat = determinism vs computer-use.** LLM computer-use is slow/costly/nondeterministic *every* run; APImeMCP is the complement — agent solves a site *once*, crystallizes the path into a template that then runs in ms deterministically forever, self-healing when the site changes.
- **Two-track product.** (a) **Self-host** (the MCP server): full power, arbitrary local templates, own Playwright — devs/agents. (b) **Cloud/consumer** (website + app + cloud exec): registry-only community templates, safe + sandboxed, phone-first — everyone. Shared substrate = the community registry.
- **The flywheel.** Agents/devs contribute templates (registry PRs, verified nightly) → instantly usable in web + app → consumers run/monitor them → usage signals which matter → more contribution; self-healing keeps them working. Coverage grows itself.
- **Target markets** (each exists *because* the systems have no API): RPA replacement (~$20B), financial data aggregation (corporate banking, EDGAR, gov procurement), healthcare (payer/prior-auth portals), government/civic data, supply-chain tracking, compliance-grade provenance, competitive intelligence, QA/E2E (the Kriya origin). The **mobile monitors** feature (get a push when a price drops / item restocks / a filing appears) is the consumer wedge.

---

## 08-skills-matrix.md — feature-specific skills (discovered via find-skills)

**Skill-quality bar (pick the *best*, not just *a* skill).** For each feature, evaluate candidates by: install count (**prefer ≥1K; reject <100**), source reputation (official vendor `vercel:*` / `anthropics` / `microsoft` > known community > unknown), and repo stars. When no reputable ≥1K-install skill exists for a need, **do not settle for a weak one** — use `context7` (live official docs) + the vendor's own skill instead. (Verified: Cloudflare / serverless-Chromium / Playwright community skills top out at 142 / 75 / 63 installs → **rejected**; those areas use `context7` + official docs.) Each feature's `Key skills` column is the vetted pick; each spec's *Skills* section carries the quality signal + install command + which sub-task it guides.

**Independent per-task setup & reuse (self-service, no human step).** Every builder agent, before coding, runs `npx skills check` (reuse anything already installed — skills are **global, durable memory shared across all agents**), then `npx skills add <pkg> -g -y` for only its *missing* feature skills. Setup is idempotent and per-task; a skill installed for an early feature is automatically available to every later agent — that is how agents "use previous skills".

**Already available in this environment — no install (assign at build time):**

| Skill(s) | Applied to |
|---|---|
| The 24 `.agents/skills/` (test-driven-development, code-review-and-quality, code-simplification, security-and-hardening, spec-driven-development, planning-and-task-breakdown, git-workflow-and-versioning, ci-cd-and-automation, observability-and-instrumentation, performance-optimization, browser-testing-with-devtools, documentation-and-adrs, incremental-implementation, …) | Every builder/QA/review/orchestration role — the disciplines each role enforces |
| `frontend-design`, `ui-ux-pro-max:*` (design, design-system, ui-styling, banner-design), `dataviz` | W02/W03-W08/W05, M02-M06, result charts/tables, design system, marketing + store assets |
| `vercel:nextjs`, `vercel:shadcn`, `vercel:react-best-practices`, `vercel:next-forge` | W01–W08 (Next.js App Router site, shadcn/ui, Turborepo scaffold) |
| `vercel:vercel-functions`, `vercel:vercel-sandbox`, `vercel:workflow`, `vercel:runtime-cache`, `vercel:routing-middleware`, `vercel:vercel-firewall` | X01–X05 (serverless exec API, **microVM to run untrusted community templates**, **durable jobs/monitors**, edge rate-limit/WAF) |
| `vercel:vercel-storage`, `vercel:auth`, `vercel:env-vars`, `vercel:vercel-cli`, `vercel:deployments-cicd` | X07/W07/M01 (Postgres/Redis/Blob, Clerk auth, deploys, EAS) |
| `context7-mcp` | Live docs for Next/Expo/Playwright/Clerk during build |
| `using-apimemcp`, `deep-research` | Engine usage patterns; market/competitive validation |

**To install from skills.sh (verified install counts; `npx skills add <pkg> -g -y`):**

| Skill | Installs | Used by | Install |
|---|---|---|---|
| `mindrally/skills@expo-react-native-typescript` | 1.6K | **M01–M07** (Expo + RN + TS mobile) | `npx skills add mindrally/skills@expo-react-native-typescript -g -y` |
| `pproenca/dot-skills@expo-react-native-performance` | 1K | M (mobile perf, list virtualization, startup) | `npx skills add pproenca/dot-skills@expo-react-native-performance -g -y` |
| `sickn33/antigravity-awesome-skills@bullmq-specialist` | 1.5K | X03 **only if/when a worker is added** (deferred by the free-tier-first decision) | `npx skills add sickn33/antigravity-awesome-skills@bullmq-specialist -g -y` |

**Deliberately NOT installed:** playwright skills (top hit only 63 installs; the project *is* Playwright and we know it deeply — use `context7` for API docs). Swift-native push skill (iOS-only; Expo's own Notifications API covers cross-platform push — covered by the Expo skill). **Cloudflare/Workers** and **serverless-Chromium** skills likewise top out at 142/75 installs → rejected; the Cloud/Infra Builder uses `context7` + official Vercel/Cloudflare docs for X01/X02 instead. The execution agent re-runs `npx skills find <query>` per workstream in case higher-quality skills have since appeared, and only installs ≥1K-install skills from reputable owners.

---

# PROGRAM 1 — API Engine (F00–F25)

## 01-adrs/ — Phase-0 contracts (Architect authors before any builder forks)

| ADR | Decision | Depended on by |
|---|---|---|
| **ADR-01 Schema contract** | Template output shape stored as JSON Schema on `ManifestEntry.outputSchema?`; pure `validateOutput(value, schema)` (zod-backed, no IO) in `types.ts` (or new pure `src/schema.ts`). Absent = no validation (back-compat). | F01,F02,F04,F11,F25,W04,M04 |
| **ADR-02 Tool-module convention** | Each MCP tool registered by `registerXxxTool(server, deps)` in its own module (or `src/tools/`); `index.ts` becomes an **append-only list of calls** — turns the 48-feature `index.ts` contention into one-line appends. F00's 3 tools retrofitted. | Every tool-adding feature |
| **ADR-03 Transform interface** | `TransformSpec` type + pure `applyTransform(data, spec)` in `src/transform.ts` (jq-like map/rename/pick/coerce). | F10,F09,F25,W05,M04 |
| **ADR-04 Metrics measure-model** | One instrumentation point in `runExtraction` emits `{templateId,kind,success,durationMs,timestamp,error?}`; `metrics.ts` aggregates, OTel adapter (F17) exports, cache (F16) + monitor (F20/X05) read. | F14,F16,F17,F20,F24,X05 |
| **ADR-05 Vault vs app-connections** | **app-connections** = login *profile/session dirs* (browser identity). **Vault** (`src/vault.ts`, F13) = *encrypted secrets*. Separate stores/modules; a vault entry MAY be referenced by an app-connection/template. | F00,F13,X06 |
| **ADR-06 Registry = cross-repo contract** | The `apimemcp-templates` manifest shape + the published `@neetigyashah/apimemcp` types are the ONLY contract between the engine repo and the platform repo. Platform consumes types via npm, never imports engine internals. | All of Program 2 |

## Feature catalog F00–F25 (seed for the 26 specs + Excel)

Pillars: **Fnd**/A reliability/B agent-native/C fabric/D compliance/E dist+perf/F creative. Gates: **Ar**/**Se**/**Lv** (⚫ required). ★=critical path.

| ID | Name | Pil | What it does | Modules (new?) | Deps | Wave | Gates | Risk |
|---|---|---|---|---|---|---|---|---|
| **F00**★ | App-connections hardening & merge | Fnd | Land in-flight persistent-login feature through gates; retrofit ADR-02; fix engine↔app-connections erosion | app-connections.ts, engine.ts, index.ts | — | 0 | Ar Se Lv | M |
| **F01**★ | Schema contracts | A | Template declares output JSON Schema; validated each run | types/schema.ts, storage, engine, index | ADR-01 | 1 | Ar Lv | M |
| **F02**★ | Drift detection | A | Diff live shape vs contract → flag; expose reusable diff primitive | drift.ts (new), engine, metrics, dashboard | F01 | 2 | Lv | M |
| **F03**★ | Nightly re-verification + badges | A | verify-registry.mjs + nightly workflow → shields.io status | scripts/verify-registry.mjs (new), workflow (new), registry-client | registry | 1 | Lv | L |
| **F04**★ | Self-healing templates | A | On drift, hand forensic DOM+old script to the calling agent → fix → verify → registry PR (never auto-merge) | self-heal.mjs (new), engine, registry PR helper | F02,F03,F05 | 3 | Ar Se Lv | H |
| **F05** | synthesize_schema (agent-native) | B | `renderPage()` → agent writes script → dry-run via executeExtraction → register | engine (renderPage), index | ADR-01 | 1 | Ar Lv | M |
| **F06** | Computer-use crystallization | B | Agent solves unmapped site via computer-use → record → crystallize → optional auto-PR | engine, storage, registry-client | F05 | 3 | Ar Se Lv | H |
| **F07** | Template pipelines / DAG | C | Chain templates; pipeline def + runner | pipeline.ts (new), types, index | exec | 3 | Ar Lv | M |
| **F08** | CEL conditional branching | C | Port Kriya's CEL evaluator; action-sequence branches on live state | cel-eval.ts (new), engine, types | action-seq | 3 | Ar Lv | M |
| **F09** | Bidirectional flows | C | Read A → transform → form-fill *write* into B | engine, pipeline | F07,F10 | 4 | Ar Se Lv | H |
| **F10** | Transform / normalize layer | C | jq-like output mapping | transform.ts (new), types, index | ADR-03 | 2 | Ar | L |
| **F11** | Signed provenance receipts | D | content-hash + version + schema-valid, signed, exportable | provenance.ts (new), engine, types | F01 | 3 | Ar Se | M |
| **F12** | Policy engine | D | robots.txt/ToS awareness + per-template rate limits | policy.ts (new), engine | — | 4 | Se Lv | M |
| **F13** | Encrypted credential vault | D | Encrypted secrets injected at run; distinct from app-connections | vault.ts (new), cookie-store, engine | F00,ADR-05 | 4 | Ar Se | H |
| **F14** | Metrics 2.0 (SLA) | E | Aggregate success-rate + latency (durationMs already captured) | metrics, dashboard | ADR-04 | 1 | QA only | L |
| **F15** | `static-http` template kind | E | cheerio fast-path (no browser) — 10–50× faster for no-JS pages | types, storage, engine, index (+cheerio) | — | 3 | Ar Lv | M |
| **F16** | Short-TTL result cache | E | in-mem Map TTL; key=templateId+url+cookie-present+proxy | result-cache.ts (new), index | F14,ADR-04 | 2 | Se | L |
| **F17** | OpenTelemetry observability | E | Export ADR-04 measures as OTel | otel adapter (new), engine | F14 | 4 | Lv | M |
| **F18** | Ephemeral hosted endpoint | E | read-registry + zero-state HTTP endpoint; the substrate X01/X02 productize | hosted entry (new) | F11,registry | 5 | Se Lv | H |
| **F19** | Close items 4/5 gaps | E | `apimemcp add` CLI + lint-in-CI + live network-behavior check in verify-registry | index (argv), verify.yml, verify-registry | (F03) | 1 | Lv | L |
| **F20** | Change-monitoring mesh | F | Diff template results over time → events (**reuses F02 diff**) | scheduler, notifier, drift | F02 | 4 | Lv | M |
| **F21** | NL→template one-shot | F | "make me an API for X" wrapper (F05+F06) | index wrapper | F05,F06 | 5 | Ar | M |
| **F22** | Semantic template discovery | F | Search "what can APImeMCP do for domain X" (local+registry) | discovery (new), registry-client | — | 2 | QA only | L |
| **F23** | Golden-snapshot regression | F | Record known-good output; regression-detect | snapshot infra (new) | F01 | 2 | Lv | L |
| **F24** | Marketplace reputation + semver | F | Contributor reputation + template versioning/changelog | registry tooling, registry-client | F03,F14 | 5 | Se | M |
| **F25** | OpenAPI + client export | F | Generate OpenAPI + typed client from a bundle | exporter (new), usage pattern | F01,F07 | 5 | QA only | M |

**Critical path:** ADRs → **F01→F02→F04** (F04 also needs F03+F05). Secondary: F05→F06→F21. Waves: **0** F00+ADRs · **1** F01,F05,F03,F14,F19 · **2** F02,F10,F16,F22,F23 · **3** F04,F06,F07,F08,F11,F15 · **4** F09,F12,F13,F17,F20 · **5** F18,F21,F24,F25.

## Per-feature spec template (every `02a-*/F##.md` follows)

1. Summary (id/name/pillar/wave/risk, what+why). 2. Story. 3. Design (exact data shapes, ADR(s) obeyed, module-by-module changes with **exact paths**, tool signatures via ADR-02). 4. Sub-tasks (uniform **S0–S11**, mark N/A). 5. Deps & sequencing. 6. Gates (Ar/Se/Lv) + Definition of Done. 7. Test plan (`*.test.ts` cases + `scripts/verify-F##.mjs` + fixture if engine-touching). 8. Acceptance criteria (live observable proof). 9. Reuse notes (`captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript`, …).
10. **Skills (setup + when-to-use)** — the exact best-quality skill(s) this feature's builder installs *first* (`npx skills check` to reuse; else `npx skills add <pkg> -g -y`), each with its quality signal (install count / source) and which sub-task (S#) it guides; explicit fallback to `context7` + official vendor docs when no ≥1K-install reputable skill exists (e.g. Cloudflare / serverless-Chromium).

---

# PROGRAM 2 — Consumer Platform (Web + Cloud + Mobile)

## Two-track architecture & the bridge

Phones/browsers can't run Playwright → the **cloud execution layer (X##) is mandatory** and is the bridge. The cloud runs **only registry (community) templates** — sandboxed + network-allowlisted (item-5) — never arbitrary user code, so the safe scope of F18 is exactly the productized cloud runtime. Auth templates: user supplies cookies that transit encrypted and are used ephemerally (or stored in a per-user encrypted vault, F13/X06, only if they opt in). Web + mobile are thin clients of the cloud API. The engine repo and platform repo share only the registry manifest + published types (ADR-06).

## 07-platform-design/website-design.md

**Identity (frontend-design, grounded — not a templated default).** Extend the established "compiler/terminal" brand — phosphor amber `#ffb627` on void `#14100a`, **IBM Plex Mono** (machine output) + **IBM Plex Sans** (interface copy) — elevated from raw dashboard to a polished product + community hub. **Signature element:** the hero is a *live* interactive terminal — type a domain, watch a real community template compile → run → **stream real results** (the compiler metaphor made literal; real data, never mocked). **Structural device:** the registry as a monospace "ledger" (npm-registry-for-websites), each row a template with a live verification badge (F03 shields), run-count, one-tap Run. Deliberately avoid the AI-default looks (cream+serif / black+acid-neon / broadsheet) — the terminal-phosphor identity is already distinctive and earned.
**Pages:** Landing (vision + live hero demo) · Registry browser (search/filter/category/verification badges) · Template detail (schema F01, verification, Run, `.mjs` download, provenance F11) · Run console (inputs + live results: JSON / table / image gallery / share) · Contribute (PR onboarding + gate explainer) · Docs (vision / how-it-works / self-host / API ref) · Account (monitors, run history, saved cookies, API keys).
**Tech:** Next.js App Router + shadcn/Tailwind on Vercel; registry via jsDelivr + cached Postgres mirror (X07); user data Postgres (Neon); auth Clerk (`vercel:auth`); calls X01.

## 07-platform-design/cloud-architecture.md (Vercel-native, free-tier-first)

- **X01 API gateway** (Vercel Functions): `POST /api/run {templateId,targetUrl?,cookieString?}` → `jobId`; `GET /api/run/:id` → status/result; Clerk auth + rate-limit (`vercel:vercel-firewall`/middleware).
- **X02 Safe runtime:** light + `static-http` (F15) + quick extractions run **inline** in a Function via `@sparticuz/chromium` **or Vercel Sandbox** (isolated microVM) — sync result within timeout. Registry-only, network-allowlisted. *An early feasibility spike must confirm Playwright/Chromium runs acceptably in Sandbox/Function; if not, `@sparticuz/chromium` covers the light path and heavy stays self-host.*
- **X03 Durable orchestration** (`vercel:workflow`): multi-step + monitor flows, retries/pause-resume. **Heavy paginated templates** (1000-comment type) that exceed serverless limits return a clear *"too heavy for the cloud tier — run on your self-host server"* + deep-link to self-host instructions (the free-tier-first tradeoff). A deferred BullMQ worker would lift this later.
- **X04 Delivery:** SSE/websocket → web live console; **Expo push** → mobile ("run finished / value changed"). Ephemeral: results + cookies **not persisted server-side** by default (F18); cookies encrypted in transit, used ephemerally.
- **X05 Monitors** (F20 productized + Vercel Cron): subscribe template+inputs+schedule → cron run → F02 diff vs last → on change, **Expo push** ("Bernhardt K1325 → $X", "back in stock", "new filing"). **The killer mobile feature.**
- **X06 Encrypted cookie transit + optional per-user vault** (F13/ADR-05). **X07 Registry mirror/cache** (Postgres) synced from the git registry for fast catalog/search.
- **Safety posture (Security-Reviewer gates all X):** registry-only + sandbox + allowlist + rate-limit + zero-persist default + strict per-user isolation (never share cookies/results across users).

### Free hosting matrix (answers "is there another free layer to run the whole thing")
The locked posture ⑦ (Vercel free-tier-first) punts heavy templates to self-host. Several **genuinely-free** layers combine to run *everything* — heavy templates + monitors included — at **$0**:

| Layer | Free option(s) | Runs | Caveat |
|---|---|---|---|
| Web/site | **Vercel Hobby** or **Cloudflare Pages** | Next.js site | Vercel non-commercial hobby terms |
| DB + auth + storage | **Supabase free** (Postgres+auth+storage+edge fns) or **Cloudflare D1+R2** | X07, W07, accounts | Supabase pauses idle projects |
| Light execution | **Cloudflare Browser Rendering** (free Playwright-at-edge) or Vercel fn + `@sparticuz/chromium` | static-http + quick templates | edge CPU/time limits |
| **Heavy + always-on** | ⭐ **Oracle Cloud Always-Free** (permanent ARM VM, 4 cores/24 GB — runs the full APImeMCP engine + a queue worker forever, free) | 1000-comment-class templates, the whole engine | one free signup; ARM arch |
| On-demand + cron runner | ⭐ **GitHub Actions** (free; *unlimited* minutes on public repos) — `workflow_dispatch` to run a template, scheduled workflows for monitors + nightly-verify (F03), result via artifact/webhook/`repository_dispatch` | monitors, nightly re-verify, on-demand heavy runs | ~job-start latency; unlimited only on public repos |
| Push | **Expo Push** + **FCM** | mobile delivery | free |

**Recommended $0 full-stack:** Vercel/Cloudflare (web) + Supabase (DB/auth) + Cloudflare Browser Rendering or `@sparticuz/chromium` (light exec) + **Oracle Always-Free ARM worker** (heavy exec = the engine) + **GitHub Actions** (cron monitors + nightly-verify) + Expo Push. Runs the *entire* two-track product — every community API from the phone, heavy ones included — at no recurring cost, lifting the heavy→self-host fallback while staying $0. *(Skill note: no ≥1K-install skill exists for Cloudflare/serverless-Chromium/Oracle — the Cloud/Infra Builder uses `context7` + official vendor docs here, per the skill-quality bar.)*

## 07-platform-design/mobile-app-design.md (React Native + Expo)

**Decision + why.** RN+Expo over Flutter/native because: (a) whole stack is TypeScript — the app shares the API client, F01 result types, and validation with backend+web; (b) React mental model shared with the site; (c) Expo EAS = one codebase → native iOS+Android + OTA + **first-class Expo Push** (the "results to your phone" mechanism across APNs+FCM with no native plumbing); (d) native look via RN native components + a themed design system. Flutter = second language, no code-share; native = two codebases. RN+Expo is lazy-correct.
**Screens:** Onboarding/auth (same Clerk accounts) · **Browse** (registry search/filter/badges/category/trending) · Template detail (schema, Run) · **Run** (inputs: URL or one-tap fixed-target; cookies via paste or later a "grab from this site" webview; enqueue → progress → result **in-app + push**; views: JSON / table / image gallery / share) · **Monitors** (subscribe → schedule → **push-on-change**; list with last value + history) — the headline · Runs (history) · Account (device-encrypted cookies/vault, API key, settings).
**Native feel:** RN core + a themed component system (Tamagui / RN-Paper / custom), Expo Router, respects iOS/Android conventions (not a webview). Push via Expo Notifications. Offline: cache catalog; runs need connectivity. **Distribution:** EAS build both platforms; internal / TestFlight / Expo Go free first; public store launch later (owner: Apple $99/yr, Google $25). "Direct results / without going anywhere" = the push notification delivers the result/change and deep-links into the app; for monitors the notification *is* the value.

## 07-platform-design/design-system.md
One cross-surface token system (color/type/space) shared by web (`shadcn` theme) + mobile (RN theme), owned by the **Design Lead**, derived from the phosphor/void identity, adapted per platform. Real data everywhere; visible focus + reduced-motion + a11y floor on both.

## Program 2 feature catalog (W / X / M) — seed for the 22 specs + Excel

| ID | Name | Surface | What it does | Key skills | Deps | Wave | Gates | Risk |
|---|---|---|---|---|---|---|---|---|
| **W01** | Platform monorepo scaffold | Web | Turborepo (apps/web, apps/mobile, packages/shared) + Vercel project + CI/CD | next-forge, deployments-cicd | — | P0 | Ar | L |
| **W02** | Cross-surface design system | Web | Shared tokens; phosphor/void identity elevated; web+mobile | frontend-design, ui-ux-pro-max:design-system, shadcn | W01 | P0 | Ar(Design Lead) | M |
| **W03** | Registry browser + search | Web | Browse/filter templates + verification badges | nextjs, shadcn, ui-ux-pro-max | W01,W02,X07 | P1 | — | L |
| **W04** | Template detail + schema/docs | Web | Rendered docs + F01 schema + Run entry | nextjs, dataviz | W03,F01 | P1 | — | L |
| **W05** | Web run console | Web | Call X01; live results (JSON/table/image) | nextjs, dataviz, ui-styling | W04,X01,X04 | P2 | Lv | M |
| **W06** | Contribute flow | Web | PR onboarding + gate explainer | nextjs, documentation-and-adrs | W03,registry | P2 | — | L |
| **W07** | Auth + accounts + dashboard | Web | Clerk auth; monitors/history/keys | vercel:auth, vercel-storage | W01 | P1 | Se | M |
| **W08** | Landing + interactive hero | Web | Vision pages + live compile-and-run hero demo | frontend-design, ui-ux-pro-max, banner-design | W02,X01 | P2 | — | M |
| **X01** | Execution API gateway | Cloud | POST/GET run; auth + rate-limit | vercel-functions, vercel-firewall, routing-middleware, auth | F18 | P1 | Se Lv | H |
| **X02** | Safe registry-only runtime | Cloud | Sandbox/@sparticuz/chromium; feasibility spike | vercel-sandbox, vercel-functions, security-and-hardening | F18,F15,item-5 | P1 | Se Lv | H |
| **X03** | Durable jobs + heavy fallback | Cloud | Vercel Workflow; heavy→self-host message | vercel:workflow (bullmq deferred) | X02 | P2 | Se Lv | M |
| **X04** | Results delivery | Cloud | SSE/ws + Expo push; ephemeral no-persist | vercel-functions, expo push | X01 | P2 | Se | M |
| **X05** | Monitors service | Cloud | Cron + F02 diff + push-on-change | vercel:workflow, vercel cron | X03,F02/F20 | P3 | Se Lv | M |
| **X06** | Encrypted cookies + vault | Cloud | Per-user encrypted transit + optional vault | security-and-hardening, vercel-storage | F13,ADR-05 | P2 | **Se (blocks)** | H |
| **X07** | Registry mirror/cache DB | Cloud | Postgres mirror + sync for fast catalog | vercel-storage, runtime-cache | registry | P1 | — | L |
| **M01** | Expo app scaffold | Mobile | iOS+Android, Expo Router, EAS, Clerk auth | expo-react-native-typescript, vercel:auth | W01,W02 | P1 | Ar | M |
| **M02** | Mobile design system impl | Mobile | Native-look themed components | frontend-design, expo-react-native-typescript, ui-ux-pro-max | W02,M01 | P1 | Ar(Design Lead) | M |
| **M03** | Browse/registry screens | Mobile | Search/filter/badges/trending | expo-react-native-typescript | M02,X07 | P2 | — | L |
| **M04** | Run screen + result views | Mobile | Inputs/cookies; JSON/table/image/share | expo-react-native-typescript, dataviz | M03,X01,X04 | P2 | Lv(device) | M |
| **M05** | Monitors + push | Mobile | Subscribe + Expo push + notification handling | expo push, expo-react-native-typescript | M04,X05 | P3 | Lv(device) | M |
| **M06** | Run history + account + cookies | Mobile | History; device-encrypted cookies | expo-react-native-typescript, security-and-hardening | M04,X06 | P3 | Se | M |
| **M07** | App-store prep | Mobile | Icons/splash/EAS submit; listing (fees = owner step) | expo-react-native-performance, banner-design | M01–M06 | P4 | — | L |

**Program 2 depends on Program 1:** registry (F03/registry repo), schema contracts (F01, for result typing + views), hosted-exec substrate (F18 → X01/X02), diff (F02→F20→X05 monitors), static-http (F15, the cloud-friendly kind), provenance (F11, trust in shown results). So Program 2's **P0** (W01, W02, X07, X02-spike) runs in parallel with Program 1 Waves 1–2; its "run community APIs" core (X01/X02/W05/M04) lands after F18/F15/F03.

---

## 03-orchestration/ — sub-agent playbook (both programs)

### agent-roster.md — roles (quality-heavy; only builders write feature code)

| Role | Count | Merges? | Blocks? | Mission (skills) |
|---|---|---|---|---|
| **Orchestrator / Lead** | 1 | No | Yes (scope) | Owns wave schedule + tracker + cross-lane conflicts; only role that instructs others. (planning-and-task-breakdown, spec-driven-development, shipping-and-launch) |
| **Architect / Boundary-keeper** | 1 | No | **Yes** | Authors ADR-01..06 in Phase 0; gates any PR touching `types.ts` shapes / new module / 4-module boundary / cross-repo contract. (spec-driven-development, documentation-and-adrs, code-simplification) |
| **Design Lead** *(Program 2)* | 1 | No | **Yes (brand)** | Owns the cross-surface design system (W02/M02); blocks UI PRs that break identity/a11y. (frontend-design, ui-ux-pro-max:design-system, dataviz) |
| **Engine Builder** | **3** (burst 4) | No | No | Program 1 features end-to-end in a lane. Cannot self-merge/self-approve. (test-driven-development, incremental-implementation + per-feature discipline) |
| **Web Builder** | 1–2 | No | No | W## features on the platform repo. (vercel:nextjs/shadcn/react-best-practices, frontend-design, ui-ux-pro-max) |
| **Mobile Builder** | 1–2 | No | No | M## features. (expo-react-native-typescript, expo-react-native-performance, expo push, frontend-design) |
| **Cloud/Infra Builder** | 1 | No | No | X## features. (vercel:vercel-functions/vercel-sandbox/workflow/vercel-storage, security-and-hardening) |
| **Code-Reviewer** | 1–2 | No | Yes | Correctness + simplification on every PR (separate from builder); no reinvented stdlib/existing-module code; minimal diff. (code-review-and-quality, code-simplification) |
| **Security-Reviewer** | 1 | No | **Yes** | Gates all security-sensitive PRs — **all of X##** (untrusted templates in cloud, user cookies, auth), F00/F04/F06/F11/F12/F13/F16/F18, any sandbox/allowlist change. No secret leakage; sandbox intact; F04 never auto-merges; registry input untrusted; cache/cookies non-cross-user. (security-and-hardening) |
| **QA / Test-Verifier** | 1 | No | Yes | Vitest browser-free gate on every engine PR; component-test gate on web/mobile PRs. (test-driven-development, ci-cd-and-automation) |
| **Live-Verification Gatekeeper** | 1 | No | **Yes** | `scripts/verify-*.mjs` + real Playwright for engine; **device/simulator** runs for mobile; perf-claim measurement (F15/F16). (browser-testing-with-devtools, performance-optimization) |
| **Integration / Merge** | 1 per repo | **Yes (sole merger)** | Yes | Owns each repo's `integration`/`main`; merges in Orchestrator's order; resolves `index.ts`/`types.ts` conflicts via ADR-02; keeps releasable; tags+changelog. (git-workflow-and-versioning, ci-cd-and-automation) |
| **Deployment Agent** *(Program 2)* | 1 | No | No | Vercel deploys (web+cloud) + EAS builds (mobile) at promote gates; env/secret hygiene. (vercel:deployments-cicd, vercel-cli, env-vars) |
| **Docs / Tracker** | 1 | No | No | Maintains the 3-sheet tracker (derives % from gate status), README/tool-docs/ADRs, `usage.ts` regen. (documentation-and-adrs, observability-and-instrumentation) |

**Startup rule:** Phase 0 = Orchestrator + Architect (+ Design Lead for Program 2 P0). Reviewers/verifiers/integration spin up on first PR. **Program 2 runs as a parallel pod** (Web/Mobile/Cloud builders) so it doesn't contend with Engine Builders on the MCP-server files. **3 Engine Builders is the cap** (shared `types.ts`/`engine.ts`/`index.ts`); burst to 4 only in a low-contention wave.

### quality-gates.md — pipeline G0→G8 (bracketed = conditional)

`Assigned → G0 Spec → G1 Build → G2 Code-Review → [G3 Arch] → [G3b Design] → [G4 Security] → G5 QA(unit/component) → [G6 Live/Device-Verify] → G7 Integration → (wave) G8 Promote(+Deploy)`

| Gate | Owner | Definition of Done | Rejects to |
|---|---|---|---|
| G0 Spec | Architect(+Design Lead if UI)+Orchestrator | One-page spec consistent with ADRs, module/screen-per-change, test+verify plan, not a duplicate | Orchestrator |
| G1 Build | Builder (CI) | build clean; unit/component tests green; lint passes | Builder |
| G2 Code-Review | Code-Reviewer | Correct vs spec; no reinvented code; minimal diff; boundary error handling | Builder |
| G3 Arch *(types/boundary/module/cross-repo)* | Architect | 4-module separation; ADR-02; ADR-06 (platform imports only published types). **Blocks** | Builder |
| G3b Design *(UI)* | Design Lead | Matches design system + a11y floor + platform conventions. **Blocks** | Builder |
| G4 Security *(flagged / all X)* | Security-Reviewer | No secret leakage; sandbox/allowlist intact; per-user isolation; registry input untrusted. **Blocks** | Builder |
| G5 QA | QA | Meaningful deterministic tests (unit for logic, component for UI); full suite green on rebased branch | Builder |
| G6 Live/Device-Verify *(engine/PW or device)* | Live-Verification | `verify-*.mjs`+real Playwright (engine) OR simulator/device run (mobile) OR preview-URL smoke (web); perf claims measured. **Blocks** | Builder |
| G7 Integration | Integration | Rebased; prior gates green; CI green on merge; merged in order; tracker updated | Builder/Orchestrator |
| G8 Promote+Deploy | Integration+Deployment+Orchestrator | Wave coherent; CI green; CHANGELOG+semver; docs/usage regen; engine `npm pack` dry-run / web+cloud Vercel deploy / mobile EAS build green; tag | Failed gate |

Pure-logic engine features skip G6; boundary-neutral skip G3; non-UI skip G3b.

### task-decomposition.md — uniform S0–S11 (reinterpreted per surface)

| # | Sub-task | Engine meaning | Web/Mobile meaning | N/A when |
|---|---|---|---|---|
| S0 Spec / S1 Types / S2 Storage / S3 Core / S4 Module / S5 Wiring / S6 Unit / S7 Verify / S8 Docs / S9 Review / S10 Live / S11 Merge | types→storage→engine→module→index wiring→`*.test.ts`→verify-mjs→docs→G2→G6→G7 | S1 shared types · S2 data/API client · **S3 screens/components** · S4 feature module · S5 route/nav wiring · **S6 component tests** · **S7 e2e/device** · S8 docs · S9 review · **S10 device/preview verify** · S11 merge | mark per feature |

**% complete = done non-N/A ÷ total non-N/A** (equal weight; optional 2× on S3/S9/S10).

### handoff-protocol.md
The **`<PREFIX>##` id** (F##/W##/X##/M##) is the universal join key across branch/PR/commit-trailer/tracker-row. Each gate result flips the feature's S-cell status in `tracker-data.json` (Docs/Tracker regenerates the `.xlsx`). A rejected gate returns the feature to the named role with written findings; overall status → `Blocked` (red) until resolved.

### context-bounded-workflow.md — the never-blow-context execution model
The whole build runs as a **dispatched workflow**, not one long-lived agent, so no agent ever approaches its context limit and the pipeline scales in *features* without scaling any single context window:
1. **One feature per fresh subagent.** The Orchestrator dispatches each F##/W##/X##/M## to a *new* Builder subagent whose prompt contains ONLY: (a) the path to that feature's spec, (b) the specific ADR(s) it touches, (c) its skill list + install commands. It never receives the whole plan; when the feature merges, that context is discarded.
2. **Disk is the shared brain.** All specs, ADRs, and `tracker-data.json` live in the `radical-pipeline/` package on disk. Agents read only their slice and write status back to the tracker — project state lives in files, not any agent's window. (Apply the `.agents/context-engineering` skill.)
3. **Skills = durable reusable memory.** A skill installed once (`-g`) is available to every later agent (this *is* "use previous skills"); each agent `npx skills check`s first and installs only what's missing.
4. **Bounded fan-out harness.** Use the **Workflow tool** (deterministic `pipeline()`/`parallel()` over the dependency DAG) so each feature runs as an isolated agent with its own context; the Orchestrator holds only the wave plan + tracker, never the sum of feature contexts. (Reference `superpowers:subagent-driven-development`.)
5. **Gate agents are stateless too.** Each Code-Review / QA / Security / Live-Verify agent is dispatched per-PR with only the diff + that feature's Definition of Done — reviews one thing, records a verdict in the tracker, is discarded.

---

## 04-git-strategy.md — THREE repos

| Repo | Program | Model | Deploy |
|---|---|---|---|
| **`apimemcp`** (D:\MCP) | 1 (engine) | `master` (releasable) ← `integration` ← `feat/F##` | npm publish |
| **`apimemcp-templates`** | shared | `main`; PR-per-template (gated by F03 verify + F19 lint) | jsDelivr (auto) |
| **`apimemcp-platform`** (NEW Turborepo) | 2 (web+cloud+mobile) | `main` ← `feat/W##` / `feat/X##` / `feat/M##` | web+cloud→Vercel, mobile→EAS |

- **Two long-lived branches per code repo** (`master`/`main` releasable ← `integration`); short-lived `feat/<id>-slug`. Split a feature branch only when too big for one review (`feat/F04-drift-forensics`, `feat/F04-registry-pr`).
- **Promotion order within a wave:** critical-path/foundation feature to `integration` first so dependents rebase onto it; `index.ts`/`types.ts` conflicts resolved via ADR-02 append-only.
- **Branch protection:** `master`/`main` — no direct push, green CI + Integration sole-merger + Orchestrator sign-off, linear. `integration` — no self-merge, all applicable gates + green CI + Code-Review (+Security if flagged, +Arch if boundary, +Design if UI), rebased first.
- **Cross-repo contract (ADR-06):** platform consumes `@neetigyashah/apimemcp` **published types** + the registry manifest — never engine internals. A breaking engine type change = a semver major + a platform bump PR.
- **F00 reconciliation (explicit):** land app-connections **first** through the full gate pipeline (zero prior review). Rebase `codex/lead-applicant-sync` onto `master`, retrofit its 3 tools to ADR-02, fix the `engine↔app-connections` erosion, merge to `integration` as the very first merge — clears the biggest `index.ts` contention before Wave 1. **Vault (F13) ≠ app-connections** (ADR-05). If F00 isn't green in time, freeze its public surface via ADR-05 so F13/X06 code against it; land F00 before F13; rebase weekly.

---

## 05-tracking/ — the styled Excel tracker (3 sheets, ~48 rows) + concurrency-safe update protocol

**Split static definitions from live status so many subagents can update the Excel in parallel with zero write-contention:**
- `tracker-data.json` — **static**: every F##/W##/X##/M## with its sub-task applicability (S0–S11 = applicable/N-A), deps, wave, schedule targets, and a top-level configurable `START_DATE`. Written once at package build; rarely changes.
- `status/<ID>.json` — **live**, **one file per feature**: `{ id, subtasks:{S0..S11: "Todo|In-Prog|In-Review|Blocked|Done"}, overall, currentGate, blockedBy, owner, reviewer, updatedAt }`. **Only the agent that owns feature `<ID>` writes `status/<ID>.json`** → two agents never touch the same file, so parallel subagent updates can't corrupt each other.
- `update_status.mjs <ID> <S#> <status>` (and `--gate/--overall/--blocked` flags) — a tiny helper any subagent calls to update *its own* status file atomically (`atomicWriteFile`-style temp+rename). No lock needed because writes are per-feature-file.
- `generate_tracker.py` (openpyxl) — reads `tracker-data.json` (definitions) **+ merges every `status/*.json`** → produces `APImeMCP-Radical-Tracker.xlsx` with computed %. Re-run any time (after each gate/wave); `README.md` documents `pip install openpyxl` + the update/regenerate loop.

**The rule for agents:** finish a sub-task/gate → `update_status.mjs` your feature's file → run `generate_tracker.py`. The Docs/Tracker agent owns a periodic regenerate + a per-wave summary, but *every* builder/reviewer subagent updates its own status file itself, satisfying "update the Excel from multiple subagents".

- **Sheet 1 "Feature Catalog"** (row per feature): `ID · Name · Program(1/2) · Surface(Server/Web/Cloud/Mobile) · Pillar · One-line description · Value/why · Tool/route/screen added · Primary modules · New module? · Skills · Deps · Wave · Critical? · Gates(Ar/Se/Lv/Design flags) · Owner · Risk · ADR link`. *Style:* Program bands (P1 vs P2 shaded); pillar/surface categorical fills; critical red; risk green/amber/red; gate flags filled; frozen header.
- **Sheet 2 "Progress"** (the "beautiful" heat-map): `ID · Name · Program · S0…S11 (12 status cells) · % Complete(computed) · Current gate · Blocked-by · Owner · Reviewer · Overall status · Last-updated`. *Style:* each S-cell colored by enum (grey=N/A, white=Todo, blue=In-Prog, amber=In-Review, **red=Blocked**, green=Done); `% Complete` = green data-bar; blocked rows highlighted; frozen header + frozen ID column. The S0–S11 strip reads as a heat-map.
- **Sheet 3 "Schedule / Deadlines"** (milestone-based): `ID · Name · Program · Wave · Planned start · Spec-done · Build-complete · Review-passed · Live-verify · Merged · Promote · Duration est(days) · Status vs plan(Ahead/On-track/At-risk/Late) · Owner`. *Style:* Status green/amber/red; past-due-and-not-Done red; waves as alternating bands; optional Gantt start→promote. Dates **relative** to `START_DATE` (owner sets cadence; sheet computes).

---

## 06-creative-ideas.md — moonshot idea bank (unscheduled)

- **Self-describing MCP** — expose each registered template as its *own* typed MCP tool (`get_bernhardt_products()`), so agents see a real API surface, not `execute_native_extraction(id)`.
- **Auto-generated agent skills** — from a template, emit a `SKILL.md` so any agent "knows" the capability exists.
- **Monitors-as-a-product** (mobile) — the push-on-change monitor is arguably the biggest consumer hook: price drops, restocks, gov-filing alerts, "did my competitor change pricing". Bundle vertical monitor packs.
- **Time-travel snapshots** — persist rendered DOM per run; replay extraction offline against history (testing + provenance + "what did this page say last Tuesday").
- **Multi-modal fallback** — when DOM extraction fails, screenshot → hand to the calling agent's vision → best-effort read → crystallize.
- **Federated registries** — corporate-private + public with precedence (enterprises keep proprietary templates internal).
- **Vertical capability packs** — "US-gov-procurement pack", "carrier-tracking pack", one-command install; surfaced as app categories.
- **Optional local-LLM autonomous mode** — an Ollama adapter for F05/F04 when there's *no* calling agent (fully headless), preserving the "no paid API key" constraint.
- **Provenance ledger** — publish F11 receipts to a tamper-evident public log for regulated-data attestation.
- **Shareable cross-site recipes** — put F07 pipelines (not just single templates) in the registry and the app.
- **"API for the physical world"** — monitors + notifier as a consumer product ("tell me when concert tickets drop").

---

## Cold-start handoff prompt (paste into ANY fresh agent — resumable from zero chat history)

Execution writes this same brief to `radical-pipeline/START-HERE.md`, so you can either tell a new agent *"Read D:\MCP\radical-pipeline\START-HERE.md and proceed"* or paste the block below verbatim. It is entirely **disk-state-driven** — re-runnable after you clear history; each run reads the tracker and resumes from where the last one stopped. It self-locates the starting point (Step 1), auto-detects whether to build the planning package or the features, fans out subagents, and makes every subagent update the Excel.

```
You are the ORCHESTRATOR for the APImeMCP "Radical Pipeline". Assume ZERO prior chat context — bootstrap entirely from disk. Read only the slice each step needs; never load the whole plan at once.

STEP 1 — LOCATE STATE.
  Read C:\Users\neeti\.claude\plans\cheeky-stirring-shannon.md (the master plan).
  Check whether D:\MCP\radical-pipeline\ exists.

STEP 2 — IF radical-pipeline\ DOES NOT EXIST  →  PACKAGE-BUILD phase (plans only, NO product code):
  Execute the plan's "Execution checklist": create the folder tree; write 00-vision, the 6 ADRs,
  all 48 feature specs (02a/02b), the 03-orchestration docs, 04-git-strategy, 06-creative-ideas,
  07-platform-design (incl. hosting-options), 08-skills-matrix, START-HERE.md, and the tracker
  (pip install openpyxl; write tracker-data.json + status/ + update_status.mjs + generate_tracker.py;
  run generate_tracker.py to produce the .xlsx). Commit radical-pipeline\. Then STOP and report.

STEP 3 — IF radical-pipeline\ DOES EXIST  →  FEATURE-BUILD phase:
  Read radical-pipeline\README.md, radical-pipeline\05-tracking\tracker-data.json, and every
  radical-pipeline\05-tracking\status\*.json. From 03-orchestration (dependency DAG + wave schedule),
  pick the next UNBLOCKED feature(s), skipping anything already Done.
  For each, DISPATCH A FRESH SUBAGENT (Workflow tool / Agent tool — do NOT build inline). Its prompt
  contains ONLY: (a) the path to that feature's spec 02a/02b-features\<ID>.md, (b) the ADR(s) it
  touches, (c) its Skills section. The subagent runs `npx skills check` then `npx skills add <pkg> -g -y`
  for missing skills before coding.
  Respect: the builder cap (<=3 engine builders; a separate web/mobile/cloud pod for Program 2);
  the git strategy (04-git-strategy: branch feat\<ID>-slug off integration; Integration subagent is the
  SOLE merger); and the gate pipeline — dispatch stateless Code-Review, QA, Security (for flagged/all-X),
  and Live-Verify subagents per PR.

STEP 4 — TRACKER, after EVERY sub-task/gate (parallel subagents update safely):
  Each subagent updates ONLY its own file via:
     node D:\MCP\radical-pipeline\05-tracking\update_status.mjs <ID> <S#> <Done|In-Prog|In-Review|Blocked>
  Then regenerate the Excel:
     python D:\MCP\radical-pipeline\05-tracking\generate_tracker.py
  (generate_tracker.py merges tracker-data.json + all status\*.json → APImeMCP-Radical-Tracker.xlsx.)
  Never let two agents write the same file — each writes status\<its-own-ID>.json only.

STEP 5 — LOOP: finish the current wave, regenerate the tracker, report % + blockers, continue to the next wave.

Begin at STEP 1 now.
```

**Why this survives a cleared history:** it references only on-disk artifacts (the plan file + the `radical-pipeline/` package + the per-feature `status/*.json`). A brand-new agent with no memory reads those, sees which features are `Done`/`Blocked`/`Todo`, and picks up the next one — the tracker *is* the resume point.

## Execution checklist (the approving agent BUILDS THE PLANS — not the product)

1. `mkdir` the `radical-pipeline/` tree.
2. `00-vision.md` from the outline; `08-skills-matrix.md` from the matrix (re-run `npx skills find` per workstream to refresh).
3. `01-adrs/` — the 6 ADRs with the decisions in the ADR tables.
4. `02a-features-engine/` — **26** full F## specs (template + catalog row + S0–S11 + ADR refs).
5. `02b-features-platform/` — **22** full W##/X##/M## specs (same template; Ut the surface-reinterpreted S0–S11).
6. `07-platform-design/` — website / cloud / mobile / design-system / **hosting-options (free matrix)** docs from the design sections above.
7. `03-orchestration/` (roster/DAG/gates/decomposition/handoff) + `04-git-strategy.md` + `06-creative-ideas.md`.
8. Tracker: `05-tracking/tracker-data.json` (all ~48 features seeded from both catalogs, S-cells applicable/N-A, `START_DATE` placeholder, per-wave duration estimates) + `status/` dir with an initial `status/<ID>.json` per feature (all Todo) + `update_status.mjs` (atomic per-file writer) + `generate_tracker.py` (openpyxl, 3 styled sheets, merges `tracker-data.json` + `status/*.json`) → `pip install openpyxl` → run → confirm the `.xlsx`.
9. `START-HERE.md` = the verbatim Cold-start handoff prompt (above). `README.md` (index + "how other agents consume this: read START-HERE → vision → skills-matrix → ADRs → your assigned `<ID>` spec → follow gates → `update_status.mjs` + `generate_tracker.py` → deploy at G8").
10. Commit the `radical-pipeline/` folder. **Do NOT build any feature, scaffold any repo, or deploy anything.**

---

## Verification (that the PACKAGE is complete/coherent — not that anything runs)

- **Structure:** `radical-pipeline/` has every file; `ls 02a-features-engine | wc -l`=**26**, `ls 02b-features-platform | wc -l`=**22**.
- **Excel + update protocol:** `python 05-tracking/generate_tracker.py` runs clean → `.xlsx` opens with **3 sheets**, all **~48** rows on each, colored status cells + `% Complete` data-bar on Progress, Program/Surface columns present. `node 05-tracking/update_status.mjs <ID> S3 Done` flips only `status/<ID>.json`, and re-running `generate_tracker.py` reflects it — confirming multiple subagents can update in parallel without touching a shared file.
- **Cold-start resumability:** `radical-pipeline/START-HERE.md` exists and contains the verbatim handoff prompt; a fresh read of the plan + package + `status/*.json` is sufficient to determine the next unblocked feature with zero chat context.
- **Cross-refs resolve:** every `Deps (F##/W##/X##/M##)` points to a real spec; every ADR referenced exists in `01-adrs/`; every gate flag matches `quality-gates`; every "Key skills" entry appears in `08-skills-matrix.md`.
- **Consistency with reality:** 11 current tools; F00 = the in-flight app-connections work; the 3-repo split names `apimemcp` / `apimemcp-templates` / `apimemcp-platform`; RN+Expo + Vercel-native-free-tier-first + distribute-free-first reflected in the platform specs.
- **No product code, no scaffolding, no deploys:** `git status` shows only `radical-pipeline/` additions; no `src/`, no new repo, no Vercel/EAS actions.
