# MCP Compiler Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `mcp-compiler-server` — an MCP server that registers reusable JavaScript extraction "templates" per domain and executes them deterministically against target URLs via a persistent headless Chromium instance, with zero external database dependencies.

**Architecture:** Four isolated modules — `types.ts` (Zod schemas + inferred types, no logic), `storage.ts` (manifest/file I/O, no Playwright knowledge), `engine.ts` (browser lifecycle + script execution, no manifest knowledge), `index.ts` (MCP tool wiring, the only file that imports both storage and engine). A persistent Chromium instance is launched once at startup; each extraction gets an isolated `browser.newContext()` closed in `finally`.

**Tech Stack:** Node.js 20+ ESM, TypeScript strict mode, `@modelcontextprotocol/sdk` v1.29.x, Playwright (Chromium only), Zod, Vitest.

## Global Constraints

- Node.js v20+, ESM only (`"type": "module"` in package.json).
- TypeScript strict mode enabled (`"strict": true` in tsconfig.json).
- `@modelcontextprotocol/sdk` imports use the confirmed v1.29.x subpaths: `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js` (verified against SDK docs — do not use the `@modelcontextprotocol/server` package, that is a different, newer alpha package).
- `server.tool(name, zodRawShape, handler)` takes a plain object of Zod schemas (a "raw shape"), not a wrapped `z.object(...)`.
- Chromium only — no Firefox/WebKit engines.
- No `playwright-extra` / `puppeteer-extra-plugin-stealth` dependency. Native Playwright config only (fixed UA, fixed viewport, `navigator.webdriver` patch) — approved spec explicitly scopes out bot-detection-evasion tooling.
- No automated proxy rotation or pooling — `proxyUrl` is a single optional passthrough into `browser.newContext({ proxy })`.
- stdout is reserved for MCP JSON-RPC framing. All logging MUST go to `process.stderr`, never `console.log`.
- One persistent Chromium instance for the server process lifetime (`chromium.launch()` once at startup); a fresh `browser.newContext()` per request, always closed in `finally`.
- Zero external database — all state lives in `templates/manifest.json` plus sibling `<templateId>.js` files.
- `templates/*.js` and `templates/manifest.json` are tracked in git (they are the reusable extraction library, not throwaway runtime data).
- Domain matching: `hostname === domainPattern || hostname.endsWith('.' + domainPattern)`, longest `domainPattern` string wins on ambiguity. No regex evaluation of user-supplied patterns.
- `targetUrl` must be `http:`/`https:` only — a hard scheme guard, not full SSRF hardening.

---

## Task 1: Project Scaffolding & Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `templates/manifest.json`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm run build` (runs `tsc`), `npm start` (runs `node dist/index.js`), `npm test` (runs `vitest run`). Later tasks assume these three scripts exist.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "mcp-compiler-server",
  "version": "1.0.0",
  "description": "MCP server implementing a compiler pattern for deterministic web scraping and data extraction",
  "type": "module",
  "private": true,
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "playwright": "^1.55.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^20.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
.env
*.log
.DS_Store
Thumbs.db
```

- [ ] **Step 4: Seed `templates/manifest.json`**

```json
{}
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes with no errors, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore templates/manifest.json
git commit -m "chore: scaffold project (package.json, tsconfig, manifest seed)"
```

---

## Task 2: Shared Types & Validation Schemas

**Files:**
- Create: `src/types.ts`
- Test: `src/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3–5):
  - `RegisterExtractionTemplateShape: { templateId: ZodString, domainPattern: ZodEffects<ZodString>, executableScript: ZodString }`
  - `RegisterExtractionTemplateInputSchema: ZodObject`, `type RegisterExtractionTemplateInput`
  - `ExecuteNativeExtractionShape: { targetUrl: ZodEffects<ZodString>, templateId: ZodOptional<ZodString>, proxyUrl: ZodOptional<ZodString> }`
  - `ExecuteNativeExtractionInputSchema: ZodObject`, `type ExecuteNativeExtractionInput`
  - `interface ManifestEntry { templateId, domainPattern, scriptPath, createdAt, updatedAt: string }`
  - `type Manifest = Record<string, ManifestEntry>`
  - `interface ExtractionMeta { url, templateId, domainMatched: string; durationMs: number; timestamp: string }`
  - `interface ExtractionResult { success: boolean; data?: unknown; error?: string; meta: ExtractionMeta }`

