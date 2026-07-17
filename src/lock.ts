// In-process async mutex: serializes read-modify-write critical sections
// (e.g. manifest.json) across concurrent tool calls in this single Node
// process. Subagents in the same Claude Code session share one connection
// to this server, so concurrent calls are a real race, not a distributed
// one - a promise-chain queue is sufficient, no file locking needed.
const queues = new Map<string, Promise<unknown>>();

export function withLock<T>(fn: () => Promise<T>): Promise<T>;
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
export function withLock<T>(keyOrFn: string | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
  const key = typeof keyOrFn === 'string' ? keyOrFn : '__global__';
  const fn = typeof keyOrFn === 'function' ? keyOrFn : maybeFn!;
  const queue = queues.get(key) ?? Promise.resolve();
  const result = queue.then(fn, fn);
  const nextQueue = result.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, nextQueue);
  void nextQueue.then(() => {
    if (queues.get(key) === nextQueue) queues.delete(key);
  });
  return result;
}

export function getLockQueueSize(): number {
  return queues.size;
}
