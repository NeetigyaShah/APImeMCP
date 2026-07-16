# F22 — Semantic template discovery

## 1. Summary
- **id/name:** F22, "Semantic template discovery" · **pillar:** F (creative) · **wave:** 2 · **risk:** L · **gates:** QA only
- **What:** a read-only `discover_templates` MCP tool that answers "what can APImeMCP already do for domain X" — scores every locally-registered template *and* every community-registry template against a natural-language domain string, local+registry together, ranked.
- **Why (ties to 00-vision.md):** the flywheel ("agents/devs contribute templates → instantly usable → usage signals which matter → more contribution") only compounds if existing coverage is *findable*. Without discovery, every agent re-solves a site with F05 (synthesize_schema) or F06 (computer-use crystallization), or a human hand-hunts the registry — duplicated work against the very inversion the vision describes ("a template a portable, versioned, verified unit of programmatic access… crowd-and-agent-supplied, not vendor-supplied"). F22 is the cheap lookup step that should run *before* F21's "make me an API for X" one-shot and before burning a synthesize/crystallize pass — local, no browser, no external LLM call, preserving the project's "no paid API key" posture (06-creative-ideas.md).

## 2. Story
- **Agent story:** an MCP-connected agent is asked "get me SEC EDGAR filing alerts." Before spending a computer-use pass or a synthesize_schema call, it calls `discover_templates({domain:"SEC EDGAR filings"})`. It gets ranked hits from its own local templates and the community registry; if a hit scores high enough it calls `execute_native_extraction` directly instead of authoring anything new.
- **Human story** (secondary — no dedicated UI in this feature): a developer poking the server with an MCP inspector/CLI client runs the same tool to check "did someone already automate this site" before hand-writing a template.

## 3. Design

