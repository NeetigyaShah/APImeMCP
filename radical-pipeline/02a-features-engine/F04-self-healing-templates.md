# F04 — Self-healing templates

## 1. Summary

- **ID / Name:** F04 — Self-healing templates
- **Pillar:** A (reliability) · **Wave:** 3 · **Risk:** H · **Gates:** Ar Se Lv (all three) · Critical path: ★
- **What:** When F02 drift detection (or a schema-validation failure under ADR-01) flags a template as broken, F04 captures forensic evidence (DOM snapshot + screenshot + console errors + the old script) and the live drift diff, hands that bundle to the *calling agent* over MCP, accepts a fixed script back, dry-runs + schema-validates it, and — only if it passes — opens a PR against the `apimemcp-templates` registry. **It never auto-merges and it never calls an LLM itself.**
- **Why:** This is the mechanism that makes the 00-vision moat real: "agent solves a site once, crystallizes the path into a template that runs in ms deterministically forever, **self-healing when the site changes**." Without F04, drift detection (F02) is a dead-end alert; with it, the registry's coverage survives the web changing under it — the flywheel ("self-healing keeps them working") depends on this feature existing, not on a paid auto-fix LLM (the project's no-paid-API-key constraint stays intact because the *calling agent* supplies the fix, not the server).

## 2. User/agent story

> As an agent (or a human via an agent) that depends on a community template, when the target site changes and my template starts returning garbage or failing schema validation, I want the MCP server to hand me exactly what I need to fix it — the old script, a screenshot/DOM of the new page, and a diff of what changed — so I can write a corrected script in one pass, submit it, get it dry-run-verified for free, and have a PR opened for maintainer review, instead of manually re-discovering the site from scratch or leaving the template silently broken for every other consumer.

## 3. Design

**ADRs obeyed:** ADR-01 (schema contract — `validateOutput` gates every heal before a PR opens), ADR-02 (tool-module convention — all 3 new tools are `registerXxxTool(server, deps)` modules, `index.ts` gets append-only lines).

### Data shapes (`src/types.ts` additions — purely additive, ADR-01 precedent)

```ts
export interface HealForensics {
  templateId: string;
  capturedAt: string;        // ISO
  targetUrl: string;
  domSnapshotPath: string;   // from engine.captureForensics — file, not inline blob
  screenshotPath: string;    // from engine.captureForensics
  consoleErrors: string[];
  oldScript: string;         // current ManifestEntry script source
  driftDiff: DriftResult;    // F02's diff.ts type — reused, not redefined
  outputSchema?: JsonSchema; // ADR-01 field, when present on the template
}

export type HealStatus = 'pending' | 'submitted' | 'pr-opened' | 'rejected';

export interface HealTicket {
  id: string;                // `${templateId}-${capturedAt}`
  templateId: string;
  status: HealStatus;
  forensics: HealForensics;
  createdAt: string;
  updatedAt: string;
}

export interface HealResult {
  valid: boolean;
  validationErrors?: ValidationResult['errors']; // ADR-01's ValidationResult
  dryRunOutput?: unknown;
  prUrl?: string;             // present only when valid && PR opened
  branch?: string;
  rejectedReason?: string;
}
```

### Module-by-module changes (exact paths)

