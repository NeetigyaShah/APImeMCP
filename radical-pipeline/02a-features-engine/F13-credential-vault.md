# F13 — Encrypted credential vault

## 1. Summary

| Field | Value |
|---|---|
| ID | **F13** |
| Name | Encrypted credential vault |
| Pillar | **D** (compliance) |
| Wave | **4** (with F09, F12, F17, F20) |
| Gates | **Ar, Se** (per catalog row — G6 Live-Verify is run for confidence but is not a listed blocking gate for this feature) |
| Risk | **H** |
| Deps | **F00** (must be green, or its public surface frozen via ADR-05), **ADR-05** |
| Unblocks | **X06** (Cloud: encrypted cookies + optional per-user vault) — X06 hard-depends on F13+ADR-05 and is itself a Security-blocking gate |

**What.** A local, encrypted-at-rest store for named secrets (passwords, API keys, TOTP seeds, arbitrary key/value credential bundles) that can be *referenced by id* from a template's manifest and are decrypted **just-in-time**, injected into a single `executeExtraction` run, and then discarded — never written to disk, forensics dumps, metrics events, or tool return values in plaintext.

**Why.** ADR-05 draws a hard line: **app-connections (F00)** is a whole *browser identity* (a persistent Playwright profile — cookies, localStorage, everything that comes with "being logged in as X"); **the vault (F13)** is a *named secret* substituted into one script's inputs. The two are orthogonal and a vault entry MAY be referenced by an app-connection or a template directly. Without F13, the only way to automate a login-gated site is either a standing persistent-context profile (F00 — heavyweight, whole-session) or a secret pasted in plaintext into a template/script (leaks into `.agents/` forensics, chat transcripts, or an accidental `git add -A`, per the exact class of risk Phase −1 already had to gate for with `saved-cookies.json`). F13 is the primitive that makes the **compliance-grade market angle in 00-vision** viable — corporate banking / EDGAR / gov-procurement / healthcare payer portals all require a login, and the **mobile monitors wedge (X05, "push when a filing appears")** can't run unattended against a login-gated site without a secret store that doesn't leak the credential every time a monitor fires.

## 2. User / agent story

> An agent (or a human via the dashboard) wants to stand up a scheduled monitor (F20/X05) against a payer portal that requires a username+password. It calls `set_vault_secret({id:"payer-portal-login", value:{username:"...",password:"..."}})` once. The template's manifest declares `secretInputs: {username:"payer-portal-login.username", password:"payer-portal-login.password"}`. Every scheduled run, `engine.ts` resolves those refs, decrypts them in memory, fills the login form, runs the extraction, and discards the plaintext. Months later the agent runs `list_vault_secrets()` to audit what's stored — it sees `{id, label, createdAt, updatedAt}` only, never the password. If the site's self-heal forensics (F04) capture the DOM after a failed run, the captured HTML has `[REDACTED]` where the password was typed, not the password itself.

## 3. Design

### 3.1 ADRs obeyed

- **ADR-05 (Vault vs app-connections)** — governs this entire feature. `src/vault.ts` is a store **separate** from `src/app-connections.ts`; no shared state, no shared file. `engine.ts` calls *into* vault via one narrow function; vault never imports app-connections or engine internals (avoids repeating the exact `engine.ts` ↔ `app-connections.ts` erosion F00 exists to fix).
- **ADR-02 (Tool-module convention)** — vault's 3 MCP tools are each `registerXxxTool(server, deps)` in `src/vault.ts` (mirrors F00's `connect_app`/`confirm_app_connection`/`list_app_connections` pattern); `index.ts` gets 3 new append-only call lines, nothing else.
- **ADR-04 (Metrics measure-model)** — the vault must never let a resolved secret value reach the `{templateId,kind,success,durationMs,timestamp,error?}` measure point; `resolveSecretsForRun` output is excluded from anything passed to the metrics emitter.

### 3.2 Data shapes (`src/types.ts` additions + `src/vault.ts`)

```typescript
// src/types.ts — additions
export const VaultEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  algo: z.literal("aes-256-gcm"),
  iv: z.string(),          // base64, 12 bytes
  authTag: z.string(),     // base64, 16 bytes
  ciphertext: z.string(),  // base64 — encrypted JSON: string | Record<string,string>
  keyId: z.string(),       // fingerprint of the master key that encrypted this entry (rotation support)
});
export type VaultEntry = z.infer<typeof VaultEntrySchema>;

export const VaultStoreSchema = z.object({
  version: z.literal(1),
  entries: z.record(VaultEntrySchema),
});
export type VaultStore = z.infer<typeof VaultStoreSchema>;

// ManifestEntry addition (extends the existing manifest shape) — how a template *references* the vault
export const ManifestSecretInputsSchema = z.record(z.string()); // fieldName -> "vaultId" or "vaultId.subkey"
// ManifestEntry.secretInputs?: Record<string,string>  (added as an optional field alongside outputSchema from ADR-01)
```

