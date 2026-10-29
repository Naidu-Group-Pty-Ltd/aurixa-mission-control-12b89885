/**
 * Run `worker` over `items` with a bounded number of in-flight promises,
 * preserving input order in the result.
 *
 * Pure and dependency-free so both a `.server.ts` module and a client-reachable
 * `.functions.ts` one can import it without dragging server-only code into a
 * browser bundle. It existed as two byte-identical private copies before this,
 * in `codex-scheduling.server.ts` and `github-secrets.functions.ts`, which is
 * two places for a concurrency bug to be fixed in one of.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * `mapWithConcurrency` for a loop that stopped at its first failure, and must
 * still. Once a worker throws, no further item is started; the items already
 * in flight finish, and then the first error is thrown. `mapWithConcurrency`
 * rejects on that error too, but its other runners carry on through the rest
 * of the list after it, writing whatever their items write.
 */
export async function mapWithConcurrencyOrThrow<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const failure: { thrown: boolean; error?: unknown } = { thrown: false };
  const { results } = await mapWithConcurrencyUntil(
    items,
    limit,
    async (item) => {
      try {
        return await worker(item);
      } catch (error) {
        if (!failure.thrown) Object.assign(failure, { thrown: true, error });
        return undefined as R;
      }
    },
    () => failure.thrown,
  );
  if (failure.thrown) throw failure.error;
  return results;
}

/**
 * `mapWithConcurrency`, but the caller can stop it.
 *
 * `shouldStop` is asked before each item is STARTED; an item already started
 * runs to completion, so `results` holds exactly the first `processed`
 * items, in order, every one of them finished. Nothing past `processed` was
 * touched. For a pass that must fit an invocation budget this is the whole
 * contract: what it did is complete and recorded, what it did not do is
 * untouched and can be done next time.
 */
export async function mapWithConcurrencyUntil<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  shouldStop: () => boolean,
): Promise<{ results: R[]; processed: number; stopped: boolean }> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop()) {
        stopped = true;
        return;
      }
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return { results: results.slice(0, cursor), processed: cursor, stopped };
}
