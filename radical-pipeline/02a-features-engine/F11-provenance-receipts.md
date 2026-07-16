# F11 — Signed provenance receipts

## 1. Summary

- **ID / Name:** F11 — Signed provenance receipts
- **Pillar:** D (compliance) · **Wave:** 3 · **Risk:** M
- **Gates:** Ar (G3 Architect), Se (G4 Security-Reviewer) — F11 is explicitly named on the Security-Reviewer's gated-feature list in `agent-roster.md`. **Lv/G6 is not marked required** for this row (pure post-processing over an already-produced result, not new browser interaction) — see §6.
- **Modules:** `provenance.ts` (new), `engine.ts`, `types.ts`
- **Deps:** F01 (schema contracts) — hard dependency, see §5
- **What it does (catalog):** content-hash + version + schema-valid, signed, exportable — i.e. every extraction run produces a small, portable, cryptographically-signed **receipt** asserting "this exact template produced this exact data, and it did/didn't validate against its declared shape."
- **Why (market angle, 00-vision.md):** 00-vision.md names **compliance-grade provenance** as one of the target markets a no-API-today world creates (alongside financial data aggregation, healthcare portals, gov/civic data). Without F11, every result the engine or the consumer platform hands back is an unverifiable claim — fine for a dev's own script, not fine for "prove to a regulator/auditor this filing/price/record is what the site actually showed." F11 is the trust primitive the rest of the compliance story (F12 policy, and downstream the platform's shown-result trust story) builds on. 06-creative-ideas.md's "Provenance ledger" moonshot (publish F11 receipts to a tamper-evident public log) and website-design.md's template-detail page (schema F01, verification, Run, provenance F11) both consume this feature directly.

## 2. Story

**As an agent or engineer calling `execute_native_extraction`,** I get back not just `data`, but a signed receipt I can hand to a downstream system (a compliance log, a registry consumer, another agent) that proves *which* template ran, against *which* URL, *when*, whether the output matched its declared schema, and a content-hash tying the receipt to these exact bytes — without needing to trust my own client to not have altered the data en route.

**As a third party who receives a result + receipt but never talked to the MCP server** (a registry consumer, the community website, a regulator), I can fetch the engine's public key once (`get_provenance_public_key`) and independently verify any receipt (`verify_provenance_receipt`, or the same pure check offline) — the receipt is a **standalone artifact**, not a session token.

## 3. Design

### 3.1 ADRs obeyed
- **ADR-01 (schema contract):** F11 calls F01's pure `validateOutput(value, schema)` — never re-implements schema validation. `outputSchema` absent → `schemaValid: null` (ADR-01's back-compat rule), not `false`.
- **ADR-02 (tool-module convention):** the two new tools are each a separate exported `registerXxxTool(server, deps)` function, co-located in `provenance.ts` (ADR-02 explicitly allows co-location as an alternative to `src/tools/`), each appended as one line in `index.ts`. No edits to any other tool's handler body.

### 3.2 Data shapes (`src/provenance.ts`, new)

```ts
import { z } from "zod";

export const ProvenanceReceiptShape = {
  receiptVersion: z.literal(1),
  templateId: z.string(),
  templateVersion: z.string().optional(),   // populated once F24 semver lands — additive, mirrors the
                                             // ADR-01 precedent (waitStrategy/readySelector/source were
                                             // added the same way: optional, absent = old behavior)
  templateSourceHash: z.string(),           // sha256(ManifestEntry.source) — a "version" proxy that exists
                                             // TODAY, before F24 ships formal semver; ties the receipt to the
                                             // exact template code, not just a label
  targetUrl: z.string(),
  ranAt: z.string(),                        // ISO-8601, Date.now() at receipt-build time
  contentHash: z.string(),                  // sha256 hex of canonicalize(result.data)
  hashAlgo: z.literal("sha256"),
  schemaValid: z.boolean().nullable(),       // null = outputSchema absent (ADR-01 rule) — NOT false
  schemaErrors: z.array(z.string()).optional(),
  keyId: z.string(),                        // first 16 hex chars of sha256(raw Ed25519 public key)
  signAlgo: z.literal("ed25519"),
  signature: z.string(),                    // base64; signs canonicalize(receipt minus `signature`)
};
export const ProvenanceReceipt = z.object(ProvenanceReceiptShape);
export type ProvenanceReceipt = z.infer<typeof ProvenanceReceipt>;
```

