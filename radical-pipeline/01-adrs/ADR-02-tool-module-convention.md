# ADR-02 — Tool-module convention

- **Status:** Accepted (Phase 0 — locked before any feature branch forks)
- **Date:** 2026-07-17
- **Deciders:** Architect / Boundary-keeper
- **Depended on by:** every tool-adding feature (F00 retrofit first; then F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25, and any platform feature that adds an engine tool)

## Context

All 11 MCP tools are registered **inline** in `src/index.ts` with `server.tool(name, shape, handler)` — `register_extraction_template`, `execute_native_extraction`, `connect_app`, `confirm_app_connection`, `list_app_connections`, `save_template_cookies`, `schedule_stock_check`, `get_extraction_stats`, `send_notification`, `batch_download_assets`, `add_community_template`. Every handler body lives in that one file.

Roughly 48 features across two programs will add or touch tools. If each feature edits the body of `index.ts`, that file becomes the single worst merge-contention point in the repo: every feature branch conflicts there, and the context-bounded fan-out model (one fresh subagent per feature, many in parallel) collapses into a serial queue fighting over one file.

The 4-module boundary already assigns `index.ts` the role of *sole wiring*. We keep that role — but make the wiring **append-only** so parallel branches stop colliding.

## Decision

1. Each MCP tool is registered by an exported `registerXxxTool(server, deps)` function that lives in **its own module** — co-located with the feature's logic module, or under a new `src/tools/` directory (builder's choice), one function per tool.
2. `deps` is an explicit object of the collaborators the handler needs (storage fns, engine fns, notifier, metrics, …). No hidden cross-boundary imports inside the handler — the dependencies are passed in, which keeps each tool unit-testable with a fake `deps` and keeps the 4-module separation intact.
3. `index.ts` shrinks to: construct `server`, assemble the `deps` object once, and then an **append-only list of `registerXxxTool(server, deps)` calls**. Adding a feature's tool = one appended line.
4. **F00's three app-connections tools are the first retrofit** (this also resolves the `engine ↔ app-connections` state-mutation erosion F00 is chartered to fix). The existing 11 tools migrate to the convention as F00/F01 land.

## Consequences

- **Positive.** Turns 48-feature `index.ts` contention into conflict-free one-line appends; parallel feature branches stop colliding on wiring. Each handler becomes independently unit-testable (inject a fake `deps`) without booting the whole MCP server. Reinforces the boundary — engine/storage stop leaking into a monolithic wiring file.
- **Negative / cost.** A one-time mechanical refactor of the 11 existing tools (covered by F00 + F01 landing first) and a few more files. A tool that needs a new collaborator adds it to the single `deps` object — still one place, still append-only.
- **Contract rule (G3 Arch enforces).** No feature adds tool wiring by editing another tool's block. New tools are new `registerXxxTool` modules plus one appended call. The Integration/Merge agent resolves any residual `index.ts` conflict by **re-ordering appends, never by merging handler bodies**.

## Which features depend on it, and how

Every feature that adds or modifies an MCP tool binds to this convention — it is the mechanism that makes the whole feature fan-out parallelizable rather than serialized on one file.

| Feature | Dependency |
|---|---|
| **F00** App-connections | First retrofit: its 3 tools move to `registerXxxTool` modules; fixes the engine↔app-connections erosion at the same time. |
| **F01, F05, F07, F08, F10, F13, F15, F16, F19, F20, F21, F22, F25** | Each ships its tool(s) as a `registerXxxTool` module + one appended call in `index.ts`, so branches never conflict on wiring. |
| Platform features (Program 2) | Any engine-side tool they require follows the same append-only convention. |
