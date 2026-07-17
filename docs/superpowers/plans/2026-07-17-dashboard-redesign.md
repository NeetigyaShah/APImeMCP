# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every one of the 20 shipped Program-1 features a visible, interactive surface in the local dashboard, in a distinctive steel-blue/void visual style, with a tile-grid + drill-down interaction model — zero new runtime dependencies.

**Architecture:** One shared "shell" lands first (tile grid, detail-area swap mechanism, shared types). Then 7 new dashboard sections are built as fully independent files under `src/dashboard-sections/` (each self-contained: own route handlers, own panel/tile builders, own tests) plus one task enhancing two existing sections — all 8 of these run in parallel since they touch disjoint files. A final integration task wires everything into `src/dashboard.ts`.

**Tech Stack:** Express (existing), vanilla server-rendered HTML strings + vanilla client JS (existing pattern, no new dependency), Vitest for tests (existing).

## Global Constraints

- **Palette:** void `#0d0d10`, panel `#17181d`, line `#262932`, accent (steel blue) `#3f6fb8`, text `#e4e9f2`, text-dim `#6c7a91`. Keep existing `--ok`/`--err` semantic colors as-is.
- **No glow.** Never add `text-shadow` or `box-shadow` glow to any accent element. Flat color only.
- **Pulse animation is for status only**, not decoration: only animate a tile's dot when that area has recent activity (see each section's "pulse condition" below). Idle = static dot, no animation.
- **Every new CSS animation must be wrapped for `prefers-reduced-motion`**, matching the existing pattern at `src/dashboard.ts`'s `@media (prefers-reduced-motion: reduce) { .cursor { animation: none; opacity: 1; } }` — add each new animated selector to that same media query block.
- **Zero new npm dependencies.** Every section reuses an existing backend function; the work is wiring and HTML string building only.
- **Vault route must never return `ciphertext`/`iv`/`authTag`** — call `listVaultSecrets()` (already omits them by return type) and never touch the raw store.
- Follow the existing `src/dashboard.ts` code style: template-literal HTML strings, `res.json(...)` for API routes, no JSX/templating engine.

---

### Task 1: Shell — tile grid, detail-area swap, shared types

**Files:**
- Create: `src/dashboard-sections/types.ts`
- Modify: `src/dashboard.ts` (add tile grid HTML/CSS, detail-area container, client-side swap JS, `/api/dashboard-summary` route, `DashboardDeps` gains nothing yet — sections needing new deps add them in their own task since `DashboardDeps` is just an interface any task can extend additively)
- Test: `src/dashboard-sections/types.test.ts`

**Interfaces:**
- Produces (every later task depends on these exact names/shapes):
  ```typescript
  // src/dashboard-sections/types.ts
  export interface TileSummary {
    id: string;                              // e.g. "pipelines"
    label: string;                           // e.g. "Pipelines"
    glance: string;                          // e.g. "3 registered"
    dotState: 'idle' | 'ok' | 'alert' | 'pulse';
  }

  export interface DashboardSection {
    id: string;
    label: string;
    registerRoutes(app: import('express').Express, deps: import('../dashboard.js').DashboardDeps): void;
    getTileSummary(deps: import('../dashboard.js').DashboardDeps): Promise<TileSummary>;
  }
  ```
- Client-side JS contract every section's panel HTML can rely on (defined in `dashboard.ts`, not exported as TS but documented here so section tasks write compatible markup): a global `function selectSection(id)` exists that fetches `/api/section/<id>` and replaces `#detail-area`'s innerHTML with the response text. Section route handlers created in later tasks must respond to `GET /api/section/<id>` with a `text/html` body (the drill-down panel markup) — **not** JSON — so `selectSection` can insert it directly.

- [ ] **Step 1: Write the tile-summary type test**

```typescript
// src/dashboard-sections/types.test.ts
import { describe, it, expect } from 'vitest';
import type { TileSummary, DashboardSection } from './types.js';

describe('dashboard-sections types', () => {
  it('TileSummary shape accepts the four dot states', () => {
    const states: TileSummary['dotState'][] = ['idle', 'ok', 'alert', 'pulse'];
    for (const dotState of states) {
      const tile: TileSummary = { id: 'x', label: 'X', glance: '0', dotState };
      expect(tile.dotState).toBe(dotState);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/types.test.ts`
Expected: FAIL — `Cannot find module './types.js'`

- [ ] **Step 3: Create the types file**

```typescript
// src/dashboard-sections/types.ts
import type { Express } from 'express';
import type { DashboardDeps } from '../dashboard.js';

export interface TileSummary {
  id: string;
  label: string;
  glance: string;
  dotState: 'idle' | 'ok' | 'alert' | 'pulse';
}

export interface DashboardSection {
  id: string;
  label: string;
  registerRoutes(app: Express, deps: DashboardDeps): void;
  getTileSummary(deps: DashboardDeps): Promise<TileSummary>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/types.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Add the tile grid + detail area + swap script to `src/dashboard.ts`**

In the `<style>` block, update the `:root` color tokens (replace the existing `--phosphor`/`--void`/etc. block):

```css
  :root {
    --void: #0d0d10;
    --panel: #17181d;
    --panel-2: #1c1e24;
    --line: #262932;
    --accent: #3f6fb8;
    --accent-dim: #5d7599;
    --ok: #7fd858;
    --err: #ff5f56;
    --paper: #f0e6d2;
    --ink: #2a2015;
    --text: #e4e9f2;
    --text-dim: #6c7a91;
  }
```

Everywhere the old stylesheet referenced `--phosphor` or `--phosphor-dim`, rename to `--accent` / `--accent-dim` (find/replace across the `<style>` block — same variable count, same usage sites, just renamed for the new palette).

Add tile grid CSS right after the `.chrome-title b { ... }` rule:

```css
  .tile-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.6rem; padding: 1rem; max-width: 1080px; margin: 0 auto;
  }
  .tile {
    background: var(--panel); border: 1px solid var(--line); border-radius: 4px;
    padding: 0.7rem 0.8rem; cursor: pointer; font-family: 'IBM Plex Mono', monospace;
    transition: border-color 0.15s ease;
  }
  .tile:hover { border-color: var(--accent-dim); }
  .tile.selected { border-color: var(--accent); }
  .tile-label { font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); display: flex; align-items: center; gap: 0.4rem; }
  .tile-glance { font-size: 1.05rem; color: var(--text); margin-top: 0.3rem; }
  .tile-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); flex-shrink: 0; }
  .tile-dot.ok { background: var(--ok); }
  .tile-dot.alert { background: var(--err); }
  .tile-dot.pulse { background: var(--ok); animation: tile-pulse 1.8s ease-out infinite; }
  @keyframes tile-pulse {
    0% { box-shadow: 0 0 0 0 rgba(127,216,88,0.5); }
    70% { box-shadow: 0 0 0 7px rgba(127,216,88,0); }
    100% { box-shadow: 0 0 0 0 rgba(127,216,88,0); }
  }
  #detail-area { max-width: 1080px; margin: 0 auto; padding: 0 1rem 4rem; }
```

Add the same selector to the existing reduced-motion media query:

```css
  @media (prefers-reduced-motion: reduce) { .cursor, .tile-dot.pulse { animation: none; opacity: 1; } }
