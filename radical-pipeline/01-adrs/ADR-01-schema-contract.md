# ADR-01 — Schema contract

- **Status:** Accepted (Phase 0 — locked before any feature branch forks)
- **Date:** 2026-07-17
- **Deciders:** Architect / Boundary-keeper
- **Depended on by:** F01, F02, F04, F11, F25, W04, M04

## Context

Every template today returns `ExtractionResult.data: unknown` (`src/types.ts`). There is no machine-readable description of *what shape* a template produces. That single gap blocks a whole column of downstream features: drift detection has nothing to diff a live result against, provenance receipts have nothing to assert, the platform's result views (web + mobile) have nothing to render or type against, and an OpenAPI/typed-client export has nothing to generate from.

Two facts about the existing code make the right move obvious:

- `src/types.ts` already depends on `zod`, and `ManifestEntry` has already grown optional fields (`waitStrategy`, `readySelector`, `source`) via a purely additive pattern — every existing template kept working because the new field was optional and absent meant "old behavior". We follow that exact precedent.
- The description must cross the repo boundary (ADR-06) to the platform and to the OpenAPI exporter (F25), so the *stored* form has to be language-neutral, not a zod object literal.

We want **one declarative output shape per template** and **one pure validator** — no IO, reusable by the engine, by the platform (via published types), and by export tooling.

## Decision

1. Add an optional `outputSchema?` (a JSON Schema object, stored inline) to `ManifestEntry` in `src/types.ts`. It persists in the manifest like every other entry field and therefore travels through the registry (ADR-06) for free.
2. Add a pure `validateOutput(value: unknown, schema): ValidationResult` — zod-backed, **no file/network IO, total (never throws)**, returning `{ valid, errors? }` — in `src/types.ts` or a new pure `src/schema.ts`.
3. **Absent `outputSchema` = validation skipped, run unchanged.** Full back-compat for every template registered before this field existed.
4. JSON Schema is the on-the-wire form (language-neutral, crosses the repo boundary and feeds F25); `zod` is the in-engine *implementation* that validates against it. Whichever direction the conversion runs, pick one small reputable dependency (an existing json-schema↔zod bridge or `ajv`) rather than hand-rolling — that choice is F01's, not this ADR's.

## Consequences

- **Positive.** Every downstream trust/typing feature reads one shape: F02 diffs against it, F11 signs "schema-valid", the platform renders and types from it, F25 emits OpenAPI from it. Additive + optional ⇒ zero migration, old templates keep running. Pure/no-IO ⇒ trivially unit-testable and safe to call inside the sandboxed cloud runtime (X02).
- **Negative / cost.** A bounded validation cost per run (skipped when the schema is absent). Schema authoring is new per-template work — F05 (`synthesize_schema`) and F01 tooling exist to reduce it. A JSON-Schema↔zod dependency enters the tree; keep it to one vetted library.
- **Contract rule (G3 Arch enforces).** `validateOutput` must stay pure and total — no throw, no IO. That property is exactly what lets F04 (self-heal verify loop), F11 (provenance), and X02 (sandbox) call it in hot or isolated paths. A change that makes it throw or do IO is a boundary violation.

## Which features depend on it, and how

| Feature | Dependency |
|---|---|
| **F01** Schema contracts | Owns this field + `validateOutput`; wires validation into the run path. |
| **F02** Drift detection | Diffs the live result shape against `outputSchema` to flag drift; the schema is the reference shape. |
| **F04** Self-healing | After an agent proposes a fix, re-verifies the new output against `outputSchema` before any registry PR. |
| **F11** Provenance receipts | Receipt asserts "schema-valid" as part of the signed content-hash + version bundle. |
| **F25** OpenAPI + client export | Generates the OpenAPI response schema and typed client directly from `outputSchema`. |
| **W04** Template detail (web) | Renders `outputSchema` as human-readable output docs on the template page. |
| **M04** Mobile run + result views | Types and lays out JSON/table/image result views from the schema. |
