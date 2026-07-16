# F03 — Nightly Re-verification + Badges

## 1. Summary

- **ID / Name:** F03 — Nightly re-verification + badges
- **Pillar:** A (reliability) · **Wave:** 1 · **Gates:** Lv (Live-Verify only) · **Risk:** L
- **What:** A script (`scripts/verify-registry.mjs`) that re-runs every registry template's extraction against its live target, plus a nightly GitHub Actions workflow that drives it and publishes a per-template shields.io status badge back into the `apimemcp-templates` registry repo.
- **Why:** 00-vision.md's flywheel line is explicit: "*Agents/devs contribute templates (registry PRs, **verified nightly**) → instantly usable in web + app → consumers run/monitor them...*". A crowd-sourced template registry is only a trust-worthy alternative to vendor APIs if staleness is caught automatically — otherwise the registry rots silently the way abandoned npm packages do, and the whole "agent solves it once, runs deterministically forever" moat collapses into "runs until the site changes and nobody notices." F03 is the mechanism that keeps the moat honest, and it is the literal trust signal ("live verification badges") that W03's registry-browser ledger renders per row and that F04 (self-healing) uses as its failure trigger.

## 2. Story

- **As a template author / contributor**, when I open a PR against `apimemcp-templates`, I want an automated check to prove my new template actually extracts data from its live target before a human reviews it — not just that it type-checks.
- **As an agent or developer browsing the community registry** (W03), I want to see, next to each template, a live badge that says "passing" (checked last night) or "failing" (broken since a site change) — not just "was accepted once, six months ago" — before I build a pipeline on top of it.
- **As F04 (self-healing templates)**, I need a trustworthy, low-noise signal that a specific template just broke, on a predictable nightly cadence, so I can hand its forensics to a fixing agent without polling every template myself.

## 3. Design

### 3.1 ADR compliance

- **ADR-06 (Registry = cross-repo contract).** `src/registry-client.ts` already fetches `manifest.json` (`Manifest = Record<string, ManifestEntry>`) from `https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/registry`. F03 **reuses that fetch**, never re-implements it, and treats `ManifestEntry` as the only contract — badges are *derived data*, not a new shared type, so they never touch the ADR-06 semver-major tripwire.
- **ADR-04 (Metrics measure-model)** is the natural per-run record shape (`{templateId, kind, success, durationMs, timestamp, error?}` emitted by `runExtraction`) — F03's verification loop calls `runExtraction` directly (see 3.3) instead of re-deriving success/duration itself, so its badge data is just ADR-04's own measure, filtered to the nightly run.
- **ADR-01 (`ManifestEntry.outputSchema?`)** is not required by F03 (no output-shape validation here — that's F01/F02's job); F03 only checks "did extraction complete and return something," reusing whatever validation those features later layer in.

### 3.2 Data shapes

```ts
// scripts/verify-registry.mjs — JSDoc @typedef (matches the plain-.mjs style of existing scripts/verify-*.mjs; no new .ts module needed for this)

/** @typedef {{
 *   templateId: string;
 *   ok: boolean;
 *   durationMs: number;
 *   timestamp: string;                 // ISO 8601
 *   error?: string;
 *   skipped?: 'no-fixed-target';        // set instead of ok/error when the template has no fixedTargetUrl
 * }} VerificationRecord */

/** @typedef {{
 *   schemaVersion: 1;
 *   label: 'apimemcp';
 *   message: 'passing' | 'failing' | 'unverified';
 *   color: 'brightgreen' | 'red' | 'lightgrey';
 * }} ShieldsEndpointBadge */               // https://shields.io "endpoint" badge schema, consumed as
                                             // https://img.shields.io/endpoint?url=<badge json url>
```

`templateId` is already filename-safe by the existing `register_extraction_template` contract (`^[a-z0-9]+(-[a-z0-9]+)*$`), so `badges/<templateId>.json` needs no escaping.

### 3.3 Module-by-module changes (exact paths)

