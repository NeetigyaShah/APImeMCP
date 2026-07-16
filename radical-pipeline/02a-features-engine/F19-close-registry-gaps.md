# F19 — Close registry gaps (items 4/5)

## 1. Summary

- **ID / Name:** F19 — Close items 4/5 gaps
- **Pillar:** E (dist+perf)
- **Wave:** 1 (parallel with F01, F05, F03, F14)
- **Risk:** L
- **Gates:** Lv only (per catalog — G3 Arch / G3b Design / G4 Security do not apply to this feature)

**What.** Commit `94b6101` already shipped item 4 (public template registry: `add_community_template` tool + `registry-client.ts` fetching `manifest.json` from jsDelivr) and item 5 (sandboxing: a declared network allowlist on registry templates). Both are real but incomplete: (a) the registry has no friction-free way for a human/CI script to pull a template without speaking MCP — no `apimemcp add` CLI; (b) nothing in CI actually checks an incoming template obeys the sandboxing contract — no lint step; (c) nothing confirms a template's *live* network behavior matches what it *declared* — `scripts/verify-registry.mjs` (built by F03, same wave) re-runs templates and diffs output shape but doesn't watch the wire. F19 closes exactly these three gaps. Nothing more.

**Why (00-vision tie-in).** The flywheel ("agents/devs contribute templates → instantly usable → verified nightly → coverage grows itself") depends on contribution being low-friction (the CLI) and on the safety posture being *enforced*, not just declared (lint + live check) — because Program 2's entire cloud story ("the cloud runs only registry templates — sandboxed + network-allowlisted — never arbitrary code") is only as trustworthy as item 5's allowlist actually being real. F19 is small and low-risk but it's the thing that makes X02 (Safe registry-only runtime) buildable on a registry anyone can trust.

## 2. User / agent story

- *As a contributor/agent*, I run `apimemcp add lulus-product-search` from a terminal and get the template written to my local `templates/` dir — no MCP client needed, same result as calling the `add_community_template` tool.
- *As the Integration agent*, I open a PR adding a new community template with no declared allowlist (or one with `eval(` in its script), and CI's new lint step fails the PR with a specific, readable reason before it ever reaches nightly verification.
- *As the Live-Verification Gatekeeper*, I run nightly `verify-registry.mjs` and it tells me not just "output shape still matches" but "this template contacted `evil-tracker.io`, which is outside its declared allowlist" — a drift the static lint could never catch because it only sees the declaration, not the runtime.

## 3. Design

