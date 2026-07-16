# ADR-06 — Registry = cross-repo contract

- **Status:** Accepted (Phase 0 — locked before any feature branch forks)
- **Date:** 2026-07-17
- **Deciders:** Architect / Boundary-keeper
- **Depended on by:** all of Program 2 — W01–W08, X01–X07, M01–M07

## Context

Three repos make up the system:

- **`apimemcp`** (this repo, the engine) — published to npm as `@neetigyashah/apimemcp`.
- **`apimemcp-templates`** — the community registry git repo, served over jsDelivr. `src/registry-client.ts` already fetches its `manifest.json` (`Manifest = Record<string, ManifestEntry>`) from `https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/registry`.
- **`apimemcp-platform`** — the new Turborepo for Program 2 (web + cloud + mobile).

The platform must run community templates and render their results, but it must **not** depend on the engine's internal modules (`engine.ts`, `storage.ts`, …) — those are Playwright-bound, filesystem-bound, and refactor freely. If the platform reached into engine internals, every engine refactor would break the platform and the two programs could never move independently. The registry manifest shape is already the natural interchange format; we formalize it as *the* contract.

## Decision

1. The **only** contract between the engine repo and the platform repo is:
   - the `apimemcp-templates` **manifest shape** — `ManifestEntry` / `Manifest`, including `outputSchema` from ADR-01; and
   - the **published `@neetigyashah/apimemcp` types**, consumed via npm.
2. The platform imports types **from the npm package**, never from engine source. It reaches templates through the registry manifest + the cloud execution API (X01) — never by importing engine internals.
3. A breaking change to the shared types = a **semver major** on the engine package **plus** an explicit platform bump PR. Additive fields stay optional (the ADR-01 / `ManifestEntry` precedent — that is how `waitStrategy`, `readySelector`, `source` were added without breaking anyone).

## Consequences

- **Positive.** The two programs evolve independently: engine internals refactor freely as long as the published types + manifest shape hold. One obvious, enforceable boundary (npm types + manifest) that G3 Arch can police and a fresh agent can understand in one read. The manifest already crosses via jsDelivr, so formalizing it costs nothing operationally.
- **Negative / cost.** The engine must treat its exported types + `ManifestEntry` as a **public API**: additive-optional by default, semver-major on any break — a real discipline tax on type changes. The engine must actually *export* the shared types from the package entry (a small barrel) and keep them free of Node-only / Playwright-only imports so they are consumable in the platform's browser/edge contexts.
- **Contract rule (G3 Arch, cross-repo — G7 Integration).** A platform PR importing anything but published types / the manifest is rejected. An engine PR changing a shared type without a semver bump + a platform-bump note is rejected.

## Which features depend on it, and how

**All of Program 2** — it is the seam that lets Program 2 exist as a separate repo at all.

| Surface | Dependency |
|---|---|
| **W01–W08** (web) | Consume the manifest + published types for the registry browser, template detail, run console, and contribute flow. |
| **X01–X07** (cloud) | Run registry-only templates, mirror the manifest in X07, and type the execution API (X01) from the package — never from engine internals. |
| **M01–M07** (mobile) | Share the same API client + result types (derived from `ManifestEntry` + ADR-01 `outputSchema`) via the published package. |

A breaking engine type change ripples here as a coordinated semver-major + platform-bump — the whole reason the contract is narrow and explicit.