| Path | New/Touch | Change |
|---|---|---|
| `scripts/verify-registry.mjs` | **New** | Driver. Loads the manifest via `registry-client`'s existing fetch, partitions entries by presence of `fixedTargetUrl` (verifiable vs `skipped:'no-fixed-target'`), calls engine's `runExtraction(templateId, fixedTargetUrl)` **in-process** for each verifiable entry (reuse, not `buildStandaloneScript` — that helper is for the *external* ".mjs download" feature on the template-detail page, a different use case), classifies each `VerificationRecord` → `ShieldsEndpointBadge`, writes one JSON per template under `--out` (default `./.verify-badges/`, local scratch, not committed by this repo). CLI: `node scripts/verify-registry.mjs [--only <templateId>] [--concurrency <n=4>] [--out <dir>] [--dry-run]`. |
| `scripts/verify-F03.mjs` | **New** | G6 fixture script (distinct from the file above — this one *tests* it). See §7. |
| `src/registry-client.ts` | **Touch (additive)** | Export the manifest-fetch function if not already exported; add a small pure filter `listVerifiable(manifest)` returning `[templateId, ManifestEntry][]` where `fixedTargetUrl` is set. No behavior change to existing exports. |
| `.github/workflows/nightly-verify.yml` | **New** | Triggers: `schedule` (nightly cron, e.g. `17 6 * * *`) and `workflow_dispatch` (optional `templateId` input for a manual single-template run). Steps mirror the existing `.github/workflows/verify.yml`'s Node/Playwright setup. Runs `verify-registry.mjs` in full mode (always exits 0 — a broken *community* template must never redden this repo's own CI), then checks out `apimemcp-templates` with a scoped `TEMPLATES_REPO_TOKEN` secret (contents:write only, that repo only), copies `.verify-badges/*.json` → `badges/`, commits+pushes to `main` if changed. **If `TEMPLATES_REPO_TOKEN` is unset (fork/dry-run), log and skip the commit step rather than failing the job** — `# ponytail: unset-secret is a valid state (forks, first-time setup), not an error`. |
| `package.json` | **Touch (additive)** | Add a `bin` entry (e.g. `"apimemcp-verify-registry": "scripts/verify-registry.mjs"`) so `apimemcp-templates`'s own PR CI can run `npx @neetigyashah/apimemcp apimemcp-verify-registry --only <changedTemplateId> --dry-run` — this is exactly the hook 04-git-strategy.md already promises: *"`apimemcp-templates` ... PR-per-template (gated by **F03 verify** + F19 lint)"*. Building that PR-side workflow file lives in the `apimemcp-templates` repo, out of F03's Modules scope — F03 only has to expose a stable, invocable CLI contract, which this bin entry does. |

### 3.4 MCP tool / HTTP route / app screen (ADR-02)

**N/A.** F03 adds no MCP tool, route, or screen. Badges are static JSON consumed directly by shields.io's own image service (`img.shields.io/endpoint?url=...`) from the registry-browser HTML (W03) — the badge URL is a pure function of `templateId` (`https://img.shields.io/endpoint?url=https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/badges/<templateId>.json`), so nothing needs to round-trip through the MCP server or X07's registry mirror at read time. If a later feature wants agents to query verification status programmatically, that would be a new tool under ADR-02 in that feature's own spec — not invented here.

### 3.5 Notifier hook (nice-to-have reuse, not new infra)