- [ ] **Step 1: Write the failing test**

Create `src/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RegisterExtractionTemplateInputSchema, ExecuteNativeExtractionInputSchema } from './types.js';

describe('RegisterExtractionTemplateInputSchema', () => {
  it('accepts a valid kebab-case templateId and lowercases domainPattern', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'amazon-product',
      domainPattern: 'Amazon.com',
      executableScript: '(() => document.title)()',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.domainPattern).toBe('amazon.com');
    }
  });

  it('rejects a templateId with uppercase or underscores', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'Amazon_Product',
      domainPattern: 'amazon.com',
      executableScript: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an executableScript over the 100KB limit', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'big',
      domainPattern: 'big.com',
      executableScript: 'a'.repeat(100_001),
    });
    expect(result.success).toBe(false);
  });
});

describe('ExecuteNativeExtractionInputSchema', () => {
  it('accepts an absolute https URL', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({ targetUrl: 'https://example.com/page' });
    expect(result.success).toBe(true);
  });

  it('rejects a file:// URL', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({ targetUrl: 'file:///etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-absolute string', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({ targetUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional proxyUrl', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({
      targetUrl: 'https://example.com',
      proxyUrl: 'http://user:pass@proxy.example.com:8080',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/types.test.ts`
Expected: FAIL — `src/types.ts` does not exist / cannot resolve module.

- [ ] **Step 3: Write `src/types.ts`**

```typescript
import { z } from 'zod';

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TemplateIdSchema = z
  .string()
  .regex(TEMPLATE_ID_PATTERN, 'templateId must be lowercase kebab-case alphanumeric (e.g. "amazon-product")');

const DomainPatternSchema = z
  .string()
  .min(1, 'domainPattern must not be empty')
  .transform((value) => value.toLowerCase());

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const RegisterExtractionTemplateShape = {
  templateId: TemplateIdSchema,
  domainPattern: DomainPatternSchema,
  executableScript: z
    .string()
    .min(1, 'executableScript must not be empty')
    .max(100_000, 'executableScript exceeds the 100KB limit'),
};

export const RegisterExtractionTemplateInputSchema = z.object(RegisterExtractionTemplateShape);
export type RegisterExtractionTemplateInput = z.infer<typeof RegisterExtractionTemplateInputSchema>;

export const ExecuteNativeExtractionShape = {
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }),
  templateId: TemplateIdSchema.optional(),
  proxyUrl: z.string().url().optional(),
};

export const ExecuteNativeExtractionInputSchema = z.object(ExecuteNativeExtractionShape);
export type ExecuteNativeExtractionInput = z.infer<typeof ExecuteNativeExtractionInputSchema>;

export interface ManifestEntry {
  templateId: string;
  domainPattern: string;
  scriptPath: string;
  createdAt: string;
  updatedAt: string;
}

export type Manifest = Record<string, ManifestEntry>;

export interface ExtractionMeta {
  url: string;
  templateId: string;
  domainMatched: string;
  durationMs: number;
  timestamp: string;
}

export interface ExtractionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  meta: ExtractionMeta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/types.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/types.test.ts
git commit -m "feat: add shared Zod schemas and types"
```

---

## Task 3: Storage Manager