Pure functions (no IO except the lazy keypair file, guarded — see §3.3):

```ts
export function canonicalize(value: unknown): string;          // stable stringify, sorted object keys, arrays kept in order
export function hashContent(value: unknown): string;            // sha256 hex over canonicalize(value)
export function getOrCreateSigningKeypair(): { privateKey: KeyObject; publicKey: KeyObject; keyId: string };
export function exportPublicKey(): { keyId: string; publicKey: string /* PEM SPKI */; algo: "ed25519" };
export function buildReceipt(input: {
  templateId: string; templateVersion?: string; templateSource: string;
  targetUrl: string; data: unknown; outputSchema?: unknown; /* JSON Schema */
}): ProvenanceReceipt;
export function verifyReceipt(receipt: ProvenanceReceipt, publicKeyPem: string): { valid: boolean; reasons?: string[] };
```

Implementation notes for the builder (confirm exact Node API via context7 at S3, see §10): Ed25519 keygen is `crypto.generateKeyPairSync('ed25519')` (Node stdlib, zero new dependency); one-shot sign/verify is `crypto.sign(null, data, privateKey)` / `crypto.verify(null, data, publicKey, sig)` (Ed25519's oneshot API takes `null` for the algorithm arg); public key export via `publicKey.export({ type: 'spki', format: 'pem' })`.

### 3.3 Module-by-module changes (exact paths)

| File | Change |
|---|---|
| `src/provenance.ts` (new) | All of §3.2 + `registerGetPublicKeyTool(server, deps)` + `registerVerifyReceiptTool(server, deps)` (ADR-02: one function per tool, same file). Keypair persisted at `templates/provenance-key.json` (new, gitignored — same treatment as the existing `templates/saved-cookies.json`); lazily created on first call via `getOrCreateSigningKeypair()`, guarded by the existing in-proc mutex (`src/lock.ts`'s `withLock`) so two concurrent first-run extractions can't race-write two different keypairs. Written with the existing `atomicWriteFile` helper, never a raw `fs.writeFileSync`. |
| `src/engine.ts` | In `runExtraction` (the same single instrumentation point ADR-04 already hooks for metrics), immediately after the result `data` is produced and (if F01 wired) `validateOutput` runs: look up the owning `ManifestEntry` via the existing `findTemplateByUrl`/manifest-lookup path (for `.source` and `.outputSchema`), call `provenance.buildReceipt(...)`, attach to the returned result as `.provenance`. One added call; no new branch, no new wrapper around extraction. |
| `src/types.ts` | Add `provenance?: ProvenanceReceipt` to `ExtractionResult` — additive/optional, same precedent ADR-01 already established for `ManifestEntry`. |
| `src/index.ts` | Two appended lines: `registerGetPublicKeyTool(server, deps)`, `registerVerifyReceiptTool(server, deps)`. No edits inside any existing tool's block (ADR-02). |
| `.gitignore` | Add `templates/provenance-key.json` alongside the existing `templates/saved-cookies.json` entry — **Se-gate blocking if missed** (private key must never be committed). |

### 3.4 MCP tool signatures (ADR-02 `registerXxxTool(server, deps)`)

1. **`get_provenance_public_key`** — `registerGetPublicKeyTool(server, deps: { exportPublicKey })`. Input: `{}`. Output: `{ keyId: string; publicKey: string; algo: "ed25519" }`. Never returns the private key.
2. **`verify_provenance_receipt`** — `registerVerifyReceiptTool(server, deps: { verifyReceipt, exportPublicKey })`. Input: `{ receipt: <ProvenanceReceiptShape as raw zod shape> }`. Output: `{ valid: boolean; reasons?: string[] }`.

No new tool is needed to *produce* a receipt — it is embedded automatically in every `execute_native_extraction` response (`result.provenance`), which is the existing tool already migrated to the ADR-02 convention by F00/F01.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `ProvenanceReceiptShape`/`ProvenanceReceipt` zod schema in `provenance.ts`; `ExtractionResult.provenance?` in `types.ts`. |
| S2 Storage | Applicable | `templates/provenance-key.json` (gitignored) via `atomicWriteFile`, guarded by `withLock`. |
| S3 Core | Applicable | `canonicalize`/`hashContent`/`getOrCreateSigningKeypair`/`buildReceipt`/`verifyReceipt`/`exportPublicKey` — pure except the guarded lazy keyfile read/write. |
| S4 Module | Applicable | New `src/provenance.ts`, co-locating the two `registerXxxTool` functions per ADR-02. |
| S5 Wiring | Applicable | Two appended `index.ts` lines; one added call inside `engine.ts`'s `runExtraction`. |
| S6 Unit | Applicable | `src/provenance.test.ts` — see §7. |
| S7 Verify | Applicable | `scripts/verify-F11.mjs` + fixture — engine-touching (Modules column includes `engine`). |
| S8 Docs | Applicable | README + `using-apimemcp` SKILL.md: document `provenance` field + the two new tools. |
| S9 Review | Applicable | G2 Code-Review (every feature). |
| S10 Live | Applicable, non-blocking | Catalog Gates = Ar, Se only (no Lv) — G6 is not a merge-blocking gate for F11, but `verify-F11.mjs` is still authored and run for live observable proof (§8), per the test-plan requirement for engine-touching features. |
| S11 Merge | Applicable | G7 Integration, standard. |

## 5. Dependencies & sequencing

- **Hard dep:** F01 (schema contracts, Wave 1) — F11 cannot assert `schemaValid` without `ManifestEntry.outputSchema` + `validateOutput` existing first. By Wave 3, F01 is already landed (Wave 1), so this is satisfied by scheduling alone.
- **ADRs obeyed:** ADR-01, ADR-02 (§3.1).
- **Formal catalog unblock:** **F18** (ephemeral hosted endpoint, Wave 5) lists `Deps: F11, registry` directly — F18's cloud-facing result trust story requires F11's receipts to exist first.
- **Narrative/product ties (not formal Deps-column edges, cite with that caveat):** the Program-2-depends-on-Program-1 note calls out "provenance (F11, trust in shown results)"; website-design.md's template-detail page shows F11 receipts; 06-creative-ideas.md's "Provenance ledger" moonshot builds on F11 receipts. None of W04/M04/X0# declare F11 in their own Deps column — treat these as future consumers, not blockers on F11.
- **Wave:** 3, alongside F04, F06, F07, F08, F15 — F11 has no intra-wave dependency on any of those siblings.

## 6. Quality gates

- **G3 Arch (Ar):** new module boundary respected — all crypto/canonicalization logic stays inside `provenance.ts`; `engine.ts` only calls `buildReceipt(...)` and stores the result, never inlines hashing/signing; ADR-02 append-only `index.ts` respected; `ExtractionResult.provenance?` is additive-optional (ADR-01 precedent).
- **G4 Security (Se), blocking:** private key never logged, never returned by any tool or error message, never committed (`templates/provenance-key.json` gitignored — verify with `git status --short`); keyfile creation race-safe (`withLock`); `verify_provenance_receipt` must reject a receipt whose `signature` doesn't match a mutated field (no false positives).
- **G6 Live-Verify:** not a required blocking gate per the catalog row (no `Lv`), but `scripts/verify-F11.mjs` is authored anyway for observable proof (§8) — run it in CI as a non-blocking check if convenient, per the Docs/Tracker agent's discretion.
- **Definition of Done:** every `execute_native_extraction` response includes a well-formed `provenance` object (validates against `ProvenanceReceiptShape`); `get_provenance_public_key` and `verify_provenance_receipt` are registered via ADR-02 and pass unit tests; a tampered receipt is reliably rejected; the private key file is gitignored and race-safe; docs updated; `npm run build` + full Vitest suite green.

## 7. Test plan

**`src/provenance.test.ts`** (Vitest, browser-free):
- `canonicalize()` produces identical output regardless of input key order (nested objects); arrays preserve element order.
- `hashContent()` is stable across repeated calls on the same value and changes when any field changes.
- `getOrCreateSigningKeypair()` creates the keyfile on first call and returns the same `keyId` on a second call (temp-dir fixture, not the real `templates/` path).
- `signReceipt`/`verifyReceipt` round-trip: a freshly built receipt verifies `true`; mutating any single field (`contentHash`, `schemaValid`, `templateId`, `signature` itself) flips the result to `false` with a populated `reasons`.
- `buildReceipt()`: `outputSchema` present + valid `data` → `schemaValid: true`; present + invalid `data` → `false` + non-empty `schemaErrors`; `outputSchema` absent → `schemaValid: null` (ADR-01 back-compat — must NOT be `false`).
- `ProvenanceReceipt.parse()` accepts every receipt `buildReceipt()` produces (shape self-consistency).
- Tool handlers (fake `deps`, per ADR-02's unit-testability consequence): `get_provenance_public_key` never includes a private-key field in its output; `verify_provenance_receipt` returns `{valid:false}` for a hand-tampered receipt fixture.

**`scripts/verify-F11.mjs`** + fixture (real Playwright, no mocks — engine-touching per §4 S7): register/run a simple fixture template end-to-end via `execute_native_extraction`; assert the response's `provenance.contentHash` equals a locally recomputed `hashContent(result.data)`; call `get_provenance_public_key`, then `verifyReceipt(provenance, publicKey)` locally and assert `true`; clone the receipt, flip one character of `contentHash`, assert `verifyReceipt` now returns `false`. Exit non-zero on any assertion failure (matches the existing `verify-*.mjs` pattern already in the repo).

## 8. Acceptance criteria (live, observable)

1. Calling `execute_native_extraction` against any registered template returns a response whose `result.provenance` has non-empty `contentHash`, `signature`, `keyId`, and a `schemaValid` that is `true`, `false`, or `null` (never missing).
2. Calling `get_provenance_public_key` returns a `keyId` matching the `keyId` on the receipt from step 1.
3. Calling `verify_provenance_receipt` with that exact receipt returns `{valid:true}`; resubmitting it with one character of `contentHash` flipped returns `{valid:false}`.
4. `node scripts/verify-F11.mjs` exits `0` and prints the built receipt plus a PASS line for the offline signature check.
5. Restarting the MCP server process and re-running step 1 yields the **same** `keyId` (keypair persisted, not regenerated per boot).
6. `git status --short` never shows `templates/provenance-key.json` (gitignored — proves the Se-gate no-secret-leakage requirement holds).

## 9. Reuse notes

Call, don't reinvent:
- **`validateOutput`** (ADR-01/F01, `src/types.ts` or `src/schema.ts`) — the sole source of `schemaValid`/`schemaErrors`; F11 must not hand-roll JSON-Schema checking.
- **`atomicWriteFile`** — persist `templates/provenance-key.json` (and, if a receipt sidecar file is ever wanted on disk, that too) the same crash-safe way `saved-cookies.json` is written.
- **`withLock`** (existing in-proc mutex, `src/lock.ts`) — guard the lazy first-call keypair creation against a race between two concurrent extractions.
- **`findTemplateByUrl`** — the existing manifest lookup to obtain `ManifestEntry.source` (for `templateSourceHash`) and `ManifestEntry.outputSchema` at the `runExtraction` call site; do not add a second lookup path.
- **The existing ADR-04 instrumentation point in `runExtraction`** — attach receipt-building at the same call site metrics already hook, instead of adding a parallel wrapper around extraction (design/reuse guidance only — F11 does not formally depend on ADR-04).
- **`registerXxxTool(server, deps)`** (ADR-02) — both new tools follow this exactly; do not add inline `server.tool(...)` calls to `index.ts`.
- Before adding `canonicalize`/stable-stringify, **check whether an equivalent helper already exists** in the repo (none confirmed from the catalog/ADRs read for this spec) — if one exists, reuse it instead of adding a second implementation.

## 10. Skills (setup + when-to-use)

No ≥1K-install skill exists in the matrix for Node's built-in `crypto` (Ed25519 signing) or JSON canonicalization — these are core-language, not a framework — so per the skill-quality bar (08-skills-matrix.md), the fallback applies:
- **`context7-mcp`** — fetch current official Node.js docs for `crypto.generateKeyPairSync('ed25519')` / `crypto.sign`/`crypto.verify` one-shot APIs and `KeyObject.export()` before writing S3 (confirm exact signatures/return shapes rather than trusting memory).
- **Already installed, no new command (from the 24 `.agents/skills/` discipline library, applied per 08-skills-matrix.md's "Already available" table):** `security-and-hardening` (guides S3/S4 — key handling, no-leak signing logic, and the G4 Se gate itself); `test-driven-development` (guides S6, the tamper/round-trip unit tests); `documentation-and-adrs` (guides S0/S8 — this spec and the README/SKILL.md updates); `code-review-and-quality`/`code-simplification` (guides S9 — keep `provenance.ts` boundary-clean per §6).
- **`using-apimemcp`** (already installed) — background on the existing 4-module convention and tool-registration patterns before touching `engine.ts`/`index.ts`.
- `zod` is already a project dependency (per ADR-01's own note that `src/types.ts` already depends on it) — no new package needed for `ProvenanceReceiptShape`.
