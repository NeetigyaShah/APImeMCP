# Forensic Observability, Dashboard, CLI Runner & Living-Room Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add screenshot+DOM forensic capture on extraction failure, a localhost-only Express dashboard for browsing/triggering templates, a standalone CLI runner for cron use, and a new `bernhardt-living-room` extraction template.

**Architecture:** `engine.ts` gains a try/catch around the goto+evaluate sequence that dumps a screenshot and DOM snapshot to `output/logs/` on failure. `index.ts` starts an Express app bound to `127.0.0.1:3000` inside `main()`, reusing the existing `runExtraction()` helper so dashboard-triggered runs get the same metric logging and progress reporting as every other trigger path. A new `scripts/run.mjs` spawns the compiled server and calls `execute_native_extraction` via the MCP client SDK, exactly like the existing `scripts/verify-server.mjs` pattern. The new template is registered through the existing `register_extraction_template` tool — no new server capability — using the same click-pagination logic already proven in `bernhardt-bed-listing.js`.

**Tech Stack:** TypeScript strict mode, Playwright, Express, `@modelcontextprotocol/sdk` (unchanged), Vitest (unchanged — no new unit tests, per spec).

## Global Constraints

- Dashboard binds `127.0.0.1:3000` only — never `0.0.0.0`.
- If port 3000 is already in use, log a warning and continue; the MCP server itself must still start.
- `/api/run/:templateId` must call the shared `runExtraction()` helper in `index.ts`, not `engine.executeExtraction` directly (that function only accepts a resolved `scriptPath`, not a `templateId`).
- Forensic capture must never mask the real failure: if the screenshot/DOM-dump itself throws, fall back to throwing the original error unadorned.
- `bernhardt-living-room` and `bernhardt-bed-listing` both target `domainPattern: "bernhardt.com"` by design — per explicit decision, always invoke both by explicit `templateId`. Do not build path-aware domain matching; registering `bernhardt-living-room` will replace `bernhardt-bed-listing` as the domain's auto-match owner, and that's expected, not a bug.
- `output/` is already gitignored — confirm, don't re-add if already present.
- No new Vitest unit tests — Phases 2-4 are verified against a real browser/real HTTP server/the live target site, consistent with `engine.ts` having no unit tests today.

---

## Task 1: Forensic Capture on Extraction Failure

**Files:**
- Modify: `src/engine.ts`
- Test: `scripts/verify-forensics.mjs` (manual smoke test, not part of `npm test`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `executeExtraction` (unchanged signature: `(options: ExecuteExtractionOptions) => Promise<unknown>`) now throws an `Error` whose `.message` contains the substring `forensic artifacts:` followed by both paths when a failure occurs after the page context is open. No other file depends on this format — it's read by a human, not parsed by code — but Task 4's manual test relies on the substring being present.

- [ ] **Step 1: Modify `src/engine.ts` to add forensic capture**

Add `randomUUID` to the existing `node:crypto` usage (not currently imported in this file) and a `Page` type import, then wrap the goto+evaluate sequence:

```typescript
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Inject stealth plugin globally into the chromium instance
chromium.use(stealthPlugin());

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;

let browserInstance: Browser | undefined;

export async function initBrowser(): Promise<void> {
  if (browserInstance) return;
  browserInstance = await chromium.launch({ headless: true });
}

export async function closeBrowser(): Promise<void> {
  if (!browserInstance) return;
  const browser = browserInstance;
  browserInstance = undefined;
  await browser.close();
}

export function isBrowserReady(): boolean {
  return browserInstance !== undefined;
}

function getBrowser(): Browser {
  if (!browserInstance) {
    throw new Error('Browser not initialized. Call initBrowser() before executeExtraction().');
  }
  return browserInstance;
}

interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

function parseProxy(proxyUrl: string): ProxyConfig {
  const url = new URL(proxyUrl);
  const config: ProxyConfig = { server: `${url.protocol}//${url.host}` };
  if (url.username) config.username = decodeURIComponent(url.username);
  if (url.password) config.password = decodeURIComponent(url.password);
  return config;
}