**Files:**
- Create: `src/storage.ts`
- Test: `src/storage.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `ManifestEntry`, `RegisterExtractionTemplateInput` from `./types.js` (Task 2).
- Produces (used by Task 5):
  - `ensureStorageInitialized(): Promise<void>`
  - `loadManifest(): Promise<Manifest>`
  - `saveManifest(manifest: Manifest): Promise<void>`
  - `registerTemplate(input: RegisterExtractionTemplateInput): Promise<ManifestEntry>`
  - `findTemplateById(manifest: Manifest, templateId: string): ManifestEntry | undefined`
  - `findTemplateByUrl(manifest: Manifest, targetUrl: string): ManifestEntry | undefined`
- All paths (templates dir, manifest path) are resolved from `process.cwd()` fresh on every call (not cached at module load) so tests can isolate via `process.chdir()`.

- [ ] **Step 1: Write the failing test**

Create `src/storage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureStorageInitialized,
  loadManifest,
  saveManifest,
  registerTemplate,
  findTemplateById,
  findTemplateByUrl,
} from './storage.js';
import type { Manifest } from './types.js';

let originalCwd: string;
let tmpDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-compiler-test-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ensureStorageInitialized', () => {
  it('creates templates dir and an empty manifest.json when missing', async () => {
    await ensureStorageInitialized();
    const raw = await fs.readFile(path.join(tmpDir, 'templates', 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({});
  });

  it('does not overwrite an existing manifest.json', async () => {
    await ensureStorageInitialized();
    await saveManifest({
      foo: { templateId: 'foo', domainPattern: 'foo.com', scriptPath: 'templates/foo.js', createdAt: 'x', updatedAt: 'x' },
    });
    await ensureStorageInitialized();
    const manifest = await loadManifest();
    expect(manifest.foo).toBeDefined();
  });
});

describe('saveManifest / loadManifest', () => {
  it('round-trips a manifest through an atomic write', async () => {
    const manifest: Manifest = {
      example: { templateId: 'example', domainPattern: 'example.com', scriptPath: 'templates/example.js', createdAt: 'a', updatedAt: 'b' },
    };
    await saveManifest(manifest);
    expect(await loadManifest()).toEqual(manifest);
  });

  it('leaves no leftover temp files after a save', async () => {
    await saveManifest({});
    const files = await fs.readdir(path.join(tmpDir, 'templates'));
    expect(files.every((f) => !f.includes('.tmp-'))).toBe(true);
  });
});

describe('registerTemplate', () => {
  it('writes the script file and creates a manifest entry', async () => {
    const entry = await registerTemplate({
      templateId: 'amazon-product',
      domainPattern: 'amazon.com',
      executableScript: '(() => document.title)()',
    });
    expect(entry.templateId).toBe('amazon-product');
    const scriptContent = await fs.readFile(path.join(tmpDir, 'templates', 'amazon-product.js'), 'utf8');
    expect(scriptContent).toBe('(() => document.title)()');
  });

  it('upserts by templateId, preserving createdAt but bumping updatedAt', async () => {
    const first = await registerTemplate({ templateId: 'a', domainPattern: 'a.com', executableScript: 'v1' });
    const second = await registerTemplate({ templateId: 'a', domainPattern: 'a.com', executableScript: 'v2' });
    expect(second.createdAt).toBe(first.createdAt);
    const scriptContent = await fs.readFile(path.join(tmpDir, 'templates', 'a.js'), 'utf8');
    expect(scriptContent).toBe('v2');
  });

  it('removes a previous template that owned the same domainPattern', async () => {
    await registerTemplate({ templateId: 'old', domainPattern: 'shared.com', executableScript: 'old' });
    await registerTemplate({ templateId: 'new', domainPattern: 'shared.com', executableScript: 'new' });
    const manifest = await loadManifest();
    expect(manifest.old).toBeUndefined();
    expect(manifest.new).toBeDefined();
  });
});

describe('findTemplateById', () => {
  it('returns the matching entry or undefined', () => {
    const manifest: Manifest = {
      a: { templateId: 'a', domainPattern: 'a.com', scriptPath: 'templates/a.js', createdAt: 'x', updatedAt: 'x' },
    };
    expect(findTemplateById(manifest, 'a')?.templateId).toBe('a');
    expect(findTemplateById(manifest, 'missing')).toBeUndefined();
  });
});

