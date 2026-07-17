import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionSequence, ActionStep, ExtractionMeta, ExtractionResult, RunKind, WaitStrategy } from './types.js';
import { recordMeasure } from './metrics.js';
import { validateOutput } from './schema.js';
import {
  confirmAppConnection,
  getAppConnection,
  listAppConnections,
  markAppConnectionError,
  markAppConnectionOpen,
  resolveProfileDir,
} from './app-connections.js';
import type { AppConnection } from './types.js';

const DEFAULT_WAIT_STRATEGY: WaitStrategy = 'domcontentloaded';

// Inject stealth plugin globally into the chromium instance
chromium.use(stealthPlugin());

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;

export function createSuccessfulExtractionResult(
  data: unknown,
  meta: ExtractionMeta,
  outputSchema?: Record<string, unknown>,
): ExtractionResult {
  const schemaValidation = outputSchema ? validateOutput(data, outputSchema) : undefined;
  return {
    success: true,
    data,
    meta,
    ...(schemaValidation ? { schemaValidation } : {}),
  };
}

let browserInstance: Browser | undefined;
const appContexts = new Map<string, BrowserContext>();

export async function executeMeasured<T>(
  measure: { templateId: string; kind: RunKind },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  let result!: T;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  const timestamp = new Date().toISOString();
  const record = operationError
    ? {
        ...measure,
        success: false,
        durationMs: Date.now() - startedAt,
        timestamp,
        error: operationError instanceof Error ? operationError.message : String(operationError),
      }
    : { ...measure, success: true, durationMs: Date.now() - startedAt, timestamp };
  await recordMeasure(record);

  if (operationError) throw operationError;
  return result;
}

export async function initBrowser(): Promise<void> {
  if (browserInstance) return;
  browserInstance = await chromium.launch({ headless: true });
}

export async function closeBrowser(): Promise<void> {
  const contexts = [...appContexts.entries()];
  appContexts.clear();
  await Promise.allSettled(contexts.map(([, context]) => context.close()));
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

export async function launchPersistentContext(
  profileDir: string,
  launchOptions: Parameters<typeof chromium.launchPersistentContext>[1]
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, launchOptions);
}

async function ensureAppContext(connectionId: string): Promise<BrowserContext> {
  const existing = appContexts.get(connectionId);
  if (existing && !existing.isClosed()) return existing;

  const connection = await getAppConnection(connectionId);
  if (!connection) throw new Error(`No app connection configured for "${connectionId}"`);

  try {
    const context = await launchPersistentContext(await resolveProfileDir(connectionId), {
      headless: false,
      userAgent: USER_AGENT,
      viewport: VIEWPORT,
    });
    appContexts.set(connectionId, context);
    await markAppConnectionOpen(connectionId);
    const page = context.pages()[0] ?? (await context.newPage());
    if (page.url() === 'about:blank') {
      await page.goto(connection.loginUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    }
    return context;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markAppConnectionError(connectionId, message).catch(() => undefined);
    throw err;
  }
}

export async function openAppConnection(connectionId: string): Promise<AppConnection> {
  await ensureAppContext(connectionId);
  const connection = await getAppConnection(connectionId);
  if (!connection) throw new Error(`No app connection configured for "${connectionId}"`);
  return connection;
}

export async function confirmOpenAppConnection(connectionId: string): Promise<AppConnection> {
  await ensureAppContext(connectionId);
  return confirmAppConnection(connectionId);
}

export async function startConfiguredAppConnections(): Promise<void> {
  const connections = await listAppConnections();
  for (const connection of connections.filter((item) => item.autoStart)) {
    try {
      await ensureAppContext(connection.connectionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Startup should remain usable even if one optional visible profile cannot open.
      process.stderr.write(`[APImeMCP] app connection "${connection.connectionId}" failed to start: ${message}\n`);
    }
  }
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

function parseCookieString(cookieString: string, targetUrl: string): Array<{ name: string; value: string; url: string }> {
  return cookieString
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return { name: name.trim(), value: value.trim(), url: targetUrl };
    });
}

const LOW_BANDWIDTH_BLOCKED_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

// The real risk from a malicious registry-sourced template isn't code execution
// (page.evaluate() scripts already run inside Chromium's own V8 isolate - zero access to
// the Node process/filesystem by the browser's own security model, so a vm2/isolated-vm
// style Node-sandbox would be solving the wrong layer entirely). The actual risk is
// network/data-egress: a script could fetch()/exfiltrate scraped data to an
// attacker-controlled endpoint, or ride along on whatever session identity a
// cookieString/proxyUrl grants it. This is what networkAllowlist below actually defends
// against - by observing/restricting real runtime requests, not by trying to sandbox JS.
export const REGISTRY_CDN_ALLOWLIST = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'ajax.googleapis.com',
  'code.jquery.com',
  'unpkg.com',
];

function hostMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
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
  html: string;
}

function createBrowserContext(proxyUrl?: string): Promise<BrowserContext> {
  return getBrowser().newContext({
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
    ...(proxyUrl ? { proxy: parseProxy(proxyUrl) } : {}),
  });
}

async function captureForensics(page: Page): Promise<ForensicPaths> {
  const logsDir = path.join('output', 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const screenshotPath = path.join(logsDir, `${prefix}-screenshot.png`);
  const domPath = path.join(logsDir, `${prefix}-dom.html`);
  const html = await page.content();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(domPath, html);
  return { screenshotPath, domPath, html };
}

export interface PageForensics {
  html: string;
  screenshotPath?: string;
  url: string;
  capturedAt: string;
}

export async function renderPage(
  targetUrl: string,
  opts: { cookieString?: string; proxyUrl?: string } = {}
): Promise<PageForensics> {
  const context = await createBrowserContext(opts.proxyUrl);
  try {
    if (opts.cookieString) {
      await context.addCookies(parseCookieString(opts.cookieString, targetUrl));
    }
    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: DEFAULT_WAIT_STRATEGY });
      const { html, screenshotPath } = await captureForensics(page);
      return { html, screenshotPath, url: page.url(), capturedAt: new Date().toISOString() };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await context.close();
  }
}

export interface ExecuteExtractionOptions {
  targetUrl: string;
  scriptPath?: string;
  executableScript?: string;
  captureForensicsOnError?: boolean;
  proxyUrl?: string;
  // ponytail: trusted-operator params, same trust model as targetUrl/proxyUrl above —
  // this is a single-user local tool, not a multi-tenant service. Point cookieString
  // only at domains/accounts you control.
  cookieString?: string;
  // Uses a persistent, user-managed browser profile created by connect_app. This
  // replaces manual cookie extraction and keeps login state inside Chromium.
  connectionId?: string;
  simulateLowBandwidth?: boolean;
  // Falls back to DEFAULT_WAIT_STRATEGY when absent - see the field comment on
  // ManifestEntry.waitStrategy in types.ts for why 'networkidle' stopped being the
  // hardcoded default.
  waitStrategy?: WaitStrategy;
  readySelector?: string;
  // Restricts outbound requests during this run to these hostnames only (exact or
  // subdomain match) - aborts everything else. index.ts sets this to the template's own
  // domain + REGISTRY_CDN_ALLOWLIST when entry.source === 'registry'; absent (undefined)
  // for locally-authored templates, which stay unrestricted (trusted by definition, same
  // as today).
  networkAllowlist?: string[];
  onNetworkRequest?: (url: string) => void;
}

