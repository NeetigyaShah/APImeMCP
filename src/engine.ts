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
      // @ts-expect-error - this callback runs in the browser context, where `navigator`
      // is a global; the project's tsconfig intentionally omits the DOM lib for the
      // Node.js runtime code, so TypeScript cannot see it here.
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
