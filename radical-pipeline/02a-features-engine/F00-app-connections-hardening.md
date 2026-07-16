# F00 — App-connections hardening & merge

## 1. Summary

- **ID:** F00 (★ critical path) · **Name:** App-connections hardening & merge · **Pillar:** Fnd (Foundation) · **Wave:** 0 (pre-Wave-1) · **Risk:** M · **Gates:** Ar Se Lv (all three ⚫ required)
- **Modules touched:** `app-connections.ts`, `engine.ts`, `index.ts` (+ `types.ts`, `dashboard.ts`, README/SKILL docs already in the uncommitted diff).
- **What it does:** Lands the in-flight, uncommitted persistent-login browser-profile feature (`connect_app` / `confirm_app_connection` / `list_app_connections` + `launchPersistentContext`) through the **full quality-gate pipeline for the first time** (it shipped straight to the working tree with zero prior review); retrofits its 3 tools to the ADR-02 `registerXxxTool` convention; fixes the `engine.ts ↔ app-connections.ts` state-mutation erosion that currently breaks the 4-module boundary (`types.ts`=Zod/interfaces, `storage.ts`=file IO, `engine.ts`=Playwright, `index.ts`=sole wiring).
- **Why (market angle, tied to `00-vision.md`):** the vision's moat is "solve a site once, run deterministically forever." Persistent-login profiles are the piece that makes that true for the *huge* slice of target markets that sit behind a login wall — corporate banking, EDGAR/gov-procurement accounts, payer/prior-auth portals, competitive-intel dashboards. Without a hardened app-connections layer, every authenticated template in those verticals is a one-off hack; F00 makes "log in once by hand, extract forever without re-auth or stored passwords" a first-class, reviewed primitive. It is also structurally load-bearing: F13 (vault) and X06 (cloud per-user cookies) are explicitly chartered (ADR-05) to build against the boundary F00 defines, and every later tool-adding feature (F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25) copies the `registerXxxTool` pattern F00 is the first to retrofit (ADR-02). That's why it's Wave 0, merged to `integration` before anything else forks.

## 2. User/agent story

As an agent or developer building an APImeMCP template against a site that requires login (a bank portal, an EDGAR account, a payer portal), I call `connect_app({domainPattern, loginUrl})`, a real (non-headless) browser opens at `loginUrl` backed by a fresh persistent profile dir; I log in by hand — 2FA, SSO, whatever the site needs; I call `confirm_app_connection({connectionId})` once authenticated. From then on, every `execute_native_extraction` / `register_extraction_template` run against a matching domain reuses that same Playwright profile directory silently — no re-login, no password stored anywhere, no vault entry, just an ordinary Chromium user-data-dir. `list_app_connections({})` shows me what's connected and its status. This already works in the working tree today; F00 is the work to make it **safe, boundary-clean, and reviewed** before 26 more features start forking branches that touch the same files.

## 3. Design

### Data shapes (`src/types.ts` — Zod, existing file, audited not rewritten)

```ts
export const AppConnectionStatus = z.enum(["pending", "connected", "expired", "error"]);

export const AppConnectionSchema = z.object({
  connectionId: z.string(),
  domainPattern: z.string(),        // e.g. "*.example.com" or an exact host
  loginUrl: z.string().url(),
  profileDir: z.string(),           // relative path, always under templates/app-profiles/<connectionId>
  autoStart: z.boolean().default(false),
  status: AppConnectionStatus,
  createdAt: z.string(),            // ISO timestamp
  lastUsedAt: z.string().optional(),
}).strict();                        // .strict() is the F00 hardening delta: rejects any stray field —
                                     // in particular any credential/secret-shaped key, enforcing ADR-05's
                                     // "app-connections never holds a value that looks like a vault secret".
export type AppConnection = z.infer<typeof AppConnectionSchema>;
```