export async function executeExtraction(options: ExecuteExtractionOptions): Promise<unknown> {
  const persistentContext = options.connectionId ? await ensureAppContext(options.connectionId) : undefined;
  const context =
    persistentContext ??
    (await createBrowserContext(options.proxyUrl));
  try {
    if (options.cookieString) {
      await context.addCookies(parseCookieString(options.cookieString, options.targetUrl));
    }
    if (options.simulateLowBandwidth) {
      await context.route('**/*', (route) => {
        if (LOW_BANDWIDTH_BLOCKED_TYPES.has(route.request().resourceType())) {
          void route.abort();
        } else {
          void route.continue();
        }
      });
    }
    if (options.networkAllowlist) {
      const allowlist = options.networkAllowlist;
      await context.route('**/*', (route) => {
        let hostname: string;
        try {
          hostname = new URL(route.request().url()).hostname.toLowerCase();
        } catch {
          void route.abort();
          return;
        }
        if (hostMatchesAllowlist(hostname, allowlist)) {
          void route.continue();
        } else {
          void route.abort();
        }
      });
    }
    await context.addInitScript(() => {
      // @ts-expect-error - this callback runs in the browser context, where `navigator`
      // is a global; the project's tsconfig intentionally omits the DOM lib for the
      // Node.js runtime code, so TypeScript cannot see it here.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    page.on('request', (request) => options.onNetworkRequest?.(request.url()));
    try {
      await page.goto(options.targetUrl, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: options.waitStrategy ?? DEFAULT_WAIT_STRATEGY,
      });
      if (options.readySelector) {
        await page.waitForSelector(options.readySelector, { timeout: NAVIGATION_TIMEOUT_MS });
      }
      const script = options.executableScript ?? (options.scriptPath ? await fs.readFile(path.resolve(process.cwd(), options.scriptPath), 'utf8') : undefined);
      if (!script) throw new Error('scriptPath or executableScript is required');
      // ponytail: page.evaluate(stringExpression) does NOT auto-invoke a bare function
      // expression (verified live: `page.evaluate('() => 42')` returns undefined, not 42) -
      // it only awaits a promise if the expression's own evaluation already produced one.
      // Templates are written either way (bare `async () => {...}` or a self-invoking
      // `(async () => {...})()`), so eval the source in-page and call it only if it's
      // still a function, rather than picking one convention and breaking the other.
      const rawResult = await page.evaluate((src) => {
        // eslint-disable-next-line no-eval
        const value = (0, eval)(src);
        return typeof value === 'function' ? value() : value;
      }, script);
      return assertJsonSerializable(rawResult);
    } catch (err) {
      if (options.captureForensicsOnError === false) throw err;
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
    } finally {
      if (persistentContext) await page.close().catch(() => undefined);
    }
  } finally {
    if (persistentContext) {
      await context.unroute('**/*').catch(() => undefined);
    } else {
      await context.close();
    }
  }
}

function mapSameSite(sameSite: unknown): 'Strict' | 'Lax' | 'None' {
  if (sameSite === 'no_restriction') return 'None';
  if (sameSite === 'strict') return 'Strict';
  if (sameSite === 'lax') return 'Lax';
  return 'Lax';
}

function mapChromeCookies(cookies: Array<Record<string, unknown>>) {
  return cookies.map((c) => ({
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: String(c.path ?? '/'),
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
    sameSite: mapSameSite(c.sameSite),
  }));
}

const STEP_SELECTOR_TIMEOUT_MS = 3000;

async function runActionStep(page: Page, step: ActionStep): Promise<void> {
  if (step.type === 'navigate') {
    await page.goto(step.url ?? '', { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
    return;
  }
  if (step.type === 'waitForNavigation') {
    await page.waitForLoadState('networkidle', { timeout: NAVIGATION_TIMEOUT_MS });
    return;
  }
  const selectors = step.selectors ?? [];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (step.type === 'click') {
        await locator.click({ timeout: STEP_SELECTOR_TIMEOUT_MS });
      } else if (step.type === 'fill') {
        await locator.fill(step.value ?? '', { timeout: STEP_SELECTOR_TIMEOUT_MS });
      } else if (step.type === 'select') {
        await locator.selectOption(step.value ?? '', { timeout: STEP_SELECTOR_TIMEOUT_MS });
      }
      return;
    } catch {
      // this selector didn't work - fall through and try the next fallback candidate
    }
  }
  throw new Error(`no working selector for ${step.type} (tried: ${selectors.join(', ') || 'none provided'})`);
}

export interface ExecuteActionSequenceOptions {
  sequence: ActionSequence;
  proxyUrl?: string;
  simulateLowBandwidth?: boolean;
  // Launches a separate, visible browser window just for this one run - the shared
  // browser instance is always headless (fixed at initBrowser() launch time, can't be
  // toggled after the fact), so "watch it run" needs its own dedicated instance.
  headful?: boolean;
  connectionId?: string;
  networkAllowlist?: string[];
  onNetworkRequest?: (url: string) => void;
}

export async function executeActionSequence(options: ExecuteActionSequenceOptions): Promise<void> {
  const persistentContext = options.connectionId ? await ensureAppContext(options.connectionId) : undefined;
  const ownBrowser = options.headful && !persistentContext ? await chromium.launch({ headless: false }) : undefined;
  const browser = ownBrowser ?? (persistentContext ? undefined : getBrowser());
  const context =
    persistentContext ??
    (await browser!.newContext({
      userAgent: USER_AGENT,
      viewport: VIEWPORT,
      ...(options.proxyUrl ? { proxy: parseProxy(options.proxyUrl) } : {}),
    }));
  try {
    if (options.sequence.cookies && !options.connectionId) {
      await context.addCookies(mapChromeCookies(options.sequence.cookies));
    }
    if (options.simulateLowBandwidth) {
      await context.route('**/*', (route) => {
        if (LOW_BANDWIDTH_BLOCKED_TYPES.has(route.request().resourceType())) {
          void route.abort();
        } else {
          void route.continue();
        }
      });
    }
    if (options.networkAllowlist) {
      const allowlist = options.networkAllowlist;
      await context.route('**/*', (route) => {
        let hostname: string;
        try {
          hostname = new URL(route.request().url()).hostname.toLowerCase();
        } catch {
          void route.abort();
          return;
        }
        if (hostMatchesAllowlist(hostname, allowlist)) {
          void route.continue();
        } else {
          void route.abort();
        }
      });
    }
    await context.addInitScript(() => {
      // @ts-expect-error - this callback runs in the browser context, where `navigator`
      // is a global; the project's tsconfig intentionally omits the DOM lib for the
      // Node.js runtime code, so TypeScript cannot see it here.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    page.on('request', (request) => options.onNetworkRequest?.(request.url()));
    let stepIndex = -1; // -1 = still navigating to startUrl, not yet inside the step loop
    try {
      await page.goto(options.sequence.startUrl, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
      for (stepIndex = 0; stepIndex < options.sequence.steps.length; stepIndex++) {
        await runActionStep(page, options.sequence.steps[stepIndex]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const where = stepIndex === -1 ? 'navigating to startUrl' : `at step ${stepIndex + 1}`;
      try {
        const { screenshotPath, domPath } = await captureForensics(page);
        throw new Error(
          `Action sequence failed ${where}: ${message} (forensic artifacts: ${screenshotPath}, ${domPath})`
        );
      } catch (captureErr) {
        if (captureErr instanceof Error && captureErr.message.startsWith('Action sequence failed')) {
          throw captureErr;
        }
        // Forensic capture itself failed (e.g. page already closed) - don't mask the real error.
        throw err;
      }
    } finally {
      if (persistentContext) await page.close().catch(() => undefined);
    }
  } finally {
    if (ownBrowser) {
      // ponytail: leave the final state on screen for a moment before closing the
      // window - the whole point of headful mode is watching it happen.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (persistentContext) {
      await context.unroute('**/*').catch(() => undefined);
    } else {
      await context.close();
    }
    if (ownBrowser) {
      await ownBrowser.close();
    }
  }
}
