// In-process async mutex: serializes read-modify-write critical sections
// (e.g. manifest.json) across concurrent tool calls in this single Node
// process. Subagents in the same Claude Code session share one connection
// to this server, so concurrent calls are a real race, not a distributed
// one - a promise-chain queue is sufficient, no file locking needed.
let queue: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
