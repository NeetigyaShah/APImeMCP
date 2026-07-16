# radical-pipeline

Deep-spec planning package for APImeMCP's two-program roadmap — **Program 1: API Engine** (F00–F25, the MCP server itself) and **Program 2: Consumer Platform** (W01–W08 web, X01–X07 cloud, M01–M07 mobile). Everything in here is a **plan**, not product code — specs, contracts, orchestration rules, and a tracker for other agents to execute against. Source blueprint: [`PLAN.md`](./PLAN.md) (in-repo copy of the approved master plan).

## How other agents consume this

> read START-HERE -> 00-vision -> 08-skills-matrix -> 01-adrs -> your assigned `<ID>` spec in 02a/02b -> follow 03-orchestration gates -> `update_status.mjs` + `generate_tracker.py` -> deploy at G8

1. **[`START-HERE.md`](./START-HERE.md)** — cold-start handoff prompt. Paste into any fresh agent, or point it at this file; it bootstraps entirely from disk with zero chat history.
2. **[`00-vision.md`](./00-vision.md)** — why this exists: the inversion, the two-track model, the flywheel, target markets.
3. **[`08-skills-matrix.md`](./08-skills-matrix.md)** — feature → skill mapping. Every builder runs `npx skills check` then `npx skills add <pkg> -g -y` for whatever it's missing, before coding.
4. **[`01-adrs/`](./01-adrs/)** — the 6 cross-cutting contracts. Locked before any feature branch forks; read whichever ADR(s) your feature touches.
5. **Your assigned `<ID>` spec** — [`02a-features-engine/`](./02a-features-engine/) for F##, [`02b-features-platform/`](./02b-features-platform/) for W##/X##/M##. Each is a full spec: template + catalog row + S0–S11 sub-tasks + ADR refs.
6. **[`03-orchestration/`](./03-orchestration/)** — the gate pipeline (G0→G8), agent roster, dependency DAG/waves, task decomposition, handoff protocol.
7. **Tracker, after every sub-task/gate** — `node 05-tracking/update_status.mjs <ID> <S#> <status>` (writes only your own `status/<ID>.json`), then `python 05-tracking/generate_tracker.py` to regenerate the Excel.
8. **G8 = Promote + Deploy** — a per-wave gate, not per-feature; see `03-orchestration/quality-gates.md`.

## Index

| Path | What |
|---|---|
| [`PLAN.md`](./PLAN.md) | Source master blueprint: both programs, Phase −1 pre-flight, execution checklist, the cold-start prompt. |
| [`README.md`](./README.md) | This file. |
| [`START-HERE.md`](./START-HERE.md) | Verbatim cold-start handoff prompt — resumable from zero chat history. |
| [`00-vision.md`](./00-vision.md) | The radical idea, two-track model, flywheel, target markets. |
| [`01-adrs/`](./01-adrs/) | 6 cross-cutting ADRs — schema contract, tool/module convention, transform interface, metrics measure-model, vault vs app-connections, registry as cross-repo contract. |
| [`02a-features-engine/`](./02a-features-engine/) | 26 full specs, F00–F25 — Program 1: API Engine. |
| [`02b-features-platform/`](./02b-features-platform/) | 22 full specs, W01–W08 / X01–X07 / M01–M07 — Program 2: Consumer Platform. |
| [`03-orchestration/`](./03-orchestration/) | agent-roster, dependency-dag-and-waves, quality-gates, task-decomposition, handoff-protocol, context-bounded-workflow. |
| [`04-git-strategy.md`](./04-git-strategy.md) | Three repos, branch model, F00 reconcile, cross-repo contract. |
| [`05-tracking/`](./05-tracking/) | `tracker-data.json` + `status/<ID>.json` + `update_status.mjs` + `generate_tracker.py` + the generated `.xlsx` (own [README](./05-tracking/README.md)). |
| [`06-creative-ideas.md`](./06-creative-ideas.md) | Unscheduled moonshot idea bank. |
| [`07-platform-design/`](./07-platform-design/) | website / cloud-architecture / mobile-app-design / design-system / hosting-options. |
| [`08-skills-matrix.md`](./08-skills-matrix.md) | Feature → skill mapping + install list. |

### 02a-features-engine — Program 1: API Engine (F00–F25)

| ID | Spec |
|---|---|
| F00 | App-connections hardening & merge |
| F01 | Schema contracts |
| F02 | Drift detection |
| F03 | Nightly re-verification + badges |
| F04 | Self-healing templates |
| F05 | `synthesize_schema` (agent-native) |
| F06 | Computer-use crystallization |
| F07 | Template pipelines / DAG |
| F08 | CEL conditional branching |
| F09 | Bidirectional flows |
| F10 | Transform / normalize layer |
| F11 | Signed provenance receipts |
| F12 | Policy engine |
| F13 | Encrypted credential vault |
| F14 | Metrics 2.0 (SLA) |
| F15 | `static-http` template kind |
| F16 | Short-TTL result cache |
| F17 | OpenTelemetry observability |
| F18 | Ephemeral hosted endpoint |
| F19 | Close registry gaps (items 4/5) |
| F20 | Change-monitoring mesh |
| F21 | NL→template one-shot |
| F22 | Semantic template discovery |
| F23 | Golden-snapshot regression |
| F24 | Marketplace reputation + semver |
| F25 | OpenAPI + client export |

### 02b-features-platform — Program 2: Consumer Platform (W01–W08 web · X01–X07 cloud · M01–M07 mobile)

| ID | Spec |
|---|---|
| W01 | Platform monorepo scaffold |
| W02 | Cross-surface design system |
| W03 | Registry browser + search |
| W04 | Template detail + schema/docs |
| W05 | Web run console |
| W06 | Contribute flow |
| W07 | Auth + accounts + dashboard |
| W08 | Landing + interactive hero |
| X01 | Execution API gateway |
| X02 | Safe registry-only runtime |
| X03 | Durable jobs + heavy fallback |
| X04 | Results delivery |
| X05 | Monitors service |
| X06 | Encrypted cookies + vault |
| X07 | Registry mirror/cache DB |
| M01 | Expo app scaffold |
| M02 | Mobile design system impl |
| M03 | Browse/registry screens |
| M04 | Run screen + result views |
| M05 | Monitors + push |
| M06 | Run history + account + cookies |
| M07 | App-store prep |

Nothing here is built yet. For what to work on next: `03-orchestration/dependency-dag-and-waves.md` (next-unblocked features) and `05-tracking/status/*.json` (live per-feature state).
