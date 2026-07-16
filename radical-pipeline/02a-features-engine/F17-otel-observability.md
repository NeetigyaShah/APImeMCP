# F17 — OpenTelemetry Observability

## 1. Summary

- **ID / Name:** F17 — OpenTelemetry observability
- **Pillar:** E (dist+perf) **Wave:** 4 **Risk:** M **Gates:** Lv only (no Ar, no Se, no G3b)
- **What:** A new `src/otel-adapter.ts` subscribes to the ADR-04 measure record (already emitted by every extraction, aggregated by F14's `metrics.ts`) and exports it as standard OpenTelemetry metrics (counter + duration histogram) and synthetic spans, via OTLP/HTTP, to whatever collector the operator points it at. Zero configuration = zero cost, zero network calls — it is off by default.
- **Why (tied to 00-vision market angle):** 00-vision's target markets for the self-host track are enterprise-heavy — RPA replacement (~$20B), financial-data aggregation, healthcare payer/prior-auth, gov/civic, compliance-grade provenance, competitive intelligence. Every one of those buyers gates production adoption of a new scraping/automation engine on "can I see its success-rate and latency in the observability stack we already run" (Grafana, Honeycomb, Datadog, New Relic, a self-hosted collector). F14 (Metrics 2.0) makes SLA data exist internally; F17 is what makes it visible in the tools those buyers already trust — turning APImeMCP from "a CLI with logs" into "a service with SRE-grade telemetry," a checkbox that gates enterprise pilots for the self-host track (00-vision's two-track model: self-host = devs/agents, full power).

## 2. User / Agent Story

- **As an SRE/platform engineer** self-hosting APImeMCP for a compliance-grade scraping workload, **I want** extraction success-rate, latency, and error reasons to show up as metrics/spans in the Grafana/Honeycomb/Datadog stack my team already runs, **so that** I don't have to build custom log-scraping to get paged when a template's success rate drops.
- **As an agent or solo developer** running APImeMCP locally with no interest in telemetry, **I want** the adapter to do literally nothing — no SDK objects constructed, no outbound calls — unless I explicitly set an OTLP endpoint, **so that** the local-first tool never phones home by accident.

## 3. Design

### 3.1 Data shapes (reused, not redefined)

The measure record is **owned by ADR-04 / F14** — F17 only imports it:

```ts
// already defined by F14 per ADR-04 (types.ts or metrics.ts)
interface MeasureRecord {
  templateId: string;
  kind: "extraction" | "action-sequence" | "static-http";
  success: boolean;
  durationMs: number;
  timestamp: number; // epoch ms, end-of-run
  error?: string;
}
```

New shapes, in `src/otel-adapter.ts`:

```ts
import { z } from "zod"; // reuse project's existing zod dep — no new env-parsing lib

const OtelEnvSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("apimemcp"),
  OTEL_SDK_DISABLED: z.enum(["true", "false"]).default("false"),
});

export interface OtelAdapterStatus {
  enabled: boolean;
  exporter: "otlp-http" | "none";
  serviceName: string;
  recordsExported: number;
  lastExportAt?: number;
  lastError?: string;
}

export function initOtelAdapter(env?: NodeJS.ProcessEnv): OtelAdapterStatus;
export function getOtelStatus(): OtelAdapterStatus;
export function shutdownOtelAdapter(): Promise<void>;
```

