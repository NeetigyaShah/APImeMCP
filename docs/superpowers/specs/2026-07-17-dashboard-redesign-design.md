# Dashboard redesign: living-signal tiles + full feature coverage

**Date:** 2026-07-17
**Author:** Brainstorming session (Claude Code), approved by NeetigyaShah

## Goal

The dashboard (`src/dashboard.ts`, a single Express route rendering server-side
HTML with vanilla JS polling — no framework, no build step) currently shows
only 5 of the 20 shipped Program-1 features: Templates, Activity, Extraction
Stats, Scheduled Jobs, Forensic Captures. Seven features have **no UI surface
at all** (self-healing, pipelines, provenance, policy engine, credential
vault, OTel observability, change-monitoring — the last one specifically
called out as "the killer feature" in
`radical-pipeline/07-platform-design/website-design.md`), and two more are
only partially shown (golden snapshots, template kind badges).

This redesign makes every shipped feature visible and interactive, in a
visual style that's distinctive rather than default, without introducing any
new runtime dependency, build step, or framework.

## Visual design

Derived from a live browser-based brainstorm (`.superpowers/brainstorm/`)
where the user iterated through style directions and picked a final one.
**This deliberately departs from the documented cross-surface phosphor/void
brand token** (`radical-pipeline/07-platform-design/design-system.md`'s
warm `#14100a` void + amber `#ffb627` phosphor) for this one surface — the
local dev dashboard is not consumed by the mobile app or marketing site, so
this doesn't need Design-Lead sign-off the way W02/M02 would. If the token
system needs a second surface later, revisit then.

- **Palette:** cool near-black void (`#0d0d10`), muted **steel blue** accent
  (`#3f6fb8`, deliberately desaturated — not the brighter `#5b9cf6` first
  tried), existing semantic `ok`/`err` greens/reds kept as-is (status colors,
  not brand accent).
- **Texture:** a very faint (2.5% opacity) horizontal scanline overlay across
  panels — CRT-terminal reference, kept subtle.
- **Motion:** blinking block cursor next to the product name (existing
  pattern, already respects `prefers-reduced-motion` — extend that same
  media query to every new animation below, don't special-case it per
  element).
- **No glow.** Explicitly rejected in the brainstorm: no `text-shadow`, no
  `box-shadow` glow on any accent element. Flat, precise color only.
- **Living-signal pulse:** a small animated ring-pulse (`box-shadow` keyframe
  expanding and fading — this is a *status* animation, not a glow, so it's
  in scope) on tile status dots when that area has *recent* activity (a run
  in the last few seconds, a monitor that fired in the last hour). Idle
  tiles show a static dot, no animation — the pulse itself is the signal,
  so it must not run constantly or it stops meaning anything.

## Interaction model

Replace the current single scrolling stack of 5 sections with:

1. **Tile grid** (new) — always visible, directly under the `chrome` bar.
   One tile per feature area (11 total, see table below). Each tile shows a
   one-line glance metric and a status dot. Click a tile to select it.
2. **Detail area** (new) — below the grid, renders the full panel for
   whichever tile is currently selected. Defaults to Templates on load.
   Swapping is a plain `innerHTML` replace driven by a `data-section`
   attribute — no router, no history API needed (this is a local dev tool,
   deep-linking isn't a requirement).
3. **Activity ticker** — stays visible above or alongside the tile grid at
   all times rather than living behind its own tile; it's the live pulse
   for everything else, hiding it behind a click defeats its purpose.

## Section content

| Tile | Glance metric | Drill-down panel | Backend source (reuse, no new logic) |
|---|---|---|---|
| Templates | count · pulse if a run is active | existing list, + kind badge for `static-http`/`write` (today only `action-sequence` gets one), + schema-valid check, + provenance-verified check on last result | `loadManifest()`, existing `/api/templates` |
| Pipelines | count registered | list, each rendered as its step chain (read → transform → write, branch points marked), run button, last result | `listPipelineDefs()`, `runPipeline()` (`src/pipeline.ts`) |
| Monitors | active count · pulse if one fired in the last hour | subscribe form, active monitor list (template/cron/last-changed), recent change history | `scheduler.listMonitors()`, `subscribeMonitor()`, `cancelMonitor()` (`src/scheduler.ts`) |
| Self-Heal Queue | pending count (0 = quiet gray, >0 = amber-equivalent alert state using `err`) | ticket list, forensics links (screenshot/DOM/drift diff), status (pending/submitted/pr-opened/rejected) | `listPendingHeals()` (`src/self-heal.ts`) |
| Vault | secret count | stored secret IDs + labels (never values), add/delete | `listVaultSecrets()`, `setVaultSecret()`, `deleteVaultSecret()` (`src/vault.ts`) |
| Policy | e.g. "3 domains restricted" | rate-limit interval, robots.txt respect state, ToS-restricted domain list | `getPolicyConfig()` (`src/policy.ts`) |
| Observability | on/off dot | OTel endpoint, export count, last export time | `getOtelStatus()` (`src/otel-adapter.ts`) |
| Discover | — (no glance metric, it's a search tool) | search box + results (local + registry) | `discoverTemplates()` (`src/discovery.ts`) |
| Extraction Stats | aggregate success rate | existing table, + golden-snapshot column (match/regression/no-baseline) | `getAllSla()` (existing), `src/snapshot.ts` |
| Scheduled Jobs | job count | existing crontab table + form, unchanged | `scheduler.list()` (existing) |
| Forensic Captures | failure count | existing log list, unchanged | `listForensicLogs()` (existing, local to `dashboard.ts`) |

11 tiles (Activity stays outside the grid as an always-visible strip, not a
12th tile, per the interaction-model decision above).

## Technical approach

- **No new dependencies.** Every drill-down panel is backed by a function
  that already exists (it's the same function the corresponding MCP tool
  calls) — the work is wiring, not new logic.
- **New Express routes** in `src/dashboard.ts`, following the existing
  `/api/*` convention: `/api/pipelines` (GET list, POST run), `/api/monitors`
  (GET list, POST subscribe, DELETE unsubscribe), `/api/heal-tickets` (GET),
  `/api/vault` (GET list, POST set, DELETE), `/api/policy` (GET),
  `/api/otel-status` (GET), `/api/discover` (GET, query param).
- **`DashboardDeps`** (the interface `startDashboard()` takes) grows to
  include the new dependencies it needs to call — same pattern as the
  existing `runExtraction`/`scheduler` fields, additive only.
- **Vault route never returns ciphertext/iv/authTag** — same rule the F13
  `list_vault_secrets` MCP tool already follows; the dashboard route calls
  the same underlying function, so this is inherited for free, not
  reimplemented.
- **File size:** `dashboard.ts` is already 815 lines and will roughly
  double. If it crosses ~1500 lines, split the per-section HTML-string
  builders into a `src/dashboard-sections/` directory (one file per tile)
  at implementation time — call this out in the plan rather than deciding
  now, since the natural split only becomes obvious once each section's
  real size is known.

## Non-goals

- Not touching the documented cross-surface phosphor/void brand token itself
  — this redesign is scoped to the local dashboard only.
- Not adding a frontend framework, bundler, or client-side router.
- Not changing any MCP tool behavior — this is a read/display + thin-wiring
  layer over existing functions.
- Not building new backend features — every drill-down surfaces something
  that already works via MCP tools today.

## Success criteria

Every one of the 20 shipped Program-1 features has a visible, interactive
surface in the dashboard. `npm run build` and `npm test` stay green. The
dashboard still starts with zero new npm dependencies.
