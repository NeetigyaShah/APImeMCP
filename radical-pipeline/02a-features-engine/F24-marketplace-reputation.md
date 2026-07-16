# F24 — Marketplace reputation + semver

## 1. Summary

- **ID/Name:** F24 — Marketplace reputation + semver
- **Pillar:** F (creative) · **Wave:** 5 · **Risk:** M · **Gates:** Se (Security-Reviewer required)
- **Deps:** F03 (nightly re-verify + badges), F14 (Metrics 2.0 / ADR-04 measure store)
- **Modules touched:** registry tooling (new scripts), `src/registry-client.ts`

**What.** Two additive features on top of the existing `apimemcp-templates` manifest: (a) **template versioning** — every manifest entry gets a `version` (semver) and an append-only `changelog`, bumped whenever a registry PR changes its behavior; (b) **marketplace reputation** — a `TemplateReputation` score derived *only* from server-observed signals (F03's nightly verify/badge history + ADR-04's success/failure measure records), plus a rolled-up `ContributorReputation` per template author.

**Why (market angle, 00-vision).** The vision's flywheel is "agents/devs contribute templates → instantly usable → self-healing keeps them working → coverage grows itself." That only scales past the owner's personal vetting if consumers (humans on the website, agents picking among candidates) can trust an unfamiliar community template *without reading its script*. website-design.md's registry "ledger" already shows a verification badge (F03) and run-count per row; F24 is the trust layer that ledger needs to be a real marketplace — the same function reputation serves in npm/VS Code Marketplace. It also gives F04 self-healing and F06 crystallization a non-gameable acceptance signal (fixes that keep success-rate up raise reputation; those that don't, don't) and gives Program 2 (W03 registry browser, M03 mobile browse) a trust/sort signal for free once published.

## 2. User / agent story

- *As a developer/agent choosing between three community templates that all claim to scrape the same site*, I want to see which one has a high verified success-rate and a maintained changelog, so I don't gamble on a stale or unreliable one.
- *As a template contributor*, when my self-heal fix (F04) lands and keeps passing nightly verification (F03), my template's — and my own — reputation score rises automatically; I never hand-edit a "trust me" field.
- *As `registry-client.ts` resolving a URL to a template* (`findTemplateByUrl`), when two registered templates both match, I want the tie broken by reputation/semver instead of "whichever sorts first," so callers get the more reliable one by default.
- *As the Web/Mobile builder (Program 2, later)*, I want `version`/`changelog`/`reputation` to already be optional fields on the published `ManifestEntry` type so the registry browser can render a trust badge without engine internals (ADR-06).

## 3. Design

### 3.1 Data shapes — `src/types.ts` (additive-optional, per ADR-01/ADR-06 precedent — same pattern as `waitStrategy`/`readySelector`/`source`)

```ts
export const ChangelogEntrySchema = z.object({
  version: z.string(),                       // semver, e.g. "1.2.0"
  date: z.string(),                           // ISO 8601
  kind: z.enum(["major", "minor", "patch"]),
  notes: z.string(),
  prUrl: z.string().optional(),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

export const TemplateReputationSchema = z.object({
  score: z.number().min(0).max(100),
  successRate: z.number().min(0).max(1),      // from ADR-04 measure records
  verifiedStreakDays: z.number().nonnegative(),// consecutive green F03 nightly runs
  totalRuns: z.number().nonnegative(),
  lastComputed: z.string(),                   // ISO 8601
});
export type TemplateReputation = z.infer<typeof TemplateReputationSchema>;

export const ContributorReputationSchema = z.object({
  contributor: z.string(),                    // registry-repo author handle
  templatesOwned: z.number().nonnegative(),
  avgTemplateScore: z.number().min(0).max(100),
  acceptedFixes: z.number().nonnegative(),    // merged F04 self-heal PRs authored
  lastComputed: z.string(),
});
export type ContributorReputation = z.infer<typeof ContributorReputationSchema>;

// ManifestEntry gains three optional fields (back-compat: absent = unversioned/unscored legacy entry):
//   version?: string; changelog?: ChangelogEntry[]; reputation?: TemplateReputation;
```

### 3.2 ADRs this obeys

