# ADR-04 — Metrics measure-model

- **Status:** Accepted (Phase 0 — locked before any feature branch forks)
- **Date:** 2026-07-17
- **Deciders:** Architect / Boundary-keeper
- **Depended on by:** F14, F16, F17, F20, F24, X05

## Context

`src/metrics.ts` today records a narrow, image-centric row — `{timestamp, templateId, url, imageCount}` — to a CSV (`templates/extraction_metrics.csv`), and it is called from **two** places in `src/index.ts` (once with `imageCount` 0, once with the real count) rather than from the extraction path itself. That shape cannot answer the questions the observability/caching/monitoring column needs: success rate per template, latency, failure reasons.

Meanwhile `ExtractionMeta` already carries `durationMs` and `timestamp` on *every* result — latency is already measured, it just is not recorded in a queryable model. And several features (F14 SLA, F16 cache, F17 OTel, F20/X05 monitors, F24 reputation) will each want run history. If each instruments its own thing, the metrics diverge and the extraction path grows N logging calls.

We want **one emission point** and **one record shape** that every consumer reads.

## Decision

1. Define one measure record: `{ templateId, kind, success, durationMs, timestamp, error? }`, where `kind` = `extraction | action-sequence | static-http` (matching `ManifestEntry.kind`, incl. F15's new kind).
2. Emit it from a **single instrumentation point** on the extraction code path — the one place that assembles `ExtractionResult` (engine's `executeExtraction` / its wrapper in `index.ts`) — **replacing the two current ad-hoc `logExtractionMetric` call sites**. Both success and failure emit; failure carries `error`.
3. `metrics.ts` owns aggregation over these records (success-rate, latency, last-run) and stays the single reader/writer of the store. **Producers emit; consumers read.** F17's OTel adapter *exports* the same measures; F16 cache and F20/X05 monitors *read* them. No consumer re-instruments the run path.

## Consequences

- **Positive.** One measure, many consumers — SLA (F14), cache decisions (F16), OTel export (F17), change-monitors (F20/X05), reputation (F24) all read the same record, so metrics can't diverge. Failures become first-class data (the current CSV effectively only tracks image counts), enabling real success-rate SLAs and health/drift signals. Because `durationMs` already lives on `ExtractionMeta`, the emission is mostly plumbing — low risk (F14 is "QA only", wave 1).
- **Negative / cost.** The record shape changes from the current CSV; `getExtractionStats` and the dashboard read paths migrate to the new model (F14's job). The old CSV is dropped or one-time-migrated — F14 decides. The single emission point is a mild coupling chokepoint, which is the intent (single source of truth); any new run kind must set `kind` so consumers stay complete.
- **Contract rule (G3 Arch enforces).** Features do **not** add a parallel instrumentation path — they add a *consumer* that reads the measure store or the OTel stream. A second metrics-writing path is rejected.

## Which features depend on it, and how

| Feature | Dependency |
|---|---|
| **F14** Metrics 2.0 (SLA) | Owns the model + aggregation (success-rate + latency); migrates the CSV/dashboard reads. |
| **F16** Short-TTL result cache | Reads recency/hit signals from the measures to inform cache decisions. |
| **F17** OpenTelemetry | Adapter exports the ADR-04 measures as OTel spans/metrics — no new instrumentation. |
| **F20** Change-monitoring mesh | Reads run history to diff results over time and raise change events (reuses F02 diff). |
| **F24** Marketplace reputation + semver | Derives contributor/template reputation from the success/failure records. |
| **X05** Cloud monitors service | Reads the same measures to decide "changed / healthy" and fire Expo push. |
