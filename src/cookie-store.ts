import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';
import { atomicWriteFile } from './storage.js';

// Per-template saved session cookies, so a cookieString supplied once (in a chat or the
// dashboard) can be reused with one click later. Lives under templates/ (gitignored) -
// same single-user, own-accounts-only trust model as the cookieString param itself; these
// are session cookies, so the file is as sensitive as a logged-in browser profile.
function getStorePath(): string {
  return path.resolve(process.cwd(), 'templates', 'saved-cookies.json');
}

type CookieStore = Record<string, { cookieString: string; updatedAt: string }>;

async function load(): Promise<CookieStore> {
  try {
    return JSON.parse(await fs.readFile(getStorePath(), 'utf8')) as CookieStore;
  } catch {
    return {};
  }
}

export async function saveCookies(templateId: string, cookieString: string): Promise<void> {
  if (!cookieString) return;
  await withLock(async () => {
    const store = await load();
    store[templateId] = { cookieString, updatedAt: new Date().toISOString() };
    await atomicWriteFile(getStorePath(), JSON.stringify(store, null, 2));
  });
}

export async function getSavedCookies(templateId: string): Promise<string | undefined> {
  return (await load())[templateId]?.cookieString;
}

export async function templatesWithSavedCookies(): Promise<Set<string>> {
  return new Set(Object.keys(await load()));
}
