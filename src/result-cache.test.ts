import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  buildCacheKey,
  clearResultCache,
  getCached,
  getResultCacheStats,
  setCached,
  withResultCache,
} from './result-cache.js';

describe('result cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearResultCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds stable, isolated keys without exposing cookies', () => {
    const base = { templateId: 'template', targetUrl: 'https://example.com' };
    const key = buildCacheKey({ ...base, cookieString: 'session=secret', proxyUrl: 'http://proxy-a' });

    expect(key).toBe(buildCacheKey({ ...base, cookieString: 'session=secret', proxyUrl: 'http://proxy-a' }));
    expect(key).not.toContain('session=secret');
    expect(key).not.toBe(buildCacheKey({ ...base, cookieString: 'session=other', proxyUrl: 'http://proxy-a' }));
    expect(key).not.toBe(buildCacheKey({ ...base, cookieString: 'session=secret', proxyUrl: 'http://proxy-b' }));
    expect(buildCacheKey(base)).not.toContain('undefined');
    expect(buildCacheKey(base)).not.toBe(buildCacheKey({ ...base, cookieString: '' }));
  });

  it('returns values until the TTL expires, then lazily removes them', () => {
    const key = buildCacheKey({ templateId: 'template', targetUrl: 'https://example.com' });
    setCached(key, { value: 1 });

    expect(getCached(key)).toEqual({ value: 1 });
    vi.advanceTimersByTime(getResultCacheStats().ttlMs + 1);
    expect(getCached(key)).toBeUndefined();
    expect(getResultCacheStats().size).toBe(0);
  });

  it('caches successes, retries failures, and coalesces concurrent misses', async () => {
    const params = { templateId: 'template', targetUrl: 'https://example.com' };
    const run = vi.fn(async () => 'value');

    await expect(withResultCache(params, run)).resolves.toBe('value');
    await expect(withResultCache(params, run)).resolves.toBe('value');
    expect(run).toHaveBeenCalledTimes(1);

    let attempts = 0;
    const fail = () => {
      attempts += 1;
      return Promise.reject(new Error('no cache'));
    };
    await expect(withResultCache({ ...params, targetUrl: 'https://failure.example' }, fail)).rejects.toThrow('no cache');
    await expect(withResultCache({ ...params, targetUrl: 'https://failure.example' }, fail)).rejects.toThrow('no cache');
    expect(attempts).toBe(2);

    clearResultCache();
    let resolveRun!: (value: string) => void;
    const slowRun = vi.fn(() => new Promise<string>((resolve) => { resolveRun = resolve; }));
    const first = withResultCache(params, slowRun);
    const second = withResultCache(params, slowRun);
    await Promise.resolve();
    expect(slowRun).toHaveBeenCalledTimes(1);
    resolveRun('shared');
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
  });

  it('evicts the oldest entry when the bounded store is full', () => {
    const maxEntries = getResultCacheStats().maxEntries;
    for (let index = 0; index <= maxEntries; index += 1) {
      setCached(`key-${index}`, index);
    }

    expect(getResultCacheStats().size).toBe(maxEntries);
    expect(getCached('key-0')).toBeUndefined();
    expect(getCached(`key-${maxEntries}`)).toBe(maxEntries);
  });
});