Store: `templates/app-connections.json` (array of `AppConnection`, keyed by `connectionId`). Profile dirs: `templates/app-profiles/<connectionId>/` (gitignored, per the repo's existing `templates/` ignore rule — never committed, matches how `saved-cookies.json` is already handled).

### ADRs this feature obeys

- **ADR-02 (Tool-module convention)** — F00 is explicitly named as "the first retrofit." Each of the 3 tools moves from an inline `server.tool(...)` body in `index.ts` to an exported `registerXxxTool(server, deps)` function in its own module, with `deps` an explicit injected-collaborators object (no hidden cross-boundary imports inside a handler).
- **ADR-05 (Vault vs app-connections)** — F00 *defines* the browser-identity half of the split: app-connections = login profile/session dirs, never encrypted secret values. The G4 contract rule ("no code path copies a vault secret into an app-connection profile or vice-versa") is enforced here first, since F13/`vault.ts` doesn't exist yet — F00's job is to freeze a clean surface, not to integrate with a vault.

### Module-by-module changes (exact paths under `D:/MCP/src`)

- **`src/app-connections.ts`** (existing, untracked) — the sole owner of `templates/app-connections.json` reads/writes. Public surface: `createConnection(input)`, `getConnection(id)`, `listConnections()`, `updateConnectionStatus(id, status)`, `resolveProfileDir(id)`. Nothing outside this file touches the JSON store directly (mirrors the `storage.ts` file-IO role, scoped to this one store). **Hardening delta:** audit and remove any place this module reaches into `engine.ts`'s private browser/context cache instead of calling an exported `engine` function.
- **`src/engine.ts`** — **the erosion fix.** Today `engine.ts` imports/mutates `app-connections.ts` state directly (per the grounded repo facts). Fix: `engine.ts` may only call `app-connections.ts`'s exported functions (`resolveProfileDir`, `updateConnectionStatus`, …) — never reach into its internal map/array. Keep `launchPersistentContext(profileDir, launchOptions)` as the **one** Playwright-facing primitive engine.ts exposes for profile-backed contexts; `app-connections.ts` (via the tool handlers) calls *that*, the dependency only ever points one direction per the 4-module rule.
- **`src/tools/app-connections-tools.ts`** (NEW, per ADR-02) — exports `registerConnectAppTool(server, deps)`, `registerConfirmAppConnectionTool(server, deps)`, `registerListAppConnectionsTool(server, deps)`. Each is `(server, deps) => server.tool(name, zodShape, handler)`. `deps = { appConnections: { create, get, list, updateStatus, resolveProfileDir }, engine: { launchPersistentContext } }` — the explicit injected-collaborators object ADR-02 rule 2 requires, so each handler is unit-testable with a fake `deps` and never imports `engine.ts`/`app-connections.ts` directly inside the handler body.
- **`src/index.ts`** — delete the 3 inline `server.tool("connect_app", …)` / `"confirm_app_connection"` / `"list_app_connections"` bodies; replace with 3 appended calls (`registerConnectAppTool(server, deps)`, etc.) after assembling the shared `deps` object once at startup. This is literally ADR-02's "first retrofit."
- **`src/app-connections.test.ts`** (existing, untracked) — extend for the fixed boundary: fake `engine` deps, no real Playwright (matches repo's Vitest = browser-free convention).
- **`src/dashboard.ts`** — keep reading connections only via `app-connections.ts`'s `listConnections()`, never the raw JSON file.

### Tool signatures (names/shapes already shipped — only the registration *mechanism* changes)

- `connect_app({ domainPattern: string, loginUrl: string, autoStart?: boolean }) → { connectionId: string, status: "pending" }` — opens a non-headless persistent context at `loginUrl` for interactive login.
- `confirm_app_connection({ connectionId: string }) → { connectionId: string, status: "connected" }` — marks the connection usable once the human finishes logging in.
- `list_app_connections({}) → { connections: AppConnection[] }`.

No HTTP route or app screen — this is Program 1 (engine/MCP) only; Program 2 consumes it later only via ADR-06 published types, not directly.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | Audit/lock `AppConnectionSchema` in `types.ts`; add `.strict()` — this is the frozen surface ADR-05 says F13/X06 build against. |
| S2 Storage | Applicable | Audit `app-connections.ts`'s file-IO for `templates/app-connections.json` uses atomic write, is the sole writer. |
| S3 Core/Engine | Applicable | The actual hardening: remove `engine.ts`'s direct reach into `app-connections.ts` internals; keep `launchPersistentContext` as the sole exported Playwright primitive. |
| S4 Module | Applicable | Extract the 3 handlers into new `src/tools/app-connections-tools.ts` per ADR-02. |
| S5 Wiring | Applicable | `index.ts` → 3 appended `registerXxxTool` calls + shared `deps` construction. |
| S6 Unit tests | Applicable | Extend `app-connections.test.ts` + `types.test.ts` (fake engine deps). |
| S7 Verify (mjs) | Applicable | Browser-touching feature → `scripts/verify-F00.mjs` + fixture (below). |
| S8 Docs | Applicable | README.md + SKILL.md (already touched in the uncommitted diff) must describe the ADR-02 shape + ADR-05 boundary accurately. |
| S9 Review (G2) | Applicable | Code-Reviewer pass — F00's whole charter is "zero prior review," so this is mandatory and thorough. |
| S10 Live-Verify (G6) | Applicable | Live-Verification Gatekeeper runs `verify-F00.mjs` with real Chromium. |
| S11 Merge (G7) | Applicable | Integration merges to `integration` **first**, before any F01+ branch (per `04-git-strategy.md`). |

All 12 applicable, none N/A — F00 is a full-stack engine feature touching every layer of the 4-module boundary.

## 5. Dependencies & sequencing

- **Hard feature deps:** none (catalog: `Deps: —`). F00 is the Wave-0 foundation feature; nothing upstream blocks it.
- **ADRs it obeys (not feature deps, contracts):** ADR-02 (tool-module convention — first retrofit), ADR-05 (vault-vs-app-connections split — F00 defines the browser-identity half).
- **What it unblocks:** clears `index.ts`'s single worst pre-existing merge-contention point before Wave 1 forks (F01, F05, F03, F14, F19 all add tools next); establishes the ADR-05 boundary F13 (Wave 4, `vault.ts`) and X06 (platform, encrypted cookie transit) are chartered to build against even if F00 slips; is the reference implementation every later ADR-02 tool retrofit (F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25, plus any Program-2 engine-side tool) copies.
- **Wave:** 0 — per `04-git-strategy.md`'s explicit "F00 reconciliation" clause: rebase onto `master`, retrofit to ADR-02, fix the erosion, merge to `integration` as **the very first merge**, before Wave 1 forks. If F00 isn't green in time, ADR-05's frozen public surface (the `AppConnection` shape + module split) is what F13/X06 code against in the meantime; rebase weekly until F00 lands.

## 6. Quality gates

Pipeline: `G0 Spec → G1 Build → G2 Code-Review → G3 Arch(⚫) → G4 Security(⚫) → G5 QA → G6 Live-Verify(⚫) → G7 Integration → G8 Promote`. (G3b Design: N/A — no UI/screen surface.)

- **G3 Arch (Architect, blocks):** confirms the 4-module separation is restored (no `engine.ts` reach into `app-connections.ts` internals or vice versa) and the 3 tools follow ADR-02 exactly (own module, `registerXxxTool(server, deps)`, explicit `deps`).
- **G4 Security (Security-Reviewer, blocks):** confirms ADR-05's boundary holds — no field or code path lets a secret/credential value land in `AppConnection`/`profileDir`; profile dirs stay under `templates/app-profiles/` (gitignored); no cross-user sharing concern yet (single-user local server) but the shape must not preclude X06's later per-user isolation requirement.
- **G6 Live-Verify (Live-Verification Gatekeeper, blocks):** runs `scripts/verify-F00.mjs` with real Playwright — this is an engine/browser-touching feature so it does not skip G6.

**Definition of Done:**
1. All 3 tools registered via `registerXxxTool` per ADR-02; zero inline `server.tool("connect_app"…)`-style bodies remain in `index.ts`.
2. `engine.ts` contains zero direct reaches into `app-connections.ts` internal state (audited); `app-connections.ts` contains zero direct reaches into `engine.ts`'s private browser-context cache.
3. `AppConnectionSchema` is `.strict()` and matches exactly the fields ADR-05 documents — no secret-shaped field.
4. `npx vitest run src/app-connections.test.ts src/types.test.ts` green.
5. `node scripts/verify-F00.mjs` exits 0 against the fixture, with real Chromium, proving profile persistence across two launches.
6. README.md + SKILL.md accurately describe the ADR-02 tool shapes and the ADR-05 boundary.
7. Merged to `integration` first, ahead of any Wave-1 branch.

## 7. Test plan

### `src/app-connections.test.ts` (extend existing, Vitest, browser-free — fake engine deps, no real Playwright)

- `createConnection()` persists a well-formed `AppConnection` (temp/mock store dir) and returns a `connectionId`.
- `getConnection(id)` / `listConnections()` round-trip correctly; unknown id returns `undefined`, never throws.
- `updateConnectionStatus(id, "connected")` flips `status` and sets `lastUsedAt`.
- `resolveProfileDir(id)` returns exactly `templates/app-profiles/<id>` — this is the function `engine.ts` must call instead of reaching into internal state.
- Boundary regression: a test that constructs `app-connections.ts` with a fake `engine.launchPersistentContext` and asserts no other export of `engine.ts` is ever referenced (proves the erosion fix, not just that behavior still works).

### New: `src/tools/app-connections-tools.test.ts`

- For each of `registerConnectAppTool` / `registerConfirmAppConnectionTool` / `registerListAppConnectionsTool`: call with a fake `server.tool` capturer + fake `deps`; assert the registered name, the Zod input shape, and that the handler calls **only** the injected `deps` functions (never a real module import).

### `src/types.test.ts` (extend existing)

- `AppConnectionSchema.parse()` accepts a valid shape.
- `AppConnectionSchema.parse()` **rejects** an object with an extra field (proves `.strict()` is enforced — the concrete regression test for the ADR-05 hardening delta).

### `scripts/verify-F00.mjs` + fixture (required — engine/browser-touching)

- **Fixture:** `scripts/fixtures/f00-login.html` — a tiny local login form that sets a flag (cookie or `localStorage`) on submit, plus a "logged in" element that only renders when the flag is present.
- **Script steps:** (1) launch `launchPersistentContext` against the fixture with a fresh `profileDir` under a temp `templates/app-profiles/verify-f00/`; (2) programmatically submit the login form (stands in for the human step, since CI is unattended) and call the `confirm_app_connection` path; (3) close the context; (4) re-launch `launchPersistentContext` with the **same** `profileDir`; (5) assert the "logged in" element renders **without** resubmitting the form — this is the actual proof of persistence; (6) `list_app_connections` shows `status: "connected"`; (7) clean up the temp profile dir.
- Wired into `.github/workflows/verify.yml` alongside the existing `verify-*.mjs` scripts.

## 8. Acceptance criteria (live, observable proof)

- `grep -n "server.tool(\"connect_app\"" src/index.ts` (and the other two tool names) returns **nothing** — proves the inline bodies are gone.
- `grep -rn "registerConnectAppTool\|registerConfirmAppConnectionTool\|registerListAppConnectionsTool" src/index.ts` shows exactly 3 appended calls.
- `node dist/index.js` then calling `list_app_connections` over MCP returns the documented JSON shape live.
- `node scripts/verify-F00.mjs` exits 0: the second persistent-context launch shows already-logged-in state with **zero** form resubmission — observed with real Chromium, not mocked.
- `npx vitest run src/app-connections.test.ts src/types.test.ts src/tools/app-connections-tools.test.ts` all green.
- `npm run build` (tsc) clean — proves the ADR-02/erosion refactor didn't break typing across the 4-module boundary.
- PR description includes the literal diff hunk removed from `engine.ts` that reached into `app-connections.ts` internals, and its replacement call — the concrete evidence the erosion is fixed, not just "should be fine."

## 9. Reuse notes

- **Atomic writes:** reuse the repo's existing `atomicWriteFile`-style temp+rename helper (already used elsewhere, e.g. by `update_status.mjs`'s pattern) for `app-connections.ts`'s writes to `templates/app-connections.json` — do not hand-roll a new write primitive.
- **Locking:** reuse the existing in-proc mutex module (`withLock`, listed among the repo's small modules) if concurrent `connect_app` calls could race on the same `domainPattern`/`profileDir` — do not add a second locking mechanism.
- **Persistent context launch:** reuse `launchPersistentContext` in `engine.ts` as-is — it already exists per the grounded repo facts. F00 is a boundary/hardening fix, **not** a rewrite of the launch logic.
- **URL/domain matching:** if `domainPattern` matching needs a lookup helper, reuse the existing `findTemplateByUrl`-style matching pattern already used for templates rather than writing a second URL-matcher.
- **File-IO shape:** model `app-connections.ts`'s own file-IO on the existing cookie-store module (same "small store module" shape) rather than inventing a new persistence pattern.
- **Explicitly do NOT touch:** `vault.ts` doesn't exist yet (F13) — ADR-05 forbids merging the concepts. Add zero encrypted-secret handling to `app-connections.ts`.

## 10. Skills (setup + when-to-use)

F00 is scoped, in-repo TypeScript/Playwright hardening work already covered by the 24 `.agents/skills/` library that ships with **no install required** (per `08-skills-matrix.md`) — there is no ≥1K-install external skill needed or available for this narrow a task (the matrix explicitly rejects low-install Playwright-specific skills, e.g. 63 installs, in favor of the team's own Playwright depth + `context7` for API verification).

**Setup:** `npx skills check` first (reuse what's already global); nothing new needs `npx skills add` for F00.

**Which skill guides which sub-task:**
- `security-and-hardening` → S3 (engine↔app-connections boundary fix) and the G4 gate (ADR-05 profile/secret separation).
- `code-review-and-quality` + `code-simplification` → S9/G2, keep this a **minimal-diff retrofit**, not a rewrite of already-working code.
- `test-driven-development` → S6 (unit tests) and S7 (verify script + fixture).
- `documentation-and-adrs` → S8 (README/SKILL.md must accurately reflect ADR-02 and ADR-05, not just describe the tools).
- `incremental-implementation` → the overall approach: retrofit the existing shipped `app-connections.ts`/`engine.ts`/`index.ts` minimally rather than starting over.
- `context7-mcp` → fallback only if the exact Playwright `launchPersistentContext`/`BrowserContext` API needs live-doc verification during S3 (per the global Context7 rule: prefer live docs over training-data recall for any library/API question) — not a substitute for the in-repo skills above.