function assertJsonSerializable(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('Extraction script must return a JSON-serializable value');
  }
}

interface ForensicPaths {
  screenshotPath: string;
  domPath: string;
}

async function captureForensics(page: Page): Promise<ForensicPaths> {
  const logsDir = path.join('output', 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const screenshotPath = path.join(logsDir, `${prefix}-screenshot.png`);
  const domPath = path.join(logsDir, `${prefix}-dom.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(domPath, await page.content());
  return { screenshotPath, domPath };
}

export interface ExecuteExtractionOptions {
  targetUrl: string;
  scriptPath: string;
  proxyUrl?: string;
}

export async function executeExtraction(options: ExecuteExtractionOptions): Promise<unknown> {
  const browser = getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
    ...(options.proxyUrl ? { proxy: parseProxy(options.proxyUrl) } : {}),
  });
  try {
    await context.addInitScript(() => {
      // @ts-expect-error - this callback runs in the browser context, where `navigator`
      // is a global; the project's tsconfig intentionally omits the DOM lib for the
      // Node.js runtime code, so TypeScript cannot see it here.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    try {
      await page.goto(options.targetUrl, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'networkidle' });
      const script = await fs.readFile(path.resolve(process.cwd(), options.scriptPath), 'utf8');
      const rawResult = await page.evaluate(script);
      return assertJsonSerializable(rawResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const { screenshotPath, domPath } = await captureForensics(page);
        throw new Error(`Extraction failed: ${message} (forensic artifacts: ${screenshotPath}, ${domPath})`);
      } catch (captureErr) {
        if (captureErr instanceof Error && captureErr.message.startsWith('Extraction failed:')) {
          throw captureErr;
        }
        // Forensic capture itself failed (e.g. page already closed) - don't mask the real error.
        throw err;
      }
    }
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no type errors, `dist/engine.js` updated.

- [ ] **Step 3: Write the forensic-capture smoke test**

Create `scripts/verify-forensics.mjs`:

```javascript
import http from 'node:http';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { initBrowser, closeBrowser, executeExtraction } from '../dist/engine.js';

const HTML = '<!doctype html><html><head><title>Forensics Test</title></head><body>ok</body></html>';
const THROWING_SCRIPT_PATH = 'scripts/_forensics-throwing-script.js';

await writeFile(THROWING_SCRIPT_PATH, "(() => { throw new Error('intentional test failure'); })()");

await rm('output/logs', { recursive: true, force: true });

const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

await initBrowser();
try {
  await executeExtraction({ targetUrl: `http://127.0.0.1:${port}/`, scriptPath: THROWING_SCRIPT_PATH });
  console.log('FAIL: expected executeExtraction to throw');
  process.exitCode = 1;
} catch (err) {
  const hasArtifactPaths = /forensic artifacts: (.+), (.+)\)$/.test(err.message);
  const files = await readdir('output/logs').catch(() => []);
  const hasScreenshot = files.some((f) => f.endsWith('-screenshot.png'));
  const hasDomDump = files.some((f) => f.endsWith('-dom.html'));
  console.log('Error message:', err.message);
  console.log('Message contains forensic artifact paths:', hasArtifactPaths);
  console.log('output/logs/ contains a screenshot:', hasScreenshot);
  console.log('output/logs/ contains a DOM dump:', hasDomDump);
  const ok = hasArtifactPaths && hasScreenshot && hasDomDump;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await closeBrowser();
  server.close();
  await rm(THROWING_SCRIPT_PATH, { force: true });
}
```

- [ ] **Step 4: Run the smoke test and confirm it passes**

Run: `node scripts/verify-forensics.mjs`
Expected output ends with:
```
Message contains forensic artifact paths: true
output/logs/ contains a screenshot: true
output/logs/ contains a DOM dump: true
PASS
```

- [ ] **Step 5: Confirm `output/` is gitignored (no action needed if already present)**

Run: `grep -F "output/" .gitignore`
Expected: prints `output/` — already added in an earlier session. If it's missing for any reason, add it before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts scripts/verify-forensics.mjs
git commit -m "feat: capture screenshot and DOM snapshot to output/logs/ on extraction failure"
```

---

## Task 2: Express Dashboard

**Files:**
- Modify: `package.json` (add `express` + `@types/express`)
- Modify: `src/index.ts`
- Test: `scripts/verify-dashboard.mjs` (manual smoke test, not part of `npm test`)

**Interfaces:**
- Consumes: `runExtraction(targetUrl, templateId?, proxyUrl?): Promise<ExtractionResult>` (already defined in `src/index.ts`), `loadManifest(): Promise<Manifest>` (from `storage.js`), `RegisterExtractionTemplateShape.templateId` (Zod schema, from `types.js`, reused for templateId validation), `isHttpUrl(value: string): boolean` (from `types.js`).
- Produces: an HTTP server on `127.0.0.1:3000` with `GET /` and `GET /api/run/:templateId?url=<targetUrl>`. Nothing else in this codebase depends on it.

- [ ] **Step 1: Install dependencies**

Run: `npm install express`
Run: `npm install --save-dev @types/express`
Expected: both complete without error, `package.json`/`package-lock.json` updated.

- [ ] **Step 2: Add the `isHttpUrl` import and `express` import to `src/index.ts`**

```typescript
import {
  RegisterExtractionTemplateShape,
  ExecuteNativeExtractionShape,
  BatchDownloadShape,
  ScheduleStockCheckShape,
  SendNotificationShape,
  isHttpUrl,
} from './types.js';
```

Add near the top of the file, after the existing `import { Scheduler } from './scheduler.js';` line:

```typescript
import { reportProgress } from './progress.js';
import express from 'express';
```

- [ ] **Step 3: Add the dashboard HTML renderer and route setup**

Insert this whole block into `src/index.ts` directly before `async function main(): Promise<void> {`:

```typescript
const DASHBOARD_PORT = 3000;

function renderDashboard(manifest: Manifest): string {
  const cards = Object.values(manifest)
    .map(
      (entry) => `
        <div class="card">
          <h2>${entry.templateId}</h2>
          <p class="domain">${entry.domainPattern}</p>
          <p class="updated">Updated: ${entry.updatedAt}</p>
          <input type="text" placeholder="https://example.com/page" class="url-input" />
          <button onclick="runTemplate('${entry.templateId}', this)">Run Now</button>
          <pre class="result"></pre>
        </div>`
    )
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>mcp-compiler-server dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  h1 { color: #38bdf8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card { background: #1e293b; border-radius: 8px; padding: 1rem; }
  .card h2 { margin: 0 0 0.25rem; font-size: 1.1rem; color: #f1f5f9; }
  .domain { color: #94a3b8; margin: 0 0 0.25rem; }
  .updated { color: #64748b; font-size: 0.8rem; margin: 0 0 0.75rem; }
  .url-input { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-bottom: 0.5rem; border-radius: 4px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
  button { background: #38bdf8; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-weight: 600; }
  button:hover { background: #0ea5e9; }
  button:disabled { opacity: 0.5; cursor: default; }
  .result { background: #0f172a; padding: 0.5rem; border-radius: 4px; max-height: 200px; overflow: auto; font-size: 0.75rem; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>mcp-compiler-server</h1>
<div class="grid">
${cards}
</div>
<script>
async function runTemplate(templateId, btn) {
  const card = btn.closest('.card');
  const input = card.querySelector('.url-input');
  const result = card.querySelector('.result');
  const url = input.value.trim();
  if (!url) { result.textContent = 'Enter a URL first'; return; }
  btn.disabled = true;
  result.textContent = 'Running...';
  try {
    const res = await fetch('/api/run/' + encodeURIComponent(templateId) + '?url=' + encodeURIComponent(url));
    const data = await res.json();
    result.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    result.textContent = 'Request failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}

function startDashboard(): void {
  const app = express();

  app.get('/', async (_req, res) => {
    const manifest = await loadManifest();
    res.type('html').send(renderDashboard(manifest));
  });

  app.get('/api/run/:templateId', async (req, res) => {
    const { templateId } = req.params;
    const targetUrl = typeof req.query.url === 'string' ? req.query.url : '';

    if (!RegisterExtractionTemplateShape.templateId.safeParse(templateId).success) {
      res.status(400).json({ success: false, error: 'invalid templateId' });
      return;
    }
    if (!isHttpUrl(targetUrl)) {
      res.status(400).json({ success: false, error: 'url query param must be an absolute http:// or https:// URL' });
      return;
    }

    const result = await runExtraction(targetUrl, templateId);
    res.json(result);
  });

  const httpServer = app.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    log(`Dashboard listening on http://127.0.0.1:${DASHBOARD_PORT}`);
  });
  httpServer.on('error', (err) => {
    logError(`Dashboard failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });
}
```

This also needs `Manifest` as a type import — add it to the existing `import type { ExtractionResult } from './types.js';` line:

```typescript
import type { ExtractionResult, Manifest } from './types.js';
```

- [ ] **Step 4: Call `startDashboard()` from `main()`**

```typescript
async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
  await scheduler.loadPersisted();
  startDashboard();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP compiler server running on stdio');
}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 6: Write the dashboard smoke test**

Create `scripts/verify-dashboard.mjs`:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const HTML = '<!doctype html><html><head><title>Dashboard Test</title></head><body><h1 id="target">1</h1></body></html>';
const EXTRACTION_SCRIPT = "(() => ({ value: document.getElementById('target').textContent }))()";

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-compiler-dashboard-'));

const fixtureServer = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(HTML);
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixturePort = fixtureServer.address().port;

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: tmpDir,
  stderr: 'inherit',
});
const client = new Client({ name: 'dashboard-test-client', version: '1.0.0' });

try {
  await client.connect(transport);

  await client.callTool({
    name: 'register_extraction_template',
    arguments: { templateId: 'dashboard-smoke', domainPattern: '127.0.0.1', executableScript: EXTRACTION_SCRIPT },
  });

  // give the dashboard a moment to bind after server startup
  await new Promise((resolve) => setTimeout(resolve, 500));

  const rootRes = await fetch('http://127.0.0.1:3000/');
  const rootHtml = await rootRes.text();
  const hasCard = rootHtml.includes('dashboard-smoke');
  console.log('GET / status:', rootRes.status, '| shows registered template card:', hasCard);

  const runRes = await fetch(
    `http://127.0.0.1:3000/api/run/dashboard-smoke?url=${encodeURIComponent(`http://127.0.0.1:${fixturePort}/`)}`
  );
  const runJson = await runRes.json();
  console.log('GET /api/run/... ->', JSON.stringify(runJson));

  const badRes = await fetch('http://127.0.0.1:3000/api/run/dashboard-smoke?url=ftp://example.com');
  console.log('GET /api/run/... with bad scheme -> status:', badRes.status);

  const ok =
    rootRes.status === 200 &&
    hasCard &&
    runJson.success === true &&
    runJson.data?.value === '1' &&
    badRes.status === 400;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  fixtureServer.close();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
```

- [ ] **Step 7: Run the dashboard smoke test and confirm it passes**

Run: `node scripts/verify-dashboard.mjs`
Expected output ends with:
```
GET / status: 200 | shows registered template card: true
GET /api/run/... -> {"success":true,"data":{"value":"1"},...}
GET /api/run/... with bad scheme -> status: 400
PASS
```

- [ ] **Step 8: Run the full unit test suite to confirm no regressions**

Run: `npm test`
Expected: all 20 existing tests still pass.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/index.ts scripts/verify-dashboard.mjs
git commit -m "feat: add localhost-only Express dashboard with Run Now trigger"
```

---

## Task 3: Standalone CLI Runner

**Files:**
- Create: `scripts/run.mjs`

**Interfaces:**
- Consumes: the `execute_native_extraction` MCP tool (unchanged, already exists).
- Produces: a CLI entry point `node scripts/run.mjs <templateId> <targetUrl>`. Nothing else depends on it.

- [ ] **Step 1: Write `scripts/run.mjs`**

```javascript
#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [, , templateId, targetUrl] = process.argv;

if (!templateId || !targetUrl) {
  console.error('Usage: node scripts/run.mjs <templateId> <targetUrl>');
  process.exit(1);
}

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], stderr: 'inherit' });
const client = new Client({ name: 'run-cli', version: '1.0.0' });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'execute_native_extraction',
    arguments: { targetUrl, templateId },
  });
  const payload = JSON.parse(result.content[0].text);
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.success ? 0 : 1;
} finally {
  await client.close();
}
```

- [ ] **Step 2: Test the usage-error path**

Run: `node scripts/run.mjs`
Expected: prints `Usage: node scripts/run.mjs <templateId> <targetUrl>` to stderr, exit code 1.

Run: `echo $?` (bash) — confirm it prints `1`.

- [ ] **Step 3: Test a real successful run**

Run: `node scripts/run.mjs bernhardt-bed-listing https://www.bernhardt.com/products/luxury-bedroom-furniture#?RoomType=Bedroom&$MultiView=Yes&orderBy=BedroomPosition&context=shop&page=1`
Expected: JSON printed with `"success": true` and a `data` array of bed products (this is the full paginated run — expect it to take a couple of minutes given ~9 pages).

Run: `echo $?` — confirm it prints `0`.

- [ ] **Step 4: Test the failure exit code**

Run: `node scripts/run.mjs nonexistent-template-id https://example.com/`
Expected: JSON printed with `"success": false` and an error about the templateId not being registered.

Run: `echo $?` — confirm it prints `1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/run.mjs
git commit -m "feat: add standalone CLI runner for cron-friendly template execution"
```

---

## Task 4: `bernhardt-living-room` Template

**Files:**
- Create (at runtime, via the MCP tool, not directly by the engineer): `templates/bernhardt-living-room.js`
- Create: `scripts/_register-living-room.mjs` (one-off registration driver, delete after use — matches the pattern used for `bernhardt-bed-listing` earlier in this project)

**Interfaces:**
- Consumes: `register_extraction_template` and `execute_native_extraction` MCP tools (both unchanged).
- Produces: a new manifest entry `bernhardt-living-room` with `domainPattern: "bernhardt.com"`. Per the Global Constraints, this replaces `bernhardt-bed-listing` as bernhardt.com's domain-auto-match owner — both remain fully usable via explicit `templateId`.

- [ ] **Step 1: Write the one-off registration driver**

Create `scripts/_register-living-room.mjs`:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const EXTRACTION_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const collectPage = () =>
    Array.from(document.querySelectorAll('.grid-item'))
      .map((item) => {
        const titleEl = item.querySelector('.product-header');
        const priceEl = item.querySelector('.price-component');
        const imgEl = item.querySelector('img.grid-image') || item.querySelector('img');
        const linkEl = item.querySelector('a[href]');
        const href = linkEl ? linkEl.getAttribute('href') : null;
        return {
          title: titleEl ? titleEl.textContent.trim() : null,
          price: priceEl ? priceEl.textContent.trim() : null,
          imageUrl: imgEl ? imgEl.getAttribute('src') : null,
          productUrl: href ? new URL(href, window.location.origin).href : null,
        };
      })
      .filter((p) => p.imageUrl);

  const findNext = () =>
    Array.from(document.querySelectorAll('a, button')).find((el) => /^next/i.test((el.textContent || '').trim()));

  const firstItemId = () => {
    const el = document.querySelector('.grid-item');
    return el ? el.id : null;
  };

  const parsePager = () => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.textContent && /showing\\s+\\d+\\s*-\\s*\\d+\\s*of\\s*\\d+/i.test(e.textContent) && e.textContent.length < 60
    );
    const match = el && el.textContent.match(/showing\\s+(\\d+)\\s*-\\s*(\\d+)\\s*of\\s*(\\d+)/i);
    if (!match) return null;
    return { pageStart: Number(match[1]), pageEnd: Number(match[2]), total: Number(match[3]) };
  };

  const results = [];
  const seen = new Set();
  const addPage = () => {
    for (const product of collectPage()) {
      const key = product.productUrl || product.imageUrl;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(product);
      }
    }
  };

  addPage();

  const pager = parsePager();
  const pageSize = pager ? pager.pageEnd - pager.pageStart + 1 : results.length;
  const totalPages = pager && pageSize > 0 ? Math.ceil(pager.total / pageSize) : 1;
  const MAX_PAGES = Math.min(totalPages || 1, 100);

  for (let page = 2; page <= MAX_PAGES; page++) {
    const beforeId = firstItemId();
    const nextEl = findNext();
    if (!nextEl) break;

    nextEl.click();

    let updated = false;
    for (let i = 0; i < 30; i++) {
      await wait(300);
      if (firstItemId() !== beforeId) {
        updated = true;
        break;
      }
    }
    if (!updated) break;

    addPage();
  }

  return results;
})()`;

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], stderr: 'inherit' });
const client = new Client({ name: 'living-room-register-client', version: '1.0.0' });

try {
  await client.connect(transport);

  const registerResult = await client.callTool({
    name: 'register_extraction_template',
    arguments: {
      templateId: 'bernhardt-living-room',
      domainPattern: 'bernhardt.com',
      executableScript: EXTRACTION_SCRIPT,
    },
  });
  console.log('--- register_extraction_template ---');
  console.log(registerResult.content[0].text);
} finally {
  await client.close();
}
```