- **ADR-01 (schema contract):** follows its "additive optional field" precedent exactly — no existing manifest entry is invalidated by lacking `version`/`changelog`/`reputation`.
- **ADR-04 (metrics measure-model):** F24 is a *consumer*, not a new instrumentation path — `computeTemplateReputation` reads the existing `{templateId,kind,success,durationMs,timestamp,error?}` records via `metrics.ts`'s aggregation API (owned by F14); it never re-instruments the run path (contract rule, enforced at G3).
- **ADR-06 (registry = cross-repo contract):** the three new fields become part of the published contract the instant they ship — Program 2 (W03/M03) may read them once published, never reach into engine internals. Any future breaking change to these shapes needs the semver-major + platform-bump note ADR-06 requires.

### 3.3 Module-by-module changes (exact paths)

1. **`src/types.ts`** (MODIFY) — add the three Zod schemas above + extend `ManifestEntry` with the three optional fields. No removal, no required field — G3 Arch checks this is purely additive.
2. **`src/reputation.ts`** (NEW, pure, no IO — mirrors `transform.ts`'s style from ADR-03):
   - `computeTemplateReputation(measures: MeasureRecord[], verifyHistory: VerifyRunRecord[]): TemplateReputation` — weighted composite: 60% recent success-rate (last N=50 measures), 30% verified-streak-days (F03 badge history), 10% run-volume (log-scaled, floors noise from a single lucky run).
   - `computeContributorReputation(entries: ManifestEntry[], acceptedFixCounts: Record<string, number>): ContributorReputation[]` — groups entries by `source`/author field already on `ManifestEntry`, averages member `TemplateReputation.score`.
   - `bumpVersion(current: string, kind: "major"|"minor"|"patch"): string` — thin wrapper over the `semver` npm package's `inc()` (new minimal dependency, same precedent as F15 adding `cheerio`; a hand-rolled `major.minor.patch` compare is the fallback if the team wants zero new deps — either is a pure one-function implementation).
   - `resolveBestCandidate(candidates: ManifestEntry[]): ManifestEntry` — tie-break: highest `reputation.score` (undefined treated as 0) then highest `semver` version then first-registered; used by the `findTemplateByUrl` tie-break below.
   - `validateChangelogBump(oldEntry: ManifestEntry, newEntry: ManifestEntry): { ok: boolean; reason?: string }` — fails if the manifest content changed but `version`/`changelog` did not move (the check F19's lint gate calls, see 3.4).
3. **`src/registry-client.ts`** (MODIFY, existing module) —
   - `findTemplateByUrl(url, manifest)`: when multiple entries match, replace "first match wins" with `resolveBestCandidate(matches)` from `reputation.ts`.
   - add `getReputation(templateId: string, manifest: Manifest): TemplateReputation | undefined` — pure field read (data already arrives on the mirrored manifest; no extra network call).
4. **`scripts/compute-reputation.mjs`** (NEW, sibling to F03's `scripts/verify-registry.mjs`) — nightly job: pulls ADR-04 measures + F03 verify-history for every manifest entry, calls `reputation.ts`'s pure functions, writes updated `version`/`changelog`/`reputation` fields, and opens a bot-authored PR against `apimemcp-templates` (reuses F04's registry-PR-opening helper — **never auto-merges**, matching F04's own rule and the Security-Reviewer's gate). Appended as one more step in F03's existing `nightly-verify.yml` — **not** a new workflow file.
5. **`src/tools/registry-reputation-tool.ts`** (NEW, per ADR-02 convention) — `registerRegistryReputationTool(server, deps)` registers:
   - **`get_template_reputation`** — input `{ templateId: string }` → output `{ templateId, version, changelog, reputation, contributorReputation }` (404-style error if `templateId` unknown).
   - **`list_top_templates`** — input `{ domain?: string, limit?: number }` → output `ManifestEntry[]` sorted by `resolveBestCandidate`'s ordering, capped at `limit` (default 10).
   `src/index.ts` gets exactly one appended line: `registerRegistryReputationTool(server, deps);` (ADR-02 — append-only, no other edits to `index.ts`).
6. **`src/dashboard.ts`** (MODIFY, minor) — add `version` + `reputation.score` columns to the existing per-template dashboard rows; no new dashboard section.

### 3.4 Reuse instead of new plumbing

`compute-reputation.mjs` explicitly calls **F19's `verify-registry.mjs` lint gate** (`validateChangelogBump`) rather than inventing a second CI check — a manifest PR that changes template content without a version bump fails the *existing* lint step F19 already wires into `verify.yml`.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `ChangelogEntrySchema`/`TemplateReputationSchema`/`ContributorReputationSchema` + `ManifestEntry` extension in `types.ts` |
| S2 Storage | Applicable | no local `storage.ts` change — persistence is the registry repo's `manifest.json` itself, written via the bot PR from `compute-reputation.mjs` |
| S3 Core | Applicable | `src/reputation.ts` pure scoring/version/tie-break logic |
| S4 Module | Applicable | `scripts/compute-reputation.mjs` + `src/tools/registry-reputation-tool.ts` |
| S5 Wiring | Applicable | one-line `index.ts` append (ADR-02); one step appended to F03's `nightly-verify.yml` |
| S6 Unit | Applicable | `src/reputation.test.ts` + `registry-client.test.ts` additions |
| S7 Verify | Applicable | `scripts/verify-F24.mjs` + fixture (below) |
| S8 Docs | Applicable | README tool list + SKILL.md entry for `get_template_reputation`/`list_top_templates` |
| S9 Review | Applicable | G2 code-review — confirm additive-only types, no second metrics-writing path (ADR-04 rule) |
| S10 Live | Applicable | G6 — real jsDelivr manifest fetch + live nightly-job dry run |
| S11 Merge | Applicable | G7 — rebased onto `integration` behind F03+F14 |

Nothing is N/A: F24 touches types, a new pure module, a new script, a new tool, and tests end to end.

## 5. Dependencies & sequencing

- **Hard deps (by feature ID):** F03 (needs the nightly verify/badge history as an input signal) and F14 (needs ADR-04's aggregated measure store — "Metrics 2.0" is what F24 reads, per ADR-04's own dependency table). Both are Wave 1; F24 cannot start scoring until both are merged and producing real data.
- **Soft integration (not a hard dep):** F19's `verify-registry.mjs` lint gate is the natural place `validateChangelogBump` plugs in — reuse, not a blocking dependency.
- **What F24 unblocks:** nothing in Program 1 is gated on F24 (it's a Wave-5 leaf on the engine side). In Program 2 (later, cross-repo via ADR-06), it is what lets **W03** (registry browser) render trust badges/version history and **M03** (mobile browse/trending) sort by reputation — those consume the published fields once F24 ships, with no engine-internals coupling.
- **Wave:** 5 (last engine wave) — by this point F03/F14 have real production data to score against instead of cold-start zeros.

## 6. Quality gates

Applicable: **G0 Spec, G1 Build, G2 Code-Review, G3 Arch, G4 Security (Se), G5 QA, G6 Live-Verify, G7 Integration, G8 Promote.** N/A: **G3b Design** (no UI surface in this repo).

- **G3 Arch** checks: `ManifestEntry` extension is additive-optional only; no second ADR-04 instrumentation path created; `reputation.ts` stays pure (no IO, no network) — only `compute-reputation.mjs` touches the network/filesystem.
- **G4 Security** (catalog-mandated `Se`) checks: reputation score is derived **only** from server-observed signals (F03 verify runs + ADR-04 measures collected by the engine itself) — never from a self-reported field inside a contributor's own manifest PR, so a malicious contributor cannot inflate their own score by hand-editing JSON; the bot PR from `compute-reputation.mjs` **never auto-merges** (same rule as F04).

**Definition of Done:** `ManifestEntry` carries optional `version`/`changelog`/`reputation` end to end; `get_template_reputation` and `list_top_templates` are registered per ADR-02 and return correct shapes for both legacy (fields absent) and new entries; `findTemplateByUrl` tie-breaks deterministically by reputation/semver; the nightly job step computes scores from real F03/F14 data and opens (never merges) a registry PR; all gates above are green.

## 7. Test plan

- **`src/reputation.test.ts`** (new): `computeTemplateReputation` — high success-rate + long verified streak → score near 100; recent failures drag score down; `bumpVersion` — patch/minor/major each produce the correct semver string, rejects a non-semver input; `resolveBestCandidate` — picks the higher-reputation entry among two matches, falls back to higher semver when scores tie, falls back to first-registered when both tie; `validateChangelogBump` — flags a manifest diff with no version/changelog movement, passes a properly bumped one.
- **`src/registry-client.test.ts`** (additions to existing file): `findTemplateByUrl` returns the reputation-preferred entry when two candidates match the same URL; `getReputation` returns `undefined` (not a throw) for a legacy entry lacking the field — back-compat proof.
- **`scripts/verify-F24.mjs`** (new, engine/registry-touching per the template's rule) + **fixture** `scripts/fixtures/f24-manifest-sample.json` (3 entries: one legacy with no `version`/`reputation`, one fully-scored, one with two same-domain candidates for the tie-break check): fetches the live jsDelivr manifest for one real registered template and asserts `version` matches `/^\d+\.\d+\.\d+$/` and, if `reputation` present, `score` is in `[0,100]` and `lastComputed` parses as a valid recent ISO date; then calls `get_template_reputation` against the running MCP server and asserts the response shape; then loads the offline fixture and asserts `resolveBestCandidate`/back-compat behavior without any network dependency (keeps CI deterministic).

## 8. Acceptance criteria (live, observable proof)

1. `get_template_reputation({ templateId: "<real-registered-id>" })` called against a running `node dist/index.js` MCP server returns a populated `{ version, changelog, reputation }` for at least one real template that has run through F03's nightly job.
2. `list_top_templates({ limit: 5 })` returns entries sorted with the highest-reputation entry first — verified by comparing the returned order to the raw manifest.
3. A dry-run of `scripts/compute-reputation.mjs` against real F03/F14 data produces a diff-only PR body (no auto-merge) showing a version bump + changelog line for a template whose behavior changed.
4. The dashboard (`src/dashboard.ts`) renders the reputation score/version column for a real template when the server is running locally.
5. `findTemplateByUrl` demonstrably returns the higher-reputation of two same-domain fixture candidates (unit test + a one-off `node -e` smoke check against the fixture).

## 9. Reuse notes

- **Reuse:** `metrics.ts`'s aggregation reader (ADR-04, owned by F14) — do not re-scan raw measure records; F03's badge/verify-history store — do not re-derive verification state; F04's registry-PR-opening helper — do not hand-roll a second "open a PR against `apimemcp-templates`" path; `findTemplateByUrl` (existing function in `registry-client.ts`) — extend its tie-break, don't fork a parallel lookup path; F19's `verify-registry.mjs` lint gate — plug `validateChangelogBump` into it rather than adding a second CI check.
- **Not applicable here:** `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `buildStandaloneScript` — F24 doesn't capture drift forensics, doesn't need local-file atomicity beyond what `compute-reputation.mjs`'s own PR-write path already handles, doesn't register new templates, and emits no standalone scripts.

## 10. Skills (setup + when-to-use)

No skills.sh package exists for a bespoke "marketplace reputation scoring" need (nothing to search for — this is project-specific logic, not a library), so per the skill-quality bar this feature runs entirely on **already-available** skills plus **context7** for the one small new library:

- **`.agents/skills/git-workflow-and-versioning`** (already installed, part of the 24-skill discipline library) — guides **S1/S3**: correct semver bump semantics (major/minor/patch) and changelog-entry conventions before writing `bumpVersion`/`ChangelogEntry`.
- **`.agents/skills/documentation-and-adrs`** (already installed) — guides **S8**: writing the README/SKILL.md entries for the two new tools and documenting the additive `ManifestEntry` fields against ADR-01/06 precedent.
- **`.agents/skills/security-and-hardening`** (already installed) — guides **S9/G4**: reasoning about the self-reported-vs-server-observed trust boundary that the Security-Reviewer gate checks (a contributor must not be able to inflate their own score).
- **`.agents/skills/test-driven-development`** (already installed) — guides **S6**: write `reputation.test.ts`'s cases before the scoring formula, since the weighting (60/30/10) is exactly the kind of logic that should be pinned by tests first.
- **`using-apimemcp`** (already available) — guides **S3/S7**: how `registry-client.ts` and the MCP tool-registration convention already work, before extending them.
- **`context7-mcp` fallback** — if the team picks the `semver` npm package over hand-rolled comparison for `bumpVersion`/`resolveBestCandidate`, use `context7` (resolve-library-id → query-docs) to pull current `semver` package API docs (`inc`, `compare`, `satisfies`) rather than relying on training-data recall of its API — this is the explicit context7 fallback the skill-quality bar calls for when no reputable installed skill covers a small library need.
