# F20 — Change-monitoring mesh

## 1. Summary

- **ID / Name:** F20 · Change-monitoring mesh
- **Pillar:** F (creative) · **Wave:** 4 · **Risk:** M · **Gates:** Lv
- **Deps:** F02 (drift detection — reuses its diff primitive)

**What.** Generalizes the engine's existing single-purpose cron tool (`schedule_stock_check`) into a **mesh of arbitrary template subscriptions**: subscribe any registered template + inputs + cron schedule, run it on tick, diff each result against the previous one using **F02's reusable diff primitive** (not a bespoke comparator), and fire a notification through the existing notifier channel only when the diff reports a real change. Modules touched: `scheduler`, `notifier`, `drift` — no new core-logic module; F20 is a wiring/generalization feature, not a from-scratch subsystem.

**Why (tied to 00-vision).** The vision's target-market list and flywheel both point at this: *"The mobile monitors feature (get a push when a price drops / item restocks / a filing appears) is the consumer wedge."* F20 is the **engine-side substrate** for that wedge — self-host/agent-native today, and per the catalog's own Deps line, **X05 (Cloud monitors service, Program 2)** depends on `F02/F20` directly: X05 is Vercel Cron + Expo push wrapped around exactly this subscribe→diff→event mechanism. Landing F20 well (generic, reusing F02's diff instead of a one-off) is what lets X05 not reinvent it, and is what eventually lets M05 (mobile Monitors + push) exist. Market angle: competitive intelligence, financial/gov data watches, RPA-replacement polling — every one of these is "run this template repeatedly, tell me only when it changes."

## 2. Story

- **As a calling agent/dev (self-host),** I register or already have a template. I call `subscribe_monitor` with a cron schedule and a webhook URL. I stop polling — the mesh runs the template for me on schedule and only calls my webhook when the extracted value actually changed, with the before/after values attached.
- **As the future cloud/mobile consumer (X05→M05, out of scope here),** the push I get on my phone ("Bernhardt K1325 → $412", "back in stock", "new filing") is X05 calling straight through to this same subscribe/diff/notify mechanism — F20 is what X05 wraps, not something X05 reimplements.

## 3. Design

### 3.1 Data shapes

```ts
// src/scheduler.ts — EXTEND (existing module already backs schedule_stock_check's cron entry)
export interface MonitorSubscription {
  id: string;                     // `mon_${randomUUID()}`
  templateId: string;             // FK -> ManifestEntry.id (storage.ts registry)
  targetUrl?: string;             // else resolved via findTemplateByUrl/template default
  inputs?: Record<string, unknown>;
  cronExpression: string;         // same free-form cron string schedule_stock_check already accepts (minLength 1)
  notifyEndpointUrl: string;      // reuses the existing endpoint-push channel behind send_notification
  active: boolean;
  createdAt: string;              // ISO
  lastRunAt?: string;             // ISO
  lastResultHash?: string;        // sha256 of normalized JSON result — cheap unchanged-skip before diffing
  lastResult?: unknown;           // last raw result value, fed into next tick's diff as "previous"
  lastChange?: { at: string; summary: string };
}

export interface MonitorDeps {
  runExtraction: typeof executeExtraction;  // engine.ts — the SAME fn ADR-04 names as the one instrumentation point
  diff: (prev: unknown, curr: unknown) => DiffResult;  // drift.ts — F02's exported pure diff primitive; import, do not reimplement
  notify: typeof notifyChange;               // notifier.ts extension, §3.2
  loadTemplate: typeof findTemplateByUrl;    // storage.ts
  withLock: typeof withLock;                 // lock.ts — in-proc mutex
}

export function scheduleMonitor(input: Omit<MonitorSubscription,
  'id'|'active'|'createdAt'|'lastRunAt'|'lastResultHash'|'lastResult'|'lastChange'>,
  deps: MonitorDeps): MonitorSubscription;
export function listMonitors(): MonitorSubscription[];
export function cancelMonitor(id: string): boolean;
```

`DiffResult` is F02's own exported shape (drift.ts) — F20's contract with it is just: pass `(previousValue, currentValue)`, get back something with a `changed: boolean` and a human `summary: string` (plus whatever patch detail F02 defines). F20 must not hand-roll a second diff algorithm — that would violate the whole point of "reuses F02 diff" in the catalog.

### 3.2 Module-by-module changes (exact paths)

- **`src/scheduler.ts`** — add `MonitorSubscription`/`MonitorDeps`/`scheduleMonitor`/`listMonitors`/`cancelMonitor` and an internal `tick(sub, deps)` that: `withLock('monitor:' + sub.id, …)` → `runExtraction({templateId, targetUrl, inputs})` → hash result → if `lastResultHash` existed and differs, call `deps.diff(sub.lastResult, result.data)`; if `report.changed`, call `deps.notify(...)` and stamp `lastChange` → persist. This *generalizes* the cron-registration mechanism already powering `schedule_stock_check`, it does not fork a second scheduler.
- **`src/drift.ts`** (lands via F02, wave 2, before F20 forks in wave 4) — F20 only imports its exported diff primitive. No changes needed unless F02's export needs a small generic-value overload (schema-drift vs result-content-drift are the same "diff two JSON values" problem) — if so, F20's PR adds that overload to `drift.ts` rather than a parallel `monitor-diff.ts`.
- **`src/notifier.ts`** — add `notifyChange(endpointUrl: string, event: MonitorEvent): Promise<void>` that formats a `MonitorEvent` (`{monitorId, templateId, changed, summary, before?, after?, at}`) into the **same delivery path `send_notification` already uses** (it takes `{endpointUrl, message}` today — see the live tool schema, `endpointUrl` is a URL string, `message` is a plain string). `notifyChange` is additive: it builds a message string from the event and calls straight through the existing notify function, so there is exactly one outbound-notification code path, matching ADR-04's "one emission point, many consumers" spirit applied to notifications instead of metrics.
- **`src/storage.ts`** — `monitors.json` persisted via the existing `atomicWriteFile` pattern (temp+rename), same as every other store in this codebase. Scheduler never touches `fs` directly.
- **`src/lock.ts`** — `withLock` guards each subscription's tick so an overlapping cron fire (slow extraction + short interval) can't race a read-diff-write on the same subscription's `lastResult`.
- **`src/tools/monitor-tool.ts` (NEW, per ADR-02)** — `registerMonitorTool(server, deps: MonitorDeps)` registering three tools (ADR-02 explicitly names F20 in its "ships its tool(s) as a `registerXxxTool` module" list, independent of the catalog's terse Modules cell which only lists core-logic files):

```ts
server.tool('subscribe_monitor', {
  templateId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),   // same pattern execute_native_extraction/register_extraction_template already use
  targetUrl: z.string().url().optional(),
  inputs: z.record(z.unknown()).optional(),
  cronExpression: z.string().min(1),                          // same constraint schedule_stock_check already enforces
  notifyEndpointUrl: z.string().url(),                        // same shape send_notification's endpointUrl already uses
}, async (args) => ({ monitorId: scheduleMonitor(args, deps).id }));

server.tool('list_monitors', {}, async () => ({ monitors: listMonitors() }));

server.tool('unsubscribe_monitor', { monitorId: z.string().min(1) },
  async ({ monitorId }) => ({ ok: cancelMonitor(monitorId) }));
```

- **`src/index.ts`** — exactly one appended line, `registerMonitorTool(server, monitorDeps);`, in the ADR-02 append-only tool list. No edits to any other tool's block.
- **`src/metrics.ts`** — untouched by F20. Each tick's `runExtraction` call already flows through ADR-04's single instrumentation point and gets measured like any other run; F20 does not add a second metrics path.

### 3.3 ADRs obeyed

- **ADR-02 (tool-module convention):** new tools live in `src/tools/monitor-tool.ts` as `registerMonitorTool(server, deps)`, `deps` explicit and fakeable, one appended `index.ts` line.
- **ADR-04 (metrics measure-model):** F20 is a **reader/rider**, not a second writer — the extraction runs it triggers are measured for free at the existing single emission point; F20 introduces no parallel instrumentation.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | This document. |
| S1 Types | Applicable | `MonitorSubscription`, `MonitorEvent`, `MonitorDeps` (scheduler.ts / notifier.ts). |
| S2 Storage | Applicable | `monitors.json` via storage.ts `atomicWriteFile`. |
| S3 Core | Applicable | `tick()` wiring: runExtraction → hash → F02 diff → notifyChange. |
| S4 Module | Applicable | `src/tools/monitor-tool.ts` (ADR-02). |
| S5 Wiring | Applicable | One appended `registerMonitorTool(server, deps)` call in `index.ts`. |
| S6 Unit | Applicable | `src/monitor-tool.test.ts`, fake `MonitorDeps`. |
| S7 Verify | Applicable | `scripts/verify-F20.mjs` + fixture (Lv is a required gate). |
| S8 Docs | Applicable | README + `using-apimemcp` SKILL: document 3 new tools, note relationship to `schedule_stock_check`. |
| S9 Review | Applicable | G2 code-review — checks no parallel diff/metrics/notify path was introduced. |
| S10 Live | Applicable | G6 live-verify (Lv flagged in the catalog). |
| S11 Merge | Applicable | G7 — append-only `index.ts` line, no handler-body conflicts possible. |

## 5. Dependencies & sequencing

- **Hard dep:** F02 (drift detection) must land first (wave 2) — F20 (wave 4) imports its diff primitive and cannot fork before it exists.
- **Contract deps (Phase 0, precede all features):** ADR-02 (tool registration), ADR-04 (no parallel metrics path). Both are already locked before any feature branch forks, so they gate F20's *shape*, not its schedule.
- **Soft/adjacent surfaces generalized, not owned:** the pre-existing `schedule_stock_check` (scheduler.ts) and `send_notification` (notifier.ts) tools — F20 extends these modules' internals; it does not delete or rename the existing tools (back-compat), it adds the general-purpose path alongside.
- **What F20 unblocks:** **X05 (Cloud monitors service, Program 2, wave P3)** — its Deps column is literally `X03,F02/F20`; X05 wraps Vercel Cron + Expo push around this same subscribe/diff/notify primitive instead of reimplementing it. Transitively unblocks **M05 (mobile Monitors + push)**, the roadmap's stated "killer mobile feature."
- **Wave:** 4, alongside F09/F12/F13/F17 — no critical-path coupling to those; F20's only blocking predecessor is F02.

## 6. Quality gates

Catalog Gates flag = **Lv** only (no Ar/Se blocking review required for this feature).

- **G0 Spec → G1 Build → G2 Code-Review → G5 QA → G6 Live-Verify → G7 Integration → G8 Promote** all apply.
- **G3 Arch** not flagged as blocking, but ADR-02/ADR-04 compliance is still checked at G2 (no parallel tool-wiring path, no parallel metrics path).
- **G3b Design:** N/A — no UI surface.
- **G4 Security:** not flagged — no new secret/sandbox surface; `notifyEndpointUrl` reuses the exact same endpoint-push shape `send_notification` already exposes today.

**Definition of Done:** `subscribe_monitor` persists a subscription and schedules it; a tick calls the real `executeExtraction` path (not a stub); an unchanged second result produces **no** notification; a changed second result produces **exactly one** `notifyChange` call carrying an F02-shaped diff summary + before/after; `unsubscribe_monitor` stops all future ticks; `index.ts` diff is a single appended line; unit tests and `verify-F20.mjs` are green.

## 7. Test plan

**`src/monitor-tool.test.ts`** (Vitest, browser-free, fake `MonitorDeps` per ADR-02's unit-testability promise):
- `subscribe_monitor` returns a `monitorId` and the subscription is retrievable via `list_monitors`.
- First tick (no prior `lastResultHash`) records a baseline and does **not** call `notify`.
- Second tick with an unchanged fake result (`diff` fake returns `{changed:false}`) does not call `notify`.
- Second tick with a changed fake result (`diff` fake returns `{changed:true, summary:'...'}`) calls `notify` exactly once with a `MonitorEvent` containing `monitorId`, `templateId`, `summary`, `before`, `after`.
- `unsubscribe_monitor` returns `{ok:true}` and a subsequent tick is not scheduled (fake `withLock` spy not invoked again).
- Two overlapping tick calls on the same subscription: `withLock` fake proves serialization (second call observably waits for the first).

**`scripts/verify-F20.mjs` + fixture** (Playwright, real): serves `scripts/fixtures/f20/page.html` from a local static server whose content is swapped via a toggle file between two runs; registers a throwaway template pointed at it; `subscribe_monitor` with a short cron and a `notifyEndpointUrl` pointing at a tiny local HTTP listener started by the script itself. Flow: tick once (baseline, listener receives nothing) → flip the fixture content → force/await a second tick → assert the listener received exactly one POST whose body matches the F02 diff shape with the correct before/after text → `unsubscribe_monitor` → flip fixture again → assert no further POST.

## 8. Acceptance criteria (live, observable)

1. `node scripts/verify-F20.mjs` exits 0 and prints: monitor created → baseline tick logged, no notification → fixture changed → second tick logged → **exactly one** notification received by the local listener, printed with old/after values → unsubscribe → third tick produces no listener activity.
2. `npx vitest run src/monitor-tool.test.ts` green.
3. `list_monitors` (called live against a running server) shows the subscription's `lastRunAt`/`lastChange` fields populated after the demo above.
4. `git diff src/index.ts` for this feature shows a single added line (proves ADR-02 append-only held).

## 9. Reuse notes

- **`executeExtraction`** (engine.ts, named explicitly in ADR-04) — the tick's run, not a bespoke fetch/scrape.
- **F02's diff primitive** (`drift.ts`) — the only diff logic F20 is allowed to call.
- **`atomicWriteFile`** (storage.ts pattern) — `monitors.json` persistence.
- **`withLock`** (lock.ts, in-proc mutex) — serializes concurrent ticks per subscription.
- **`findTemplateByUrl`** (storage.ts) — resolves `templateId` → `ManifestEntry` when `subscribe_monitor` omits `targetUrl`.
- **Existing notifier endpoint-push** (backs `send_notification` today) — `notifyChange` formats into this same channel; no second delivery mechanism.

## 10. Skills (setup + when-to-use)

This is a Program-1, server-only TypeScript feature — no new external dependency, no UI. Per the skill-quality bar in `08-skills-matrix.md`, none of the ≥1K-install skill list applies here; use what's already resident:

- **`.agents/skills/test-driven-development`** + **`incremental-implementation`** (already available, no install) — guides S3/S6: write `monitor-tool.test.ts` fakes first, land `tick()`/diff/notify wiring incrementally.
- **`.agents/skills/observability-and-instrumentation`** — guides S3/S9: keeps the "one emission point" ADR-04 discipline honest when wiring the tick's metrics-adjacent behavior.
- **`.agents/skills/ci-cd-and-automation`** — guides S7: wiring `verify-F20.mjs` into the existing `.github/workflows/verify.yml` pattern.
- **Fallback per the global Context7 rule:** if `scheduler.ts`'s existing cron mechanism or `drift.ts`'s diff mechanism turns out to wrap a third-party library, use **`context7-mcp`** to pull that library's current docs before extending it — do not guess its API from training data, and do not install a generic "cron" or "diff" skill from skills.sh (neither clears the documented ≥1K-install bar; `08-skills-matrix.md` explicitly rejects sub-1K skills in this project).