On a pass→fail (or fail→pass) transition for a template between two nightly runs, call the existing `notifier.ts` module (already used by other alerting paths, e.g. F20's mesh) rather than building new alerting — one call site, not a new module.

## 4. Sub-tasks (S0–S11)

| # | Sub-task | Applicable? | Note |
|---|---|---|---|
| S0 Spec | Yes | This document. |
| S1 Types | Yes (light) | `VerificationRecord` / `ShieldsEndpointBadge` JSDoc typedefs only — no Zod; no untrusted external input crosses a boundary here. |
| S2 Storage | Yes | Local badge-JSON write (`atomicWriteFile`) to `--out`; cross-repo commit is the workflow's job, not this repo's storage layer. |
| S3 Core | Yes | The verify loop + `computeBadge()` classification — kept as pure functions for S6. |
| S4 Module | Yes | Additive `registry-client.ts` export + `listVerifiable()`. |
| S5 Wiring | Yes | `nightly-verify.yml` triggers + `package.json` `bin`. **Not** `index.ts` — no tool (§3.4). |
| S6 Unit | Yes | Vitest on `computeBadge()`/classification purity and the new `registry-client` export. |
| S7 Verify | Yes | `scripts/verify-F03.mjs` + 2 local fixtures (good/broken) — real Playwright. |
| S8 Docs | Yes | README "Registry verification badges" section (how an author reads/embeds theirs); one-line note in `using-apimemcp` SKILL.md. |
| S9 Review (G2) | Yes | Standard. |
| S10 Live (G6) | Yes | **Required** — Gates column = `Lv`. |
| S11 Merge (G7) | Yes | Merge to `integration` **before** F19 forks (same-file sequencing, §5). |

## 5. Dependencies & sequencing

- **Hard deps (catalog `Deps`):** `registry` — already satisfied; `apimemcp-templates` + `registry-client.ts`'s manifest fetch exist today (ADR-06). No blocking predecessor feature.
- **ADR dependency:** ADR-06 only (must fetch via `registry-client`, must never have platform/templates-repo code import engine internals — badges are data, so this holds trivially).
- **Wave:** 1, alongside F01, F05, F14, F19.
- **What it unblocks:**
  - **F04 (self-healing, Wave 3)** — hard dep (`F02,F03,F05`). F04 consumes a red badge / failed `VerificationRecord` as (one of) its drift-detected trigger(s) before handing forensics to a fixing agent.
  - **F19 (Wave 1, soft dep `(F03)`)** — F19 *extends* `scripts/verify-registry.mjs` with a live network-behavior check and adds the separate `apimemcp add` CLI + lint-in-CI. Because F19 edits the same file F03 creates, **Orchestrator must promote F03 to `integration` first within Wave 1** so F19 forks from a landed version, not a parallel copy.
  - Loosely, later features that want a trust/reputation signal (e.g. **F24** marketplace reputation, Wave 5) can read badge history rather than recomputing it — not a hard dep, just cheap reuse once it exists.

## 6. Quality gates

| Gate | Applies | Definition of Done |
|---|---|---|
| G0 Spec | Yes | This spec, consistent with ADR-06, not a duplicate of F02/F19. |
| G1 Build | Yes | `npm run build` + lint clean with the new script/module. |
| G2 Code-Review | Yes | No re-implemented manifest fetch or extraction/timing logic; minimal `registry-client.ts` diff. |
| G3 Arch | **Skip** | Additive-only touch, no 4-module boundary or shared-type change (Gates col = `Lv` only). |
| G3b Design | **Skip** | Non-UI. |
| G4 Security | **Skip** (per catalog, Risk=L) | Still: `TEMPLATES_REPO_TOKEN` scoped to contents:write on `apimemcp-templates` only, never logged/printed. |
| G5 QA | Yes | Full Vitest suite green, including new cases. |
| G6 Live-Verify | **Yes — required** | `scripts/verify-F03.mjs` passes against local fixtures with a real Playwright run. |
| G7 Integration | Yes | Rebased, merges to `integration` before F19 forks. |
| G8 Promote | At Wave-1 promotion | CHANGELOG note; `npm pack` dry-run unaffected; `bin` entry present in the packed tarball. |

## 7. Test plan

- **`src/registry-client.test.ts`** (extend existing suite): `listVerifiable()` returns only entries with `fixedTargetUrl` set; unaffected entries pass through unchanged.
- **`scripts/verify-registry.test.ts`** (Vitest, browser-free — exercise the pure classifier only): `computeBadge([...])` → `passing/brightgreen` for an all-ok record, `failing/red` for any error, `unverified/lightgrey` for `skipped:'no-fixed-target'`; CLI arg parsing (`--only`, `--concurrency`, `--dry-run`) defaults correctly.
- **`scripts/verify-F03.mjs`** (G6, real Playwright, no live third-party site — avoids CI flakiness against the open web):
  - Fixture A: `scripts/fixtures/f03-good.html` (local file, static target element present) + a matching registered template → run in `--only` mode → assert badge `passing`/`brightgreen`.
  - Fixture B: `scripts/fixtures/f03-broken.html` (same page, target selector removed — simulates a site redesign) → assert badge `failing`/`red` and a non-empty `error`.
  - Fixture C: a template entry with no `fixedTargetUrl` → assert `unverified`/`lightgrey`, and that it is *not* counted as a failure (script still exits 0 in full mode).
  - Assert `--dry-run` writes no badge file.

## 8. Acceptance criteria (live, observable)

1. `node scripts/verify-registry.mjs --only <a-real-passing-template-id>` exits 0 and writes `badges/<id>.json` with `message:"passing", color:"brightgreen"`.
2. Running the same command against a template whose live target has been intentionally broken (via the fixture in §7) produces `message:"failing", color:"red"` and a populated `error`.
3. A template with no `fixedTargetUrl` produces `message:"unverified", color:"lightgrey"` and does not affect the run's overall exit code.
4. `curl "https://img.shields.io/endpoint?url=<badge-json-url>"` returns a `200` SVG once a badge JSON is published — pasted into a browser it visibly renders green/red/grey.
5. Triggering `.github/workflows/nightly-verify.yml` via `workflow_dispatch` in the Actions UI completes green and its log shows either a real commit to `apimemcp-templates` or the explicit "no token, skipping commit" line (never a hard failure) when the secret is absent.
6. Existing `.github/workflows/verify.yml` and the full Vitest suite remain green — no regression.

## 9. Reuse notes

- **`runExtraction` (engine.ts, ADR-04's instrumented function)** — call directly per template; do not re-derive success/duration/error handling.
- **`registry-client.ts`'s existing manifest fetch (ADR-06)** — do not re-fetch/re-parse `manifest.json` by hand.
- **`fixedTargetUrl`** (already part of the `register_extraction_template` contract) — the exact discriminator for "nightly-verifiable" vs "skip."
- **`atomicWriteFile`** — for the local badge-JSON scratch writes (avoid partial files if the job is cancelled mid-run).
- **`withLock`** — guard the driver so a manual `workflow_dispatch` can't race an in-flight nightly cron run.
- **`notifier.ts`** — reuse for pass→fail/fail→pass transition alerts instead of new alerting code (§3.5).
- **Existing `.github/workflows/verify.yml`** — model `nightly-verify.yml`'s Node/Playwright setup steps on it rather than reinventing CI boilerplate.
- **Existing `scripts/verify-*.mjs` conventions** (shebang, exit-code semantics, console output style) — follow them in both new scripts.
- Explicitly **not** reused here: `buildStandaloneScript` (that's for the external ".mjs download" template-detail feature, not this in-process nightly loop).

## 10. Skills (setup + when-to-use)

- **`.agents/skills/ci-cd-and-automation`** (already available, no install) — guides S5 (the `nightly-verify.yml` triggers, secret handling, skip-on-missing-secret pattern). Run `npx skills check` first (per context-bounded-workflow.md) — it's already local.
- **`.agents/skills/observability-and-instrumentation`** (already available) — guides S3 (treating the ADR-04 measure as the source of truth for badge state, transition-based alerting).
- **`.agents/skills/test-driven-development`** (already available) — guides S6/S7 (write `computeBadge()` tests and the fixture pair before wiring the workflow).
- **`using-apimemcp`** (already available) — guides S3/S4 (how `registry-client`/`runExtraction`/`ManifestEntry` actually compose today).
- **`context7-mcp` fallback** — no ≥1K-install skill exists for "shields.io endpoint badges" or "GitHub Actions `schedule`/`workflow_dispatch` syntax" (PLAN.md's skill-quality bar explicitly rejects sub-1K/unknown-source skills, and none is listed for this need in 08-skills-matrix.md); use `context7` for shields.io's endpoint-badge JSON schema and current GitHub Actions workflow-trigger syntax while writing `nightly-verify.yml`, per the user's global Context7 instruction to fetch live docs for library/CLI/service syntax rather than rely on training data.
