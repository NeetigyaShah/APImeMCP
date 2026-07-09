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
  // ponytail: trusted-operator params, same trust model as targetUrl/proxyUrl above —
  // this is a single-user local tool, not a multi-tenant service. Point cookieString
  // only at domains/accounts you control.
  cookieString?: string;
  simulateLowBandwidth?: boolean;
}

export async function executeExtraction(options: ExecuteExtractionOptions): Promise<unknown> {
  const browser = getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
    ...(options.proxyUrl ? { proxy: parseProxy(options.proxyUrl) } : {}),
  });
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
