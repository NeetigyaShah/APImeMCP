import { describe, expect, it } from 'vitest';
import { getLockQueueSize, withLock } from './lock.js';

describe('keyed locks', () => {
  it('removes idle queues after all queued work completes', async () => {
    const key = 'lock-cleanup-regression';
    let releaseFirst!: () => void;
    const first = withLock(key, () => new Promise<string>((resolve) => {
      releaseFirst = () => resolve('first');
    }));
    const second = withLock(key, async () => 'second');

    await Promise.resolve();
    expect(getLockQueueSize()).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(getLockQueueSize()).toBe(0);
  });
});