Config is **100% standard OTel env vars** (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, plus the SDK's own `OTEL_METRIC_EXPORT_INTERVAL`) — no APImeMCP-specific config surface is invented; any collector/backend that speaks OTLP/HTTP works with zero adapter-side code.

### 3.2 ADR compliance — and one deliberate reconciliation

Obeys **ADR-04** directly: *"F17's OTel adapter exports the same measures... no consumer re-instruments the run path"* and the contract rule *"Features do not add a parallel instrumentation path — they add a consumer... A second metrics-writing path is rejected."*

The catalog's Modules cell for F17 says `otel adapter (new), engine`. Per ADR-04's explicit text this is read as **F17 touches the engine's measurement plumbing, not `engine.ts`'s extraction logic** — the single instrumentation point in `executeExtraction` stays exactly as F14 left it. F17's only touch outside its own new file is a **3-line additive hook in `metrics.ts`** (a fan-out list, not a second writer), which satisfies the catalog cell without violating the ADR-04 contract rule. This is why Gates = `Lv` only: no G3 Arch needed (new module follows the same small-module pattern as `cookie-store`/`scheduler`/`notifier`; no boundary/shared-type change), no G4 Security (no secrets, no new tool, no cross-user data, no sandbox/allowlist touched).

### 3.3 Module-by-module changes (exact paths)

| File | Change |
|---|---|
| `D:/MCP/src/metrics.ts` | **Add**, do not replace: an in-memory listener registry. `export type MeasureListener = (m: MeasureRecord) => void;` `export function onMeasure(l: MeasureListener): () => void` (subscribe, returns unsubscribe). Inside the existing `record()`/write function (F14's), after the existing write, fan out: `for (const l of listeners) { try { l(measure); } catch { /* never break the producer path */ } }`. This is the entire diff to an existing file. |
| `D:/MCP/src/otel-adapter.ts` (new) | Parses `OtelEnvSchema` from `process.env`. If `OTEL_SDK_DISABLED==="true"` or no `OTEL_EXPORTER_OTLP_ENDPOINT` → `status = {enabled:false, exporter:"none", serviceName, recordsExported:0}`, return immediately — **no OTel SDK object is constructed**, true zero-cost no-op. Else: builds a `MeterProvider` (`@opentelemetry/sdk-metrics`) with a `PeriodicExportingMetricReader` wrapping `OTLPMetricExporter` (`@opentelemetry/exporter-metrics-otlp-http`), and a minimal `BasicTracerProvider` (`@opentelemetry/sdk-trace-base`, **not** `sdk-trace-node` — no auto-instrumentation needed) with a `BatchSpanProcessor` wrapping `OTLPTraceExporter` (`@opentelemetry/exporter-trace-otlp-http`). Creates one counter (`apimemcp.extraction.count`) and one histogram (`apimemcp.extraction.duration_ms`) on a `meter`, and a `tracer`. Calls `metrics.onMeasure(record => {...})` once: increments the counter and records the histogram with attributes `{template_id, kind, success}`; also opens a **synthetic span** via `tracer.startSpan(record.templateId, {startTime: record.timestamp - record.durationMs})`, sets `SpanStatusCode.ERROR` + the error message when `!record.success`, and calls `span.end(record.timestamp)` — this is the standard OTel pattern for exporting a span for work that already finished, which is exactly how "spans/metrics, no new instrumentation" (ADR-04's own phrase) is satisfied. Bumps `status.recordsExported`/`lastExportAt`, catches/records `lastError` on exporter failure (never throws into the caller). |
| `D:/MCP/src/index.ts` | **One line** at server startup (ADR-02's "index.ts is an append-only list of calls" — no tool schema, just an init call): `initOtelAdapter();`. No `registerXxxTool` — see 3.4. |
| `D:/MCP/README.md` | New section: the 3 env vars, an example `docker run otel/opentelemetry-collector` + Grafana quick-start. |
| `D:/MCP/skills/using-apimemcp/SKILL.md` | One paragraph noting OTel export exists and is opt-in. |

### 3.4 MCP tool / route / screen signature

**N/A — no new MCP tool.** `get_extraction_stats` (existing tool, backed by `metrics.ts`'s F14 aggregation) already gives agents/humans the in-process read path; F17 is purely an *export* to external systems and would duplicate, not complement, a new "otel status" tool. `initOtelAdapter()`/`getOtelStatus()` are plain exported functions, imported directly by `index.ts` (startup) and by tests/`verify-F17.mjs` — never registered as a tool. Confirmed against the catalog: F17's Modules cell omits `index.ts`/tool wiring, unlike F00/F16 which explicitly add tools.

## 4. Sub-tasks (S0–S11)

| # | Status | Note |
|---|---|---|
| S0 Spec | Applicable | this document |
| S1 Types | Applicable | `OtelEnvSchema`, `OtelAdapterStatus`, `MeasureListener` (imports `MeasureRecord` from F14, does not redefine it) |
| S2 Storage | **N/A** | push-based exporter only; no local persistence, no file added |
| S3 Core | Applicable | `otel-adapter.ts`: env resolution, MeterProvider/TracerProvider wiring, counter+histogram+synthetic-span mapping |
| S4 Module | Applicable | new `otel-adapter.ts` + 3-line additive hook in `metrics.ts` |
| S5 Wiring | Applicable | one `initOtelAdapter()` call in `index.ts` startup |
| S6 Unit | Applicable | `otel-adapter.test.ts` (new) + 2 cases appended to `metrics.test.ts` |
| S7 Verify | Applicable | `scripts/verify-F17.mjs` — real extraction, real (local mock) OTLP receipt |
| S8 Docs | Applicable | README env-var table + SKILL.md paragraph |
| S9 Review | Applicable | G2 code-review |
| S10 Live | Applicable | G6 via `verify-F17.mjs` (only `Lv` gate marked in catalog) |
| S11 Merge | Applicable | G7 integration, wave 4 |

## 5. Dependencies & sequencing

- **Hard dep:** F14 (Metrics 2.0/SLA) — F17 cannot exist before `metrics.ts` carries the ADR-04 `MeasureRecord` shape and owns aggregation; F17 only adds a consumer hook to it.
- **Soft context:** ADR-04 (measure model, read in full for this spec).
- **Unblocks:** nothing in the F00–F25 DAG or the W/X/M catalog depends on F17 — it is a DAG leaf (no feature lists `F17` in its `Deps` column). Its value is operational (enterprise-adoption signal for the self-host track), not a build-order blocker.
- **Wave:** 4, alongside F09, F12, F13, F20 — safe to build in parallel with those since it touches no file any of them own (`metrics.ts`'s 3-line hook is additive and unlikely to conflict).

## 6. Quality gates & Definition of Done

Gates that apply (per the catalog's Gates cell for F17 = `Lv`): **G0 Spec → G1 Build → G2 Code-Review → G5 QA → G6 Live-Verify → G7 Integration → (wave) G8 Promote.** Skipped: G3 Arch (new module follows the established small-module pattern, no boundary/shared-type change), G3b Design (no UI), G4 Security (no secrets, no new tool, no cross-user data, no sandbox/allowlist surface).

**Definition of Done:**
1. Every `MeasureRecord` emitted (success **and** failure) reaches the configured OTLP endpoint as one metric-count increment, one histogram observation, and one synthetic span, within one `OTEL_METRIC_EXPORT_INTERVAL`/`BatchSpanProcessor` flush.
2. With no `OTEL_EXPORTER_OTLP_ENDPOINT` set (the default), zero OTel SDK objects are constructed and zero network calls happen — verified, not assumed.
3. `metrics.ts`'s existing write path is unchanged in shape; the only diff is the additive listener fan-out (ADR-04's "no second metrics-writing path" rule holds).
4. `npm run build` clean; `src/otel-adapter.test.ts` + updated `metrics.test.ts` green; `scripts/verify-F17.mjs` exits 0 locally and in `.github/workflows/verify.yml`.
5. No new MCP tool registered; `index.ts` diff is exactly one call.

## 7. Test plan

**`D:/MCP/src/metrics.test.ts`** (extend existing file, 2 new cases):
- `onMeasure` registers a listener that receives the exact record passed to `record()`; `unsubscribe()` (the returned fn) stops further delivery.
- a listener that throws does not prevent `record()` from completing or from calling the other registered listeners (isolation of the fan-out).

**`D:/MCP/src/otel-adapter.test.ts`** (new):
- No endpoint / `OTEL_SDK_DISABLED=true` → `initOtelAdapter(fakeEnv)` returns `{enabled:false, exporter:"none", recordsExported:0}`; no exporter/meter constructor is invoked (assert via a spy on the exporter module — dependency-injectable or mocked at the module boundary).
- Endpoint set + a mocked `Meter`/`Tracer` (inject via a test seam, or mock `@opentelemetry/sdk-metrics`/`sdk-trace-base`) → feeding one success `MeasureRecord` through `metrics.onMeasure`'s callback results in exactly one `counter.add(1, {template_id, kind, success:true})` and one `histogram.record(durationMs, ...)`, plus one span with `startTime = timestamp - durationMs` and `endTime = timestamp`.
- A failure record (`success:false, error:"..."`) still gets exported (not dropped) and the span carries `SpanStatusCode.ERROR` + the error message.
- `shutdownOtelAdapter()` unsubscribes from `metrics.onMeasure` — a `record()` call after shutdown does not reach the (now-stale) exporter mock again.

**`D:/MCP/scripts/verify-F17.mjs`** + fixture (reuses existing infra, adds none):
1. Spin a throwaway local `http.createServer` OTLP/HTTP-JSON receiver (Node built-in `http`, no new dep) that records received POST bodies to `/v1/metrics` and `/v1/traces`.
2. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to that server's URL and `OTEL_METRIC_EXPORT_INTERVAL=200` (fast flush) in-process; call `initOtelAdapter()`.
3. Run one real extraction against whichever local HTML fixture the existing `scripts/verify-*.mjs` scripts already serve (no new fixture file — reuse).
4. Poll (bounded, e.g. up to 5s) until the mock receiver has ≥1 metrics POST containing a data point with the matching `template_id` attribute, and ≥1 trace POST containing a span named after that `templateId`.
5. Assert `getOtelStatus().recordsExported >= 1` and `lastError === undefined`; exit 1 on any assertion failure so CI (`.github/workflows/verify.yml`) fails loudly.

## 8. Acceptance criteria (live, observable proof)

1. Start the MCP server with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` pointing at a real local OTel Collector (or the `verify-F17.mjs` mock receiver); run any extraction tool; within `OTEL_METRIC_EXPORT_INTERVAL`, the collector/mock shows a `apimemcp.extraction.count` data point and a span for that `templateId` — inspectable directly in the collector's logging exporter output or the mock's captured payload.
2. Start the server with no `OTEL_*` env vars set; run an extraction; `getOtelStatus()` reports `{enabled:false, exporter:"none"}` and a network spy shows zero outbound connections to any OTLP endpoint — proving the local-first "pay nothing unless you opt in" property.
3. `npm run build` succeeds; `node scripts/verify-F17.mjs` exits 0; CI workflow run is green.

## 9. Reuse notes

- **Reuse, don't redefine:** the ADR-04 `MeasureRecord` shape (F14's), and `ExtractionMeta.durationMs`/`timestamp` which already exist on every result — F17 adds zero new measurement, only a new reader.
- **Reuse the existing sole-writer role of `metrics.ts`:** the single instrumentation point in `executeExtraction` is untouched; F17's only edit to an existing file is the additive `onMeasure` fan-out.
- **Reuse `get_extraction_stats`** (existing tool) as the in-process read path — deliberately not duplicated as a new "OTel status" tool.
- **Reuse the OTel spec's own env-var convention** (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, `OTEL_METRIC_EXPORT_INTERVAL`) instead of inventing APImeMCP-specific config keys or CLI flags — every OTLP-speaking backend already understands these.
- **Reuse zod** (already a project dependency, per ADR-01's own use of it in `types.ts`) for `OtelEnvSchema` instead of adding an env-validation library.
- **Reuse existing verify-script/CI plumbing** (`scripts/verify-*.mjs` pattern + `.github/workflows/verify.yml`) and an existing fixture — no new fixture file.
- **Not applicable here:** `captureForensics`, `atomicWriteFile`, `withLock`, `registerTemplate`, `findTemplateByUrl`, `buildStandaloneScript` — this feature writes no local files and touches no template lifecycle; nothing in that list applies. Noted explicitly rather than silently omitted.
- **Deliberately trimmed dependency footprint:** `@opentelemetry/api`, `sdk-metrics`, `exporter-metrics-otlp-http`, `sdk-trace-base`, `exporter-trace-otlp-http` (5 small packages) — **not** `@opentelemetry/sdk-node`, which bundles auto-instrumentation and resource detectors this feature doesn't need. `// ponytail: metrics+synthetic-spans only, add sdk-node's auto-instrumentation if a future feature needs it to trace things other than extractions.`

## 10. Skills (setup + when-to-use)

- **`context7-mcp`** (already available, no install) — primary skill for this feature. No ≥1K-install OpenTelemetry-specific skill exists on skills.sh (same rejection pattern the plan already applied to Cloudflare/serverless-Chromium/Playwright, all <150 installs) — per the plan's own skill-quality bar, fall back to `context7` + official docs rather than settle for a weak match. Resolve `/open-telemetry/opentelemetry-js`, query for the `Meter`/`Counter`/`Histogram` API, `PeriodicExportingMetricReader` + `OTLPMetricExporter` config, and the `BasicTracerProvider`/synthetic-span pattern (explicit `startTime`/`endTime`), before writing S1/S3. Run `npx skills find opentelemetry` once first (the execution agent's re-check convention) in case a reputable ≥1K-install skill has since appeared; use it instead of/alongside context7 if so.
- **`.agents/skills/observability-and-instrumentation`** (already installed, part of the repo's 24-skill discipline library — no install command needed) — guides S3 (what to instrument and how to name metrics/spans) and S8 (what to document for operators).
- **`.agents/skills/test-driven-development`** (already installed) — guides S6 (write the no-op/enabled/failure/shutdown cases before the implementation).
- Setup: `npx skills check` first (idempotent, reuses anything already installed); no `npx skills add` calls are needed for F17 specifically since both applicable skills are already present.