- [ ] **Step 2: Build and run the registration driver**

Run: `npm run build`
Run: `node scripts/_register-living-room.mjs`
Expected: prints the created manifest entry with `"templateId": "bernhardt-living-room"` and `"domainPattern": "bernhardt.com"`.

- [ ] **Step 3: Run a real (first-page-only) shape check before committing to a full 23-page run**

Since a full run walks ~23 pages, first sanity-check the extraction shape and pagination advance on just the live page using the CLI runner from Task 3 with a short timeout expectation — run it for real and let it complete (this is the template's actual job, not a mock):

Run: `node scripts/run.mjs bernhardt-living-room "https://www.bernhardt.com/products/luxury-living-room-furniture#?RoomType=Living&$MultiView=Yes&orderBy=LivingPosition&context=shop&page=1"`

Expected: JSON with `"success": true`, `meta.templateId` = `"bernhardt-living-room"`, and `data` is an array of objects shaped `{ title, price, imageUrl, productUrl }` with roughly 1000+ entries (the live total was 1,104 at design time; treat any large count in that neighborhood as correct, exact figure may drift with live inventory). Confirm at least one sample entry has a non-null `title` and `imageUrl`, and note whether `price` is empty (expected, per the design spec's gated-pricing finding) or populated (would mean the site's pricing gate changed).

- [ ] **Step 4: Delete the one-off registration driver**

```bash
rm scripts/_register-living-room.mjs
```

(`templates/bernhardt-living-room.js` and the updated `templates/manifest.json` stay on disk — they're gitignored, not committed, same as every other template in this project.)

- [ ] **Step 5: Confirm no stray files need committing**

Run: `git status --short`
Expected: no untracked/modified files remain from this task (the registration driver is deleted, and `templates/` is gitignored).

---

## Final Check

- [ ] **Run the full unit test suite one more time**

Run: `npm test`
Expected: all 20 tests pass (unchanged from before this plan — no new unit tests were added, per the spec).

- [ ] **Run `npm run build` one more time**

Run: `npm run build`
Expected: no type errors across all four tasks' changes.
