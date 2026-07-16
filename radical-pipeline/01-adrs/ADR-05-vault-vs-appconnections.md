# ADR-05 — Vault vs app-connections

- **Status:** Accepted (Phase 0 — locked before any feature branch forks)
- **Date:** 2026-07-17
- **Deciders:** Architect / Boundary-keeper, Security-Reviewer
- **Depended on by:** F00, F13, X06

## Context

Two different secret-ish concepts are easy to conflate, and conflating them blurs the security model.

- **app-connections** (shipped as F00, `src/app-connections.ts`) stores **browser identity**: an `AppConnection` = `{connectionId, domainPattern, loginUrl, profileDir, autoStart, status, …}`, backed by a persistent Playwright profile directory (`templates/app-profiles/<id>`) established by an interactive login. It is a *session/profile*, not a credential you can print or re-inject as a string.
- **Vault** (F13, not yet built) will store **encrypted secrets** — API keys, bearer tokens, passwords — encrypted at rest and injected into a run. A fundamentally different store: keyed encrypted *values*, not a browser profile dir.

They have different threat models, different lifecycles, and different review gates. If they merge into one module/store, the Security-Reviewer can no longer reason about them separately, and F13/X06 have no stable boundary to build against — especially X06, where cloud per-user isolation is a hard requirement.

## Decision

1. Keep them as **separate modules and separate stores**:
   - **app-connections** — `src/app-connections.ts`, store `templates/app-connections.json` + profile dirs under `templates/app-profiles/` = login profile/session dirs = browser identity.
   - **Vault** — `src/vault.ts` (F13), a distinct encrypted-at-rest store of secrets injected at run time.
2. A vault entry **MAY be referenced by** an app-connection or a template (e.g. a template names a vault key to inject). Cross-boundary *reference* is allowed; **merging the stores is not**.
3. Freeze the public surface of each at Phase 0 so F13/X06 can code against it even while F00 hardening is still in flight (per the git strategy's F00 note — if F00 isn't green in time, this ADR is what F13/X06 build against).

## Consequences

- **Positive.** Cleanly separable security boundaries: profile dirs vs encrypted secret values each get their own threat model and their own Security-Reviewer gate. F13 and X06 build against a stable, documented split instead of a moving target. Matches the two-track model — self-host uses rich local browser profiles; cloud (X06) leans on the encrypted-vault path for per-user secrets with zero cross-user sharing.
- **Negative / cost.** Two stores to maintain and two concepts to keep straight in docs. The "MAY reference" link needs a small defined format (a vault key id on a template/connection) — defined in F13, not here. Neither store may later absorb the other without a new ADR; the rigidity is deliberate, to protect the security model.
- **Contract rule (Security-Reviewer gate — G4).** No code path copies a vault secret into an app-connection profile or vice-versa. In the cloud, neither store is ever shared across users.

## Which features depend on it, and how

| Feature | Dependency |
|---|---|
| **F00** App-connections | Defines the *browser-identity* side of the boundary; its hardening + engine↔app-connections erosion fix land against this split. |
| **F13** Encrypted credential vault | Builds the *encrypted-secrets* side (`src/vault.ts`) as the other half of the boundary; defines the "MAY reference" key format. |
| **X06** Encrypted cookies + optional per-user vault (cloud) | Encrypted per-user transit + optional vault; the boundary is exactly what keeps per-user isolation reviewable and secrets un-mixed with profiles. |