```

Replace the `<main>...</main>` block's Templates section opening (keep Templates, Activity, Extraction Stats, Scheduled Jobs, Forensic Captures panels exactly as they are for now — later tasks/the integration task will move them behind tiles) by inserting, directly after `<div class="chrome">...</div>` and before `<main>`:

```html
<div class="tile-grid" id="tile-grid"></div>
<div id="detail-area"></div>
```

Remove the old `<main>...</main>` wrapper's section markup for Templates/Activity/Stats/Jobs/Forensics from the initial server-rendered HTML (they'll be rendered into `#detail-area` on demand instead) — but **keep** the Activity ticker visible outside the tile system per the spec (it stays a persistent strip). Place it directly under the tile grid, before `#detail-area`:

```html
<div class="tile-grid" id="tile-grid"></div>
<section style="max-width:1080px;margin:0 auto;padding:0 1rem">
  <h2>Activity</h2>
  <div class="panel" id="ticker"></div>
</section>
<div id="detail-area"></div>
```

Delete the old `<section><h2>Activity</h2>...</section>` block from where it was inside `<main>` (now duplicated above) and delete the old Templates/Stats/Jobs/Forensics `<section>` blocks from `<main>` entirely — their markup moves into per-section route responses instead (Templates and Stats in Task 9, Jobs and Forensics in this task, Step 6 below, since they're simple moves not new features).

- [ ] **Step 6: Move Jobs and Forensics into section routes (no new features, straight relocation)**

Add to the client `<script>` block:

```javascript
const KNOWN_SECTIONS = ['templates', 'pipelines', 'monitors', 'self-heal', 'vault', 'policy', 'observability', 'discover', 'stats', 'jobs', 'forensics'];

async function refreshTileSummary() {
  try {
    const res = await fetch('/api/dashboard-summary');
    const tiles = await res.json();
    const grid = document.getElementById('tile-grid');
    grid.innerHTML = tiles.map(function (t) {
      return '<div class="tile" data-section="' + t.id + '" onclick="selectSection(\'' + t.id + '\')">' +
        '<div class="tile-label"><span class="tile-dot ' + t.dotState + '"></span>' + t.label + '</div>' +
        '<div class="tile-glance">' + t.glance + '</div></div>';
    }).join('');
    const selected = document.querySelector('.tile[data-section="' + currentSection + '"]');
    if (selected) selected.classList.add('selected');
  } catch {
    // non-fatal, keep showing last known tiles
  }
}

let currentSection = 'templates';
async function selectSection(id) {
  currentSection = id;
  document.querySelectorAll('.tile').forEach(function (t) { t.classList.toggle('selected', t.dataset.section === id); });
  const area = document.getElementById('detail-area');
  area.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await fetch('/api/section/' + id);
    area.innerHTML = await res.text();
    if (typeof window['init_' + id] === 'function') window['init_' + id]();
  } catch (err) {
    area.innerHTML = '<div class="empty">Could not load: ' + err.message + '</div>';
  }
}

refreshTileSummary();
selectSection(currentSection);
setInterval(refreshTileSummary, 5000);
```

Remove the old `pollStats()`, `loadJobs()`, `loadLogs()`, `loadTemplates()` top-level calls and their `setInterval` calls at the bottom of the script (their logic moves into each section's own panel, invoked via the `init_<id>()` convention shown above — each section route response is a self-contained `<script>`-including HTML fragment that defines its own `init_<id>` function if it needs post-insert JS, e.g. to attach form listeners).

- [ ] **Step 7: Add the `/api/dashboard-summary` and `/api/section/:id` routes**

In `startDashboard()`, add (near the existing `/api/templates` route):

```typescript
  // Populated by the integration task once all section modules exist (Task 10).
  const sections: Record<string, DashboardSection> = {};

  app.get('/api/dashboard-summary', async (_req, res) => {
    const summaries = await Promise.all(Object.values(sections).map((s) => s.getTileSummary(deps)));
    res.json(summaries);
  });

  app.get('/api/section/:id', async (req, res) => {
    const section = sections[req.params.id];
    if (!section) {
      res.status(404).type('text/plain').send('Unknown section: ' + req.params.id);
      return;
    }
    // Each section registers its own GET /api/section/<id> handler via registerRoutes;
    // this fallback only fires if a section forgets to. Individual sections own their
    // panel rendering, not this shared route.
    res.status(501).type('text/plain').send('Section "' + req.params.id + '" has not registered a panel route');
  });
```

Import `DashboardSection` type at the top of `src/dashboard.ts`: `import type { DashboardSection } from './dashboard-sections/types.js';`

- [ ] **Step 8: Build and verify**

Run: `npm run build`
Expected: clean, no TypeScript errors

Run: `npx vitest run src/dashboard-sections/types.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/dashboard-sections/types.ts src/dashboard-sections/types.test.ts src/dashboard.ts
git commit -m "feat(dashboard): shell for tile-grid + drill-down redesign"
```

---

### Task 2: Pipelines section

**Files:**
- Create: `src/dashboard-sections/pipelines.ts`
- Test: `src/dashboard-sections/pipelines.test.ts`

**Interfaces:**
- Consumes: `TileSummary`, `DashboardSection` from `./types.js`; `listPipelineDefs(): PipelineDef[]` and `runPipeline(pipelineId: string, initialInput: Record<string, unknown>, deps: PipelineDeps): Promise<PipelineRunResult>` from `../pipeline.js`; `DashboardDeps` from `../dashboard.js` (read-only, this task does not modify it).
- Produces: `export const pipelinesSection: DashboardSection` — the object the integration task (Task 10) imports and registers.

- [ ] **Step 1: Write the panel-rendering test**

```typescript
// src/dashboard-sections/pipelines.test.ts
import { describe, it, expect } from 'vitest';
import { renderPipelinesPanel, renderPipelineChain } from './pipelines.js';
import type { PipelineDef } from '../types.js';

describe('renderPipelineChain', () => {
  it('renders read -> write with an arrow and marks write steps', () => {
    const steps: PipelineDef['steps'] = [
      { kind: 'read', id: 'r1', templateId: 'amazon-price' },
      { kind: 'write', id: 'w1', fromStepId: 'r1', targetTemplateId: 'contact-form', transform: { version: 1, ops: [] } },
    ];
    const html = renderPipelineChain(steps);
    expect(html).toContain('amazon-price');
    expect(html).toContain('contact-form');
    expect(html).toContain('&rarr;');
    expect(html).toContain('write');
  });
});

describe('renderPipelinesPanel', () => {
  it('shows an empty state with no pipelines', () => {
    const html = renderPipelinesPanel([]);
    expect(html).toContain('No pipelines registered');
  });

  it('lists a pipeline by id and name', () => {
    const def: PipelineDef = {
      id: 'checkout-flow', name: 'Checkout Flow',
      steps: [{ kind: 'read', id: 'r1', templateId: 'amazon-price' }],
    };
    const html = renderPipelinesPanel([def]);
    expect(html).toContain('checkout-flow');
    expect(html).toContain('Checkout Flow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/pipelines.test.ts`
Expected: FAIL — `Cannot find module './pipelines.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/pipelines.ts
import { listPipelineDefs, runPipeline } from '../pipeline.js';
import type { PipelineDef, PipelineStep } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';
import type { DashboardDeps } from '../dashboard.js';

export function renderPipelineChain(steps: PipelineStep[]): string {
  return steps
    .map((step) => {
      if (step.kind === 'write') {
        return `<span class="mono" style="color:var(--err)">${step.targetTemplateId} [write]</span>`;
      }
      return `<span class="mono">${step.templateId}</span>`;
    })
    .join(' &rarr; ');
}

export function renderPipelinesPanel(defs: PipelineDef[]): string {
  if (defs.length === 0) {
    return `<div class="empty">No pipelines registered. Use register_pipeline.</div>`;
  }
  const rows = defs
    .map(
      (def) => `
      <div class="row" data-pipeline-id="${def.id}">
        <div class="row-main">
          <span class="mono id">${def.id}</span>
          <span class="mono domain">${def.name}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">${renderPipelineChain(def.steps)}</div>
        <div class="row-controls" style="margin-top:0.5rem">
          <button class="btn run-btn" onclick="runPipelineFromPanel('${def.id}', this)">Run</button>
        </div>
        <pre class="result mono" id="pipeline-result-${def.id}"></pre>
      </div>`
    )
    .join('\n');
  return `
    <section>
      <h2>Pipelines</h2>
      <div class="panel">${rows}</div>
    </section>
    <script>
      window.init_pipelines = function () {};
      window.runPipelineFromPanel = async function (pipelineId, btn) {
        btn.disabled = true;
        const result = document.getElementById('pipeline-result-' + pipelineId);
        result.textContent = 'Running...';
        try {
          const res = await fetch('/api/pipelines/' + encodeURIComponent(pipelineId) + '/run', { method: 'POST' });
          const data = await res.json();
          result.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          result.textContent = 'Request failed: ' + err.message;
        } finally {
          btn.disabled = false;
        }
      };
    </script>`;
}

export const pipelinesSection: DashboardSection = {
  id: 'pipelines',
  label: 'Pipelines',
  registerRoutes(app, deps: DashboardDeps & { listPipelineDefs?: typeof listPipelineDefs }) {
    app.get('/api/section/pipelines', (_req, res) => {
      res.type('html').send(renderPipelinesPanel(listPipelineDefs()));
    });
    app.post('/api/pipelines/:pipelineId/run', async (req, res) => {
      try {
        const result = await runPipeline(req.params.pipelineId, req.body ?? {}, deps as any);
        res.json(result);
      } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const count = listPipelineDefs().length;
    return { id: 'pipelines', label: 'Pipelines', glance: `${count} registered`, dotState: 'idle' };
  },
};
```

**Note on `runPipeline`'s deps parameter:** it expects a `PipelineDeps` object (`runExtraction`, `registerPipeline`, `findPipelineById`, `listPipelineDefs`, `recordMeasure`, `executeWriteFlow`) — the same shape already assembled in `src/index.ts` as `pipelineDeps` and passed to `registerRunPipelineTool`. This dashboard route needs that same object, not the narrower `DashboardDeps`. **The integration task (Task 10) is responsible for passing the real `pipelineDeps` object through** — for this task, write the route to accept `deps` typed loosely (`as any` cast shown above is intentional and temporary) since the real wiring type gets finalized when `DashboardDeps` is extended in Task 10. Do not attempt to redesign `DashboardDeps` in this task — that touches the shared `dashboard.ts` file other parallel tasks are also relying on staying stable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/pipelines.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect clean (the `as any` cast means this compiles even though `DashboardDeps` doesn't have pipeline fields yet).

```bash
git add src/dashboard-sections/pipelines.ts src/dashboard-sections/pipelines.test.ts
git commit -m "feat(dashboard): pipelines section"
```

---

### Task 3: Monitors section

**Files:**
- Create: `src/dashboard-sections/monitors.ts`
- Test: `src/dashboard-sections/monitors.test.ts`

**Interfaces:**
- Consumes: `TileSummary`, `DashboardSection` from `./types.js`; `deps.scheduler.listMonitors(): MonitorSubscription[]`, `deps.scheduler.subscribeMonitor(input): Promise<MonitorSubscription>`, `deps.scheduler.cancelMonitor(id): Promise<boolean>` — **all already present on `DashboardDeps.scheduler`, no new dependency wiring needed** (this section requires zero changes to `DashboardDeps`, unlike Pipelines).
- Produces: `export const monitorsSection: DashboardSection`.
- Pulse condition: `dotState: 'pulse'` if any monitor's `lastChange.at` is within the last hour, else `'ok'` if `active count > 0`, else `'idle'`.

- [ ] **Step 1: Write the panel test**

```typescript
// src/dashboard-sections/monitors.test.ts
import { describe, it, expect } from 'vitest';
import { renderMonitorsPanel, computeMonitorsDotState } from './monitors.js';
import type { MonitorSubscription } from '../types.js';

describe('renderMonitorsPanel', () => {
  it('shows an empty state with no monitors', () => {
    expect(renderMonitorsPanel([])).toContain('No monitors');
  });

  it('lists a monitor with its cron and last-changed time', () => {
    const sub: MonitorSubscription = {
      id: 'mon_1', templateId: 'amazon-price', cronExpression: '* * * * *',
      notifyEndpointUrl: 'http://example.com/hook', active: true, createdAt: '2026-01-01T00:00:00Z',
      lastChange: { at: '2026-01-01T00:05:00Z', summary: '1 change(s) detected' },
    };
    const html = renderMonitorsPanel([sub]);
    expect(html).toContain('amazon-price');
    expect(html).toContain('* * * * *');
    expect(html).toContain('1 change(s) detected');
  });
});

describe('computeMonitorsDotState', () => {
  it('is idle with no monitors', () => {
    expect(computeMonitorsDotState([])).toBe('idle');
  });

  it('is pulse when a monitor changed within the last hour', () => {
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const sub = { active: true, lastChange: { at: recentIso, summary: 'x' } } as any;
    expect(computeMonitorsDotState([sub])).toBe('pulse');
  });

  it('is ok when active but nothing changed recently', () => {
    const oldIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const sub = { active: true, lastChange: { at: oldIso, summary: 'x' } } as any;
    expect(computeMonitorsDotState([sub])).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/monitors.test.ts`
Expected: FAIL — `Cannot find module './monitors.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/monitors.ts
import type { MonitorSubscription } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';
import type { DashboardDeps } from '../dashboard.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

export function computeMonitorsDotState(monitors: MonitorSubscription[]): TileSummary['dotState'] {
  const now = Date.now();
  const recentlyChanged = monitors.some((m) => m.lastChange && now - new Date(m.lastChange.at).getTime() < ONE_HOUR_MS);
  if (recentlyChanged) return 'pulse';
  if (monitors.some((m) => m.active)) return 'ok';
  return 'idle';
}

export function renderMonitorsPanel(monitors: MonitorSubscription[]): string {
  const rows = monitors.length
    ? monitors
        .map(
          (m) => `
      <div class="row" data-monitor-id="${m.id}">
        <div class="row-main">
          <span class="mono id">${m.id}</span>
          <span class="mono domain">${m.templateId}</span>
          <span class="mono dim">${m.cronExpression}</span>
          <span class="mono ts dim">${m.lastChange ? m.lastChange.summary + ' @ ' + m.lastChange.at : 'no changes yet'}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">
          <button class="btn" onclick="unsubscribeMonitor('${m.id}', this)">Unsubscribe</button>
        </div>
      </div>`
        )
        .join('\n')
    : `<div class="empty">No monitors active. Subscribe one below.</div>`;

  return `
    <section>
      <h2>Monitors</h2>
      <div class="panel">${rows}</div>
      <form class="job-form" id="monitor-form" style="margin-top:0.75rem">
        <input type="text" name="templateId" placeholder="templateId" required />
        <input type="text" name="cronExpression" placeholder="* * * * * (min hr dom mon dow)" required />
        <input type="text" name="notifyEndpointUrl" placeholder="https://your-webhook.example.com" required />
        <button type="submit" class="btn">Subscribe</button>
      </form>
      <div class="form-status" id="monitor-form-status"></div>
    </section>
    <script>
      window.init_monitors = function () {
        document.getElementById('monitor-form').addEventListener('submit', async function (e) {
          e.preventDefault();
          const form = e.target;
          const status = document.getElementById('monitor-form-status');
          status.textContent = 'Subscribing...';
          try {
            const res = await fetch('/api/monitors', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                templateId: form.templateId.value.trim(),
                cronExpression: form.cronExpression.value.trim(),
                notifyEndpointUrl: form.notifyEndpointUrl.value.trim(),
              }),
            });
            const data = await res.json();
            if (!res.ok) { status.textContent = 'Error: ' + (data.error || 'could not subscribe'); return; }
            status.textContent = 'Subscribed ' + data.id;
            selectSection('monitors');
          } catch (err) { status.textContent = 'Request failed: ' + err.message; }
        });
      };
      window.unsubscribeMonitor = async function (id, btn) {
        btn.disabled = true;
        try { await fetch('/api/monitors/' + encodeURIComponent(id), { method: 'DELETE' }); selectSection('monitors'); }
        finally { btn.disabled = false; }
      };
    </script>`;
}

export const monitorsSection: DashboardSection = {
  id: 'monitors',
  label: 'Monitors',
  registerRoutes(app, deps: DashboardDeps) {
    app.get('/api/section/monitors', (_req, res) => {
      res.type('html').send(renderMonitorsPanel(deps.scheduler.listMonitors()));
    });
    app.post('/api/monitors', async (req, res) => {
      try {
        const body = req.body ?? {};
        const sub = await deps.scheduler.subscribeMonitor({
          templateId: String(body.templateId ?? ''),
          cronExpression: String(body.cronExpression ?? ''),
          notifyEndpointUrl: String(body.notifyEndpointUrl ?? ''),
        });
        res.json(sub);
      } catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.delete('/api/monitors/:id', async (req, res) => {
      const ok = await deps.scheduler.cancelMonitor(req.params.id);
      res.json({ ok });
    });
  },
  async getTileSummary(deps: DashboardDeps): Promise<TileSummary> {
    const monitors = deps.scheduler.listMonitors();
    const active = monitors.filter((m) => m.active).length;
    return { id: 'monitors', label: 'Monitors', glance: `${active} active`, dotState: computeMonitorsDotState(monitors) };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/monitors.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect a TypeScript error if `DashboardDeps.scheduler`'s type doesn't expose `subscribeMonitor`/`cancelMonitor`/`listMonitors` — check `src/scheduler.ts`'s `Scheduler` class exports these as public methods (they do, per the codebase read during planning); `DashboardDeps.scheduler: Scheduler` already gives full access. If build fails on this, it means `Scheduler`'s type changed since this plan was written — read `src/scheduler.ts` to confirm the real method names before fixing.

```bash
git add src/dashboard-sections/monitors.ts src/dashboard-sections/monitors.test.ts
git commit -m "feat(dashboard): monitors section"
```

---

### Task 4: Self-Heal Queue section

**Files:**
- Create: `src/dashboard-sections/self-heal.ts`
- Test: `src/dashboard-sections/self-heal.test.ts`

**Interfaces:**
- Consumes: `listPendingHeals(deps: HealCoreDeps = {}): Promise<HealTicket[]>` from `../self-heal.js`. `HealCoreDeps` is optional/defaults to `{}` in the real signature — call it with no args from the route handler (matches how the MCP tool itself calls it: `listPendingHeals(healCoreDeps)` in `index.ts`, but a bare call `listPendingHeals()` also works per the default parameter).
- Produces: `export const selfHealSection: DashboardSection`.
- Alert condition: `dotState: 'alert'` (uses `--err`) if any ticket is pending, else `'idle'`.

- [ ] **Step 1: Write the panel test**

```typescript
// src/dashboard-sections/self-heal.test.ts
import { describe, it, expect } from 'vitest';
import { renderSelfHealPanel, computeSelfHealDotState } from './self-heal.js';
import type { HealTicket } from '../types.js';