describe('findTemplateByUrl', () => {
  const manifest: Manifest = {
    root: { templateId: 'root', domainPattern: 'amazon.com', scriptPath: 'templates/root.js', createdAt: 'x', updatedAt: 'x' },
    sub: { templateId: 'sub', domainPattern: 'smile.amazon.com', scriptPath: 'templates/sub.js', createdAt: 'x', updatedAt: 'x' },
  };

  it('matches an exact hostname', () => {
    expect(findTemplateByUrl(manifest, 'https://amazon.com/dp/123')?.templateId).toBe('root');
  });

  it('matches a subdomain against the root domainPattern', () => {
    expect(findTemplateByUrl({ root: manifest.root }, 'https://www.amazon.com/dp/123')?.templateId).toBe('root');
  });

  it('prefers the most specific domainPattern when multiple match', () => {
    expect(findTemplateByUrl(manifest, 'https://smile.amazon.com/dp/123')?.templateId).toBe('sub');
  });

  it('rejects lookalike domains that merely share a suffix string', () => {
    expect(findTemplateByUrl(manifest, 'https://amazon.com.evil.net/x')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(findTemplateByUrl(manifest, 'https://unrelated.org')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage.test.ts`
Expected: FAIL — cannot resolve `./storage.js`.

- [ ] **Step 3: Write `src/storage.ts`**

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Manifest, ManifestEntry, RegisterExtractionTemplateInput } from './types.js';

function getTemplatesDir(): string {
  return path.resolve(process.cwd(), 'templates');
}

function getManifestPath(): string {
  return path.join(getTemplatesDir(), 'manifest.json');
}

export async function ensureStorageInitialized(): Promise<void> {
  await fs.mkdir(getTemplatesDir(), { recursive: true });
  try {
    await fs.access(getManifestPath());
  } catch {
    await saveManifest({});
  }
}

export async function loadManifest(): Promise<Manifest> {
  await ensureStorageInitialized();
  const raw = await fs.readFile(getManifestPath(), 'utf8');
  return JSON.parse(raw) as Manifest;
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  const templatesDir = getTemplatesDir();
  await fs.mkdir(templatesDir, { recursive: true });
  const tmpPath = path.join(templatesDir, `.manifest.json.tmp-${randomUUID()}`);
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(tmpPath, getManifestPath());
}

export async function registerTemplate(input: RegisterExtractionTemplateInput): Promise<ManifestEntry> {
  const manifest = await loadManifest();
  const now = new Date().toISOString();

  for (const [id, entry] of Object.entries(manifest)) {
    if (id !== input.templateId && entry.domainPattern === input.domainPattern) {
      delete manifest[id];
    }
  }

  const templatesDir = getTemplatesDir();
  const scriptFileName = `${input.templateId}.js`;
  await fs.writeFile(path.join(templatesDir, scriptFileName), input.executableScript, 'utf8');

  const existing = manifest[input.templateId];
  const entry: ManifestEntry = {
    templateId: input.templateId,
    domainPattern: input.domainPattern,
    scriptPath: path.join('templates', scriptFileName),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  manifest[input.templateId] = entry;
  await saveManifest(manifest);
  return entry;
}

export function findTemplateById(manifest: Manifest, templateId: string): ManifestEntry | undefined {
  return manifest[templateId];
}

export function findTemplateByUrl(manifest: Manifest, targetUrl: string): ManifestEntry | undefined {
  const hostname = new URL(targetUrl).hostname.toLowerCase();
  let best: ManifestEntry | undefined;
  for (const entry of Object.values(manifest)) {
    const pattern = entry.domainPattern;
    const matches = hostname === pattern || hostname.endsWith(`.${pattern}`);
    if (matches && (!best || pattern.length > best.domainPattern.length)) {
      best = entry;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts src/storage.test.ts
git commit -m "feat: add storage manager with atomic manifest writes and domain matching"
```

---

## Task 4: Browser Execution Engine

**Files:**
- Create: `src/engine.ts`
- Create: `scripts/verify-engine.mjs` (manual smoke test, not part of `npm test`)
- Create: `scripts/fixtures/read-target.js`

**Interfaces:**
- Consumes: nothing from Tasks 2–3 (engine has no knowledge of the manifest).
- Produces (used by Task 5):
  - `initBrowser(): Promise<void>`
  - `closeBrowser(): Promise<void>`
  - `interface ExecuteExtractionOptions { targetUrl: string; scriptPath: string; proxyUrl?: string }`
  - `executeExtraction(options: ExecuteExtractionOptions): Promise<unknown>`

No automated Vitest coverage for this task (per spec: no Playwright in the CI test suite). Verification is a real, scripted smoke test against a local HTTP server and a real headless Chromium instance.

- [ ] **Step 1: Write `src/engine.ts`**

```typescript
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    await page.goto(options.targetUrl, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'networkidle' });
    const script = await fs.readFile(path.resolve(process.cwd(), options.scriptPath), 'utf8');
    const rawResult = await page.evaluate(script);
    return assertJsonSerializable(rawResult);
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 2: Install Playwright's Chromium binary**

Run: `npx playwright install --with-deps chromium`
Expected: downloads Chromium (and OS deps on Linux); completes without error.

- [ ] **Step 3: Build so the smoke test can import compiled output**

Run: `npm run build`
Expected: `dist/engine.js` exists, no type errors.

- [ ] **Step 4: Write the extraction fixture script**

Create `scripts/fixtures/read-target.js`:

```javascript
(() => {
  return {
    title: document.title,
    value: document.getElementById('target').textContent,
  };
})()
```

- [ ] **Step 5: Write the smoke test harness**

Create `scripts/verify-engine.mjs`:

```javascript
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { initBrowser, closeBrowser, executeExtraction } from '../dist/engine.js';

const HTML = '<!doctype html><html><head><title>Engine Smoke Test</title></head><body><h1 id="target">42</h1></body></html>';

async function main() {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const scriptPath = fileURLToPath(new URL('./fixtures/read-target.js', import.meta.url));

  await initBrowser();
  try {
    const data = await executeExtraction({
      targetUrl: `http://127.0.0.1:${port}/`,
      scriptPath,
    });
    const expected = { title: 'Engine Smoke Test', value: '42' };
    const ok = JSON.stringify(data) === JSON.stringify(expected);
    console.log('Extracted:', data);
    console.log(ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await closeBrowser();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Run the smoke test and confirm it passes**

Run: `node scripts/verify-engine.mjs`
Expected output ends with:
```
Extracted: { title: 'Engine Smoke Test', value: '42' }
PASS
```

- [ ] **Step 7: Commit**

```bash
git add src/engine.ts scripts/verify-engine.mjs scripts/fixtures/read-target.js
git commit -m "feat: add persistent-browser extraction engine with a scripted smoke test"
```

---

## Task 5: MCP Server Wiring & End-to-End Smoke Test

**Files:**
- Create: `src/index.ts`
- Create: `scripts/verify-server.mjs` (manual smoke test, not part of `npm test`)

**Interfaces:**
- Consumes:
  - From `./types.js`: `RegisterExtractionTemplateShape`, `ExecuteNativeExtractionShape`, `ExtractionResult`.
  - From `./storage.js`: `ensureStorageInitialized`, `loadManifest`, `registerTemplate`, `findTemplateById`, `findTemplateByUrl`.
  - From `./engine.js`: `initBrowser`, `closeBrowser`, `executeExtraction`.
- Produces: the runnable server entry point `dist/index.js` (no other file depends on index.ts — it's the top of the dependency graph).

- [ ] **Step 1: Write `src/index.ts`**

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RegisterExtractionTemplateShape, ExecuteNativeExtractionShape } from './types.js';
import type { ExtractionResult } from './types.js';
import {
  ensureStorageInitialized,
  loadManifest,
  registerTemplate,
  findTemplateById,
  findTemplateByUrl,
} from './storage.js';
import { initBrowser, closeBrowser, executeExtraction } from './engine.js';

function log(message: string): void {
  process.stderr.write(`[mcp-compiler-server] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[mcp-compiler-server] ERROR: ${message}\n`);
}

const server = new McpServer({ name: 'mcp-compiler-server', version: '1.0.0' });

server.tool('register_extraction_template', RegisterExtractionTemplateShape, async (input) => {
  try {
    const entry = await registerTemplate(input);
    log(`Registered template "${entry.templateId}" for domain "${entry.domainPattern}"`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(entry, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`register_extraction_template failed: ${message}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.tool('execute_native_extraction', ExecuteNativeExtractionShape, async (input) => {
  const startedAt = Date.now();
  const buildMeta = (templateId: string, domainMatched: string) => ({
    url: input.targetUrl,
    templateId,
    domainMatched,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });

  try {
    const manifest = await loadManifest();
    const entry = input.templateId
      ? findTemplateById(manifest, input.templateId)
      : findTemplateByUrl(manifest, input.targetUrl);

    if (!entry) {
      const result: ExtractionResult = {
        success: false,
        error: input.templateId
          ? `No registered template with templateId "${input.templateId}"`
          : `No registered template matches the domain for ${input.targetUrl}`,
        meta: buildMeta(input.templateId ?? '', ''),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: true };
    }

    const data = await executeExtraction({
      targetUrl: input.targetUrl,
      scriptPath: entry.scriptPath,
      proxyUrl: input.proxyUrl,
    });
    const result: ExtractionResult = {
      success: true,
      data,
      meta: buildMeta(entry.templateId, entry.domainPattern),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`execute_native_extraction failed: ${message}`);
    const result: ExtractionResult = {
      success: false,
      error: message,
      meta: buildMeta(input.templateId ?? '', ''),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: true };
  }
});

async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP compiler server running on stdio');
}

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down`);
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  logError(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `dist/index.js` exists, no type errors.

- [ ] **Step 3: Write the end-to-end smoke test harness**

Create `scripts/verify-server.mjs`:

```javascript
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HTML = '<!doctype html><html><head><title>Server Smoke Test</title></head><body><h1 id="target">7</h1></body></html>';
const EXTRACTION_SCRIPT = "(() => ({ title: document.title, value: document.getElementById('target').textContent }))()";

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-compiler-server-smoke-'));

  const httpServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(HTML);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: tmpDir,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    console.log('Tools:', toolNames);
    if (JSON.stringify(toolNames) !== JSON.stringify(['execute_native_extraction', 'register_extraction_template'])) {
      throw new Error('Unexpected tool list');
    }

    const registerResult = await client.callTool({
      name: 'register_extraction_template',
      arguments: {
        templateId: 'smoke-test',
        domainPattern: '127.0.0.1',
        executableScript: EXTRACTION_SCRIPT,
      },
    });
    console.log('Register result:', registerResult.content[0].text);

    const extractResult = await client.callTool({
      name: 'execute_native_extraction',
      arguments: { targetUrl: `http://127.0.0.1:${port}/` },
    });
    const payload = JSON.parse(extractResult.content[0].text);
    console.log('Extraction result:', payload);
    const ok = payload.success === true && payload.data.title === 'Server Smoke Test' && payload.data.value === '7';
    console.log(ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.close();
    httpServer.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run the end-to-end smoke test and confirm it passes**

Run: `node scripts/verify-server.mjs`
Expected output ends with:
```
Extraction result: { success: true, data: { title: 'Server Smoke Test', value: '7' }, meta: { ... } }
PASS
```

- [ ] **Step 5: Run the full unit test suite one more time to confirm no regressions**

Run: `npm test`
Expected: all Task 2 and Task 3 tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts scripts/verify-server.mjs
git commit -m "feat: wire MCP tools to storage and engine, add end-to-end smoke test"
```

---

## Task 6: Docker Packaging & Documentation

**Files:**
- Create: `Dockerfile`
- Create: `README.md`

**Interfaces:**
- Consumes: the finished `package.json` scripts (`build`, `start`) and directory layout from Tasks 1–5.
- Produces: nothing consumed by other tasks — this is the final task.

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:20-slim AS base
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY templates ./templates
RUN groupadd -r mcp \
    && useradd -r -g mcp -m mcp \
    && chown -R mcp:mcp /app
USER mcp
ENTRYPOINT ["node", "dist/index.js"]
```

- [ ] **Step 2: Write `README.md`**

```markdown
# MCP Compiler Server

An MCP (Model Context Protocol) server that implements a "Compiler Pattern" for
deterministic web-page data extraction: author a plain JavaScript extraction script
once per domain, and re-run it deterministically against any matching URL — no
external database, no re-derivation of extraction logic per request.

## How it works

1. `register_extraction_template` saves a JavaScript snippet (evaluated inside the
   page's own browser context) to `templates/<templateId>.js` and records the mapping
   from a domain pattern to that script in `templates/manifest.json`.
2. `execute_native_extraction` opens the target URL in an isolated Playwright browser
   context, waits for the page to reach `networkidle`, evaluates the matching script,
   and returns the result.

Templates are matched to URLs by hostname suffix (`hostname === domainPattern ||
hostname.endsWith('.' + domainPattern)`), so registering `amazon.com` also matches
`www.amazon.com` and `smile.amazon.com`. Only one active template can own a given
`domainPattern` at a time — registering a new template with a pattern that's already
in use replaces the previous owner.

## Requirements

- Node.js 20+
- ~300MB disk for the Chromium binary Playwright installs

## Install & build

```bash
npm install
npx playwright install --with-deps chromium
npm run build
```

## Run

```bash
npm start
```

The server communicates over stdio — it's meant to be spawned by an MCP client, not
run interactively.

## Test

```bash
npm test                       # unit tests (storage + validation, no browser)
node scripts/verify-engine.mjs # manual smoke test of the browser engine
node scripts/verify-server.mjs # manual end-to-end smoke test of the full server
```

The two `scripts/verify-*.mjs` smoke tests spin up a local HTTP server and drive a
real headless Chromium instance; they require `npm run build` and
`npx playwright install --with-deps chromium` to have been run first.

## Claude Desktop configuration

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcp-compiler-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-compiler-server/dist/index.js"]
    }
  }
}
```

## Docker

```bash
docker build -t mcp-compiler-server .
docker run -i mcp-compiler-server
```

The image installs Chromium and its OS dependencies at build time
(`npx playwright install --with-deps chromium`) and runs as a non-root user.

## Tools

### `register_extraction_template`

| field | type | notes |
|---|---|---|
| `templateId` | string | lowercase kebab-case, e.g. `amazon-product` |
| `domainPattern` | string | e.g. `amazon.com` — matches that hostname and its subdomains |
| `executableScript` | string | vanilla JavaScript, evaluated via `page.evaluate()`; must return a JSON-serializable value; capped at 100KB |

### `execute_native_extraction`

| field | type | notes |
|---|---|---|
| `targetUrl` | string | absolute `http://` or `https://` URL |
| `templateId` | string, optional | explicit template; if omitted, resolved from `targetUrl`'s domain |
| `proxyUrl` | string, optional | e.g. `http://user:pass@host:port`, passed through to Playwright's `context.newContext({ proxy })` for routing through an authorized egress proxy or testing region-specific rendering. No automated rotation. |

Returns `{ success, data?, error?, meta: { url, templateId, domainMatched, durationMs, timestamp } }`.

## Security notes

- `targetUrl` is restricted to `http:`/`https:` — a headless browser navigating to
  `file://` or other schemes is a local-file-exfiltration risk, so this is enforced
  unconditionally.
- Stealth configuration (fixed user agent, fixed viewport, `navigator.webdriver`
  patch) exists to make DOM rendering deterministic across runs. This server does not
  bundle bot-detection-evasion tooling and does not rotate IPs — `proxyUrl` is a
  single, explicit passthrough for legitimate egress routing, not an anti-ban feature.
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile README.md
git commit -m "docs: add Dockerfile and README"
```
