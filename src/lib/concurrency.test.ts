import { describe, expect, it } from "vitest";
import { mapWithConcurrency, mapWithConcurrencyOrThrow } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 10, 20, 0], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("does not spawn more runners than there are items", async () => {
    // Math.min(limit, items.length) — a limit of 50 over 2 items must not
    // create 48 runners that immediately find the cursor exhausted.
    const out = await mapWithConcurrency([1, 2], 50, async (n) => n * 2);
    expect(out).toEqual([2, 4]);
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("mapWithConcurrencyOrThrow", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("returns every result in input order when no worker throws", async () => {
    const out = await mapWithConcurrencyOrThrow([30, 10, 20, 0], 3, async (ms) => {
      await wait(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  it("starts nothing after a worker throws, and throws once the ones in flight finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const run = mapWithConcurrencyOrThrow(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (i) => {
        started.push(i);
        if (i === 1) {
          await wait(1);
          throw new Error("item 1 failed");
        }
        await wait(10);
        finished.push(i);
        return i;
      },
    );
    await expect(run).rejects.toThrow("item 1 failed");
    expect(started.sort()).toEqual([0, 1, 2]);
    expect(finished.sort()).toEqual([0, 2]);
    // Nothing is started later, either.
    await wait(30);
    expect(started.sort()).toEqual([0, 1, 2]);
  });

  it("throws the first error when more than one worker fails", async () => {
    const run = mapWithConcurrencyOrThrow([5, 1, 3], 3, async (ms) => {
      await wait(ms);
      throw new Error(`failed after ${ms} ms`);
    });
    await expect(run).rejects.toThrow("failed after 1 ms");
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithConcurrencyOrThrow([], 4, async () => 1)).toEqual([]);
  });
});
