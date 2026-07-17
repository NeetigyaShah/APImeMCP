import { createHash } from 'node:crypto';
import { withLock } from './lock.js';

export interface CacheKeyParams {
  templateId: string;
  targetUrl: string;
  cookieString?: string;
  proxyUrl?: string;
}

interface CacheEntry {
  value: unknown;
  cachedAt: number;
}

const TTL_MS = Number(process.env.APIMEMCP_CACHE_TTL_MS) || 60_000;
const MAX_ENTRIES = Number(process.env.APIMEMCP_CACHE_MAX_ENTRIES) || 500;
const store = new Map<string, CacheEntry>();

export function buildCacheKey(params: CacheKeyParams): string {
  const cookieIdentity = params.cookieString === undefined
    ? 'no-cookie'
    : createHash('sha256').update(params.cookieString).digest('hex').slice(0, 16);
  return JSON.stringify([params.templateId, params.targetUrl, cookieIdentity, params.proxyUrl ?? 'no-proxy']);
}

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt >= TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T): void {
  store.delete(key);
  store.set(key, { value, cachedAt: Date.now() });
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export async function withResultCache<T>(params: CacheKeyParams, run: () => Promise<T>): Promise<T> {
  const key = buildCacheKey(params);
  const cached = getCached<T>(key);
  if (cached !== undefined) return cached;

  return withLock(key, async () => {
    const lockedCached = getCached<T>(key);
    if (lockedCached !== undefined) return lockedCached;
    const value = await run();
    setCached(key, value);
    return value;
  });
}

export function clearResultCache(): void {
  store.clear();
}

export function getResultCacheStats(): { size: number; ttlMs: number; maxEntries: number } {
  return { size: store.size, ttlMs: TTL_MS, maxEntries: MAX_ENTRIES };
}