```typescript
// src/vault.ts (new module)
export async function setVaultSecret(id: string, value: string | Record<string,string>, label?: string): Promise<{ id: string }>;
export async function listVaultSecrets(): Promise<Array<Pick<VaultEntry,"id"|"label"|"createdAt"|"updatedAt">>>; // never ciphertext/iv/authTag
export async function deleteVaultSecret(id: string): Promise<{ id: string; deleted: boolean }>;

// engine-facing — the ONLY function engine.ts calls into
export async function resolveSecretsForRun(
  secretInputs: Record<string,string>          // fieldName -> "vaultId" or "vaultId.subkey"
): Promise<Record<string,string>>;              // fieldName -> decrypted plaintext, held only for this call

// forensics-facing — used before any DOM/script dump is written to disk
export function redactSecrets(text: string, resolvedValues: Record<string,string>): string;
```

### 3.3 Module-by-module changes (exact paths under `D:/MCP/src`)

| File | Change |
|---|---|
| `D:/MCP/src/vault.ts` **(new)** | Encrypted store: AES-256-GCM via Node's built-in `crypto` (`createCipheriv`/`createDecipheriv`, `randomBytes(12)` IV). Master key: `process.env.APIMEMCP_VAULT_KEY` (base64, 32 bytes) if set, else auto-generated once into `templates/.vault-key` (0600-equivalent perms) alongside the existing gitignored `templates/saved-cookies.json` convention. Store file: `templates/vault.json` (gitignored — same directory cookie-store already treats as local-secret-safe per Phase −1). Exposes `setVaultSecret`/`listVaultSecrets`/`deleteVaultSecret`/`resolveSecretsForRun`/`redactSecrets` plus the 3 `registerXxxTool` functions. |
| `D:/MCP/src/types.ts` | Add `VaultEntrySchema`, `VaultStoreSchema`, and the optional `secretInputs?: Record<string,string>` field on the manifest/template-entry type (additive, back-compat — absent means no vault involvement, same non-breaking pattern as ADR-01's `outputSchema?`). |
| `D:/MCP/src/engine.ts` | In the `executeExtraction`/`runExtraction` path: if the resolved template has `secretInputs`, call `resolveSecretsForRun(secretInputs)` immediately before invoking the compiled script, pass the result the same way `cookieString`/proxy values are already threaded into `buildStandaloneScript`'s injected context. Immediately after the run (success or failure), let the resolved-values object fall out of scope (no caching, no closure retention). Before `captureForensics` writes DOM/script to disk on a failure, run `redactSecrets(html, resolvedValues)` / `redactSecrets(scriptSrc, resolvedValues)` first. |
| `D:/MCP/src/index.ts` | Append 3 lines: `registerSetVaultSecretTool(server, deps)`, `registerListVaultSecretsTool(server, deps)`, `registerDeleteVaultSecretTool(server, deps)` — pure append per ADR-02, no other edits. |
| `D:/MCP/src/cookie-store.ts` | **Not modified.** Referenced only as the precedent for "gitignored local JSON file in `templates/`" — vault.ts mirrors that storage convention rather than inventing a new layout, but stays a physically separate file/module (ADR-05). |
| `D:/MCP/src/app-connections.ts` | **Not modified.** F13 must not create a second coupling like the one F00 is fixing; if a future template wants "this app-connection's profile also carries a vault-backed secret", that composition happens at the *manifest* level (`secretInputs` sits next to whatever app-connection id the template already uses), never via vault.ts importing app-connections.ts or vice versa. |

### 3.4 MCP tool signatures (registered per ADR-02)

```typescript
// registerSetVaultSecretTool
server.tool("set_vault_secret",
  { id: z.string(), label: z.string().optional(), value: z.union([z.string(), z.record(z.string())]) },
  async ({ id, label, value }) => ({ id, ok: true }));  // never echoes value back

// registerListVaultSecretsTool
server.tool("list_vault_secrets", {}, async () =>
  (await listVaultSecrets()));  // [{id,label,createdAt,updatedAt}]

// registerDeleteVaultSecretTool
server.tool("delete_vault_secret", { id: z.string() },
  async ({ id }) => (await deleteVaultSecret(id)));
```

No new HTTP route or app screen in this feature (engine-only, Program 1); `src/dashboard.ts` gets one read-only addition — a vault section listing `{id, label, updatedAt}` (reuses the existing dashboard rendering pattern, no new endpoint shape).

## 4. Sub-tasks (S0–S11)

| # | Applicable? | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `VaultEntrySchema`/`VaultStoreSchema` + manifest `secretInputs?` in `types.ts`. |
| S2 Storage | Applicable | `templates/vault.json` + `templates/.vault-key`, atomic read/write in `vault.ts`. |
| S3 Core | Applicable | AES-256-GCM encrypt/decrypt, key bootstrap, `resolveSecretsForRun`, `redactSecrets`. |
| S4 Module | Applicable | `src/vault.ts` as its own module, 3 `registerXxxTool` exports. |
| S5 Wiring | Applicable | 3 append-only lines in `index.ts`; one hook call in `engine.ts`'s run path. |
| S6 Unit | Applicable | `src/vault.test.ts` (see §7). |
| S7 Verify | Applicable | `scripts/verify-F13.mjs` + login fixture — engine/browser-touching. |
| S8 Docs | Applicable | README + `SKILL.md` (using-apimemcp) gain a short "vault vs app-connections" note, cross-referencing ADR-05. |
| S9 Review | Applicable | G2 code-review — no reinvented crypto, minimal diff, boundary error handling on missing/corrupt entries. |
| S10 Live | Applicable | G6 run for confidence (real Playwright fixture) even though not a catalog-blocking gate for F13. |
| S11 Merge | Applicable | G7 — rebase onto `integration` after F00 lands. |

## 5. Dependencies & sequencing

- **Hard dep: F00.** Per `04-git-strategy.md`: "Vault (F13) ≠ app-connections (ADR-05). If F00 isn't green in time, freeze its public surface via ADR-05 so F13/X06 code against it; land F00 before F13; rebase weekly." F13 cannot merge to `integration` ahead of F00.
- **Hard dep: ADR-05.** The Architect's ADR-05 text (store separation, referencing rule) is the contract F13's module boundary must satisfy at G3.
- **Unblocks X06** (Program 2, Cloud): X06 "Encrypted cookies + optional per-user vault" lists `F13,ADR-05` as its deps and carries a **blocking Se gate** — X06 cannot start its vault-dependent surface until F13's `VaultEntry`/`resolveSecretsForRun` shape is stable.
- **Wave 4**, alongside F09 (bidirectional flows), F12 (policy engine), F17 (OTel), F20 (change-monitoring mesh) — no intra-wave ordering requirement between F13 and its wave-mates; F20's monitors are the feature most likely to *consume* F13 in practice (login-gated monitor targets) but there is no code dependency, only a product one.

## 6. Quality gates & Definition of Done

- **G3 Arch (blocks, per catalog):** Architect confirms (a) `vault.ts` never imports `app-connections.ts` and vice versa, (b) `engine.ts` calls only `resolveSecretsForRun`/`redactSecrets` — no reach-in to vault's file store, (c) the 3 tools follow ADR-02's `registerXxxTool` shape, (d) `secretInputs?` on the manifest is additive/back-compat like ADR-01's `outputSchema?`.
- **G4 Security (blocks, per catalog):** Security-Reviewer confirms (a) `list_vault_secrets` and every tool return value are ciphertext/plaintext-free, (b) `templates/.vault-key` and `templates/vault.json` stay under the existing gitignore posture (never appear in `git status --short`, matching Phase −1's exact secret-safety gate), (c) `captureForensics` output has zero occurrences of any resolved secret value after `redactSecrets` runs, (d) a missing/corrupt vault entry **fails closed** (run aborts with a typed error) rather than silently substituting an empty string into a login form, (e) decrypted values are not retained past the single `executeExtraction` call (no process-level cache).
- **Definition of Done:** A caller can `set_vault_secret` an entry, reference it by id from a template's `secretInputs`, run the template, and `scripts/verify-F13.mjs` proves — against a real local page, via real Playwright — that (1) the login succeeds using the vault-resolved value, and (2) neither the vault file, the forensics dump, the ADR-04 metrics event, nor any tool's return payload ever contains the plaintext secret.

## 7. Test plan

**`src/vault.test.ts` (Vitest, browser-free):**
- Encrypt→decrypt round-trip for a plain string value.
- Encrypt→decrypt round-trip for a structured `{username,password}` value; `secretInputs` sub-key lookup (`"id.username"`) resolves the right field.
- Tamper detection: flipping one byte of `authTag` or `ciphertext` causes decrypt to throw a typed error, not return corrupted plaintext.
- `listVaultSecrets()` output contains only `{id,label,createdAt,updatedAt}` — assert `iv`/`authTag`/`ciphertext` keys are absent from the JSON, not merely unused.
- `deleteVaultSecret` removes the entry; a subsequent `resolveSecretsForRun` referencing it fails closed with a clear "unknown vault id" error.
- `resolveSecretsForRun` resolves multiple `secretInputs` fields in one call; a missing id fails the whole call (no partial fill).
- `redactSecrets` replaces every occurrence of each resolved value in a sample HTML string and a sample script-source string.
- Master-key bootstrap: first call with no `templates/.vault-key` present creates one and reuses it on the next call (same ciphertext-decryptability across two separate `vault.ts` invocations in the test).

**`scripts/verify-F13.mjs` + fixture (engine/browser-touching — real Playwright):**
- Fixture: `scripts/fixtures/vault-login.html` — a static local login form (`username`/`password` fields, a submit button, and a `#status` element that reads "Logged in as {username}" on success).
- Script: `set_vault_secret("verify-f13-login", {username:"verify-user",password:"verify-pass"})` → a throwaway manifest entry pointing at the fixture with `secretInputs:{username:"verify-f13-login.username", password:"verify-f13-login.password"}` → `executeExtraction` → assert `#status` shows the logged-in text → assert the forensics/log output captured during the run contains zero occurrences of `"verify-pass"` → `deleteVaultSecret("verify-f13-login")` cleanup. Prints a single `PASS`/`FAIL` line consumable by CI.

## 8. Acceptance criteria (live, observable proof)

- `node scripts/verify-F13.mjs` exits 0 and prints a line confirming the fixture login succeeded via a vault-resolved credential, plus a second line confirming zero plaintext leakage into forensics/stdout.
- Calling `set_vault_secret` then `list_vault_secrets` through the MCP tool interface shows the new entry's `id`/`label`/timestamps and nothing else — visually confirmable in a manual client call or the dashboard's new vault section.
- Deleting or hand-corrupting `templates/vault.json`'s single entry and re-running the fixture template produces a clear, typed failure message (not a crash, not a silent blank-password submit).

## 9. Reuse notes (call, don't reinvent)

- **`atomicWriteFile`** (storage.ts) — vault store writes use the existing temp+rename primitive; no new file-write path.
- **`withLock`** (lock.ts, in-proc mutex) — wraps vault's read-modify-write cycle so concurrent `set_vault_secret`/`delete_vault_secret` calls can't race, same pattern already used elsewhere in the codebase.
- **`captureForensics`** (engine.ts) — reused unchanged as the capture mechanism; F13 adds a redaction *pass* in front of its writeout, not a competing forensics path.
- **`buildStandaloneScript`** (engine.ts) — resolved secrets are threaded through the same script-build injection point already used for `cookieString`/proxy, not a parallel injection mechanism.
- **`registerTemplate` / `findTemplateByUrl`** (registry-client/storage) — untouched; a template locates itself exactly as today, `secretInputs` is just one more optional manifest field it may carry.
- **Node's built-in `crypto`** (`createCipheriv`, `createDecipheriv`, `randomBytes`) — no new npm dependency for encryption; stdlib covers AES-256-GCM completely.
- **`templates/` gitignore convention** (already covers `saved-cookies.json`) — vault's two new files (`vault.json`, `.vault-key`) land in the same already-gitignored directory rather than requiring a new gitignore rule.

## 10. Skills (setup + when-to-use)

| Skill | Signal | Guides | Install |
|---|---|---|---|
| **security-and-hardening** (`.agents/skills/`) | Already available in this environment — one of the 24 discipline skills, no install step | S3 (encrypt/decrypt/key-handling/redaction design) and G4/S9 (the security-review pass: fail-closed on missing entries, no leakage into forensics/metrics) | `npx skills check` (already present globally — nothing to add) |
| **test-driven-development** (`.agents/skills/`) | Already available, no install | S6 — write the round-trip/tamper-detection/redaction tests in `vault.test.ts` before wiring the engine hook | `npx skills check` |
| **context7-mcp** (fallback only) | Used only if the builder needs current Node.js `crypto` API specifics (e.g. GCM tag-length options) beyond recall | S3, incidental | No skills.sh search performed here — this is Node **stdlib**, not a third-party library, so the ≥1K-install skill bar doesn't apply; same "no reputable skill exists → use context7 + official docs" fallback the plan already applies to Cloudflare/serverless-Chromium |

**Deliberately not installed:** no npm "vault"/"encryption" skill from skills.sh was searched for or added — Node's built-in `crypto` already fully covers AES-256-GCM (ladder: stdlib solves it), and per the plan's own skill-quality bar a narrow-need skill in this space would be expected to land well under the ≥1K-install reputable-source threshold.
