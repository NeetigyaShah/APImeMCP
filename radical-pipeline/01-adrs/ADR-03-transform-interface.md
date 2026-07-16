# ADR-03 — Transform interface

- **Status:** Accepted (Phase 0 — locked before any feature branch forks)
- **Date:** 2026-07-17
- **Deciders:** Architect / Boundary-keeper
- **Depended on by:** F10, F09, F25, W05, M04

## Context

Raw template output usually needs reshaping before it is useful: rename fields, pick a subset, coerce types, map over an array. Today nothing does this, so every consumer would hand-roll its own mapping. Worse, the **write side** (F09 bidirectional flows: read A → transform → form-fill *write* into B) needs the *same* mapping logic pointed the other direction, and a pipeline (F07) needs to serialize a transform *as data* into its definition.

We want one **declarative, serializable transform spec** (so it can live in a pipeline def, the registry, or the platform without shipping code) plus one **pure applier** — the same shape and discipline as ADR-01's validator: no IO, total, deterministic.

## Decision

1. New `src/transform.ts` exporting a `TransformSpec` type — zod-validated, serializable JSON — describing a small set of jq-like ops: `map`, `rename`, `pick`, `coerce` (plus only the minimum F10 actually needs). **Not** a general expression language.
2. Pure `applyTransform(data: unknown, spec: TransformSpec): unknown` — no file/network IO, total, deterministic.
3. Because the spec is plain data (JSON), it serializes into F07 pipeline definitions, the registry, and the platform with no code crossing the boundary.

## Consequences

- **Positive.** One mapping implementation is shared by output normalization (F10), pipeline steps (F07/F09), export (F25), and both client surfaces (W05/M04) — written once. Serializable spec ⇒ transforms travel inside pipeline defs and across the repo boundary (ADR-06) as data, not code. Pure/no-IO ⇒ sandbox-safe (X02) and unit-testable with plain fixtures.
- **Negative / cost.** A new mini-DSL to define and document.
  <!-- ponytail: keep TransformSpec to map/rename/pick/coerce; add ops only when F09/F25 actually need them, not speculatively -->
  Grow the op set only on a real feature need; the ceiling is deliberate.
- **Contract rule (G3 Arch enforces).** `applyTransform` stays pure/total; a PR that hand-rolls output reshaping which should be a `TransformSpec` is rejected in favor of the shared applier.

## Which features depend on it, and how

| Feature | Dependency |
|---|---|
| **F10** Transform / normalize layer | Owns `src/transform.ts`, the `TransformSpec` type, the op set, and `applyTransform`. |
| **F09** Bidirectional flows | Uses the same applier to shape read-A output into B's form-fill *write* payload — same spec, reverse direction. |
| **F25** OpenAPI + client export | Uses the spec to describe/emit the output mapping in the generated client. |
| **W05** Web run console | Applies (and previews) a transform on live results in the browser. |
| **M04** Mobile run + result views | Reshapes results for JSON/table/image views on device. |