### 3a. ADRs this obeys
- **ADR-02 (tool-module convention).** F19 is listed as an ADR-02 dependent. The existing `add_community_template` tool (currently inline in `index.ts` per the ADR's own "Context" grounding) is extracted into its own module with a pure, deps-injected core function — reused by *both* the MCP tool and the new CLI path, per ADR-02 §2 ("no hidden cross-boundary imports... dependencies are passed in"). If F00/F01's ADR-02 retrofit has already relocated this tool by the time F19 starts, F19 reuses it as-is instead of re-extracting.
- **ADR-06 (registry = cross-repo contract).** F19 only reads/writes the `ManifestEntry`/`Manifest` shape already defined for the registry; it adds no new cross-repo surface and does not touch platform-facing types.

### 3b. Data shapes

```ts
// src/tools/add-community-template.ts (NEW — extraction target if not already ADR-02-compliant)
export interface AddCommunityTemplateDeps {
  fetchManifest: () => Promise<Manifest>;         // reuse registry-client.ts, unchanged
  writeTemplateFile: typeof atomicWriteFile;       // reuse storage.ts atomic writer, unchanged
  templatesDir: string;
}

export async function addCommunityTemplateCore(
  deps: AddCommunityTemplateDeps,
  args: { templateId: string }
): Promise<{ templateId: string; path: string }> {
  const manifest = await deps.fetchManifest();
  const entry = manifest[args.templateId];
  if (!entry) throw new Error(`unknown registry template: ${args.templateId}`);
  const path = `${deps.templatesDir}/${args.templateId}.json`;
  await deps.writeTemplateFile(path, JSON.stringify(entry, null, 2));
  return { templateId: args.templateId, path };
}

export function registerAddCommunityTemplateTool(server: McpServer, deps: AddCommunityTemplateDeps) {
  server.tool("add_community_template", { templateId: z.string() }, async (args) =>
    toToolResult(await addCommunityTemplateCore(deps, args))
  );
}
```

```ts
// src/registry-lint.ts (NEW — pure, no IO, Vitest-tested)
export interface LintResult { templateId: string; errors: string[]; warnings: string[] }

export function isDomainAllowed(domain: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false; // fail closed: no declaration = nothing allowed
  return allowlist.some(p => p === "*" ? true : domain === p || domain.endsWith(`.${p}`));
}

export function lintManifestEntry(entry: ManifestEntry, rawScript: string): LintResult {
  const errors: string[] = []; const warnings: string[] = [];
  const allowlist = entry.allowedDomains; // NOTE: confirm exact field name item 5 (commit 94b6101) added to
                                           // ManifestEntry in types.ts — use it verbatim; do not introduce a 2nd field.
  if (!allowlist?.length) errors.push("missing/empty network allowlist");
  if (allowlist?.includes("*")) warnings.push("wildcard '*' allowlist defeats sandboxing");
  for (const bad of ["child_process", "eval(", "fs.unlink", "fs.writeFile"]) {
    if (rawScript.includes(bad)) errors.push(`disallowed pattern in template script: ${bad}`);
  }
  return { templateId: entry.id ?? "unknown", errors, warnings };
}
```

```ts
// scripts/verify-registry.mjs (F03's file — F19 EXTENDS the per-template result with:)
interface NetworkBehaviorFinding {
  templateId: string;
  declaredAllowlist: string[];
  observedDomains: string[];
  undeclaredDomains: string[];   // observedDomains minus everything isDomainAllowed() accepts
  verdict: "clean" | "drift";
}
```

### 3c. Module-by-module changes (exact paths)

| Path | Change |
|---|---|
| `src/tools/add-community-template.ts` | NEW (or confirm already-extracted by F00/F01). Houses `AddCommunityTemplateDeps`, `addCommunityTemplateCore`, `registerAddCommunityTemplateTool`. |
| `src/tools/add-community-template.test.ts` | NEW. Unit tests with a fake `deps`. |
| `src/registry-lint.ts` | NEW. `isDomainAllowed`, `lintManifestEntry` — pure, shared by both the lint script and the verify-registry extension. |
| `src/registry-lint.test.ts` | NEW. Vitest cases (S6). |
| `src/index.ts` | MODIFIED, minimally. One appended argv-dispatch block *before* server bootstrap/stdio connect: if `process.argv[2] === "add"`, call `addCommunityTemplateCore` with the same `deps` object already assembled for `registerXxxTool` calls (ADR-02 §3), print result, `process.exit`. Falls through to existing MCP-server start otherwise. This is additive dispatch, not a rewrite of the wiring block. |
| `scripts/lint-templates.mjs` | NEW. Walks `templates/` (or a `--changed` glob for CI diff-mode), loads each entry + its script text, calls `lintManifestEntry` (imported from compiled `src/registry-lint`, same import convention the existing `scripts/verify-*.mjs` already use to reach engine code), aggregates a `LintReport`, prints per-template results, exits 1 if any `errors` are non-empty. |
| `scripts/verify-registry.mjs` | MODIFIED (F03's file). Per template run, attach a Playwright request listener (`page.on("request")`), collect `observedDomains`, run each through `isDomainAllowed`, attach `network: NetworkBehaviorFinding` to that template's existing result entry, mark run `verdict: "drift"` on any undeclared domain. |
| `.github/workflows/verify.yml` | MODIFIED. New step: `node scripts/lint-templates.mjs` — required, runs on every PR touching `templates/**` or the registry client. |
| `scripts/verify-F19.mjs` | NEW. G6 live-verify proof (see §7). |
| `scripts/fixtures/f19/*.json` + a tiny local fixture server | NEW. Two fixture manifest entries (compliant / over-reaching) for the above. |
| `README.md` / `skills/using-apimemcp/SKILL.md` | MODIFIED. Document the `apimemcp add <templateId>` CLI subcommand and the new CI lint step. |

**Tool/CLI signatures registered:**
- MCP tool (existing, retrofitted if needed): `add_community_template({ templateId: string })` via `registerAddCommunityTemplateTool(server, deps)`.
- New CLI surface (not an MCP tool — an argv branch in the existing bin entry): `apimemcp add <templateId> [--json]` → same `addCommunityTemplateCore`, exits instead of starting the server.
- No new HTTP route, no app screen (engine-only feature).

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `AddCommunityTemplateDeps`, `LintResult`, `NetworkBehaviorFinding` — colocated in the modules that use them, not pushed into `types.ts` (no cross-module consumer yet; keep it local per YAGNI). |
| S2 Storage | Reused, not new | Writes go through the existing `atomicWriteFile` path already used by `add_community_template` — no second write path. |
| S3 Core | Applicable | CLI argv handler, `registry-lint.ts` matcher/linter, verify-registry network-listener extension. |
| S4 Module | Applicable | `src/registry-lint.ts`, `src/tools/add-community-template.ts`, `scripts/lint-templates.mjs`. |
| S5 Wiring | Applicable | `index.ts` argv branch (one appended block); `verify.yml` new step. |
| S6 Unit tests | Applicable | `src/registry-lint.test.ts`, `src/tools/add-community-template.test.ts` (Vitest, browser-free). |
| S7 Verify (mjs) | Applicable | `scripts/verify-F19.mjs` + `scripts/fixtures/f19/` (real Playwright — this feature touches live network behavior). |
| S8 Docs | Applicable | README + SKILL.md CLI/lint mentions. |
| S9 Review (G2) | Applicable | Standard Code-Reviewer pass — watch specifically for duplicated add-template logic between tool and CLI. |
| S10 Live-Verify (G6) | Applicable | `scripts/verify-F19.mjs` run with real Playwright is the G6 proof. |
| S11 Merge (G7) | Applicable | Standard Integration merge into `integration`. |

## 5. Dependencies & sequencing

- **Hard/soft deps:** `(F03)` — parenthetical in the catalog because it's a same-wave, sequencing dependency, not a hard blocker: F19 extends `scripts/verify-registry.mjs` and the nightly workflow that F03 creates. Within Wave 1, F03 should land its skeleton first so F19 extends real files instead of stubs; if scheduling forces F19 first, F19's builder stubs the extension against the shape in F03's row and rebases once F03 merges.
- **Soft precondition:** F00/F01's ADR-02 retrofit of the existing 11 tools (Wave 0/1). If `add_community_template` is already modularized by then, F19 reuses it outright; if not, F19 performs the minimal extraction itself as part of S4 (still small — one function move, no behavior change).
- **What it unblocks:** Nothing is listed against F19 in the F00–F25 Deps column — it is a leaf quality/tooling feature, not a hard blocker for any other F##. Informally, it derisks **X02** (Safe registry-only runtime — the whole cloud safety posture assumes the allowlist is enforced, not just declared) and **W06** (Contribute flow — a contributor-facing CLI + a clear CI lint failure message is exactly what "gate explainer" needs to point at).
- **Wave:** 1.

## 6. Quality gates

Per the catalog's own Gates column (`Lv` only) — honored exactly, no gates added or removed:

- **G0 Spec, G1 Build, G2 Code-Review, G5 QA, G7 Integration, G8 Promote** — apply (standard pipeline baseline).
- **G3 Arch** — **skip.** No new module boundary or cross-repo contract beyond the already-approved ADR-02 mechanical extraction; not a fresh boundary decision.
- **G3b Design** — **skip.** Non-UI, engine/CLI only.
- **G4 Security** — **skip.** F19 is not in the Security-Reviewer's mandatory list (that list is X##, F00/F04/F06/F11/F12/F13/F16/F18); F19 *tightens* an existing safety net rather than introducing new attack surface.
- **G6 Live/Device-Verify — applies** (flagged `Lv`, and this feature is Playwright/network-touching): `scripts/verify-F19.mjs` with real Playwright is required, not optional.

**Definition of Done:**
1. `apimemcp add <templateId>` works end-to-end from a clean build, reusing `addCommunityTemplateCore` — zero duplicated fetch/parse/write logic between the CLI and the `add_community_template` tool.
2. `scripts/lint-templates.mjs` exists, runs as a required `.github/workflows/verify.yml` step, and fails on a template missing/wildcarding its allowlist or containing a disallowed script pattern.
3. `scripts/verify-registry.mjs` reports a `network: NetworkBehaviorFinding` per template with a correct `verdict`, using live-captured requests, not just the static declaration.
4. All pure logic has green `*.test.ts`; the live behavior is proven by `scripts/verify-F19.mjs` against both fixtures.
5. README/SKILL docs mention the CLI subcommand and the CI lint step.

## 7. Test plan

**`src/registry-lint.test.ts` (Vitest):**
- `isDomainAllowed`: exact match → true; subdomain of an allowlisted domain → true; unrelated domain → false; `"*"` in allowlist → true for anything; `undefined`/`[]` allowlist → false (fail-closed).
- `lintManifestEntry`: missing allowlist → `errors` non-empty; `"*"` allowlist → `warnings` non-empty, `errors` empty; script containing `eval(` → `errors` non-empty; fully clean entry+script → both empty.

**`src/tools/add-community-template.test.ts` (Vitest, fake `deps`):**
- Known `templateId` in a fixture manifest → `writeTemplateFile` spy called once with the right path/content; returns `{templateId, path}`.
- Unknown `templateId` → rejects with a clear error; `writeTemplateFile` spy never called.

**`scripts/verify-F19.mjs` (G6, real Playwright) + `scripts/fixtures/f19/`:**
- Fixture A (`compliant-template.json`): targets a local fixture page that only calls its own declared origin → run through the extended verify-registry logic → assert `verdict: "clean"`, `undeclaredDomains: []`.
- Fixture B (`overreaching-template.json`): targets a local fixture page that also fetches a second local origin **not** in its declared allowlist → assert `verdict: "drift"`, `undeclaredDomains` contains that second origin.
- Invoke `scripts/lint-templates.mjs` against a fixture missing the allowlist field → assert non-zero exit + the specific error string; against the compliant fixture → assert exit 0.
- Spawn `node dist/index.js add <fixtureTemplateId>` against a mocked/local registry URL (via whatever env override `registry-client.ts` already exposes for a non-default registry endpoint) → assert the file lands in a temp `templates/` dir and the process exits 0 without hanging on stdio (proves the CLI branch never reaches the MCP server bootstrap).

## 8. Acceptance criteria (live, observable proof)

1. `node dist/index.js add <known-templateId>` from a clean checkout writes `templates/<templateId>.json` and exits 0 — it never blocks on stdio waiting for an MCP client.
2. `node scripts/lint-templates.mjs` against the over-reaching/missing-allowlist fixture exits non-zero with a human-readable violation line; against the compliant fixture exits 0.
3. A scratch PR adding a template with no allowlist fails the new CI lint step in `.github/workflows/verify.yml`, visibly, before nightly verification ever runs.
4. `node scripts/verify-registry.mjs` (or `scripts/verify-F19.mjs` standing in for it against fixtures) prints a `network` finding per template with the correct `clean`/`drift` verdict, and the drift case names the actual undeclared domain it observed.

## 9. Reuse notes

- **Reuse, don't reimplement:** the existing `add_community_template` fetch/parse path (`registry-client.ts`'s manifest fetch) and `atomicWriteFile` for the write — the CLI is a second *entry point* into the same core function, never a second implementation.
- **Reuse F03's run-loop:** `scripts/verify-registry.mjs`'s existing per-template Playwright page lifecycle — F19 attaches a request listener and a comparison, it does not fork a second verify script for this.
- **Skip `withLock`:** the CLI is a manual, one-shot, human-triggered command; racing it against a concurrently-running MCP server writing the same `templates/` file is a low-probability edge case for a Wave-1/Risk-L feature — noted as N/A rather than reflexively wrapped. `// ponytail: no lock; add withLock if concurrent CLI+server writes to the same template ever actually collide.`
- **Skip F02's structural-diff machinery:** comparing `observedDomains` vs `declaredAllowlist` is a flat set-difference — don't pull in the shape-diff primitive built for output-schema drift.

## 10. Skills (setup + when-to-use)

No `npx skills add` needed for F19 — it needs no new library, so per the skill-quality bar (and the ladder: don't add a dependency for what already-installed skills/stdlib cover) it uses only what's already available:

- **`.agents/skills/ci-cd-and-automation`** (already installed, provider-neutral) — guides S5 (the new `verify.yml` lint step) and S4 (`lint-templates.mjs` structure).
- **`.agents/skills/test-driven-development`** (already installed) — guides S6/S7 (write the fixture-drift test before wiring the live check).
- **`.agents/skills/code-simplification`** (already installed) — guides S9: the reviewer's specific job here is confirming the CLI truly reuses `addCommunityTemplateCore` rather than re-fetching the manifest a second way.
- **`context7-mcp` fallback** — for Playwright's request/route-interception API (`page.on("request")` semantics) used in the verify-registry extension: no ≥1K-install Playwright community skill exists (verified in 08-skills-matrix, top hit 63 installs), so per the project's context7 rule, pull live Playwright docs via `context7-mcp` rather than relying on training-data recall of the API.