const ticket: HealTicket = {
  id: 'amazon-price-2026-01-01T00-00-00Z', templateId: 'amazon-price', status: 'pending',
  forensics: {
    templateId: 'amazon-price', capturedAt: '2026-01-01T00:00:00Z', targetUrl: 'https://amazon.com/x',
    domSnapshotPath: '/logs/x-dom.html', screenshotPath: '/logs/x-screenshot.png', consoleErrors: [],
    oldScript: 'old', driftDiff: { templateId: 'amazon-price', timestamp: '2026-01-01T00:00:00Z', hasDrift: true, entries: [] },
  },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('renderSelfHealPanel', () => {
  it('shows an empty state with no tickets', () => {
    expect(renderSelfHealPanel([])).toContain('No pending heal tickets');
  });
  it('lists a ticket with its status and forensics links', () => {
    const html = renderSelfHealPanel([ticket]);
    expect(html).toContain('amazon-price');
    expect(html).toContain('pending');
    expect(html).toContain('/logs/x-screenshot.png');
  });
});

describe('computeSelfHealDotState', () => {
  it('is idle with no tickets', () => { expect(computeSelfHealDotState([])).toBe('idle'); });
  it('is alert with a pending ticket', () => { expect(computeSelfHealDotState([ticket])).toBe('alert'); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/self-heal.test.ts`
Expected: FAIL — `Cannot find module './self-heal.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/self-heal.ts
import { listPendingHeals } from '../self-heal.js';
import type { HealTicket } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';

export function computeSelfHealDotState(tickets: HealTicket[]): TileSummary['dotState'] {
  return tickets.some((t) => t.status === 'pending') ? 'alert' : 'idle';
}

export function renderSelfHealPanel(tickets: HealTicket[]): string {
  const rows = tickets.length
    ? tickets
        .map(
          (t) => `
      <div class="row" data-ticket-id="${t.id}">
        <div class="row-main">
          <span class="mono id">${t.templateId}</span>
          <span class="mono domain">${t.status}</span>
          <span class="mono ts dim">${t.createdAt}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">
          <a class="btn docs-btn" href="${t.forensics.screenshotPath}" target="_blank">Screenshot</a>
          <a class="btn docs-btn" href="${t.forensics.domSnapshotPath}" target="_blank">DOM</a>
        </div>
      </div>`
        )
        .join('\n')
    : `<div class="empty">No pending heal tickets — nothing has drifted.</div>`;
  return `<section><h2>Self-Heal Queue</h2><div class="panel">${rows}</div></section>`;
}

export const selfHealSection: DashboardSection = {
  id: 'self-heal',
  label: 'Self-Heal',
  registerRoutes(app) {
    app.get('/api/section/self-heal', async (_req, res) => {
      res.type('html').send(renderSelfHealPanel(await listPendingHeals()));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const tickets = await listPendingHeals();
    const pending = tickets.filter((t) => t.status === 'pending').length;
    return { id: 'self-heal', label: 'Self-Heal', glance: `${pending} pending`, dotState: computeSelfHealDotState(tickets) };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/self-heal.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect clean.

```bash
git add src/dashboard-sections/self-heal.ts src/dashboard-sections/self-heal.test.ts
git commit -m "feat(dashboard): self-heal queue section"
```

---

### Task 5: Vault section

**Files:**
- Create: `src/dashboard-sections/vault.ts`
- Test: `src/dashboard-sections/vault.test.ts`

**Interfaces:**
- Consumes: `listVaultSecrets(): Promise<Array<Pick<VaultEntry, 'id' | 'label' | 'createdAt' | 'updatedAt'>>>`, `setVaultSecret(id: string, value: string | Record<string,string>, label?: string): Promise<{id: string}>`, `deleteVaultSecret(id: string): Promise<{id: string; deleted: boolean}>` from `../vault.js`.
- Produces: `export const vaultSection: DashboardSection`.
- **Security constraint (from spec):** the panel must never render a value input as anything but `type="password"`-equivalent handling client-side, and the route must only ever pass through what `listVaultSecrets()` already returns (id/label/createdAt/updatedAt) — never touch `VaultStore`/`VaultEntry`'s `ciphertext`/`iv`/`authTag` fields directly.

- [ ] **Step 1: Write the panel test**

```typescript
// src/dashboard-sections/vault.test.ts
import { describe, it, expect } from 'vitest';
import { renderVaultPanel } from './vault.js';

describe('renderVaultPanel', () => {
  it('shows an empty state with no secrets', () => {
    expect(renderVaultPanel([])).toContain('No secrets stored');
  });
  it('lists a secret by id and label, never a value field', () => {
    const html = renderVaultPanel([{ id: 'amazon-login', label: 'Amazon creds', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]);
    expect(html).toContain('amazon-login');
    expect(html).toContain('Amazon creds');
    expect(html).not.toContain('ciphertext');
    expect(html).not.toContain('authTag');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/vault.test.ts`
Expected: FAIL — `Cannot find module './vault.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/vault.ts
import { listVaultSecrets, setVaultSecret, deleteVaultSecret } from '../vault.js';
import type { VaultEntry } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';

type VaultListItem = Pick<VaultEntry, 'id' | 'label' | 'createdAt' | 'updatedAt'>;

export function renderVaultPanel(secrets: VaultListItem[]): string {
  const rows = secrets.length
    ? secrets
        .map(
          (s) => `
      <div class="row" data-secret-id="${s.id}">
        <div class="row-main">
          <span class="mono id">${s.id}</span>
          <span class="mono domain">${s.label ?? ''}</span>
          <span class="mono ts dim">${s.updatedAt}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">
          <button class="btn" onclick="deleteVaultSecretFromPanel('${s.id}', this)">Delete</button>
        </div>
      </div>`
        )
        .join('\n')
    : `<div class="empty">No secrets stored.</div>`;
  return `
    <section>
      <h2>Vault</h2>
      <div class="panel">${rows}</div>
      <form class="job-form" id="vault-form" style="margin-top:0.75rem">
        <input type="text" name="id" placeholder="secret id" required />
        <input type="text" name="label" placeholder="label (optional)" />
        <input type="password" name="value" placeholder="value (or JSON for multi-field)" required />
        <button type="submit" class="btn">Store</button>
      </form>
      <div class="form-status" id="vault-form-status"></div>
    </section>
    <script>
      window.init_vault = function () {
        document.getElementById('vault-form').addEventListener('submit', async function (e) {
          e.preventDefault();
          const form = e.target;
          const status = document.getElementById('vault-form-status');
          status.textContent = 'Storing...';
          try {
            const res = await fetch('/api/vault', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: form.id.value.trim(), label: form.label.value.trim() || undefined, value: form.value.value }),
            });
            const data = await res.json();
            if (!res.ok) { status.textContent = 'Error: ' + (data.error || 'could not store'); return; }
            status.textContent = 'Stored ' + data.id;
            selectSection('vault');
          } catch (err) { status.textContent = 'Request failed: ' + err.message; }
        });
      };
      window.deleteVaultSecretFromPanel = async function (id, btn) {
        btn.disabled = true;
        try { await fetch('/api/vault/' + encodeURIComponent(id), { method: 'DELETE' }); selectSection('vault'); }
        finally { btn.disabled = false; }
      };
    </script>`;
}

export const vaultSection: DashboardSection = {
  id: 'vault',
  label: 'Vault',
  registerRoutes(app) {
    app.get('/api/section/vault', async (_req, res) => {
      res.type('html').send(renderVaultPanel(await listVaultSecrets()));
    });
    app.post('/api/vault', async (req, res) => {
      try {
        const body = req.body ?? {};
        const result = await setVaultSecret(String(body.id ?? ''), body.value, body.label ? String(body.label) : undefined);
        res.json(result);
      } catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.delete('/api/vault/:id', async (req, res) => {
      res.json(await deleteVaultSecret(req.params.id));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const count = (await listVaultSecrets()).length;
    return { id: 'vault', label: 'Vault', glance: `${count} secrets`, dotState: 'idle' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/vault.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect clean.

```bash
git add src/dashboard-sections/vault.ts src/dashboard-sections/vault.test.ts
git commit -m "feat(dashboard): vault section"
```

---

### Task 6: Policy section

**Files:**
- Create: `src/dashboard-sections/policy.ts`
- Test: `src/dashboard-sections/policy.test.ts`

**Interfaces:**
- Consumes: `getPolicyConfig(): PolicyConfig` from `../policy.js`, where `PolicyConfig = { respectRobotsTxt: boolean; minIntervalMsPerTemplate: number; userAgent: string; robotsCacheTtlMs: number; tosRestrictedDomains: string[] }`.
- Produces: `export const policySection: DashboardSection`. Read-only panel — no form, this is an info display of server config, not something the dashboard mutates.

- [ ] **Step 1: Write the panel test**

```typescript
// src/dashboard-sections/policy.test.ts
import { describe, it, expect } from 'vitest';
import { renderPolicyPanel } from './policy.js';

describe('renderPolicyPanel', () => {
  it('shows rate limit, robots, and restricted domains', () => {
    const html = renderPolicyPanel({
      respectRobotsTxt: true, minIntervalMsPerTemplate: 3000,
      userAgent: 'APImeMCP-bot/1.0', robotsCacheTtlMs: 3600000,
      tosRestrictedDomains: ['blocked.example.com'],
    });
    expect(html).toContain('3000');
    expect(html).toContain('robots.txt: respected');
    expect(html).toContain('blocked.example.com');
  });
  it('shows "none" when no domains are restricted', () => {
    const html = renderPolicyPanel({
      respectRobotsTxt: false, minIntervalMsPerTemplate: 0,
      userAgent: 'x', robotsCacheTtlMs: 0, tosRestrictedDomains: [],
    });
    expect(html).toContain('robots.txt: ignored');
    expect(html).toContain('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/policy.test.ts`
Expected: FAIL — `Cannot find module './policy.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/policy.ts
import { getPolicyConfig } from '../policy.js';
import type { PolicyConfig } from '../policy.js';
import type { DashboardSection, TileSummary } from './types.js';

export function renderPolicyPanel(cfg: PolicyConfig): string {
  return `
    <section>
      <h2>Policy</h2>
      <div class="printout">
        <div><div class="stat-label">Rate limit</div><div class="stat-value">${cfg.minIntervalMsPerTemplate} ms / template</div></div>
        <div><div class="stat-label">Robots.txt</div><div class="stat-value">${cfg.respectRobotsTxt ? 'robots.txt: respected' : 'robots.txt: ignored'}</div></div>
        <div><div class="stat-label">User-Agent</div><div class="stat-value" style="font-size:0.9rem">${cfg.userAgent}</div></div>
        <div class="domains"><div class="stat-label">ToS-restricted domains</div>${cfg.tosRestrictedDomains.length ? cfg.tosRestrictedDomains.join(', ') : 'none'}</div>
      </div>
    </section>`;
}

export const policySection: DashboardSection = {
  id: 'policy',
  label: 'Policy',
  registerRoutes(app) {
    app.get('/api/section/policy', (_req, res) => {
      res.type('html').send(renderPolicyPanel(getPolicyConfig()));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const cfg = getPolicyConfig();
    const n = cfg.tosRestrictedDomains.length;
    return { id: 'policy', label: 'Policy', glance: n ? `${n} domains restricted` : 'no restrictions', dotState: 'idle' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/policy.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect clean.

```bash
git add src/dashboard-sections/policy.ts src/dashboard-sections/policy.test.ts
git commit -m "feat(dashboard): policy section"
```

---

### Task 7: Observability (OTel) section

**Files:**
- Create: `src/dashboard-sections/observability.ts`
- Test: `src/dashboard-sections/observability.test.ts`

**Interfaces:**
- Consumes: `getOtelStatus(): OtelAdapterStatus` from `../otel-adapter.js`, where `OtelAdapterStatus = { enabled: boolean; exporter: 'otlp-http' | 'none'; serviceName: string; recordsExported: number; lastExportAt?: number; lastError?: string }`.
- Produces: `export const observabilitySection: DashboardSection`.

- [ ] **Step 1: Write the panel test**

```typescript
// src/dashboard-sections/observability.test.ts
import { describe, it, expect } from 'vitest';
import { renderObservabilityPanel } from './observability.js';

describe('renderObservabilityPanel', () => {
  it('shows disabled state clearly', () => {
    const html = renderObservabilityPanel({ enabled: false, exporter: 'none', serviceName: 'apimemcp', recordsExported: 0 });
    expect(html).toContain('disabled');
  });
  it('shows export count and last export time when enabled', () => {
    const html = renderObservabilityPanel({
      enabled: true, exporter: 'otlp-http', serviceName: 'apimemcp',
      recordsExported: 42, lastExportAt: 1700000000000,
    });
    expect(html).toContain('42');
    expect(html).toContain('otlp-http');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/observability.test.ts`
Expected: FAIL — `Cannot find module './observability.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/observability.ts
import { getOtelStatus } from '../otel-adapter.js';
import type { OtelAdapterStatus } from '../otel-adapter.js';
import type { DashboardSection, TileSummary } from './types.js';

export function renderObservabilityPanel(status: OtelAdapterStatus): string {
  if (!status.enabled) {
    return `
      <section>
        <h2>Observability</h2>
        <div class="printout"><div><div class="stat-label">OTel export</div><div class="stat-value">disabled</div></div></div>
      </section>`;
  }
  return `
    <section>
      <h2>Observability</h2>
      <div class="printout">
        <div><div class="stat-label">Exporter</div><div class="stat-value">${status.exporter}</div></div>
        <div><div class="stat-label">Records exported</div><div class="stat-value">${status.recordsExported}</div></div>
        <div><div class="stat-label">Last export</div><div class="stat-value" style="font-size:0.9rem">${status.lastExportAt ? new Date(status.lastExportAt).toLocaleString() : 'never'}</div></div>
        ${status.lastError ? `<div class="domains"><div class="stat-label">Last error</div>${status.lastError}</div>` : ''}
      </div>
    </section>`;
}

export const observabilitySection: DashboardSection = {
  id: 'observability',
  label: 'Observability',
  registerRoutes(app) {
    app.get('/api/section/observability', (_req, res) => {
      res.type('html').send(renderObservabilityPanel(getOtelStatus()));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const status = getOtelStatus();
    return { id: 'observability', label: 'Observability', glance: status.enabled ? 'on' : 'off', dotState: status.enabled ? 'ok' : 'idle' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/observability.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect clean.

```bash
git add src/dashboard-sections/observability.ts src/dashboard-sections/observability.test.ts
git commit -m "feat(dashboard): observability section"
```

---

### Task 8: Discover section

**Files:**
- Create: `src/dashboard-sections/discover.ts`
- Test: `src/dashboard-sections/discover.test.ts`

**Interfaces:**
- Consumes: `searchTemplates(query: DiscoveryQuery, deps: DiscoveryDeps): Promise<DiscoveryResult>` from `../discovery.js`, where `DiscoveryQuery = { domain: string; limit?: number; source?: 'local'|'registry'|'both' }` and `DiscoveryDeps = { listLocalTemplates: () => Promise<DiscoveryCandidate[]>; listRegistryTemplates: () => Promise<DiscoveryCandidate[]> }` (the exact same deps shape already assembled as `deps.discovery` inside `ToolDeps` in `src/index.ts` — this section's route needs that object passed through).
- Produces: `export const discoverSection: DashboardSection`. This section has no glance-worthy count (per spec, it's a search tool) — its tile summary just shows a static label.

- [ ] **Step 1: Write the panel test**

```typescript
// src/dashboard-sections/discover.test.ts
import { describe, it, expect } from 'vitest';
import { renderDiscoverPanel, renderDiscoverResults } from './discover.js';
import type { DiscoveryHit } from '../discovery.js';

describe('renderDiscoverPanel', () => {
  it('renders a search box with no results yet', () => {
    const html = renderDiscoverPanel();
    expect(html).toContain('discover-query');
  });
});

describe('renderDiscoverResults', () => {
  it('shows an empty state with no hits', () => {
    expect(renderDiscoverResults([])).toContain('No matches');
  });
  it('lists a hit with its score and source', () => {
    const hit: DiscoveryHit = { templateId: 'amazon-price', name: 'amazon-price', source: 'local', score: 3, matchedOn: ['name'] };
    const html = renderDiscoverResults([hit]);
    expect(html).toContain('amazon-price');
    expect(html).toContain('local');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard-sections/discover.test.ts`
Expected: FAIL — `Cannot find module './discover.js'`

- [ ] **Step 3: Implement the section**

```typescript
// src/dashboard-sections/discover.ts
import { searchTemplates } from '../discovery.js';
import type { DiscoveryHit, DiscoveryDeps } from '../discovery.js';
import type { DashboardSection, TileSummary } from './types.js';

export function renderDiscoverResults(hits: DiscoveryHit[]): string {
  if (hits.length === 0) return `<div class="empty">No matches.</div>`;
  return hits
    .map(
      (h) => `
    <div class="row">
      <div class="row-main">
        <span class="mono id">${h.templateId}</span>
        <span class="mono domain">${h.source}</span>
        <span class="mono ts dim">score ${h.score}</span>
      </div>
    </div>`
    )
    .join('\n');
}

export function renderDiscoverPanel(): string {
  return `
    <section>
      <h2>Discover</h2>
      <div class="panel" style="padding:0.85rem 1rem">
        <input type="text" class="url-input mono" id="discover-query" placeholder="domain, e.g. amazon.com" />
        <button class="btn" style="margin-top:0.5rem" onclick="runDiscoverSearch()">Search</button>
      </div>
      <div class="panel" id="discover-results" style="margin-top:0.6rem"></div>
    </section>
    <script>
      window.init_discover = function () {};
      window.runDiscoverSearch = async function () {
        const domain = document.getElementById('discover-query').value.trim();
        const results = document.getElementById('discover-results');
        if (!domain) { results.innerHTML = '<div class="empty">Enter a domain first.</div>'; return; }
        results.innerHTML = '<div class="empty">Searching…</div>';
        try {
          const res = await fetch('/api/discover?domain=' + encodeURIComponent(domain));
          results.innerHTML = await res.text();
        } catch (err) {
          results.innerHTML = '<div class="empty">Search failed: ' + err.message + '</div>';
        }
      };
    </script>`;
}

export const discoverSection: DashboardSection = {
  id: 'discover',
  label: 'Discover',
  registerRoutes(app, deps) {
    const discoveryDeps = (deps as unknown as { discovery: DiscoveryDeps }).discovery;
    app.get('/api/section/discover', (_req, res) => {
      res.type('html').send(renderDiscoverPanel());
    });
    app.get('/api/discover', async (req, res) => {
      const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
      if (!domain) {
        res.type('html').send(renderDiscoverResults([]));
        return;
      }
      const result = await searchTemplates({ domain, source: 'both' }, discoveryDeps);
      res.type('html').send(renderDiscoverResults(result.hits));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    return { id: 'discover', label: 'Discover', glance: 'search', dotState: 'idle' };
  },
};
```

**Note:** like Task 2 (Pipelines), this section needs a dependency (`discovery: DiscoveryDeps`) that isn't on the current `DashboardDeps` interface. The `(deps as unknown as { discovery: DiscoveryDeps }).discovery` cast is intentional and temporary — Task 10 (Integration) is responsible for actually extending `DashboardDeps` and removing this cast in favor of a properly-typed field.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard-sections/discover.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Build and commit**

Run: `npm run build` — expect clean.

```bash
git add src/dashboard-sections/discover.ts src/dashboard-sections/discover.test.ts
git commit -m "feat(dashboard): discover section"
```

---

### Task 9: Enhance existing sections — Templates badges + Stats snapshot column

**Files:**
- Modify: `src/dashboard.ts` (the `templateRowHtml` JS-string function and its server-side twin in `renderDashboard`'s `templateRows`, plus the `#stats` table header/`pollStats` rendering)

**Interfaces:**
- Consumes: `ManifestEntry.kind` (now `'extraction' | 'action-sequence' | 'static-http'`), `ManifestEntry.templateKind` (`'read' | 'write'`, from `../types.js`), `loadSnapshot(templateId: string): Promise<GoldenSnapshot | null>` from `../snapshot.js`.
- This task touches the **same file** as Task 1 (Shell) and Task 10 (Integration) but not the same regions — Task 1 must fully land first (this task starts after Task 1 is committed), and this task's edits must land before Task 10 runs (Task 10 depends on the final `dashboard.ts` shape). It runs in parallel with Tasks 2-8 (Pipelines/Monitors/Self-Heal/Vault/Policy/Observability/Discover), which touch none of `dashboard.ts`.

- [ ] **Step 1: Update the template kind badge** (both `renderDashboard`'s template literal and the client-side `templateRowHtml` JS function need the identical change — search for `action-sequence` template kind check in both places)

Replace:
```javascript
${entry.kind === 'action-sequence' ? '<span class="mono kind-badge" title="Action-sequence template">&#9881; action-sequence</span>' : ''}
```
with:
```javascript
${entry.kind === 'action-sequence' ? '<span class="mono kind-badge" title="Action-sequence template">&#9881; action-sequence</span>' : ''}
${entry.kind === 'static-http' ? '<span class="mono kind-badge" title="Static HTTP template (no browser)">&#9889; static-http</span>' : ''}
${entry.templateKind === 'write' ? '<span class="mono kind-badge" style="color:var(--err)" title="Write template (fills/submits a real form)">&#9997; write</span>' : ''}
```
(and the matching string-concatenation version in the client-side `templateRowHtml` function).

- [ ] **Step 2: Add golden-snapshot status to the stats table**

In `src/dashboard.ts`, import at the top: `import { loadSnapshot } from './snapshot.js';`

Add a new `<th>snapshot</th>` column to the `table.crontab` header inside the stats section HTML, and extend `pollStats()`'s row-building JS to include a `<td>` reading from a new field the `/api/stats` response will carry. Extend the existing `/api/stats` route handler:

```typescript
  app.get('/api/stats', async (_req, res) => {
    const templates = await getAllSla();
    const withSnapshot = await Promise.all(
      templates.map(async (t) => ({ ...t, hasSnapshot: (await loadSnapshot(t.templateId)) !== null }))
    );
    res.json({ templates: withSnapshot });
  });
```

Update the client `pollStats()` row template to add `'<td>' + (sla.hasSnapshot ? 'recorded' : 'none') + '</td>'` before the closing `</tr>`, and add `<th>snapshot</th>` to the table header, matching column count.

- [ ] **Step 3: Build and manually verify**

Run: `npm run build`
Expected: clean

Run: `npm start` in one terminal, then in another: `curl -s http://127.0.0.1:3000/api/stats | head -c 300` — confirm the response includes a `hasSnapshot` field per template (or an empty `templates: []` if none are registered yet, which is fine — the field just needs to be present in the shape, not necessarily populated in this smoke test).

- [ ] **Step 4: Commit**

```bash
git add src/dashboard.ts
git commit -m "feat(dashboard): template kind badges + golden-snapshot stats column"
```

---

### Task 10: Integration — wire all sections into the shell

**Files:**
- Modify: `src/dashboard.ts` (populate the `sections` map from Task 1's Step 7, extend `DashboardDeps`, remove the temporary casts from Tasks 2 and 8)
- Modify: `src/index.ts` (pass the additional dependencies `startDashboard()` now needs)

**Interfaces:**
- Consumes: `pipelinesSection` from `./dashboard-sections/pipelines.js`, `monitorsSection` from `./dashboard-sections/monitors.js`, `selfHealSection` from `./dashboard-sections/self-heal.js`, `vaultSection` from `./dashboard-sections/vault.js`, `policySection` from `./dashboard-sections/policy.js`, `observabilitySection` from `./dashboard-sections/observability.js`, `discoverSection` from `./dashboard-sections/discover.js`.
- This task must run **after** Tasks 1-9 are all committed (it imports files every one of them creates, and edits the `dashboard.ts` region Task 9 also touched — sequenced last precisely to avoid conflicting with Task 9's parallel edit).

- [ ] **Step 1: Extend `DashboardDeps` in `src/dashboard.ts`**

```typescript
export interface DashboardDeps {
  runExtraction: (/* ...unchanged existing signature... */) => Promise<ExtractionResult>;
  scheduler: Scheduler;
  isBrowserReady: () => boolean;
  log: (message: string) => void;
  logError: (message: string) => void;
  // Added for the dashboard redesign — same objects already assembled in index.ts
  // for the MCP tool registrations (pipelineDeps, deps.discovery); reused, not duplicated.
  pipelineDeps: import('./pipeline.js').PipelineDeps;
  discovery: import('./discovery.js').DiscoveryDeps;
}
```

- [ ] **Step 2: Register the sections and remove temporary casts**

In `startDashboard()`, replace the empty `const sections: Record<string, DashboardSection> = {};` from Task 1 with:

```typescript
  const sections: Record<string, DashboardSection> = Object.fromEntries(
    [pipelinesSection, monitorsSection, selfHealSection, vaultSection, policySection, observabilitySection, discoverSection]
      .map((s) => [s.id, s])
  );
  for (const section of Object.values(sections)) {
    section.registerRoutes(app, deps);
  }
```

Add the imports at the top of `src/dashboard.ts`:

```typescript
import { pipelinesSection } from './dashboard-sections/pipelines.js';
import { monitorsSection } from './dashboard-sections/monitors.js';
import { selfHealSection } from './dashboard-sections/self-heal.js';
import { vaultSection } from './dashboard-sections/vault.js';
import { policySection } from './dashboard-sections/policy.js';
import { observabilitySection } from './dashboard-sections/observability.js';
import { discoverSection } from './dashboard-sections/discover.js';
```

In `src/dashboard-sections/pipelines.ts`, replace the `deps: DashboardDeps & { listPipelineDefs?: typeof listPipelineDefs }` parameter type on `registerRoutes` with plain `DashboardDeps`, and replace `runPipeline(req.params.pipelineId, req.body ?? {}, deps as any)` with `runPipeline(req.params.pipelineId, req.body ?? {}, deps.pipelineDeps)`.

In `src/dashboard-sections/discover.ts`, replace `const discoveryDeps = (deps as unknown as { discovery: DiscoveryDeps }).discovery;` with `const discoveryDeps = deps.discovery;`.

- [ ] **Step 3: Also register the Templates and Extraction Stats panels as sections** (they predate the `DashboardSection` pattern — Task 9 only added content to them, this step makes them addressable via `/api/section/templates` and `/api/section/stats` like every other tile)

In `startDashboard()`, add two inline route registrations (these don't need their own file — they're thin wrappers around the existing `renderDashboard`/stats-table logic already in `dashboard.ts`):

```typescript
  app.get('/api/section/templates', async (_req, res) => {
    const manifest = await loadManifest();
    res.type('html').send(renderTemplatesSection(Object.values(manifest), await templatesWithSavedCookies()));
  });
  app.get('/api/section/stats', (_req, res) => {
    res.type('html').send(renderStatsSection());
  });
  app.get('/api/section/jobs', (_req, res) => {
    res.type('html').send(renderJobsSection());
  });
  app.get('/api/section/forensics', (_req, res) => {
    res.type('html').send(renderForensicsSection());
  });
```

Extract `renderTemplatesSection`, `renderStatsSection`, `renderJobsSection`, `renderForensicsSection` as small top-level functions in `dashboard.ts` returning the section markup Task 1's Step 5 removed from the initial page render. **That exact markup is not lost — it's in git history.** Before writing these functions, run `git log --oneline -- src/dashboard.ts` to find the commit from Task 1 (message: `"feat(dashboard): shell for tile-grid + drill-down redesign"`), then `git show <that-commit>^:src/dashboard.ts` to view the file exactly as it was the moment before Task 1 removed the sections — copy the `<section><h2>Templates</h2>...</section>`, `<section><h2>Extraction stats</h2>...</section>`, `<section><h2>Scheduled jobs</h2>...</section>`, and `<section><h2>Forensic captures</h2>...</section>` blocks from there verbatim into the four new functions (each function takes whatever data it needs as a parameter — e.g. `renderTemplatesSection(templates: ManifestEntry[], cookieSet: Set<string>): string` — and returns exactly that block's HTML string, unchanged from what Task 1 removed, now that it's Task 9's turn to have already added the kind badges and snapshot column on top of it).

Add all four to the tile grid's data source: extend `getTileSummary` equivalents inline for these four built-in sections in the `/api/dashboard-summary` handler (they don't have a `DashboardSection` object like the 7 new ones — just compute their four `TileSummary` objects directly in the route handler using the same data each already fetches: manifest length for Templates, `getAllSla()` aggregate for Stats, `deps.scheduler.list().length` for Jobs, `listForensicLogs().length` for Forensics).

- [ ] **Step 4: Update `src/index.ts`'s `startDashboard()` call**

```typescript
startDashboard({ runExtraction, scheduler, isBrowserReady, log, logError, pipelineDeps, discovery: deps.discovery });
```

(`pipelineDeps` already exists as a local const in `index.ts` per tonight's F09 work; `deps.discovery` already exists on the `ToolDeps` object — both are being reused, not created new.)

- [ ] **Step 5: Full build and test run**

Run: `npm run build`
Expected: clean, no TypeScript errors anywhere (this is the step that proves every parallel task's temporary cast/placeholder was correctly resolved)

Run: `npm test`
Expected: all tests pass, including every `src/dashboard-sections/*.test.ts` file from Tasks 1-8

- [ ] **Step 6: Live smoke test**

Run: `npm start` in the background, then:
```bash
curl -s http://127.0.0.1:3000/api/dashboard-summary
```
Expected: a JSON array with 11 entries (templates, pipelines, monitors, self-heal, vault, policy, observability, discover, stats, jobs, forensics), each with `id`, `label`, `glance`, `dotState`.

```bash
curl -s http://127.0.0.1:3000/api/section/monitors
```
Expected: HTML containing `<h2>Monitors</h2>`.

Open `http://127.0.0.1:3000` in a browser (or describe to the user how to) and click through every tile to confirm the detail area swaps correctly and no tile throws a JS console error.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard.ts src/index.ts src/dashboard-sections/pipelines.ts src/dashboard-sections/discover.ts
git commit -m "feat(dashboard): integrate all sections into tile-grid shell"
```