| Path | Change |
|---|---|
| `src/types.ts` | Add `HealForensics`, `HealStatus`, `HealTicket`, `HealResult` (additive only — no existing field touched). |
| `src/self-heal.ts` **(new)** | Orchestration module, sibling to `drift.ts`/`transform.ts`. Exports: `captureHealForensics(templateId, deps)`, `writeHealTicket`/`readHealTicket`/`listPendingHeals` (file store, see below), `verifyHealSubmission(ticket, newScript, deps)`, `openHealRegistryPr(templateId, newScript, ticket, dryRunOutput, deps)`. Composes F02's diff, ADR-01's `validateOutput`, engine's `captureForensics`/dry-run executor, storage's `findTemplateByUrl`/`registerTemplate`. Contains **no** Playwright calls itself (stays out of engine.ts's lane) and **no** direct git/HTTP calls (delegates to `registry-client.ts`). |
| `src/engine.ts` | Export the existing forensic-capture helper (`captureForensics`) if not already exported, for `self-heal.ts` to call on-demand. **No automatic capture on every failed run** — only when `request_template_heal` is called or from the nightly sweep, to avoid disk bloat (ponytail: forensics are opt-in per ticket, not per failure). Export/reuse the same dry-run executor F05 already uses to run an agent-authored script against a live page, so `verifyHealSubmission` doesn't reimplement "run this script and see what it returns." |
| `src/registry-client.ts` | Add one exported fn, `openTemplatePr(templateId, branch, files, body): Promise<{prUrl, branch}>`, reusing whatever git/HTTP client the module already wraps. This function **must not** expose a merge/approve call — there is deliberately no `mergeTemplatePr` anywhere in the codebase (structural enforcement of "never auto-merge," not just a runtime flag). |
| `src/tools/heal-tools.ts` **(new)** | ADR-02 convention, one file, three `registerXxxTool(server, deps)` exports (below). |
| `src/index.ts` | Append-only: import the 3 register functions, add their collaborators to the shared `deps` object, append 3 `registerXxxTool(server, deps)` calls. No edits inside any other tool's block. |
| `scripts/self-heal.mjs` **(new)** | Nightly sweep, invoked as one added step in F03's `nightly-verify.yml` *after* `verify-registry.mjs`. For each template `verify-registry.mjs` marked drifted, calls `self-heal.ts`'s `captureHealForensics` + `writeHealTicket`, then reuses the existing `notifier` module to announce "N templates need healing — call `list_pending_heals`." **It fixes nothing** — it only prepares tickets for an agent's next session. This is what keeps the "never auto" invariant true even for the unattended nightly path. |
| `templates/heal-tickets/*.json` **(new dir)** | Ticket store. Lives under the already-`.gitignore`d `templates/` tree (reuses the existing ignore boundary — forensic screenshots/DOM of a live site are exactly the kind of local-only artifact that dir already exists for; no new ignore rule needed). |

### MCP tool signatures (ADR-02, in `src/tools/heal-tools.ts`)

```ts
registerRequestTemplateHealTool(server, deps)
// tool: request_template_heal
// in:  { templateId: z.string() }
// out: { ticketId: string, forensics: HealForensics }

registerSubmitTemplateHealTool(server, deps)
// tool: submit_template_heal
// in:  { templateId: z.string(), ticketId: z.string(), newScript: z.string(), notes: z.string().optional() }
// out: HealResult

registerListPendingHealsTool(server, deps)
// tool: list_pending_heals
// in:  {}
// out: { id: string, templateId: string, status: HealStatus, createdAt: string }[]  (summaries only — no forensic blobs)
```

`submit_template_heal`'s handler: load ticket → `verifyHealSubmission` (dry-run via the reused F05 executor + `validateOutput` per ADR-01) → if `valid`, ticket status → `pr-opened`, call `openHealRegistryPr`, return `HealResult` with `prUrl`; if not valid, ticket **stays `pending`** (agent can retry with another script) and `HealResult.rejectedReason` explains why. No branch is ever created for an invalid submission.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `HealForensics`/`HealTicket`/`HealResult` in `src/types.ts`. |
| S2 Storage | Applicable | Heal-ticket file store under `templates/heal-tickets/`, via reused `atomicWriteFile` + `withLock`. |
| S3 Core | Applicable | `src/self-heal.ts` orchestration logic. |
| S4 Module | Applicable | `src/tools/heal-tools.ts` (3 `registerXxxTool`). |
| S5 Wiring | Applicable | 3 appended lines + deps in `src/index.ts`. |
| S6 Unit | Applicable | `src/self-heal.test.ts`. |
| S7 Verify | Applicable | `scripts/verify-F04.mjs` + `scripts/fixtures/self-heal/` (engine/browser-touching). |
| S8 Docs | Applicable | README + `using-apimemcp` SKILL.md: document the 3 tools + heal workflow. |
| S9 Review | Applicable | G2 Code-Review (mandatory, H risk). |
| S10 Live | Applicable | G6 Live-Verify — real Playwright + real (local, non-GitHub) PR-branch proof. |
| S11 Merge | Applicable | G7 Integration. |

None N/A: F04 is engine- and browser-touching, security-flagged, and UI-free (no S3b design gate).

## 5. Dependencies & sequencing

- **Hard deps:** ADR-01 (`validateOutput`), ADR-02 (tool convention) · **F02** (drift detection — supplies `DriftResult`, the reference diff F04 packages into forensics) · **F03** (nightly re-verification — `verify-registry.mjs` is what flags which templates `scripts/self-heal.mjs` sweeps; F04 adds one step to F03's `nightly-verify.yml`, does not own that file) · **F05** (`synthesize_schema` — F04 reuses its "agent writes script → dry-run via the executor" pattern for `verifyHealSubmission` instead of re-implementing script execution).
- **Sequencing:** Branches off `integration` after F00 (engine.ts erosion fix must land first — F04 edits `engine.ts` too) and after F01/F02/F03/F05 have merged (Wave 0→1→2 in that order per the critical path `ADR-01→F01→F02→F04`, F04 also needs F03+F05 from Wave 1).
- **Unblocks:** No feature lists F04 in its own `Deps` column — F04 is a leaf on the critical-path chain, not a blocker for later waves. F06 (computer-use crystallization) and F21 (NL→template) share the *conceptual* pattern (agent authors a script, engine dry-runs it, registry-client opens a PR) but do not hard-depend on F04's code — each implements its own tool per ADR-02, and could reuse `self-heal.ts`'s `verifyHealSubmission`/`openHealRegistryPr` opportunistically if their builder chooses, but that is not a gate requirement here.

## 6. Quality gates

`G0 Spec → G1 Build → G2 Code-Review → G3 Arch → G4 Security → G5 QA → G6 Live-Verify → G7 Integration → G8 Promote`. (No G3b — no UI surface.)

- **G3 Arch:** new module (`self-heal.ts`) respects the 4-module boundary (no Playwright inside it, no direct git/HTTP inside it); tools follow ADR-02 exactly; `types.ts` additions are purely additive.
- **G4 Security (blocks — Security-Reviewer explicitly gates F04 per `agent-roster.md`):** no secret leakage in the forensics bundle or PR body (no cookies/tokens serialized into `HealForensics` or PR content); the registry PR path has **no merge capability anywhere in the code** (`registry-client.ts` exposes `openTemplatePr`, never a merge/approve fn); registry input (the agent-submitted `newScript`) is treated as untrusted until `validateOutput` passes — it is dry-run, never written to the manifest, before that check.
- **Definition of Done:** all S0–S11 done · `request_template_heal`/`submit_template_heal`/`list_pending_heals` registered per ADR-02 and appended (not inlined) in `index.ts` · a genuinely broken template can be healed end-to-end against the fixture with a real PR branch created and real `main` left untouched · an invalid submission is provably rejected with zero registry side-effects · `scripts/self-heal.mjs` runs standalone and only writes tickets, never scripts/PRs.

## 7. Test plan

**`src/self-heal.test.ts` (Vitest, browser-free, fake `deps`):**
- `captureHealForensics` composes a `HealTicket` from mocked engine/storage/F02 deps (paths + diff + old script all present).
- Ticket store round-trips (`writeHealTicket` → `readHealTicket` → `listPendingHeals`) using a temp dir, via `atomicWriteFile`/`withLock`.
- `verifyHealSubmission` with a schema-passing dry-run → `{valid:true, dryRunOutput}`, ticket untouched by this call (status change is the caller's job).
- `verifyHealSubmission` with a schema-**failing** dry-run → `{valid:false, rejectedReason}` — **and assert `openHealRegistryPr`/registry-client's PR fn is never called** (this is the test that pins the never-heal-on-a-bad-fix invariant).
- `openHealRegistryPr` against a mocked `registry-client` → asserts it calls the PR-open fn and that no merge/approve fn exists to call (compile-time: `registry-client.ts` simply has none).
- Tool-handler tests for all 3 `registerXxxTool` fns with fake `deps` (ADR-02's whole point — no MCP server boot needed).

**`scripts/verify-F04.mjs` + `scripts/fixtures/self-heal/` (real Playwright, live-verify gate):**
- Fixture: a tiny local static server serving `v1.html` (the page the template was written against) and `v2.html` (a mutated structure — renamed class/reordered DOM, simulating real drift).
- Flow: register a fixture template against `v1.html` with an `outputSchema` → switch server to `v2.html` → run extraction → confirm drift/schema failure is flagged → `request_template_heal` → assert real screenshot + DOM snapshot files exist on disk → `submit_template_heal` with a script still matching `v1` selectors → assert `valid:false`, no branch created → `submit_template_heal` with a corrected `v2`-matching script → assert `valid:true`, a real branch/commit exists in a **local bare git repo** (never a live GitHub call in CI), and that repo's default branch is unchanged. Exits non-zero on any assertion failure, per the existing `verify-*.mjs` convention.

## 8. Acceptance criteria (live, observable proof)

1. `node scripts/verify-F04.mjs` exits 0 and prints: ticket id, the on-disk forensics file paths (they exist and are non-empty), the PR branch name + commit sha in the local fixture repo, and confirms the fixture repo's main ref is unchanged.
2. Calling `request_template_heal` for the deliberately-drifted fixture template returns real forensic file paths (not placeholders) plus the old script text and a non-trivial `driftDiff`.
3. Calling `submit_template_heal` with an uncorrected script returns `valid:false` with a `rejectedReason`, and a repeat `list_pending_heals` call shows the ticket still `pending` (not silently dropped or force-progressed).
4. Calling `submit_template_heal` with the corrected script returns `valid:true` and a real `prUrl`/`branch`; `list_pending_heals` now shows that ticket `pr-opened`.
5. `node scripts/self-heal.mjs` run standalone against a registry with one drifted template writes exactly one new ticket file under `templates/heal-tickets/` and creates zero scripts, zero PRs, zero branches.

## 9. Reuse notes

Call, don't reimplement: **`captureForensics`** (engine.ts — DOM/screenshot/console capture on demand) · **`atomicWriteFile`** (storage.ts — every ticket write) · **`withLock`** (lock.ts in-proc mutex — guards the ticket store from a race between an interactive tool call and the nightly sweep) · **`registerTemplate`** (storage.ts — only after a healed script is PR-merged upstream and re-synced locally, never before) · **`findTemplateByUrl`** (storage.ts — locates the template a failing run belongs to) · **`buildStandaloneScript`** (engine.ts — serializes the corrected template into the `.mjs` file the PR actually adds/updates, instead of hand-rolling script-file text) · F02's `DriftResult`/diff primitive (reused type and function, not re-diffed) · ADR-01's `validateOutput` (the single gate before any PR) · ADR-04's existing `runExtraction` instrumentation point (the dry-run inside `verifyHealSubmission` emits through that same measure, not a second bespoke one) · the existing `notifier` module (nightly sweep's only output) · F05's script-dry-run executor (reused wholesale for `verifyHealSubmission`, not duplicated).

## 10. Skills (setup + when-to-use)

Everything F04 needs is **already available — no new install**, per the skill-quality bar in `08-skills-matrix.md` (Playwright-specific community skills top out at 63 installs and are deliberately rejected in favor of `context7`). Builder runs `npx skills check` first (idempotent) to confirm presence, then proceeds:

| Skill | Source/signal | Guides |
|---|---|---|
| `.agents/skills/test-driven-development` | in-repo discipline skill, already installed | S6 (write the never-heal-on-bad-fix test first) |
| `.agents/skills/security-and-hardening` | in-repo discipline skill, already installed | S3/S4 + G4 — the never-auto-merge structural invariant |
| `.agents/skills/browser-testing-with-devtools` | in-repo discipline skill, already installed | S7 — the real Playwright fixture + forensics capture |
| `.agents/skills/git-workflow-and-versioning` | in-repo discipline skill, already installed | S3 — `openTemplatePr` branch/commit hygiene |
| `.agents/skills/documentation-and-adrs` | in-repo discipline skill, already installed | S8 |
| `using-apimemcp` | project skill, already installed | S0/S3 — engine usage patterns, F05's dry-run executor |
| `context7-mcp` | fallback (no ≥1K-install reputable Playwright or GitHub-PR-API skill exists) | S3/S7 — live Playwright API docs (screenshot/selector waits) and GitHub REST/`gh` CLI PR-creation semantics for `registry-client.ts`'s `openTemplatePr` |

No entry from the "to install" skills.sh table applies (those are mobile/BullMQ-specific); nothing new to add for F04.