### ADRs obeyed
- **ADR-02** (tool-module convention): ships as `registerDiscoverTemplatesTool(server, deps)`, co-located in the new module rather than a separate `src/tools/` dir (ADR-02 §1 leaves this as builder's choice — one tool here, a second directory buys nothing). `index.ts` gets exactly one appended call; no existing block is touched.
- **ADR-06** (registry as cross-repo contract): F22 reads the registry only through the existing internal `registry-client.ts` manifest accessor — it never fetches/parses the `apimemcp-templates` repo itself, and it is Program 1 code so it never imports platform code either.
- **ADR-01** (schema contract): N/A — `discover_templates` returns tool/discovery metadata (ids, names, scores), not a template's declared `outputSchema` result, so there's nothing to validate against.

### Data shapes — new file `D:/MCP/src/discovery.ts`
```ts
export interface DiscoveryQuery {
  domain: string;                          // "SEC EDGAR filings", "restaurant reservations"
  limit?: number;                          // default 10, max 50
  source?: 'local' | 'registry' | 'both';  // default 'both'
}

export interface DiscoveryCandidate {      // normalized shape, one per template regardless of origin
  templateId: string;
  name: string;
  description?: string;
  tags?: string[];
  targetUrl?: string;
  source: 'local' | 'registry';
}

export interface DiscoveryHit extends DiscoveryCandidate {
  score: number;        // 0..1
  matchedOn: string[];  // e.g. ["name:filing", "targetUrl-host:sec.gov"]
}

export interface DiscoveryResult {
  query: string;
  hits: DiscoveryHit[];
}

export interface DiscoveryDeps {
  listLocalTemplates: () => DiscoveryCandidate[];              // adapts storage.ts's manifest entries
  listRegistryTemplates: () => Promise<DiscoveryCandidate[]>;  // adapts registry-client.ts's manifest
}
```

Core functions (pure, no IO — testable with fake `deps`):
```ts
export function tokenize(s: string): string[];
// lowercase, strip punctuation, drop tokens <3 chars & a tiny stopword set

export function scoreCandidate(queryTokens: string[], c: DiscoveryCandidate): { score: number; matchedOn: string[] };

export async function searchTemplates(q: DiscoveryQuery, deps: DiscoveryDeps): Promise<DiscoveryResult>;
// fetch by source -> normalize -> score -> dedupe by templateId (local wins) -> sort desc -> slice(limit)

export function registerDiscoverTemplatesTool(server: McpServer, deps: DiscoveryDeps): void;
```

Scoring is deliberately **lexical, not embeddings**: `score = matchedQueryTokens / totalQueryTokens`, plus a flat `+0.3` bonus if the domain string (or a token) substring-matches the candidate's `targetUrl` hostname; matched fields land in `matchedOn` for explainability. No vector DB, no embeddings model, no new dependency — a wave-2/risk-L/QA-only feature earns a token-overlap scorer, not an ML pipeline.
`// ponytail: lexical token-overlap scoring — ceiling is literal/near-literal keyword matches; upgrade to a fuzzy-match lib (see §10) only if QA's real-registry pass shows misses on paraphrased queries.`

### Module-by-module changes
| File | Change |
|---|---|
| `D:/MCP/src/discovery.ts` | **NEW.** All types + `tokenize`/`scoreCandidate`/`searchTemplates`/`registerDiscoverTemplatesTool` above. |
| `D:/MCP/src/discovery.test.ts` | **NEW.** Unit tests, see §7. |
| `D:/MCP/src/index.ts` | **MODIFY, append-only** (ADR-02 §3): add `listLocalTemplates`/`listRegistryTemplates` entries to the one shared `deps` object (thin wrappers over whatever `storage.ts`/`registry-client.ts` already export — see §9), then append `registerDiscoverTemplatesTool(server, deps);`. No existing block edited. |
| `D:/MCP/src/storage.ts` | **MODIFY only if missing.** Grep for an existing "list all registered templates" export first (`get_extraction_stats` already needs one) — add a one-line accessor only if truly absent. |
| `D:/MCP/src/registry-client.ts` | **No change expected.** F03/F06/F24 already fetch the registry manifest through it; `discovery.ts` maps its existing export's output to `DiscoveryCandidate`. |

### MCP tool signature (ADR-02 convention)
```ts
// registerDiscoverTemplatesTool(server, deps)
server.tool(
  'discover_templates',
  {
    domain: z.string().min(1).describe('natural-language description of the target site/task'),
    limit: z.number().int().positive().max(50).optional().default(10),
    source: z.enum(['local', 'registry', 'both']).optional().default('both'),
  },
  async ({ domain, limit, source }) => {
    const result = await searchTemplates({ domain, limit, source }, deps);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);
```
Read-only: no filesystem writes, no Playwright, no vault/cookie access — this is why §6 has the smallest gate set in the catalog.

## 4. Sub-tasks (S0–S11)
| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Yes | this document |
| S1 Types | Yes | `DiscoveryQuery/Candidate/Hit/Result/Deps` in `discovery.ts` |
| S2 Storage | Yes (thin) | reuse `storage.ts`'s existing enumerator; add one line only if truly missing |
| S3 Core | Yes | `tokenize` / `scoreCandidate` / `searchTemplates` |
| S4 Module | Yes | `discovery.ts` + `registerDiscoverTemplatesTool` |
| S5 Wiring | Yes | one appended line + two `deps` keys in `index.ts` |
| S6 Unit tests | Yes | `discovery.test.ts`, see §7 |
| S7 Verify-mjs | **N/A** | no browser/Playwright surface; Gates = QA only, G6 explicitly skipped (pure-logic engine feature) |
| S8 Docs | Yes | README tool list + `using-apimemcp` SKILL gains a `discover_templates` example |
| S9 Review (G2) | Yes | standard code review |
| S10 Live-verify (G6) | **N/A** | same reason as S7 |
| S11 Merge (G7) | Yes | standard integration merge |

## 5. Dependencies & sequencing
- **Hard deps:** none — catalog `Deps` = "—". F22 can start as soon as Phase-0 ADRs land, independent of F00.
- **Wave 2**, alongside F02/F10/F16/F23 — no file contention expected: each ships a new module + one `index.ts` append (ADR-02); Integration agent reorders appends if two land the same day.
- **Unblocks:** nothing formally lists F22 as a dependency. Informally pairs with **F21** (NL→template one-shot, wave 5) as the recommended pre-check before synthesizing, and is the engine-side analog of **W03** (registry browser, Program 2) — not a hard link; W03 reads its own X07 Postgres mirror per ADR-06, it does not call this MCP tool.

## 6. Quality gates
Catalog Gates = "QA only" → `G0 Spec → G1 Build → G2 Code-Review → G5 QA → G7 Integration → (wave) G8 Promote`.
- **G3 Arch:** N/A — new module + one append, no boundary change.
- **G3b Design:** N/A — no UI.
- **G4 Security:** N/A — read-only, no secrets/browser/network-write surface; registry-client's existing fetch is already gated where F03/F24 introduced it.
- **G6 Live-Verify:** N/A — pure-logic engine feature, per quality-gates.md ("pure-logic engine features skip G6").

**Definition of Done:** `discover_templates` registered via `registerDiscoverTemplatesTool`; `npm run build` clean; `discovery.test.ts` green; `source:'local'|'registry'` never triggers the unused side's deps fn (proves no wasted network call); results sorted desc by score and capped at `limit`; README/SKILL updated (S8).

## 7. Test plan — `D:/MCP/src/discovery.test.ts`
1. `tokenize` — lowercases, strips punctuation, drops <3-char/stopword tokens.
2. `scoreCandidate` — more overlapping tokens ⇒ higher score; zero overlap ⇒ score 0; case-insensitive.
3. `scoreCandidate` — hostname-substring bonus (domain "sec filings" vs `targetUrl` on `sec.gov`) bumps score and records it in `matchedOn`.
4. `searchTemplates` — merges local+registry candidates, dedupes by `templateId` (local wins on collision), sorts desc, honors `limit`.
5. `searchTemplates({source:'local'})` — a fake `listRegistryTemplates` that throws is never invoked.
6. `searchTemplates({source:'registry'})` — a fake `listLocalTemplates` that throws is never invoked.
7. No-match domain ⇒ `{ query, hits: [] }`, not a thrown error.
8. `registerDiscoverTemplatesTool` handler — fake `deps`, valid input ⇒ JSON-parseable `DiscoveryResult` in `content[0].text`; empty `domain` rejected by the zod shape before the handler runs.

No `scripts/verify-F22.mjs` / fixture (§4 S7 = N/A) — no browser surface to verify live.

## 8. Acceptance criteria (live, observable proof)
1. `npm run build && npm test -- discovery` — all green.
2. Boot the server (`node dist/index.js`) and call `discover_templates` (MCP inspector or a one-off SDK client) with `{domain:"stock quotes"}` — response lists every local/registry template whose name/description/tags/targetUrl tokenize-overlaps "stock"/"quotes", each carrying a `score` and non-empty `matchedOn`, sorted descending, length ≤ `limit`.
3. Same call with `{domain:"stock quotes", source:"local"}` while offline (network disabled) still returns local hits without erroring — proves the registry path is truly skipped, not just slow.

## 9. Reuse notes
- **Reuse:** `storage.ts`'s existing template-enumeration export (already backs `get_extraction_stats` — grep it first, don't add a second one); `registry-client.ts`'s existing manifest-fetch export (already used by F03/F06/F24); `findTemplateByUrl` as an optional exact-match signal — if a query's implied URL resolves via `findTemplateByUrl`, surface that hit at score `1.0` with `matchedOn:["exact-url-match"]`.
- **Not applicable here** (read-only feature, no engine/browser/write path): `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `buildStandaloneScript` — do not pull these in; their presence in an F22 diff is a review smell (G2 should reject it as scope creep).

## 10. Skills (setup + when-to-use)
No new dependency and no new skill install is required — this is plain TS scoring logic. Before coding, run `npx skills check` (reuse-first, per 08-skills-matrix.md), then use what's already available:
- **`using-apimemcp`** (already available, no install) — engine usage patterns for how `storage.ts` manifest entries and `registry-client.ts`'s manifest are actually structured; guides S2/S3 so the normalizer maps real fields instead of guessed ones.
- **`.agents/skills/` — `code-simplification`** (in-repo 24-skill library) — guards against the exact over-engineering trap this feature invites ("semantic" ≠ "needs embeddings/a vector DB"); guides S3.
- **`.agents/skills/` — `test-driven-development`** — guides S6 (write the 8 cases in §7 before the scorer).
- **`.agents/skills/` — `spec-driven-development`** — guides S0/S9 review against this doc.
- **Fallback / upgrade path:** if QA's real-registry pass shows the lexical scorer misses obvious paraphrases, pull docs via **`context7-mcp`** for a minimal fuzzy-match lib (e.g. Fuse.js) rather than hand-rolling one — no ≥1K-install skill exists for "semantic search" specifically, so context7 + official docs is the correct fallback per the skill-quality bar, not a weak skill.
