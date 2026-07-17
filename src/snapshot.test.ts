import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  compareSnapshot,
  diffValues,
  loadSnapshot,
  saveSnapshot,
  snapshotPath,
  stableStringify,
} from './snapshot.js';

const templateId = 'snapshot-test';

afterEach(async () => {
  await fs.rm(path.dirname(snapshotPath(templateId)), { recursive: true, force: true });
});

describe('snapshot values', () => {
  it('sorts object keys without changing array order', () => {
    expect(stableStringify({ b: 2, a: [{ z: 1, y: 0 }] })).toBe('{"a":[{"y":0,"z":1}],"b":2}');
    expect(diffValues({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toEqual([]);
  });

  it('reports changed, added, and removed paths', () => {
    expect(diffValues({ items: [{ price: 10 }], removed: true }, { items: [{ price: 12 }, { price: 3 }], added: true })).toEqual([
      { path: 'added', actual: true },
      { path: 'items[0].price', expected: 10, actual: 12 },
      { path: 'items[1]', actual: { price: 3 } },
      { path: 'removed', expected: true },
    ]);
  });

  it('does not throw for unusual values', () => {
    expect(diffValues(undefined, null)).toEqual([{ path: '$', expected: undefined, actual: null }]);
    expect(diffValues(Number.NaN, Number.NaN)).toEqual([]);
  });
});

describe('snapshot storage and comparison', () => {
  it('round-trips a golden snapshot with a stable hash', async () => {
    const saved = await saveSnapshot(templateId, { b: 2, a: 1 }, { targetUrl: 'https://example.com' });
    const loaded = await loadSnapshot(templateId);

    expect(loaded).toEqual(saved);
    expect(saved).toMatchObject({ templateId, targetUrl: 'https://example.com', data: { b: 2, a: 1 } });
    expect(saved.outputHash).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  });

  it('returns no-baseline when nothing was recorded', async () => {
    await expect(loadSnapshot(templateId)).resolves.toBeNull();
    await expect(compareSnapshot(templateId, { value: 1 })).resolves.toEqual({ status: 'no-baseline', templateId });
  });

  it('returns match and regression comparisons', async () => {
    await saveSnapshot(templateId, { value: 1 });

    await expect(compareSnapshot(templateId, { value: 1 })).resolves.toEqual({ status: 'match', templateId });
    await expect(compareSnapshot(templateId, { value: 2 })).resolves.toEqual({
      status: 'regression',
      templateId,
      diff: [{ path: 'value', expected: 1, actual: 2 }],
    });
  });
});
